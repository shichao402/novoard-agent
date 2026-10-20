# ADR-0010: 对等回执按会话绑定，不用模块单例

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：ADR 重新整理时核对 `peer-talk.mjs`，发现 `caller` 是模块级单例，并发多对等方会串

## Context

`peer-talk.mjs` 用一个模块级变量记录"当前正在回复谁"：

```js
let caller = null;

async function receive({ from, taskId, contextId, text, parts }) {
  ...
  caller = { from: speaker, taskId, contextId: contextId || taskId };
  ...
  sendBack(reply.text, state, reply.parts);
}
```

`sendBack` 依赖这个单例：

```js
function sendBack(text, state, parts) {
  if (!caller?.taskId || !tunnel?.replyToCaller) return { ok: false, reason: "no-caller" };
  tunnel.replyToCaller({ taskId: caller.taskId, to: caller.from, ... });
}
```

`watchRun` 也依赖它：

```js
function watchRun(taskId, skillId) {
  if (!caller || !taskId) return;
  watched.set(taskId, skillId);
}
```

问题在于 `receive` 是异步的：`await answer(...)` 期间，另一个对等方的 `receive` 可以把 `caller` 覆盖掉。于是：

- 先到的请求回复会被发到后到者的 `taskId` 上。
- 先到的 `watchRun` 会把任务绑到后到者的会话上。
- `report` / `presence` 同样会发错人。

当前对等是低频人工对话，几乎不会并发，所以这个缺陷没有暴露。但本次改造要把进度推给对等方，`watchRun` 会成为常态路径；一旦两个 agent 同时派活，进度就会串到错误的对象上。

另外 `caller` 有 `taskId` 才能 `sendBack`，无 `taskId` 的对等消息（`note` 路径）会把 `caller` 置成没有 `taskId` 的值，进一步污染后续回复。

## Decision

取消 `caller` 单例，改为按会话索引：`Map<sessionId, { from, taskId, contextId }>`。

- `receive` 进入时按 `sessionIdFor(from)` 写入一条上下文，回复与回报都从这条上下文取 `from` / `taskId`。
- `watchRun(taskId, skillId, ctx)` 显式接收上下文，不再从模块变量读。
- `report` / `presence` 接收显式上下文，缺省回退到"最近一次 receive 的会话"以保持单人场景行为不变。
- `note` 只更新上下文，不覆盖其他会话。

同时规定：进度帧的收件人由 `taskId` 反查上下文，不从"当前 caller"推断。

## Consequences

- 收益：多个对等方并发时，回复、进度、结果不会串。
- 收益：`watchRun` 不再依赖调用时刻的模块状态，成为纯函数式登记，测试可直接构造。
- 代价：需要维护一个上下文 Map，并在会话删除时清理，否则长时间运行会积累。
- 代价：`report` 的调用方（`novoard_report_result` 工具）当前不带会话信息，需要补一个"从哪个会话来"的字段，或由 run 上下文推导。
- 代价：单人场景的代码路径变长了一点（先查 Map 再回退），但行为不变。
- 被否决的方案一：给 `caller` 加锁，串行处理 `receive`。会让对等对话变成排队，一个慢回复阻塞其他成员，体验更差。
- 被否决的方案二：把 `caller` 存在 `AsyncLocalStorage` 里。Node 支持，但当前代码是回调与 Promise 混用，上下文容易在 `await` 边界丢失，调试成本高。
- 被否决的方案三：不改，靠"对等是低频"这个假设。本次改造正是要把对等变成常态路径，假设不再成立。
