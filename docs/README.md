# novoard-agent 文档

- 版本：v1.1
- 日期：2026-10-20
- 状态：ADR 重新整理（0001–0015，本仓独立编号）；架构与 PRD 已按代码核对更新

本仓是执行侧载体，契约 SSOT 在 Hub 仓。本目录记录 agent 侧的架构决策、能力需求与运维经验；A2A 帧、字段语义、错误码的定义不在本仓裁决，见 [ADR-0004](adr/0004-contract-copy-boundary.md)。

## 目录

```text
docs/
├── README.md          本文件，索引
├── adr/               架构决策记录（0001–0015）
├── architecture/      进程模型、执行状态、本地接口面、会话与对等
├── prd/               按能力域拆分的产品需求
├── research/          外部参照
├── guides/            排障与发布
├── roadmap/           里程碑
└── archive/           归档
```

## 从哪读起

想理解这次"点击后看不见状态"的改造：

1. [ADR-0006](adr/0006-accept-then-push.md)：为什么是回执加推送，而不是等到终态。
2. [ADR-0005](adr/0005-single-task-state-enum.md)：为什么点了就显示失败，以及七态模型怎么用。
3. [ADR-0008](adr/0008-step-level-progress.md)：为什么进度会提前一格。
4. [architecture/execution-state.md](architecture/execution-state.md)：状态机、进度字段、三条链路时序与缺口。
5. [prd/prd-1-console-and-tiles.md](prd/prd-1-console-and-tiles.md)：磁贴状态区的具体要求与验收。
6. [prd/prd-4-local-a2a-and-peer.md](prd/prd-4-local-a2a-and-peer.md)：对等方怎么拿到进度。

## ADR 索引

### 载体与边界

| 编号 | 标题 |
| --- | --- |
| [0001](adr/0001-docs-layout-and-numbering.md) | 本仓 ADR 独立编号，跨仓引用必须限定来源 |
| [0002](adr/0002-single-process-carrier.md) | 单进程载体，桌面壳只监管 |
| [0003](adr/0003-loopback-trust-boundary.md) | 回环即信任边界，写端点靠同源校验 |
| [0004](adr/0004-contract-copy-boundary.md) | 契约 SSOT 在 Hub，本仓只持锁定拷贝 |

### 执行

| 编号 | 标题 |
| --- | --- |
| [0012](adr/0012-validate-before-persist.md) | 定义即校验，不合法不上盘 |
| [0013](adr/0013-hot-reload-scope.md) | 热替换只影响新触发 |
| [0009](adr/0009-launch-failure-must-be-terminal.md) | launch 失败必须当场变成终态 |
| [0008](adr/0008-step-level-progress.md) | 进度以 step 为单位，开始与结束各发一次 |

### 状态与通道

| 编号 | 标题 |
| --- | --- |
| [0005](adr/0005-single-task-state-enum.md) | 任务状态只有一套枚举 |
| [0006](adr/0006-accept-then-push.md) | 受理即回执，进度与终态靠推送 |
| [0007](adr/0007-progress-channel.md) | 进度通道复用既有 SSE 与上行帧 |
| [0011](adr/0011-task-table-in-memory.md) | 任务表只在内存，重启即清 |

### 对外与可观测

| 编号 | 标题 |
| --- | --- |
| [0010](adr/0010-peer-context-per-session.md) | 对等回执按会话绑定 |
| [0015](adr/0015-capability-derived-from-targets.md) | 能力清单从定义派生 |
| [0014](adr/0014-logs-and-audit-layers.md) | 审计与运行日志分开 |

## 架构

| 文件 | 内容 |
| --- | --- |
| [overview.md](architecture/overview.md) | 进程模型、固定端口、监听边界、出站方向、数据目录 |
| [execution-state.md](architecture/execution-state.md) | 七态机、产出点、进度字段、三链路时序、四处终态集合 |
| [local-api.md](architecture/local-api.md) | 全部本机 HTTP 端点与关键返回形状 |
| [session-and-peer.md](architecture/session-and-peer.md) | 会话状态、对等消息、三种触发的关系 |

## PRD

| 编号 | 能力域 |
| --- | --- |
| [PRD-1](prd/prd-1-console-and-tiles.md) | 本机控制台与磁贴执行 |
| [PRD-2](prd/prd-2-targets-and-editor.md) | Target 定义与编辑器 |
| [PRD-3](prd/prd-3-local-session.md) | 本地会话 |
| [PRD-4](prd/prd-4-local-a2a-and-peer.md) | 本地 A2A 与对等 |
| [PRD-5](prd/prd-5-hub-delegation.md) | Hub 委派 |
| [PRD-6](prd/prd-6-distribution-and-shell.md) | 分发与桌面壳 |

## 其他

| 文件 | 内容 |
| --- | --- |
| [research/0001](research/0001-progress-reporting-references.md) | CI 与工作流引擎的进度呈现参照 |
| [guides/tile-status-debug.md](guides/tile-status-debug.md) | 磁贴状态排障 |
| [roadmap/roadmap.md](roadmap/roadmap.md) | 里程碑与改造阶段 |

## 代码核对发现的缺陷清单

文档重新整理时逐条对照代码，以下是确认的问题，都已在对应文档写明位置与改法。

| 位置 | 缺陷 | 详见 |
| --- | --- | --- |
| `desktop/src/pages/actions-page.tsx` 状态映射 | 非 `working` 且非终态落到"失败"，`submitted` 必然误报 | ADR-0005、PRD-1 F1 |
| `desktop/src/pages/actions-page.tsx` 的 `pending` | 由 HTTP 返回驱动，与任务是否结束无关 | PRD-1 F2 |
| `desktop/src/pages/actions-page.tsx` 的 `last.state` | 直接输出英文枚举 | PRD-1 F1 |
| `src/local-a2a.mjs` 的 `trigger` | `launch` 失败时改状态但不 `emit`，也不调 `triggerHook` | ADR-0009、PRD-1 F5 |
| `src/local-a2a.mjs` 的 `tasks/cancel` | 不判断是否已是终态，会把 `completed` 改成 `canceled` | local-api、PRD-1 F6 |
| `src/local-a2a.mjs` 的 `/api/tiles` | `expose !== "none"` 是恒真判断，schema 里没有 `none` | ADR-0015 |
| `src/tunnel-client.mjs` 委派分支 | `runner.launch` 返回值被丢弃，并发满时任务停在已受理 | ADR-0009、PRD-5 |
| `src/tunnel-client.mjs` 的 `TERMINAL_OK` | 缺 `rejected`，该状态永远上不去 Hub | ADR-0005、PRD-5 |
| `src/tunnel-client.mjs` 的 `message/resume` | 恢复成功时不上行 `working` | PRD-5 |
| `src/peer-talk.mjs` 的 `watchRun` | 依赖 `caller` 单例，为空时静默失败；并发时串会话 | ADR-0010、PRD-4 P5 |
| `src/peer-talk.mjs` 的 `report` | 硬编码 `state: "completed"`，失败也报完成 | PRD-4 P3 |
| `src/peer-talk.mjs` 的 `reportRun` | 只在终态回一句，中途零帧 | PRD-4 P2 |
| `src/runner.mjs` 的 `onProgress` | 在 `await runStep` 之后触发，语义是"已完成 i 步" | ADR-0008 |
| `src/card.mjs` / `peer-talk.mjs` | 能力过滤两处写法不同（`=== "a2a"` vs `!== "local"`） | ADR-0015 |
| `src/` 内多处注释 | 裸写 `ADR-0003/0004/0008` 指 Hub，与本仓编号冲突 | ADR-0001 |

## 约定

- 正文中文；代码标识符、字段名、路径保持原文。
- ADR 一条只回答一个取舍，被否决的方案必须写。
- 文档描述"怎么消费契约"，不描述"字段应该是什么"。
- 涉及实现的结论必须能在代码里找到对应（给出文件名与函数名）。
- 跨仓引用带 `Hub` 前缀，本仓引用写 `本仓` 或不加前缀。
