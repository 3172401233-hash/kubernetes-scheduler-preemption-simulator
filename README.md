# kubernetes-scheduler-preemption-simulator

调度抢占模拟器：模拟调度队列、拓扑约束和抢占链的级联影响。

**这是一个纯本地的调度策略模拟器**：所有计算都在内存中的场景模型上完成，
不连接、不调用 Kubernetes API Server，也不会对真实集群产生任何影响。
它用于在变更优先级、PDB 或拓扑策略之前，离线评估抢占行为的后果。

## 运行环境

- Node.js 24.16.0（兼容任何提供稳定 `node:test` 的 Node >= 22）
- 无第三方依赖

```bash
node --test
```

## 快速开始

```js
import { simulate } from './src/simulator.js';

const result = simulate({
  nodes: [
    { name: 'n1', capacity: { cpu: 2 }, labels: { zone: 'zone-a' } },
    { name: 'n2', capacity: { cpu: 2 }, labels: { zone: 'zone-b' } },
  ],
  pods: [
    { name: 'mid', node: 'n1', priority: 5, requests: { cpu: 2 }, evictionCost: 3 },
  ],
  pdbs: [{ name: 'web-pdb', selector: { app: 'web' }, minAvailable: 1 }],
  queue: [
    { name: 'high', priority: 10, requests: { cpu: 2 },
      nodeAffinity: { matchLabels: { zone: 'zone-a' } } },
  ],
});

console.log(result.bindings);      // { mid: 'n2', high: 'n1' }
console.log(result.evictions);     // [{ pod: 'mid', node: 'n1', by: 'high', cost: 3 }]
console.log(result.unschedulable); // []
```

## 输入模型

| 字段 | 说明 |
| --- | --- |
| `nodes[]` | `name`、`capacity`（任意数值资源，如 `cpu`/`memory`）、`labels`（拓扑域标签） |
| `pods[]` | 已有绑定的 Pod：`node` 指定所在节点，其余字段同队列 Pod |
| `queue[]` | 待调度队列，按 `priority` 降序处理，同优先级保持输入顺序（稳定排序） |
| `pdbs[]` | `selector` + `minAvailable` 或 `maxUnavailable` |
| `settings.allowEqualPriorityPreemption` | 默认 `false`，只允许抢占严格更低优先级的 Pod |
| `settings.maxRounds` | 调度轮次上限（默认 200），防止异常配置下不收敛 |

Pod 字段：

- `priority`：优先级，高优先级可抢占低优先级
- `requests`：资源请求（数值映射）
- `evictionCost`：被驱逐的代价（默认 1），用于计算最小牺牲集合
- `critical`：`true` 时永远不会被选为抢占受害者
- `nodeAffinity.matchLabels`：节点硬亲和
- `podAffinity` / `podAntiAffinity`：`[{ topologyKey, selector }]`，按拓扑域评估
- `topologySpread`：`{ topologyKey, maxSkew, selector }`，防止同一拓扑域内过度集中

## 模拟过程

1. 按优先级稳定排序处理调度队列，为每个 Pod 评估所有候选节点。
2. 节点放得下且满足全部硬约束时直接绑定（成本 0，优先于任何驱逐方案）。
3. 放不下时枚举该节点上符合条件的受害者子集（非 `critical`、优先级足够低、
   驱逐后不违反 PDB），选择**最小牺牲集合**：先比总驱逐成本，再比受害者数量，
   再比名称字典序。
4. 多个候选节点方案成本相同时，依次按受害者数量、拓扑偏移度（skew）、
   输入节点顺序做稳定排序，结果完全确定。
5. 被驱逐的 Pod 重新进入调度队列，在后续轮次中重新模拟其调度——
   可能进一步抢占更低优先级的 Pod，形成连锁抢占，直到系统稳定
   （一轮内没有任何放置）或确认不可行。
6. 每轮对全局状态（绑定 + 待调度集合）做指纹去重，状态重复即判定为
   **抢占循环**，立即终止并报告，而不是无限振荡。

## 输出

```js
{
  ok,            // 所有 Pod 都已绑定
  converged,     // 是否收敛（false 表示检测到抢占循环）
  bindings,      // { podName: nodeName }
  evictions,     // [{ pod, node, by, cost }]
  events,        // bind / evict / fail 事件流
  unschedulable, // [{ pod, code, message, details }]
  rounds,        // 实际调度轮次
}
```

失败原因码（`code`）：

| code | 含义 |
| --- | --- |
| `INSUFFICIENT_RESOURCES` | 缺资源：驱逐所有可抢占 Pod 后仍放不下 |
| `CONSTRAINT_CONFLICT` | 约束冲突：亲和/反亲和、拓扑分布或关键 Pod 保护 |
| `PDB_BLOCKED` | PDB 冲突：任何可行的驱逐组合都会违反 PodDisruptionBudget |
| `PREEMPTION_LOOP` | 抢占链形成循环：系统状态重复，无法收敛 |

`details` 中保留每个节点的逐项诊断（如 `TOO_BIG`、`NODE_AFFINITY`、`PDB`、
`PROTECTED`、`NO_VICTIMS`），便于定位具体瓶颈。

## 设计说明与限制

- 受害者选择只针对资源缺口，不会为了解除反亲和而驱逐 Pod（与 Kubernetes 一致）。
- 严格优先级模式下抢占关系构成有向无环图，模拟必然终止；
  循环检测是防御性保障，并在 `allowEqualPriorityPreemption` 开启时真正生效。
- 单节点受害者枚举上限为 16 个候选（子集枚举），超出时退化为按成本贪心选择。
- PDB 在驱逐发生时评估，被驱逐尚未重排的 Pod 计入不可用副本。
