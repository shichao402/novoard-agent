# ADR-0021: 运行历史从运行记录派生，不另建存储

- 状态：Accepted
- 日期：2026-11-20
- 讨论来源：2026-11-20 控制台交互评审。快捷操作页底部的输出面板只能按文件名列出某个 target 的历次输出，看不到每次的成败、触发来源、耗时与停在哪一步；用户要求改成「Target 管理 → Target 详情 → 运行详情」的层级（见 [PRD-8](../prd/prd-8-target-console.md)）

## Context

控制台要回答四个问题：这个 target 最近跑得怎么样、某一次停在哪一步、现在谁在跑、谁占着并发。

现状有三份数据，各自缺一块：

- 内存任务表（`src/local-a2a.mjs` 的 `createLocalTasks()`）：只有本机触发的任务，重启即清（[ADR-0011](0011-task-table-in-memory.md)），Hub 委派与定时触发的任务都不在里面。
- 输出日志（`src/shortcut-log.mjs`，`logs/shortcuts/<target>/<taskId>.jsonl`）：给人读的文本，没有结构化的终态与步骤边界。`listShortcutRuns()` 只能给出文件名、大小与修改时间。
- 运行记录（`src/run-trace.mjs`，`logs/runs/<taskId>.jsonl`）：契约 §4.5 的结构化事件，四种触发来源都写，副作用前 fsync：

```json
{"seq":1,"type":"run/start","target":"…","trigger":"hub","timeout":"3h","ts":"…"}
{"seq":2,"type":"step/start","index":1,"command":"uses versionControl/svn-cleanup","ts":"…"}
{"seq":3,"type":"step/end","index":1,"exit":0,"ts":"…"}
{"seq":8,"type":"run/end","state":"completed","ts":"…"}
```

运行记录已经包含历史视图需要的全部字段：目标、触发来源、开始与结束时间、每步命令与退出码、终态。但它没有清理策略，会无限增长。

## Decision

运行历史与运行详情一律从运行记录派生，叠加 runtime 的在途快照得到实时状态；不新建任务历史存储，也不改契约里的事件字段。

具体约定：

- `src/run-trace.mjs` 新增 `summarizeRun()`、`listRuns()`、`readRun()`、`pruneRunTraces()`。摘要按文件 mtime 缓存，避免每次轮询重新解析。
- 运行记录保留 30 天，与输出日志的 `SHORTCUT_LOG_RETENTION_MS` 对齐；清理在打开新记录时顺带做，和 `createShortcutRun()` 的做法一致。
- 没有 `run/end` 且不在 runtime 在途表里的记录，摘要状态为 `interrupted`，展示为「中断」。这是展示层状态，不进入任务状态枚举（[ADR-0005](0005-single-task-state-enum.md)）。
- 失败原因不写进 `run/end`（契约字段不动），由「最后一个 `step/end` 的 index 与 exit」加输出日志里的 error 行给出。
- 在途状态（运行中、排队、等待审批、当前第几步、进度文字）只来自 `runtime.snapshot()`，不落盘。
- 输出日志每行新增本地字段 `step`（当前步序号），供运行详情按步折叠；旧日志没有该字段时按 `step/start` 时间切分。该字段只在本机文件里，不上行。
- `/api/tiles` 的 `last`：内存任务表没有时，回落到运行记录里该 target 最新一次的摘要。重启后磁贴不再一律显示「尚未运行」。

## Consequences

- 收益：Hub、定时、对等、本机四种来源的运行在同一张表里，重启后历史不丢。
- 收益：没有新的持久化格式，也没有内存与磁盘的一致性问题；ADR-0011 维持不变，只是它列出的「重启后无法回答上次怎么了」这条代价被消除。
- 收益：运行记录终于有清理策略。
- 代价：列表接口要读目录下全部记录文件。30 天、每天几十次的量级下，加 mtime 缓存后可以接受；量级上来后再考虑索引文件。
- 代价：失败原因只能精确到「第几步、退出码几」，人读的原因要进运行详情看日志。
- 被否决的方案一：任务表落盘（JSONL 或 SQLite）。ADR-0011 已否决，理由不变；而且它只覆盖本机触发，补不上 Hub 与定时的历史。
- 被否决的方案二：在 `run/end` 里加 `reason` 字段。运行记录会上行给 Hub，字段属于契约 SSOT，为一个展示需求改契约成本过高。
- 被否决的方案三：从输出日志的首尾行（「开始…」「结束 state=…」）解析状态。那是给人读的文本，格式随时可能改，ADR-0011 方案三已否决「把状态和输出混在一份文件」。

## 核对

- 相关代码位置：`src/run-trace.mjs` 的 `summarizeRun()`、`listRuns()`、`pruneRunTraces()`；`src/agent-runtime.mjs` 的 `snapshot()`；`src/local-a2a.mjs` 的 `/api/runs`、`/api/runs/:taskId`、`/api/runs/:taskId/cancel`；`src/shortcut-log.mjs` 的 `setStep()`
- 同步改的文档：`architecture/local-api.md`、`prd/prd-8-target-console.md`
