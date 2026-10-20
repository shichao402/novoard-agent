# ADR-0014: 审计与运行日志分开，各自可对账

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：ADR 重新整理时核对 `main.mjs` 的 `localAudit`、`shortcut-log`、`run-trace`，把三类落盘的分工写清

## Context

本仓往磁盘写三类东西，形状与用途都不同：

1. 主日志 `logs/agent.jsonl`：`createFileLogger` 产出，JSON Lines，按 5MB 滚动保留 5 份，令牌脱敏。给人排障用。
2. 单次运行日志 `logs/shortcuts/<target>/<taskId>.jsonl`：`createShortcutRun` 产出，`appendFileSync`，30 天保留，`pruneShortcutLogs` 在每次创建时顺带清理。给用户看"这次跑了什么"。
3. 运行轨迹 `logs/runs/<taskId>.jsonl`：`openRunTrace` 产出，事件序列（`run/start`、`step/start`、`step/end`、`run/end`、`run/truncated`），带 `seq`。给 Hub 侧还原执行细节。

另有一份审计 `audit.jsonl`：`localAudit` 追加，字段是 `ts / actor / lane / target / taskId / outcome / detail`，与 Hub 侧契约 §6 的语义一致，用于两侧对账。

四份东西各有自己的消费方，混在一起会让任何一方都读不顺。

## Decision

四类落盘各司其职，不合并：

- `audit.jsonl` 只记"发生了什么决定"，字段固定，可与 Hub 对账。触发、终态、拒绝、定义变更各记一条。
- `logs/agent.jsonl` 只记"过程"，可自由加字段，滚动保留。
- `logs/shortcuts/<target>/<taskId>.jsonl` 只记"这次运行的可见输出"，stdout/stderr 原文，保留 30 天。
- `logs/runs/<taskId>.jsonl` 只记"结构化轨迹"，供机器读，事件类型受契约约束。

关键约束：

- 审计写入失败不阻断执行（`localAudit` 直接 `appendFileSync`，异常会冒泡到调用处，所以调用点都包在不会被中断的位置）。
- 运行日志写入失败不阻断执行：`createShortcutRun` 抛错时 `openRunLog` 捕获并返回 null，任务继续跑。
- 轨迹写入失败只 warn，`emitTrace` 里 `onTrace` 的异常也被吞掉，不挡住已落盘的记录。
- 三类日志都不得包含令牌原文。主日志有 `redact`，审计与运行日志靠"不写进去"这个约定。

## Consequences

- 收益：排障时按需取一份，不必在巨大文件里筛。
- 收益：审计可与 Hub 对账，这是跨端一致性的验证手段。
- 代价：同一件事要在多处写，例如一次执行会同时产生审计、主日志、运行日志、轨迹。磁盘 IO 变多。
- 代价：`audit.jsonl` 没有轮转，长期运行会一直涨。当前靠它的体量小（每次执行一两条）撑着。
- 代价：运行日志的 30 天清理是"下次创建时顺带清理"，长期不运行就不会清理。
- 被否决的方案一：全部合并进 `agent.jsonl`。文件会巨大，且结构化与非结构化混在一起，机器读不了。
- 被否决的方案二：只留轨迹，运行日志由轨迹重建。轨迹里没有 stdout 原文（只有 `exit` 与 `command`），重建不出来。
- 被否决的方案三：审计也走 `createFileLogger`。审计需要固定字段与可对账性，与自由格式的日志混在一起会失去这个性质。
