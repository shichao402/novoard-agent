# ADR-0018: 更新安装等在途任务结束再重启

- 状态：Accepted
- 日期：2026-11-06
- 讨论来源：2026-11-06 讨论 A2A 客户端更新机制时核对 `updater.rs` 的 `apply()`，发现 relkit 接受更新后壳立即退出、停掉 sidecar，不看有没有任务在跑

## Context

[ADR-0017](0017-desktop-relkit-updates.md) 接入 relkit 后，安装路径是：

```rust
// desktop/src-tauri/src/updater.rs apply()
Some(apply_result::Kind::Accepted(accepted)) => {
    exit_now = accepted.requires_host_exit;
    ...
}
if exit_now { crate::begin_quit(app.clone(), supervisor); }
```

`begin_quit` 给 sidecar 发 `shutdown`，`agent-runtime.mjs` 的 `shutdown()` 会取消执行中的 runner、丢掉审批挂起的任务。[ADR-0011](0011-task-table-in-memory.md) 规定任务表只在内存里，所以：

- 执行中的任务被杀，重启后 hub 只能按 `run/truncated` 或 `lostTtl` 收尾；
- 审批挂起的任务（`running` 里 `state: "input-required"` 的条目）直接消失，hub 那边批了也没有执行者。

更新是用户点“安装并重启”触发的，但用户在设置页看不到本机有没有任务在跑。

## Decision

安装更新默认等到 sidecar 没有执行中、也没有审批挂起的任务时才进行；用户可以明确选择“立即安装”跳过等待。

具体约定：

- `agent-runtime.mjs` 新增 `activity()`，返回 `{ running, pendingApproval }`；`running` 表每次变化后经 `onActivity` 回调，计数不变时不回调。
- `sea-entry.mjs` 把回调转成宿主协议事件 `{"v":1,"type":"activity","running":1,"pendingApproval":0}`。
- 壳 `lib.rs` 的 `Supervisor` 记住最近一次计数；sidecar 退出时清零（进程没了就没有可保护的任务）。
- `updater.rs` 的 `apply(app, force)`：不空闲且非 `force` 时，置 `install_when_idle`、在 `UpdateView.waitingForTasks` 给出计数、保持 `downloaded` 阶段并返回；`on_activity()` 看到计数归零就自动接着装。
- 设置页等待期间把按钮换成“立即安装”，二次确认后以 `force: true` 调 `update_apply`。托盘“检查更新”菜单永远走非强制路径。
- 只等不拦：等待期间不拒绝新任务。持续有任务时安装会一直推迟，由用户决定是否立即安装。

## Consequences

- 收益：自动更新不再悄悄杀任务；审批挂起的任务不会因为升级凭空消失。
- 收益：协议只加一个事件，壳不新增查询通道，sidecar 重启或崩溃时计数天然归零。
- 代价：审批可能挂很久，期间更新会一直等。“立即安装”是给用户的出口。
- 代价：判空和退出之间有极短窗口，恰好进来的新任务会被 `shutdown` 取消。概率低，按普通中断处理。
- 代价：只统计快捷方式任务，不统计 CodeBuddy 对话轮次；对话中途升级会断开当前轮。
- 被否决的方案一：等待期间进入 draining，拒绝新任务。hub 只对离线成员排队，在线拒绝会让任务直接失败，比推迟升级代价大。
- 被否决的方案二：壳通过本机 HTTP 轮询 `/api/busy`。要额外处理端口、鉴权和轮询节奏，而宿主协议已经是壳与 sidecar 之间的专用通道。
- 被否决的方案三：把任务表持久化，升级后恢复。和 ADR-0011 冲突，为一个低频场景改动整个任务模型不划算。

## 核对

- `src/agent-runtime.mjs` 的 `activity()`、`notifyActivity()`
- `src/sea-entry.mjs` 的 `bootAgent()`（`onActivity`）
- `desktop/src-tauri/src/lib.rs` 的 `Supervisor::activity()`、`handle_host_line()` 的 `"activity"` 分支
- `desktop/src-tauri/src/updater.rs` 的 `apply()`、`on_activity()`、`waiting_text()`
- `desktop/src/components/update-section.tsx` 的 `applyNow()`
- 测试：`test/runtime-activity.test.mjs`、`updater.rs` 的 `waiting_text_only_when_tasks_in_flight`
