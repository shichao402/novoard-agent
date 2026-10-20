# PRD-4 本地 A2A 与对等

## 背景

其他 agent 可以直接找本机干活，不经过 Hub 的业务语义。两个场景：对等 agent 用自然语言问与做，Hub 用委派下发确定任务。

对等与委派的区别在于有没有 `taskId` 信封与 `metadata.lane`。对等是会话式，可能来回几轮；委派是一次性任务，有明确终态。

## 用户故事

**US1 对方能问我能做什么。** 对等 agent 发来"你能做什么"，本机按自我介绍与 target 列表作答，不需要模型在线。

**US2 对方能派活。** 对等 agent 要求执行某个 target，本机受理并回报结果。

**US3 对方能看见进展。** 执行期间对方能知道当前第几步、跑了多久。

**US4 对方能取消。** 对方可以取消正在执行的任务。

**US5 缺信息能追问。** 本机缺关键信息时置 `input-required` 并向对方要。

**US6 知道主人在不在。** 对方可询问主人是否在电脑前。

## 现状

US1、US2、US5、US6 已实现。US3 缺口最大，US4 服务端可用但对端无约定。

### 对等触发链路

`POST /a2a` 收到 `message/send` 且 `metadata.forPeer` 为真时：

```js
const r = trigger({ skillId, vars });
if (rpc.params?.message?.metadata?.forPeer && r.task?.id) peer?.watchRun(r.task.id, skillId);
```

`watchRun` 只做一件事：

```js
function watchRun(taskId, skillId) {
  if (!caller || !taskId) return;
  watched.set(taskId, skillId);
}
```

终态时 `main.mjs` 的 `triggerHook` 调 `reportRun`：

```js
function reportRun(taskId, state, skillId) {
  const known = watched.get(taskId);
  if (!known) return { ok: false, reason: "not-watched" };
  watched.delete(taskId);
  return report(`Target ${name} 已结束，状态 ${state}`);
}
```

所以对等方能收到的全部信息就是最后这一句。中途零帧。

### 三个已确认的缺陷

**缺陷一：`watchRun` 依赖 `caller` 单例。** `caller` 在每次 `receive` 与 `note` 时被覆盖。`watchRun` 调用时若 `caller` 为空（或已被别的会话覆盖），登记失败或登记到错误的会话上。终态时 `watched.get` 返回 undefined，`reportRun` 返回 `not-watched`，结果静默丢失。对端永远收不到终态。

**缺陷二：`report` 硬编码 `completed`。**

```js
function report(input) {
  ...
  return sendBack(`完成报告：${body}`, "completed", parts);
}
```

即使任务实际失败，报告的状态也是 `completed`。

**缺陷三：进度完全不推。** 运行期 `onProgress` 只更新 `local-a2a` 的本地任务表，不触达 `peer-talk`。

## 本次增量

### P1 受理回执要够用

要求：回执返回 `taskId`、当前 status、agent 标识。调用方凭 `taskId` 后续可查、可订阅、可取消。

现状已满足。改造中不得破坏：回执必须在任务入表之后返回。

### P2 运行中要推进度

要求：按 [ADR-0007](../adr/0007-progress-channel.md) 的节流规则上行 `working` 帧，携带步骤序号与总数。步骤切换必发，同状态内最多每秒一帧，终态必发。

实现形态：把 `watchRun` 改为订阅。`peer-talk` 提供 `onProgress(taskId, progress)` 入口，由 `local-a2a` 的进度回调触发。这样本地页面与远端对等方共享同一份进度广播，不需要两套逻辑。

注意：对等触发走的是 `local-a2a` 的 `trigger`，不是 `tunnel-client` 的委派路径。所以进度要从 `trigger` 的 `onProgress` 分出来一支给 `peer`，而不是复用委派那条上行。

验收：对等方触发三步任务，依次收到"开始第 1 步"、"第 1 步完成"、"开始第 2 步"，最后收到终态。

### P3 终态必须送达

要求：无论成功、失败、取消、拒绝，对等方都要收到一次终态。

现状问题：`reportRun` 只在 `watched` 命中时发；`process` 只回一句且状态硬编码 `completed`。

改造：`watchRun` 不再依赖 `caller` 存活，把 `{ from, taskId, contextId }` 一起记下来；`report` 接受显式 state 参数。

### P4 取消要有对端约定

要求：对等方取消时用 `tasks/cancel`，语义与本地一致。取消后状态 `canceled`，并推一次终态帧。

现状 `tasks/cancel` 已实现且会 `emit`，缺的是对等路径上的约定与文档。

一个服务端缺陷要先修：`tasks/cancel` 不判断是否已是终态，对已完成任务取消会把状态改成 `canceled`。

### P5 caller 从单例改为按会话索引

要求：`caller` 由单一变量改为 `Map<sessionId, caller>`，`watchRun` 绑定到具体会话。

这是 P2、P3 的前置。不做这一步，多对等方并发时进度与结果都可能串。见 [ADR-0010](../adr/0010-peer-context-per-session.md)。

## 边界

- 不新增契约字段。`metadata.progressUrl` 的结论见 [ADR-0007](../adr/0007-progress-channel.md)：不做。
- 不改 A2A 帧形状，进度复用 `statusNotification` 的同构消息。
- 不做对等方的主动轮询接口约定，想查就调 `tasks/get`。

## 依赖

- 进度粒度：[ADR-0008](../adr/0008-step-level-progress.md)
- 通道与节流：[ADR-0007](../adr/0007-progress-channel.md)
- 会话上下文：[ADR-0010](../adr/0010-peer-context-per-session.md)
- 契约边界：[ADR-0004](../adr/0004-contract-copy-boundary.md)
