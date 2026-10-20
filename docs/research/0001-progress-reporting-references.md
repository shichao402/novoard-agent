# 进度呈现的做法参照

调研目的：为 [ADR-0007](../adr/0007-progress-channel.md) 的通道选择与 [ADR-0008](../adr/0008-step-level-progress.md) 的进度粒度提供外部参照。

## CI 系统的普遍做法

GitHub Actions、GitLab CI、Jenkins 都把"job 内的 step"作为进度单位，而不是逐行输出。用户看到的是步骤列表与每一步的状态，日志是第二层信息。

对本仓的启示：进度粒度的自然单位是 step，不是 stdout 行。这与 `runner.mjs` 已有的 `steps` 结构一致，不需要发明新的分组。本仓的 `onStepStart` / `onStepEnd` 正是这个粒度。

## 长任务的心跳问题

CI 系统处理"看起来卡住了"的办法是：即使没有新输出，也周期性更新已完成时长。GitLab 的 job 页面每秒递增计时器，这类计时器大多在前端本地推算，只在关键事件时与服务端对齐。

对本仓的启示：`elapsedMs` 应由服务端在每次状态帧里给出，前端在帧之间本地递增，收到新帧后校准。这样既能持续跳动，又不会因前端时钟漂移而失真。

但仅靠前端递推有一个盲区：进程挂了没人通知时，界面仍会一直加。所以还需要服务端心跳，即 [ADR-0008](../adr/0008-step-level-progress.md) 里"超过 15 秒无输出补一帧"那条。

## 节流

Prometheus 与多数指标系统对同类事件的建议是"状态变化立即发，同状态内合并"。Kubernetes 的 watch 机制也类似：对象变更推送，但不保证每条中间状态都送达，客户端靠 `resourceVersion` 与重新 list 补齐。

对本仓的启示：`working` 帧按秒节流，步骤切换不节流，终态必发；断线重连后靠快照接口补齐。这与 [ADR-0007](../adr/0007-progress-channel.md) 的规则一致。

## 终态可靠性

分布式任务的普遍共识是"终态必须有确认或可查询"。只靠推送不保证送达，必须有查询兜底。AWS Step Functions、Temporal 都同时提供事件流与状态查询。

对本仓的启示：`GET /api/tasks/:taskId` 不只是给页面刷新用的，它是对端进度与终态的兜底。这条接口的存在本身就是可靠性设计的一部分。

本仓更进一步：上行帧有 `msgId` 与 `ack`，未确认的帧持久化后重连重放。这比单纯"查询兜底"更强，代价是要维护 `pending` Map。

## 与本仓的差异

上述系统都是服务端多副本、事件经过消息队列。本仓是单机单进程，没有消息队列，也没有副本。因此：

- 不需要考虑顺序与去重的完整解法，只需处理 SSE 断线与重连。
- 不需要持久化每一条进度帧，只需要任务表在进程内存活（[ADR-0011](../adr/0011-task-table-in-memory.md)）。
- 可以接受"重启后状态丢失"，因为任务本身也随进程结束。

这个差异决定了本仓的方案可以比通用系统简单得多。[ADR-0007](../adr/0007-progress-channel.md) 选择复用 SSE 而不是引入流式协议，正是基于这一点。

## 来源

- [GitHub Actions 工作流语法](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
- [GitLab CI 流水线文档](https://docs.gitlab.com/ee/ci/pipelines/)
- [Kubernetes API 概念：watch](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- [Prometheus 指标类型与最佳实践](https://prometheus.io/docs/practices/instrumentation/)
- [AWS Step Functions 状态机](https://docs.aws.amazon.com/step-functions/latest/dg/welcome.html)
- [Temporal 工作流文档](https://docs.temporal.io/workflows)
