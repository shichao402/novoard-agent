# 本机接口面

全部端点在同一 HTTP 服务上，默认 `127.0.0.1`，端口由 edition 固定（release 41783 / dev 52641）。

## 任务与磁贴

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/tiles` | 磁贴数据：targets + 各 target 最近一次执行 + 最近 20 个任务 |
| `GET` | `/api/stream/:taskId` | SSE 订阅单任务；先写快照帧，终态后关流 |
| `GET` | `/api/shortcuts/:id/runs` | 该 target 的运行记录列表（含 `retentionDays: 30`） |
| `GET` | `/api/shortcuts/:id/runs/:taskId` | 单次运行的输出行 |

`/api/tiles` 的真实返回：

```json
{
  "tiles": [
    {
      "id": "plan",
      "title": "做个计划",
      "requiresApproval": false,
      "concurrency": 1,
      "timeout": "10m",
      "icon": "▶",
      "last": { "state": "working", "message": "第 2/3 步", "at": "2026-10-20T08:12:50.324Z", "log": "plan/task-local-xxx.jsonl" }
    }
  ],
  "tasks": []
}
```

过滤条件是 `t.expose !== "none"`，但 schema 里 `expose` 只有 `a2a` 与 `local` 两个值，`none` 不存在，所以这个 filter 恒为真。见 [ADR-0015](../adr/0015-capability-derived-from-targets.md)。

`last` 是扁平形状，与 SSE 帧的嵌套 `status` 不同，界面要写两套渲染。改造目标是让两者同构，见 [ADR-0007](../adr/0007-progress-channel.md)。

## SSE 帧

```json
{ "kind": "status-update", "taskId": "task-local-xxx", "status": { "state": "working", "message": "第 2/3 步" }, "final": false }
```

三种行为：

- 任务已终态：写一帧带 `final: true`，立即 `res.end()`。
- 任务非终态：先写一帧快照（`final: false`），再注册监听。
- 任务不存在：仍然注册监听，不报错。所以订阅一个不存在的 taskId 会一直挂着直到客户端断开。

第三种行为容易踩：客户端如果先订阅再触发，会因为 taskId 尚不存在而"连上了但没帧"。当前实现不存在这个问题，因为触发总在订阅之前。

## A2A

`POST /a2a` 承接 JSON-RPC。写端点，走 `sameOrigin`。

| 方法 | 行为 |
| --- | --- |
| `message/send` | 触发执行。`parts` 里的 text 是 target id，`data` part 合并进 vars；`metadata.forPeer` 时额外调 `peer.watchRun` |
| `tasks/get` | 查快照，返回 `{ id, status, kind, history }` |
| `tasks/cancel` | 取消：调 `runtime.cancel`，置 `canceled`，`emit`，返回快照 |
| `tasks/approve` / `message/resume` | 审批恢复：调 `runtime.resume`，置 `working`，`emit` |

`message/send` 的返回：

```json
{
  "jsonrpc": "2.0",
  "id": "agent-1712345678",
  "result": {
    "id": "task-local-m1x2y3-a4b5c6",
    "status": { "state": "submitted", "message": "" },
    "contextId": "",
    "kind": "task",
    "history": []
  }
}
```

注意 `status.state` 是 `submitted`，`message` 是空串。任何把 `message` 当兜底文案的地方在这里都会显示空白或错误，这正是 [ADR-0005](../adr/0005-single-task-state-enum.md) 要解决的问题。

`tasks/get` 对未知 id 返回 `-32001 task not found`。`tasks/cancel` 找不到任务时也返回 `-32001`。

target 不存在时 `message/send` 返回 `-32002 unknown target: x`，不建任务。

一个细节：`tasks/cancel` 不管任务当前是什么状态都会置 `canceled`。对一个已经是 `completed` 的任务调取消，状态会被改成 `canceled` 并广播。这是当前实现的缺陷，取消前应判断是否已是终态。

## 编辑器

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/targets` | 盘上定义：YAML 原文 + 解析后 targets + 平台提示 |
| `PUT` | `/api/targets` | 校验 → 模板预检 → 备份 → 原子写 → 重装载 → 热替换 |

`PUT` 成功返回 `{ ok: true, count }`。失败返回 `422` 与 `errors` 数组。装配层收到 `onTargetsSaved` 后同步刷新五处：`runtime`、`localA2A`、`cardRef`、`peer`、`tunnel`，并 `sendCardUpdate`。

在途任务不受影响，原因见 [ADR-0013](../adr/0013-hot-reload-scope.md)。

## 会话

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/sessions` | 会话列表，合并本机会话与对等会话 |
| `POST` | `/api/sessions` | 新建会话，返回 201 |
| `GET` | `/api/sessions/:id` | 历史消息 |
| `DELETE` | `/api/sessions/:id` | 删除 |
| `POST` | `/api/sessions/:id/messages` | 发消息，SSE 流式返回 |
| `POST` | `/api/sessions/:id/interrupt` | 中断 |
| `POST` | `/api/sessions/:id/answer` | 回答提问 |
| `GET` | `/api/sessions/events` | 对等会话事件流 |

`POST messages` 会 `req.setTimeout(0)` 与 `res.setTimeout(0)`，因为模型回复可能远超默认超时。这说明长连接在这个服务里是常态。

`answer` 的失败码有区分：`result.ok` 为假时，`result.gone` 为真返回 `409`，否则 `400`。

会话能力未装配时（`chat` 为 null），读接口返回 `503 会话能力未装配`；但 `GET /api/sessions/:id` 对存在本地的对等会话仍然可用（`peer.has(sessionId)` 分支）。

## 对等

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/peer/report` | 向调用方报告结果 |
| `POST` | `/api/peer/ask` | 向其他成员发话 |
| `POST` | `/api/peer/request` | 请求补充信息，置 `input-required` |
| `POST` | `/api/peer/presence` | 告知主人是否在场 |
| `POST` | `/api/peer/notify` | 通知本机用户 |

## 运行时与配置

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/runtime` | `{ ok, phase, agentId, uiRemote, hubConnected, hubRegistered }` |
| `GET` / `PUT` | `/api/settings` | 连接配置。`PUT` 返回 `restartRequired: true` |
| `POST` | `/api/setup/test` | 连接测试 |
| `GET` / `PUT` | `/api/codebuddy` | 模型配置 |
| `GET` | `/api/agent/doctor` | 会话能力自检 |
| `GET` / `PUT` | `/api/profile` | 自我介绍；保存后重算 card 并上报 |
| `GET` | `/api/activity` | 审计事件，`limit` 默认 40 |
| `GET` | `/api/logs` | 主日志分页，参数 `page/level/q/pageSize` |

`/api/runtime` 的 `agentId` 取自 `card?.name`，不是配置里的 `agentId`。两者在正常情况一致，若 card 未装配则为 null。

## 登录

仅在 `uiHost` 非回环时存在：

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| `GET` | `/login` | 免鉴权，返回登录页 |
| `POST` | `/api/ui/login` | 免鉴权，校验 token 后种 cookie |

其他所有端点在非回环模式下要求已登录的 cookie，未登录时 `access.rejectUnauthorized` 拦截。

## 静态资源

`serveConsole(uiRoot, req, res, url)` 兜底，托管 `desktop/` 的构建产物。找不到文件才返回 `404 {"error":"not found"}`。

## 安全边界

写端点逐个调用 `sameOrigin`，共 18 处。读端点不做同源校验，靠回环监听与可选 `uiToken` 保护。规则细节见 [ADR-0003](../adr/0003-loopback-trust-boundary.md)。
