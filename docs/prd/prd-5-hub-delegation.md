# PRD-5 Hub 委派

## 背景

Hub 把任务派给本机执行。本机在 NAT 后，没有公网地址，所以连接方向永远是本机连 Hub。

## 用户故事

**US1 上线就注册。** sidecar 启动后连 Hub 并注册，含 agentId、能力清单、版本。

**US2 断线能重连。** 网络抖动或 Hub 重启后自动重连，重连后重新注册。

**US3 收到任务就执行。** Hub 下发的 `message/send` 解析成 target 触发。

**US4 执行过程可观测。** 进度与轨迹持续上行。

**US5 终态必达。** 执行结束必须上报终态，失败也要报。

**US6 断线期间不丢任务。** 连接中断时 Hub 侧排队，重连后按序补发；本机对重复 taskId 幂等。

## 现状

US1 至 US4、US6 已实现。`tunnel-client.mjs` 处理注册、重连、委派接收、上行通知、未确认帧重放。

委派执行的进度上报是完整的：

```js
runner.launch({
  taskId: env.taskId,
  skillId,
  vars: { ...runCfg.vars, ...vars },
  steps: runCfg.expanded,
  onTerminal: (state, detail) => uplink(env.taskId, statusNotification(env.taskId, state, detail)),
  onTrace: (event) => uplink(event.taskId || env.taskId, runTraceNotification(...)),
  onProgress: (i, n, d) => uplink(env.taskId, statusNotification(env.taskId, "working", `step ${i}/${n}：${d}`)),
});
```

三路回调都接了上行。这条链路是三条触发链路里最完整的。

## US5 的缺口

`runner.launch` 的返回值被丢弃。它会在四种情况下返回 `{ ok: false, reason }`：

- `agent-stopping`：sidecar 正在停机。
- `unknown target: x`：`currentTargets` 里查不到（注意前一步已经查过一次，这里是防御性检查）。
- `并发已满（n/m）`：同 target 的在跑数达到 `concurrency`。
- `本机同时运行的快捷方式已达 N`：整机并发到顶（`concurrency` 默认 32）。

这四种情况下任务从未启动，`onTerminal` 不会被调用，Hub 视角里它停在"已受理"。

### 改动要求

```js
const launched = runner.launch({ ... });
if (!launched.ok) {
  uplink(env.taskId, statusNotification(env.taskId, "failed", `未能启动：${launched.reason}`));
  return;
}
```

注意 `ok: true` 有三种 `reason`：`working`（正常开始）、`input-required`（挂起等审批）、`duplicate-taskId`（已有执行在跑）。只有 `input-required` 时 `onTerminal` 会被立即调用一次；其余两种不要重复上报。

## 另一个缺口：resume 成功时不上行

```js
if (body?.method === "message/resume") {
  const r = runner.resume?.(env.taskId);
  if (!r?.ok) {
    uplink(env.taskId, statusNotification(env.taskId, "failed", `恢复失败：${r?.reason ?? "not-suspended"}`));
  }
  return;
}
```

成功时什么都不发。Hub 要等第一个 `onProgress` 才知道恢复了。若恢复后第一步耗时较长（或脚本无输出），Hub 会一直显示 `input-required`。

改动要求：成功时上行一次 `working`，消息带 `"approval-resumed"`。

## 与本地触发的重复上报

本地触发路径的 `triggerHook` 已经做了终态上行：

```js
triggerHook: (state, skillId, taskId) => {
  if (TERMINAL_STATES_SET.has(state)) tunnel.uplinkTerminal?.(taskId, state, `tile-trigger ${skillId}`);
  if (TERMINAL_STATES_SET.has(state)) peer.reportRun(taskId, state, skillId);
}
```

委派路径由 `tunnel-client.mjs` 自己上行。两条路径不会重复，因为委派任务不写本地任务表，`triggerHook` 不会被调到。

这个分工要写进文档，否则后续改 `triggerHook` 时容易把委派路径也纳进来，导致 Hub 收到重复终态。

## `TERMINAL_OK` 缺 rejected

```js
const TERMINAL_OK = new Set(["completed", "failed", "canceled"]);
```

`uplinkTerminal` 用它做门禁。本地任务表把 `rejected` 当终态，但这个集合不含它，所以一个被拒绝的任务永远上不去 Hub。

要求：把 `rejected` 补进去，或改用与 `local-a2a` 相同的共享集合。见 [ADR-0005](../adr/0005-single-task-state-enum.md)。

## 重放语义

断线期间 Hub 排队的任务在重连后补发。本机用 `running.has(taskId)` 去重：

```js
if (running.has(taskId)) return { ok: true, reason: "duplicate-taskId" };
```

返回 `ok: true` 是刻意的，避免 Hub 把重复投递当成失败。

已结束的任务不在 `running` 里，所以重放一个已完成的任务会重新执行。当前依赖 Hub 只重放"未确认"的帧；若 Hub 会重放全部历史，需要本机加已结束任务的幂等表。

重连时还会调 `reportAbandonedRuns`：扫描 `logs/runs/` 里未收尾的轨迹，对不在 `running` 里的任务补一条 `run/truncated` 并上行。这是"进程重启导致轨迹断在半途"的补偿。

## 上行帧的形状

`statusNotification` 构造：

```js
{
  jsonrpc: "2.0",
  method: "message/notification",
  params: { message: {
    messageId: `msg-${randomUUID().slice(0, 8)}`,
    role: "agent",
    parts: [],
    contextId: taskId,
    taskId,
    kind: "status-update",
    status: { state, message, timestamp }
  }}
}
```

`runTraceNotification` 形状类似，`kind` 是 `"run-trace"`，多一个 `trace` 字段。

未确认的帧存在 `pending` Map 里（持久化到 `stateDir`），收到 `ack` 才删除。重连后重放全部 `pending`，Hub 按 `msgId` 幂等。

## 边界

- 本机不主动连 Hub 拉任务，所有触达都在已建立的连接上。
- 不做跨重启的任务恢复。sidecar 重启后 Hub 应把未完成的任务重新下发。
- 不做多 Hub 连接，一个 sidecar 只连一个 Hub。
- 委派任务不写本地任务表，因此 `/api/tiles` 与 `/api/stream` 都看不到它们。

## 依赖

- 状态枚举统一：[ADR-0005](../adr/0005-single-task-state-enum.md)
- 启动失败处理：[ADR-0009](../adr/0009-launch-failure-must-be-terminal.md)
- 上行帧形状：Hub 仓契约 §4.3（本仓有锁定拷贝）
