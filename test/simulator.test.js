import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REASONS, simulate } from '../src/simulator.js';

describe('单节点抢占', () => {
  it('高优先级 Pod 驱逐低优先级 Pod，受害者无法重排时被标记缺资源', () => {
    const result = simulate({
      nodes: [{ name: 'n1', capacity: { cpu: 2 }, labels: {} }],
      pods: [{ name: 'low', node: 'n1', priority: 1, requests: { cpu: 2 }, evictionCost: 7 }],
      queue: [{ name: 'high', priority: 10, requests: { cpu: 2 } }],
    });

    assert.equal(result.bindings.high, 'n1');
    assert.deepEqual(
      result.evictions.map((e) => [e.pod, e.by, e.cost]),
      [['low', 'high', 7]],
    );
    assert.equal(result.ok, false);
    const low = result.unschedulable.find((u) => u.pod === 'low');
    assert.equal(low.code, REASONS.INSUFFICIENT_RESOURCES);
  });

  it('节点容量天然不足时直接报告缺资源，不发生驱逐', () => {
    const result = simulate({
      nodes: [{ name: 'n1', capacity: { cpu: 2 }, labels: {} }],
      pods: [],
      queue: [{ name: 'huge', priority: 10, requests: { cpu: 8 } }],
    });

    assert.equal(result.evictions.length, 0);
    assert.equal(result.unschedulable[0].code, REASONS.INSUFFICIENT_RESOURCES);
  });
});

describe('跨拓扑迁移', () => {
  it('被驱逐的 Pod 重新调度到其他拓扑域，抢占链收敛', () => {
    const result = simulate({
      nodes: [
        { name: 'n1', capacity: { cpu: 2 }, labels: { zone: 'zone-a' } },
        { name: 'n2', capacity: { cpu: 2 }, labels: { zone: 'zone-b' } },
      ],
      pods: [
        {
          name: 'mid',
          node: 'n1',
          priority: 5,
          requests: { cpu: 2 },
          labels: { app: 'mid' },
        },
      ],
      queue: [
        {
          name: 'high',
          priority: 10,
          requests: { cpu: 2 },
          nodeAffinity: { matchLabels: { zone: 'zone-a' } },
        },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.bindings.high, 'n1');
    assert.equal(result.bindings.mid, 'n2');
    assert.deepEqual(
      result.evictions.map((e) => [e.pod, e.by]),
      [['mid', 'high']],
    );
  });
});

describe('PDB', () => {
  it('PDB 阻止抢占：驱逐会违反 minAvailable 时不发生驱逐', () => {
    const result = simulate({
      nodes: [{ name: 'n1', capacity: { cpu: 4 }, labels: {} }],
      pods: [
        { name: 'p1', node: 'n1', priority: 5, requests: { cpu: 2 }, labels: { app: 'web' } },
        { name: 'p2', node: 'n1', priority: 5, requests: { cpu: 2 }, labels: { app: 'web' } },
      ],
      pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, minAvailable: 2 }],
      queue: [{ name: 'high', priority: 10, requests: { cpu: 2 } }],
    });

    assert.equal(result.evictions.length, 0);
    assert.equal(result.bindings.high, undefined);
    const high = result.unschedulable.find((u) => u.pod === 'high');
    assert.equal(high.code, REASONS.PDB_BLOCKED);
  });

  it('PDB 余量充足时允许驱逐并重新调度受害者', () => {
    const result = simulate({
      nodes: [
        { name: 'n1', capacity: { cpu: 4 }, labels: { zone: 'zone-a' } },
        { name: 'n2', capacity: { cpu: 2 }, labels: { zone: 'zone-b' } },
      ],
      pods: [
        { name: 'p1', node: 'n1', priority: 5, requests: { cpu: 2 }, labels: { app: 'web' } },
        { name: 'p2', node: 'n1', priority: 5, requests: { cpu: 2 }, labels: { app: 'web' } },
      ],
      pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, minAvailable: 1 }],
      queue: [
        {
          name: 'high',
          priority: 10,
          requests: { cpu: 2 },
          nodeAffinity: { matchLabels: { zone: 'zone-a' } },
        },
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.bindings.high, 'n1');
    assert.equal(result.evictions.length, 1);
    const victim = result.evictions[0].pod;
    assert.equal(result.bindings[victim], 'n2');
  });
});

describe('连锁抢占', () => {
  it('抢占触发多级链式驱逐，直到系统稳定', () => {
    const result = simulate({
      nodes: [
        { name: 'n1', capacity: { cpu: 2 }, labels: {} },
        { name: 'n2', capacity: { cpu: 2 }, labels: {} },
      ],
      pods: [
        { name: 'b', node: 'n1', priority: 5, requests: { cpu: 2 } },
        { name: 'c', node: 'n2', priority: 1, requests: { cpu: 2 } },
      ],
      queue: [{ name: 'a', priority: 10, requests: { cpu: 2 } }],
    });

    assert.equal(result.bindings.a, 'n1');
    assert.equal(result.bindings.b, 'n2');
    assert.deepEqual(
      result.evictions.map((e) => [e.pod, e.by]),
      [
        ['b', 'a'],
        ['c', 'b'],
      ],
    );
    const c = result.unschedulable.find((u) => u.pod === 'c');
    assert.equal(c.code, REASONS.INSUFFICIENT_RESOURCES);
  });
});

describe('抢占循环', () => {
  const cyclicScenario = (settings) => ({
    settings,
    nodes: [
      { name: 'n1', capacity: { cpu: 1 }, labels: {} },
      { name: 'n2', capacity: { cpu: 1 }, labels: {} },
      { name: 'n3', capacity: { cpu: 1 }, labels: {} },
    ],
    pods: [
      { name: 'x', node: 'n1', priority: 5, requests: { cpu: 1 } },
      { name: 'y', node: 'n2', priority: 5, requests: { cpu: 1 } },
      { name: 'z', node: 'n3', priority: 5, requests: { cpu: 1 } },
    ],
    queue: [{ name: 'w', priority: 5, requests: { cpu: 1 } }],
  });

  it('允许同优先级抢占时检测到状态循环并报告 PREEMPTION_LOOP', () => {
    const result = simulate(cyclicScenario({ allowEqualPriorityPreemption: true }));

    assert.equal(result.converged, false);
    assert.ok(result.rounds <= 200);
    assert.ok(result.unschedulable.some((u) => u.code === REASONS.PREEMPTION_LOOP));
  });

  it('默认严格优先级下同优先级不可抢占，直接报告缺资源且不循环', () => {
    const result = simulate(cyclicScenario({}));

    assert.equal(result.converged, true);
    assert.equal(result.evictions.length, 0);
    assert.equal(result.unschedulable[0].code, REASONS.INSUFFICIENT_RESOURCES);
  });
});

describe('多候选节点', () => {
  it('成本不同时选择牺牲最小的节点', () => {
    const result = simulate({
      nodes: [
        { name: 'n1', capacity: { cpu: 1 }, labels: {} },
        { name: 'n2', capacity: { cpu: 1 }, labels: {} },
      ],
      pods: [
        { name: 'v1', node: 'n1', priority: 1, requests: { cpu: 1 }, evictionCost: 5 },
        { name: 'v2', node: 'n2', priority: 1, requests: { cpu: 1 }, evictionCost: 1 },
      ],
      queue: [{ name: 'high', priority: 10, requests: { cpu: 1 } }],
    });

    assert.equal(result.bindings.high, 'n2');
    assert.deepEqual(
      result.evictions.map((e) => e.pod),
      ['v2'],
    );
  });

  it('成本相同时使用稳定排序（按输入节点顺序）', () => {
    const result = simulate({
      nodes: [
        { name: 'n1', capacity: { cpu: 1 }, labels: {} },
        { name: 'n2', capacity: { cpu: 1 }, labels: {} },
      ],
      pods: [
        { name: 'v1', node: 'n1', priority: 1, requests: { cpu: 1 }, evictionCost: 3 },
        { name: 'v2', node: 'n2', priority: 1, requests: { cpu: 1 }, evictionCost: 3 },
      ],
      queue: [{ name: 'high', priority: 10, requests: { cpu: 1 } }],
    });

    assert.equal(result.bindings.high, 'n1');
    assert.deepEqual(
      result.evictions.map((e) => e.pod),
      ['v1'],
    );
    assert.equal(result.bindings.v2, 'n2');
  });

  it('无需抢占的空闲节点优先于任何驱逐方案', () => {
    const result = simulate({
      nodes: [
        { name: 'n1', capacity: { cpu: 1 }, labels: {} },
        { name: 'n2', capacity: { cpu: 2 }, labels: {} },
      ],
      pods: [{ name: 'v1', node: 'n1', priority: 1, requests: { cpu: 1 }, evictionCost: 0 }],
      queue: [{ name: 'high', priority: 10, requests: { cpu: 1 } }],
    });

    assert.equal(result.bindings.high, 'n2');
    assert.equal(result.evictions.length, 0);
  });
});

describe('拓扑与亲和约束', () => {
  it('topologySpread 阻止同一拓扑域内过度集中', () => {
    const result = simulate({
      nodes: [
        { name: 'n1', capacity: { cpu: 4 }, labels: { zone: 'zone-a' } },
        { name: 'n2', capacity: { cpu: 4 }, labels: { zone: 'zone-b' } },
      ],
      pods: [
        { name: 'w1', node: 'n1', priority: 5, requests: { cpu: 1 }, labels: { app: 'web' } },
      ],
      queue: [
        {
          name: 'w2',
          priority: 5,
          requests: { cpu: 1 },
          labels: { app: 'web' },
          topologySpread: { topologyKey: 'zone', maxSkew: 1, selector: { app: 'web' } },
        },
      ],
    });

    assert.equal(result.bindings.w2, 'n2');
  });

  it('podAntiAffinity 避开包含匹配 Pod 的拓扑域', () => {
    const result = simulate({
      nodes: [
        { name: 'n1', capacity: { cpu: 4 }, labels: { zone: 'zone-a' } },
        { name: 'n2', capacity: { cpu: 4 }, labels: { zone: 'zone-b' } },
      ],
      pods: [
        { name: 'db', node: 'n1', priority: 5, requests: { cpu: 1 }, labels: { app: 'db' } },
      ],
      queue: [
        {
          name: 'web',
          priority: 5,
          requests: { cpu: 1 },
          labels: { app: 'web' },
          podAntiAffinity: [{ topologyKey: 'zone', selector: { app: 'db' } }],
        },
      ],
    });

    assert.equal(result.bindings.web, 'n2');
  });

  it('约束全部冲突时报告 CONSTRAINT_CONFLICT', () => {
    const result = simulate({
      nodes: [{ name: 'n1', capacity: { cpu: 4 }, labels: { zone: 'zone-a' } }],
      pods: [
        { name: 'db', node: 'n1', priority: 5, requests: { cpu: 1 }, labels: { app: 'db' } },
      ],
      queue: [
        {
          name: 'web',
          priority: 5,
          requests: { cpu: 1 },
          podAntiAffinity: [{ topologyKey: 'zone', selector: { app: 'db' } }],
        },
      ],
    });

    assert.equal(result.unschedulable[0].code, REASONS.CONSTRAINT_CONFLICT);
  });
});

describe('关键 Pod 保护', () => {
  it('critical Pod 永远不会被选为抢占受害者', () => {
    const result = simulate({
      nodes: [{ name: 'n1', capacity: { cpu: 2 }, labels: {} }],
      pods: [{ name: 'crit', node: 'n1', priority: 1, requests: { cpu: 2 }, critical: true }],
      queue: [{ name: 'high', priority: 10, requests: { cpu: 2 } }],
    });

    assert.equal(result.evictions.length, 0);
    assert.equal(result.bindings.crit, 'n1');
    assert.equal(result.bindings.high, undefined);
    assert.equal(result.unschedulable[0].code, REASONS.CONSTRAINT_CONFLICT);
  });
});
