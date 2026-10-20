# ADR-0009: launch 失败必须当场变成终态并通知

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：ADR 重新整理时逐条核对 `launch` 的返回路径，发现两处静默失败

## Context

`agent-runtime.mjs` 的 `launch` 有三类成功与四类失败：

成功：

- `{ ok: true, reason: "working" }`：已开始执行，`onTerminal` 会在结束时调用。
- `{ ok: true, reason: "input-required" }`：挂起等审批，`onTerminal` 已被立即调用一次。
- `{ ok: true, reason: "duplicate-taskId" }`：同一 taskId 已在跑，不重复执行。

失败：

- `{ ok: false, reason: "agent-stopping" }`：正在停机。
- `{ ok: false, reason: "unknown target: x" }`：查不到定义。
- `{ ok: false, reason: "并发已满（1/1）" }`：同 target 并发到顶。
- `{ ok: false, reason: "本机同时运行的快捷方式已达 N" }`：整机并发到顶。

两处调用方都没有正确处理失败：

**本地触发**（`local-a2a.mjs` 的 `trigger`）：

```js
if (!r.ok) {
  task.state = "failed";
  task.status = { state: "failed", message: r.reason };
  audit?.(...);
}
```

状态改了，但没有 `emit(id)`。SSE 订阅者收不到任何帧，要等下一次 `/api/tiles` 轮询（4 秒）才更新。更糟的是 `triggerHook` 也没被调用，Hub 侧与对等方都收不到失败终态。

**委派**（`tunnel-client.mjs` 的 `handleDelegate`）：

```js
runner.launch({ taskId: env.taskId, skillId, ... });
```

返回值被丢弃。失败时任务从未启动，`onTerminal` 不会被调用，Hub 视角里任务永远停在"已受理"。

## Decision

`launch` 的返回值必须被检查。失败即终态，当场推送。

统一封装：`launch` 失败时，调用方必须做三件事——置任务状态为 `failed`、广播状态帧、调用终态钩子（本地走 `triggerHook`，委派走上行）。三件事缺一不可。

具体到两处：

- `local-a2a.mjs`：`!r.ok` 分支补 `emit(id)` 与 `triggerHook("failed", skillId, id)`。
- `tunnel-client.mjs`：检查返回值，`!ok` 时 `uplink(statusNotification(taskId, "failed", reason))` 并 `return`。

`duplicate-taskId` 不作为失败：它返回 `ok: true` 是刻意的，避免 Hub 把重复投递当失败。调用方需要按 `reason` 区分，不能只看 `ok`。

## Consequences

- 收益：并发拒绝、停机、未知 target 这三种情况都能立刻在界面上看到具体原因，而不是"看起来还在跑"。
- 收益：Hub 与对等方不会因为一次未启动而永久等待。
- 代价：`launch` 的返回契约变复杂（`ok` + `reason` 的四种组合），调用方必须按 `reason` 分支，只看 `ok` 会误判 `duplicate-taskId`。
- 代价：`requiresApproval` 的同步 `onTerminal("input-required")` 与"失败立即上报"这两条路径都在 `launch` 里触发，改动时要保证不重复上报终态（`input-required` 不是终态，见 ADR-0005）。
- 被否决的方案一：让 `launch` 内部统一处理失败上报。会让执行层知道"谁在订阅"，破坏职责分离；执行层不应关心本地 SSE 还是 Hub 上行。
- 被否决的方案二：失败时抛出异常，由调用方 try/catch。`launch` 是同步函数且失败是预期内的业务分支（并发满很常见），用异常表达会把常见路径变成异常路径。
- 被否决的方案三：把 `duplicate-taskId` 也算失败。会导致 Hub 重放时收到 failed，把幂等变成了错误。
