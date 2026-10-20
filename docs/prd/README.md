# PRD 总览

本仓产品需求按能力域拆分，每份独立可读。共享术语与契约引用见 [docs/README.md](../README.md) 与 [ADR-0004](../adr/0004-contract-copy-boundary.md)。

## 拆分逻辑

agent 是"一份源码、多平台产物"的联邦成员，能力面分三层：本机交互、定义与执行、对外连接，再加一层分发形态，共六份。

| PRD | 能力域 | 核心用户价值 | 依赖 |
| --- | --- | --- | --- |
| [PRD-1](prd-1-console-and-tiles.md) 本机控制台与磁贴执行 | 手动触发的本机体验 | 点一下就执行，看得见进展 | 执行内核 |
| [PRD-2](prd-2-targets-and-editor.md) Target 定义与编辑器 | 定义、校验、热生效 | 改完即用，不重启不改代码 | 契约 target schema |
| [PRD-3](prd-3-local-session.md) 本地会话 | 本机 AI 助手 | 在同一窗口问与做 | CodeBuddy 配置 |
| [PRD-4](prd-4-local-a2a-and-peer.md) 本地 A2A 与对等 | 本机 A2A 端点、对等触发 | 让别的 agent 派活，看到进展 | 契约 A2A 语义 |
| [PRD-5](prd-5-hub-delegation.md) Hub 委派 | 注册、委派执行、重放 | 人不在也能远程触发 | Hub 契约 |
| [PRD-6](prd-6-distribution-and-shell.md) 分发与桌面壳 | SEA 打包、轻壳、向导 | 装上就能用 | 多平台 CI |

## 共享术语

- target：一次可触发的操作单元，定义在 `agents/<agentId>/targets.yaml`。
- 磁贴：target 在本机控制台的可视形态，点击即触发。
- sidecar：被桌面壳监管的 SEA 进程，提供本机 HTTP 与执行能力。
- 会话：本机 AI 对话单元，可发起提问并等待回答。
- 对等：两个 agent 之间的直接消息与任务通道，不经 Hub 的业务语义。
- 三种触发：控制台点击、Hub 委派、对等触发。前两者与第三者共用 `/a2a` 入口，差别在订阅者。
- 终态：`completed` / `failed` / `canceled` / `rejected`。注意 `input-required` 不在其中。

## 本次改造落点

状态可见化改造集中在 PRD-1 的 F 段、PRD-4 的 P 段、PRD-5 的 US5 与一处 resume 缺口。完整缺陷清单见 [docs/README.md](../README.md)。
