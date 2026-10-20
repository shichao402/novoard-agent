# Architecture Decision Records

一条 ADR 回答一个"为什么这样做而不是那样做"，正文自包含：脱离对话上下文也能读懂。

本仓 ADR 从 0001 独立编号，不与 Hub 仓连续；跨仓引用一律带 `Hub` 前缀（见 [ADR-0001](0001-docs-layout-and-numbering.md)）。契约 SSOT 在 Hub，本仓只持锁定拷贝（见 [ADR-0004](0004-contract-copy-boundary.md)）。

## 索引

### 载体与边界

| 编号 | 标题 | 状态 | 日期 |
| --- | --- | --- | --- |
| [0001](0001-docs-layout-and-numbering.md) | 本仓 ADR 独立编号，跨仓引用必须限定来源 | Accepted | 2026-10-20 |
| [0002](0002-single-process-carrier.md) | 单进程载体，agent 自带 HTTP 服务，桌面壳只监管 | Accepted | 2026-10-20 |
| [0003](0003-loopback-trust-boundary.md) | 回环即信任边界，写端点靠同源校验 | Accepted | 2026-10-20 |
| [0004](0004-contract-copy-boundary.md) | 契约 SSOT 在 Hub，本仓只持锁定拷贝 | Accepted | 2026-10-20 |
| [0016](0016-desktop-shell-over-pwa-tiles.md) | 桌面载体由 PWA 磁贴转向 Tauri 壳 | Accepted | 2026-10-20 |

### 执行

| 编号 | 标题 | 状态 | 日期 |
| --- | --- | --- | --- |
| [0012](0012-validate-before-persist.md) | 定义即校验，不合法不上盘 | Accepted | 2026-10-20 |
| [0013](0013-hot-reload-scope.md) | 热替换只影响新触发，在途任务沿用旧定义 | Accepted | 2026-10-20 |
| [0009](0009-launch-failure-must-be-terminal.md) | launch 失败必须当场变成终态并通知 | Accepted | 2026-10-20 |
| [0008](0008-step-level-progress.md) | 进度以 step 为单位，开始与结束各发一次 | Accepted | 2026-10-20 |

### 状态与通道

| 编号 | 标题 | 状态 | 日期 |
| --- | --- | --- | --- |
| [0005](0005-single-task-state-enum.md) | 任务状态只有一套枚举，展示层只做翻译 | Accepted | 2026-10-20 |
| [0006](0006-accept-then-push.md) | 受理即回执，进度与终态靠推送 | Accepted | 2026-10-20 |
| [0007](0007-progress-channel.md) | 进度通道复用既有 SSE 与上行帧，不新增契约字段 | Accepted | 2026-10-20 |
| [0011](0011-task-table-in-memory.md) | 任务表只在内存，重启即清 | Accepted | 2026-10-20 |

### 对外与可观测

| 编号 | 标题 | 状态 | 日期 |
| --- | --- | --- | --- |
| [0010](0010-peer-context-per-session.md) | 对等回执按会话绑定，不用模块单例 | Accepted | 2026-10-20 |
| [0015](0015-capability-derived-from-targets.md) | 能力清单从定义派生，不手工维护 | Accepted | 2026-10-20 |
| [0014](0014-logs-and-audit-layers.md) | 审计与运行日志分开，各自可对账 | Accepted | 2026-10-20 |

## 约定

- 编号四位数递增，从 [TEMPLATE.md](TEMPLATE.md) 起草；一篇只回答一个取舍。
- 状态：Proposed → Accepted →（被取代时）Superseded。被取代不删除，正文标注接替者。
- `讨论来源` 写明日期与主题，便于回溯原始语境。
- 被否决的方案必须写，且要写清否决理由，否则 ADR 会退化成"当时就是这么定的"。
- 涉及实现细节的 ADR 必须在正文里给出文件名与函数名，便于核对是否与代码一致。
