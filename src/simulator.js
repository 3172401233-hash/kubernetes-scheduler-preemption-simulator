import { covers, remainingCapacity } from './resources.js';
import {
  passesExistingAntiAffinity,
  passesNodeAffinity,
  passesPodAffinity,
  passesPodAntiAffinity,
  passesTopologySpread,
  topologySkew,
} from './constraints.js';
import { evictionCost, selectVictims } from './preemption.js';

export const REASONS = {
  INSUFFICIENT_RESOURCES: 'INSUFFICIENT_RESOURCES',
  CONSTRAINT_CONFLICT: 'CONSTRAINT_CONFLICT',
  PDB_BLOCKED: 'PDB_BLOCKED',
  PREEMPTION_LOOP: 'PREEMPTION_LOOP',
};

const REASON_MESSAGES = {
  [REASONS.INSUFFICIENT_RESOURCES]:
    '缺资源：即使驱逐节点上所有可抢占的 Pod，释放的资源仍无法满足请求',
  [REASONS.CONSTRAINT_CONFLICT]:
    '约束冲突：节点亲和、Pod 亲和/反亲和、拓扑分布或关键 Pod 保护阻止了调度',
  [REASONS.PDB_BLOCKED]: 'PDB 冲突：驱逐候选受害者会违反 PodDisruptionBudget',
  [REASONS.PREEMPTION_LOOP]: '抢占链形成循环：系统状态在有限轮次内重复，无法收敛到稳定状态',
};

function fingerprint(bindings, pending) {
  return JSON.stringify({
    bound: [...bindings.entries()].sort(),
    pending: pending.map((pod) => pod.name).sort(),
  });
}

export function simulate(scenario) {
  const settings = {
    allowEqualPriorityPreemption: false,
    maxRounds: 200,
    ...(scenario.settings ?? {}),
  };
  const nodes = scenario.nodes ?? [];
  const nodesByName = new Map(nodes.map((node) => [node.name, node]));
  const podsByName = new Map();
  const stableOrder = new Map();
  let index = 0;
  for (const pod of [...(scenario.pods ?? []), ...(scenario.queue ?? [])]) {
    if (podsByName.has(pod.name)) {
      throw new Error(`重复的 Pod 名称: ${pod.name}`);
    }
    podsByName.set(pod.name, pod);
    stableOrder.set(pod.name, index);
    index += 1;
  }
  const pdbs = scenario.pdbs ?? [];

  const bindings = new Map();
  for (const pod of scenario.pods ?? []) {
    if (pod.node) bindings.set(pod.name, pod.node);
  }

  const ctx = { nodes, nodesByName, podsByName, pdbs, settings, bindings };

  let pending = [...(scenario.queue ?? [])];
  const sortPending = () => {
    pending.sort(
      (a, b) => b.priority - a.priority || stableOrder.get(a.name) - stableOrder.get(b.name),
    );
  };
  sortPending();

  const evictions = [];
  const events = [];
  const unschedulable = new Map();
  const seenStates = new Set();
  let rounds = 0;
  let loopDetected = false;

  const boundList = (excluding = new Set()) => {
    const list = [];
    for (const [name, nodeName] of bindings) {
      if (excluding.has(name)) continue;
      list.push({ pod: podsByName.get(name), node: nodeName });
    }
    return list;
  };

  const hardConstraintsPass = (pod, node, victims) => {
    const bound = boundList(new Set(victims.map((victim) => victim.name)));
    return (
      passesPodAntiAffinity(pod, node, bound, nodesByName) &&
      passesExistingAntiAffinity(pod, node, bound, nodesByName) &&
      passesPodAffinity(pod, node, bound, nodesByName) &&
      passesTopologySpread(pod, node, bound, nodes, nodesByName)
    );
  };

  const evaluateNode = (pod, node) => {
    if (!passesNodeAffinity(pod, node)) return { ok: false, code: 'NODE_AFFINITY' };
    const free = remainingCapacity(node, bindings, podsByName);
    if (covers(free, pod.requests)) {
      if (hardConstraintsPass(pod, node, [])) {
        return {
          ok: true,
          victims: [],
          cost: 0,
          skew: topologySkew(pod, node, boundList(), nodes, nodesByName),
        };
      }
      return { ok: false, code: 'POD_CONSTRAINTS' };
    }
    if (!covers(node.capacity, pod.requests)) return { ok: false, code: 'TOO_BIG' };
    const selection = selectVictims(pod, node, ctx);
    if (!selection) {
      const withoutPdb = pdbs.length
        ? selectVictims(pod, node, { ...ctx, pdbs: [] })
        : null;
      if (withoutPdb) return { ok: false, code: 'PDB' };
      const boundHere = [...bindings.entries()]
        .filter(([, nodeName]) => nodeName === node.name)
        .map(([name]) => podsByName.get(name));
      if (boundHere.some((victim) => victim.critical)) {
        return { ok: false, code: 'PROTECTED' };
      }
      return { ok: false, code: 'NO_VICTIMS' };
    }
    if (!hardConstraintsPass(pod, node, selection.victims)) {
      return { ok: false, code: 'POD_CONSTRAINTS' };
    }
    return {
      ok: true,
      victims: selection.victims,
      cost: selection.cost,
      skew: topologySkew(
        pod,
        node,
        boundList(new Set(selection.victims.map((victim) => victim.name))),
        nodes,
        nodesByName,
      ),
    };
  };

  const choosePlan = (pod) => {
    const diagnostics = [];
    const candidates = [];
    nodes.forEach((node, nodeIndex) => {
      const result = evaluateNode(pod, node);
      if (result.ok) {
        candidates.push({ node, nodeIndex, ...result });
      } else {
        diagnostics.push({ node: node.name, code: result.code });
      }
    });
    candidates.sort(
      (a, b) =>
        a.cost - b.cost ||
        a.victims.length - b.victims.length ||
        a.skew - b.skew ||
        a.nodeIndex - b.nodeIndex,
    );
    return { plan: candidates[0] ?? null, diagnostics };
  };

  const analyze = (pod, diagnostics) => {
    let code;
    if (diagnostics.length > 0 && diagnostics.every((d) => d.code === 'TOO_BIG')) {
      code = REASONS.INSUFFICIENT_RESOURCES;
    } else if (diagnostics.some((d) => d.code === 'PDB')) {
      code = REASONS.PDB_BLOCKED;
    } else if (diagnostics.some((d) => d.code === 'NO_VICTIMS' || d.code === 'TOO_BIG')) {
      code = REASONS.INSUFFICIENT_RESOURCES;
    } else {
      code = REASONS.CONSTRAINT_CONFLICT;
    }
    return { pod: pod.name, code, message: REASON_MESSAGES[code], details: diagnostics };
  };

  while (pending.length > 0) {
    rounds += 1;
    if (rounds > settings.maxRounds) {
      loopDetected = true;
      break;
    }
    const state = fingerprint(bindings, pending);
    if (seenStates.has(state)) {
      loopDetected = true;
      break;
    }
    seenStates.add(state);

    let progress = false;
    for (const pod of [...pending]) {
      const { plan, diagnostics } = choosePlan(pod);
      if (plan) {
        for (const victim of plan.victims) {
          bindings.delete(victim.name);
          evictions.push({
            pod: victim.name,
            node: plan.node.name,
            by: pod.name,
            cost: evictionCost(victim),
          });
          events.push({ type: 'evict', pod: victim.name, node: plan.node.name, by: pod.name });
          pending.push(victim);
          unschedulable.delete(victim.name);
        }
        bindings.set(pod.name, plan.node.name);
        events.push({
          type: 'bind',
          pod: pod.name,
          node: plan.node.name,
          preempted: plan.victims.map((victim) => victim.name),
        });
        pending = pending.filter((entry) => entry.name !== pod.name);
        progress = true;
      } else {
        unschedulable.set(pod.name, analyze(pod, diagnostics));
        events.push({ type: 'fail', pod: pod.name });
      }
    }
    sortPending();
    if (!progress) break;
  }

  if (loopDetected) {
    for (const pod of pending) {
      unschedulable.set(pod.name, {
        pod: pod.name,
        code: REASONS.PREEMPTION_LOOP,
        message: REASON_MESSAGES[REASONS.PREEMPTION_LOOP],
        details: [],
      });
    }
  }

  return {
    ok: pending.length === 0,
    converged: !loopDetected,
    bindings: Object.fromEntries(bindings),
    evictions,
    events,
    unschedulable: [...unschedulable.values()],
    rounds,
  };
}
