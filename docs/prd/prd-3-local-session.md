# PRD-3 本地会话

## 背景

用户可以在控制台直接与模型对话，让它读文件、改配置、执行 target。会话是自然语言入口，与磁贴的点击入口并列。

## 用户故事

**US1 开会话。** 新建会话，给个标题，开始聊。

**US2 看历史。** 会话列表持久化，重启后还在。

**US3 流式回复。** 模型输出逐块显示。

**US4 中断。** 回复不满意可以中断，已生成内容保留。

**US5 回答提问。** 模型需要补充信息时弹出提问，可回答或跳过。

**US6 会话里能干活。** 模型能调用 target 相关工具。

## 会话状态

| 状态 | 含义 | 界面 |
| --- | --- | --- |
| 空闲 | 可以发消息 | 输入框可用 |
| 生成中 | 模型正在输出 | 显示停止按钮 |
| 提问中 | 等待用户回答 | 显示提问卡片 |

中断只对"生成中"有效。提问中的会话要回答或跳过才能继续。

## 与任务状态的区别

会话的"提问中"和任务的 `input-required` 是两个东西：

- 会话提问：模型缺信息，问用户。回答后模型继续生成。
- 任务 `input-required`：target 标了 `requiresApproval`，等审批。恢复后子进程开始执行。

两者词义相近，实现完全独立。详见 [architecture/session-and-peer.md](../architecture/session-and-peer.md)。

## 存储

`session-store.mjs` 管理，`index.json` 是列表，`sessions/<id>.jsonl` 是记录。写入用 tmp + rename 保证原子。

对等会话也存这里，id 前缀 `peer-`。控制台的 `/api/sessions` 把本机会话与对等会话合并返回。

## 模型通道

`chat-bridge.mjs` 拉起 `chat-worker.mjs` 子进程，子进程持有 CodeBuddy 会话。`agent-home` 目录存放 CodeBuddy 自己的状态。

模型配置来自 `codebuddy.json`，通过 `/api/codebuddy` 读写，保存后 `chat.reload()` 重建。

`GET /api/agent/doctor` 做自检：CodeBuddy 是否可执行、配置是否完整、能否连通。模型调不通时先跑这个。

## 工具

模型可用工具定义在 `chat-worker.mjs`，实现在 `novoard-tools.mjs`，全部走本机 HTTP，执行只经 `/a2a`，不另开旁路。

| 工具 | 走的端点 |
| --- | --- |
| `novoard_status` | `/api/runtime` + `/api/tiles` |
| `novoard_list_targets` | `/api/targets` |
| `novoard_upsert_target` / `novoard_delete_target` | `/api/targets`（读改写） |
| `novoard_run_target` | `POST /a2a` |
| `novoard_report_result` | `/api/peer/report` |
| `novoard_request_detail` | `/api/peer/request` |
| `novoard_signal_presence` | `/api/peer/presence` |
| `novoard_ask_member` | `/api/peer/ask` |
| `novoard_notify_owner` | `/api/peer/notify` |
| `novoard_recent_activity` | `/api/activity` |
| `novoard_tail_logs` | `/api/logs` |

注意 `novoard_get_settings` 与 `novoard_save_settings` 也存在，分别走 `GET`/`PUT /api/settings`。

## 本次缺口

### P1 novoard_run_target 无法等待

现状：

```js
return JSON.stringify({ taskId: body.result?.id, status: body.result?.status, via: "a2a" });
```

`status` 是回执里的 `{ state: "submitted", message: "" }`。模型拿到的信息只有"已提交"。

后果：用户问"跑完了吗"，模型只能再发一次 `tasks/get`，而它没有 `tasks/get` 工具，只能调 `/api/tiles` 间接看。提示词里要求"完成后调用 `novoard_report_result`"，但模型并不知道什么时候算完成。

要求：`novoard_run_target` 增加 `wait` 参数。默认 `"ack"`（保持现有行为），可选 `"done"`（等到终态后返回）。

`"done"` 的实现不应该是轮询，而是订阅 SSE 或等 `triggerHook`。考虑到工具调用有超时上限，`"done"` 需要配套的 `timeoutMs`，超时后返回"仍在运行 + taskId"。

验收：模型调 `novoard_run_target({ id: "plan", wait: "done" })`，能拿到 `{ state: "completed" }` 而不是 `submitted`。

### P2 工具没有查询单任务的能力

现状：工具集里没有 `novoard_get_task`。

要求：新增一个，走 `GET /api/tasks/:taskId`。这是 P1 之外的独立能力，模型在用户追问时可以用。

## 边界

- 不支持多模型并行对话。一个会话一条模型通道。
- 不支持会话分叉，会话是线性的。
- 工具调用不设审批。模型可以在会话里直接执行 target，除非该 target 标了 `requiresApproval`，那时走确认框。
- 提示词里明确约束：不要改 Hub 配置，不要删除 target，除非本机用户在同一对话里明确同意。

## 依赖

- 会话与对等的关系：[architecture/session-and-peer.md](../architecture/session-and-peer.md)
- 回执语义：[ADR-0006](../adr/0006-accept-then-push.md)
