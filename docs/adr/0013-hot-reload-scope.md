# ADR-0013: 热替换只影响新触发，在途任务沿用旧定义

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：ADR 重新整理时核对 `replaceTargets` 与 `resume`，明确热替换的生效范围

## Context

编辑器保存后要立刻生效，不重启。`main.mjs` 的 `onTargetsSaved` 做了五件事：

```js
runtime.replaceTargets(saved.expanded);
localA2A.refreshTargets(saved.expanded);
cardRef.current = saved.card;
peer?.replaceTargets(saved.expanded);
tunnel.replaceTargets?.(saved.expanded);
tunnel.replaceCard?.(saved.card);
tunnel.sendCardUpdate?.(saved.card);
```

问题在于"立刻生效"的边界在哪。一个正在运行的任务，它的 `steps` 用的是启动那一刻的数组。`replaceTargets` 只改 `currentTargets`，不影响已传进 `createRunner` 的 `steps`。

审批挂起的任务是另一种情况：`launch` 时把 `{ skillId, vars, steps, onTerminal, ... }` 整包存进 `running` 的 `pending`，`resume` 时原样取出继续执行。所以审批期间改定义，恢复后跑的还是旧定义。

## Decision

热替换的生效范围是"下一次 `launch`"。在途任务与审批挂起任务一律沿用启动那一刻的定义。

具体约定：

- `replaceTargets` 只更新查表，不改已交给 runner 的 `steps`。
- `requiresApproval` 的 `pending` 里保存的是 `steps` 快照，不是 `skillId` 的引用；`resume` 直接用快照。
- 通知 sidecar 外部（Hub card、对等方能力清单）的更新只影响"以后能触发什么"，不影响"已经在跑什么"。
- 删除一个正在运行的 target 不会中断它；它继续跑完，终态正常上报。

## Consequences

- 收益：审批语义自洽。审批的是"这份定义"，不会因为审批期间改定义而执行了没被批准的步骤。
- 收益：在途任务不会因为定义热替换而中途变形，排查问题时"跑的是哪版定义"是确定的。
- 代价：用户改了定义、看到磁贴刷新，会以为在跑的也变了。需要在编辑器上给一句提示。
- 代价：`pending` 保存整份 `steps`，审批挂起期间占内存；数量很少，可接受。
- 代价：删除 target 后，在途任务的终态上报里带的 `skillId` 已经不在注册表中，Hub 侧展示需要容错。
- 被否决的方案一：热替换中断在途任务。用户改一个字段会把正在跑的长任务杀掉，不可接受。
- 被否决的方案二：`pending` 里只存 `skillId`，`resume` 时重新查表。审批期间改定义会导致"批的是 A、跑的是 B"。
- 被否决的方案三：热替换时立刻重启 sidecar。会丢掉所有在途任务与内存态，代价远大于收益。
