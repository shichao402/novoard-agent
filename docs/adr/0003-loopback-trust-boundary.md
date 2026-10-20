# ADR-0003: 回环即信任边界，写端点靠同源校验

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：ADR 重新整理时补记。代码里有完整的 `sameOrigin` / `validateUiConfig`，文档此前只写了结论没写取舍

## Context

本机服务承载两类端点：给控制台用的读接口（磁贴、日志、会话）与写接口（触发、改配置、改 target）。

本机服务天然暴露给本机所有进程与页面。浏览器里任何一个网页都能向 `127.0.0.1:41783` 发起请求，因此必须解决两件事：跨站请求伪造与 DNS rebinding。

同时存在一个合法例外：桌面壳的 WebView 页面来源不是 `http://127.0.0.1:port`，Windows 是 `http(s)://tauri.localhost`，macOS/Linux 是 `tauri://localhost` 或 `ipc://localhost`。只比对 hostname 会把 macOS 的壳页面误判成跨站。

## Decision

默认只监听回环，回环即信任边界，读端点不做鉴权。

写端点统一做同源校验：`Host` 必须是回环地址；带 `Origin` 时要求与 `Host` 同源，或来自桌面壳 scheme 且 `Host` 已是回环。

监听地址配成非回环时，必须同时配置至少 16 字符的独立 `uiToken`，否则拒绝启动；此时启用登录页，`/login` 与 `/api/ui/login` 是仅有的免鉴权端点。

`uiToken` 与 Hub 的 `agentToken` 相互独立，不共用。

## Consequences

- 收益：本机日常使用不需要额外鉴权头，控制台可以直接调 API，实现简单。
- 收益：非回环是一个显式的、需要凭据的动作，不会被误开。
- 代价：本机任何进程、任何以回环来源运行的页面都能调写接口。对个人办公机这是可接受的，对多用户机器不是。
- 代价：同源校验的实现有分支（回环、壳 scheme、allowRemote），改监听策略时必须同步改这里，容易漏。
- 代价：非回环形态是明文 HTTP，公网使用必须自带 TLS 反代，这一点只能靠文档约束。
- 被否决的方案一：所有端点都要求 token。控制台、SSE、EventSource 都要带凭据，实现复杂度显著上升，收益有限。
- 被否决的方案二：只校验 `Origin` 不看 `Host`。非浏览器客户端可以不带 `Origin`，起不到防护作用；DNS rebinding 场景下 `Host` 才是判据。
- 被否决的方案三：绑定 unix socket 代替端口。三端跨平台成本高，Windows 支持不完整。
