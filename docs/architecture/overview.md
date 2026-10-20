# 进程模型

## 组成

```text
桌面壳（Tauri，Windows/macOS）
  └── sidecar 进程（SEA 单文件，Node 运行时内嵌）
        ├── 本机 HTTP 服务（edition 固定端口）
        ├── 执行内核（runner + agent-runtime）
        ├── 隧道客户端（出站 WSS 到 Hub）
        ├── 会话能力（CodeBuddy 子进程）
        └── 数据目录（agent.json、agents/、.agent-state/、logs/）

Linux 无头形态
  └── 同一份 sidecar，不套壳；浏览器直接打开它的地址
```

两种形态跑同一份代码，区别只在启动路径与静态资源来源。这条载体决策见 [ADR-0002](../adr/0002-single-process-carrier.md)。

## 进程职责

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| 装配层 | `src/main.mjs` | 读配置、装配 sidecar、把各能力回调接起来 |
| 本机服务 | `src/local-a2a.mjs` | HTTP 路由、任务表、SSE、A2A JSON-RPC |
| 执行协调 | `src/agent-runtime.mjs` | 生命周期、并发与超时、审批挂起、run-trace |
| 执行内核 | `src/runner.mjs` | 逐步执行、变量插值、子进程、取消 |
| 隧道 | `src/tunnel-client.mjs` | 注册、委派接收、上行通知、未确认帧重放 |
| 对等 | `src/peer-talk.mjs` | 成员消息、会话存储、结果回报 |
| 会话 | `src/chat-bridge.mjs` + `chat-worker.mjs` | CodeBuddy 会话、流式事件、提问 |
| 控制台 | `desktop/` | React 界面，构建产物由 sidecar 托管 |
| 入口 | `src/sea-entry.mjs` | 数据目录锚定、宿主协议、向导与控制台启动 |

## 端口

端口按版本固定，定义在仓库根 `edition.json`，构建时写入 `src/edition.gen.mjs`：

| 版本 | 端口 |
| --- | --- |
| release | 41783 |
| dev | 52641 |

`config.mjs` 的 `pinEditionListenPort` 与 `pinPanelPort` 负责在没有显式配置时填上固定值。`scripts/edition.mjs` 在构建期校验端口必须在 10000–65535。

不随机分配的原因：桌面壳直接拼地址、SSH 转发命令、书签都需要可预期。代价是端口被占用时启动失败而不是换端口。见 [ADR-0002](../adr/0002-single-process-carrier.md)。

`agent.json` 里的 `localPort` 与环境变量 `NOVOARD_LOCAL_PORT` 可以覆盖；写 0 或省略时回落到固定端口。

## 监听与可达性

默认只监听 `127.0.0.1`。`uiHost` 配成非回环时，同一服务对机器网络或公网开放，此时要求至少 16 字符的独立 `uiToken`，否则 `validateUiConfig` 直接返回失败，agent 拒绝启动。

写端点的同源校验（`sameOrigin`）：`Host` 必须是回环地址；带 `Origin` 时要求与 `Host` 同源，或来自桌面壳 scheme（`tauri:` / `ipc:` 且 hostname 为回环）且 `Host` 已是回环。

桌面壳页面的来源分两类：Windows 的 WebView 是 `http(s)://tauri.localhost`，macOS/Linux 是自定义 scheme。只比对 hostname 会把 macOS 的壳页面误判成跨站，所以 `isDesktopShellOrigin` 单独按 scheme 识别。

这套规则解释了为什么控制台能直接调本机 API 而不需要额外鉴权头：回环加同源就是信任边界。见 [ADR-0003](../adr/0003-loopback-trust-boundary.md)。

## 出站连接

sidecar 主动连 Hub，Hub 不主动连 sidecar。所有远端触达都靠这条出站连接上的消息。

两个后果：

- 本机可以在 NAT 后工作，不需要公网可达。
- Hub 无法主动拉取本机状态。所以进度必须由本机推上去，这也是 [ADR-0007](../adr/0007-progress-channel.md) 选择上行帧而不是 `progressUrl` 的结构性原因。

## 宿主协议

桌面壳与 sidecar 之间的最小进程协议，仅在 `NOVOARD_HOST_PROTOCOL=ndjson` 时启用：

- stdout：一行一个 JSON 事件，`v / type / ts`，类型有 `ui-ready`、`stopping`、`stopped`、`fatal`、`protocol-error`。
- stdin：一行一个 JSON 命令。
- stdin 关闭视为宿主消失，sidecar 主动停机，避免孤儿进程。

宿主模式下普通日志只写文件，不碰 stdout，也不镜像 stderr。

## 数据目录

锚定 `NOVOARD_DATA_DIR`，未设置时用 `process.cwd()`（`sea-entry.mjs` 会 `chdir` 过去）。

| 路径 | 内容 |
| --- | --- |
| `agent.json` | 身份与连接配置（`agentId`、`hubUrl`、`agentToken`、`contractVersion`、可选 `localPort` / `uiHost` / `uiToken`） |
| `agents/<agentId>/targets.yaml` | target 定义；编辑器写这个文件 |
| `agents/<agentId>/targets.yaml.bak` | 单份滚动备份 |
| `agents/<agentId>/templates/` | 模板定义 |
| `.agent-state/audit.jsonl` | 审计，可与 Hub 对账 |
| `.agent-state/peers/` | 对等会话存储 |
| `.agent-state/sessions/` | 本机会话存储 |
| `logs/agent.jsonl` | 主日志，5MB 滚动保留 5 份 |
| `logs/shortcuts/<target>/<taskId>.jsonl` | 单次运行输出，保留 30 天 |
| `logs/runs/<taskId>.jsonl` | 结构化运行轨迹 |

四类落盘的分工见 [ADR-0014](../adr/0014-logs-and-audit-layers.md)。注意本仓此前文档写的 `state/` 目录并不存在，真实路径是 `logs/` 与 `.agent-state/`。

桌面安装版的数据目录是 `~/Library/Application Support/com.novoard.agent/`（macOS）与 `%APPDATA%/com.novoard.agent/`（Windows），由壳设置 `NOVOARD_DATA_DIR`。

## 停机

`agent-runtime.shutdown` 做三件事：拒绝新任务、清掉审批中的任务、取消运行中的子进程并等待回收。超时上限 4 秒，只是 sidecar 内部约定；桌面壳仍会在协议超时后做进程级强杀兜底。

`local-a2a.close` 显式调用 `server.closeAllConnections()`，避免 SSE 长连接拖住停机。
