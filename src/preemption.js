import { addInto, covers, matchLabels, remainingCapacity } from './resources.js';

export const MAX_ENUMERATED_VICTIMS = 16;

export function isVictimEligible(victim, pod, settings) {
  if (victim.critical) return false;
  if (victim.priority < pod.priority) return true;
  return Boolean(settings.allowEqualPriorityPreemption) && victim.priority === pod.priority;
}

export function evictionCost(pod) {
  return pod.evictionCost ?? 1;
}

export function pdbAllows(evictNames, pdbs, podsByName, bindings) {
  for (const pdb of pdbs) {
    const matching = [...podsByName.values()].filter((pod) =>
      matchLabels(pdb.selector, pod.labels),
    );
    if (matching.length === 0) continue;
    const healthy = matching.filter(
      (pod) => bindings.has(pod.name) && !evictNames.has(pod.name),
    ).length;
    if (pdb.minAvailable != null && healthy < pdb.minAvailable) return false;
    if (pdb.maxUnavailable != null && matching.length - healthy > pdb.maxUnavailable) {
      return false;
    }
  }
  return true;
}

function deficitCovered(free, victims, requests) {
  const total = { ...free };
  for (const victim of victims) addInto(total, victim.requests);
  return covers(total, requests);
}

function compareKey(a, b) {
  if (a.cost !== b.cost) return a.cost - b.cost;
  if (a.names.length !== b.names.length) return a.names.length - b.names.length;
  const an = a.names.join('');
  const bn = b.names.join('');
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function selectVictims(pod, node, ctx) {
  const { bindings, podsByName, pdbs, settings } = ctx;
  const free = remainingCapacity(node, bindings, podsByName);
  if (covers(free, pod.requests)) return { victims: [], cost: 0 };

  const boundHere = [...bindings.entries()]
    .filter(([, nodeName]) => nodeName === node.name)
    .map(([name]) => podsByName.get(name));
  const eligible = boundHere
    .filter((victim) => isVictimEligible(victim, pod, settings))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (eligible.length === 0) return null;

  let best = null;
  const consider = (subset) => {
    if (!deficitCovered(free, subset, pod.requests)) return;
    const names = subset.map((victim) => victim.name).sort();
    if (!pdbAllows(new Set(names), pdbs, podsByName, bindings)) return;
    const cost = subset.reduce((sum, victim) => sum + evictionCost(victim), 0);
    const candidate = { victims: subset, cost, names };
    if (!best || compareKey(candidate, best) < 0) best = candidate;
  };

  if (eligible.length <= MAX_ENUMERATED_VICTIMS) {
    const count = eligible.length;
    for (let mask = 1; mask < 1 << count; mask += 1) {
      const subset = [];
      for (let i = 0; i < count; i += 1) {
        if (mask & (1 << i)) subset.push(eligible[i]);
      }
      consider(subset);
    }
  } else {
    const sorted = [...eligible].sort(
      (a, b) =>
        evictionCost(a) - evictionCost(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const subset = [];
    for (const victim of sorted) {
      subset.push(victim);
      if (deficitCovered(free, subset, pod.requests)) break;
    }
    consider(subset);
  }

  return best ? { victims: best.victims, cost: best.cost } : null;
}
