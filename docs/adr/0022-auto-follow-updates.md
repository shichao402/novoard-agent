# ADR-0022: 空闲时自动跟随 hub 推荐版本

- 状态：Accepted
- 日期：2026-11-20
- 讨论来源：发布 v0.3.14 后的讨论。原先 agent 每 6 小时查一次更新，下载和安装都要人点，hub 升级契约后旧 agent 会一直被 nack 拒在门外。用户拍板三点：接受空闲时全自动安装；由 hub 声明推荐版本；夜间只在 02:00 查一次。

## Context

ADR-0017 接入了 Relkit，ADR-0018 让安装等在途任务结束，但发起检查、下载、安装仍依赖用户点击，节奏也只有固定间隔。结果有两个：

- hub 发布新契约后，旧 agent 收到 `contract-major-mismatch` / `contract-schema-mismatch` nack，就停在“契约不兼容”，没有自愈路径。
- 多台机器的 agent 版本长期不一致，hub 侧无法表达“请升到哪个版本”。

ADR-0018 还留了一个缺口：空闲只看快捷方式任务，不看 CodeBuddy 对话轮次，自动安装时可能切断正在回复的对话。

## Decision

agent 桌面壳在空闲时自动跟随更新：按时间表检查，或者收到 hub 的提示时立即检查；有新版本就自动下载，等到没有任务、没有审批、也没有对话在回复时，自动安装并重启。hub 通过契约 v2.8 在 `agent.hello.ack` / `agent.hello.nack` 里给出可选字段 `recommendedAgentVersion`，作为提示信号。

### 节奏

- 白天 08:00 到 23:00（本机时间）每 5 分钟检查一次。
- 夜间只在 02:00 检查一次，然后等到 08:00。
- 实现见 `desktop/src-tauri/src/updater.rs` 的 `next_check_delay(now)`。规则是：若 `now + 5 分钟` 仍落在白天，就等 5 分钟；否则等到下一个 02:00 或 08:00。

### hub 提示

- hub 侧：`src/agent-release.mjs` 的 `RECOMMENDED_AGENT_VERSION`，可用环境变量 `NOVOARD_RECOMMENDED_AGENT_VERSION` 覆盖，非法值不下发。
- agent 侧：`src/tunnel-client.mjs` 读到 ack 中的 `recommendedAgentVersion` 时，上报 `{reason: "hub-recommended", recommendedVersion}`；收到两种 contract-*-mismatch nack 时，先上报提示，再走原有的致命路径。sidecar 通过宿主协议事件 `update-hint` 交给壳。
- 壳 `updater::on_hint()`：reason 以 `contract-` 开头，或当前版本落后于推荐版本（只比较 x.y.z）时，立即触发 `follow()`。

推荐版本只是“去检查”的信号。实际装哪个版本，仍以本渠道的 Relkit 发布计划为准，壳不会去装一个指定的旧版本。

### 跟随流程

`follow()` 在下载或安装进行中时直接跳过。没有已下载的更新时，先做一次 `check(force)`；发现新版本就下载，下载完成后调用 `apply(app, false)`。`apply` 沿用 ADR-0018 的空闲等待机制。

### 空闲定义扩展

`Activity { running, pendingApproval, chatTurns }` 三项都为 0 才算空闲。`chatTurns` 来自 `src/chat-bridge.mjs` 中在途 `send` 请求的计数，经 `onTurnsChange` 汇入宿主协议的 `activity` 事件。

### 开关

环境变量 `NOVOARD_AUTO_UPDATE=0` 关闭自动跟随：此时仍按时间表检查并提示，但不自动下载和安装。设置页的“软件更新”区会说明当前是否开启了自动更新。

## Consequences

- 收益：hub 升级契约后，旧 agent 在空闲时会自愈，不用人去逐台点。
- 收益：hub 改一个常量（或一个环境变量）就能让整个机群向某个版本收敛。
- 收益：对话轮次计入空闲判断，修复了 ADR-0018 的缺口。
- 代价：白天每 5 分钟访问一次 Relkit。请求很轻，且只在本机发生。
- 代价：自动重启不再征求用户同意。依靠空闲判断兜底；仍有极短的判空窗口，按 ADR-0018 处理。
- 代价：v0.3.14 及更早的 agent 没有这套逻辑，需要手动更新一次。
- 被否决的方案一：hub 直接下发安装命令。这会让 hub 持有安装权，越过 Relkit 的渠道和签名边界，也与契约只描述连接语义的定位不符。
- 被否决的方案二：固定间隔（比如全天每 5 分钟）。夜里没人用，频繁检查没有收益。挑一个固定时间点（02:00）既能在凌晨空闲时装好，又不干扰白天。
- 被否决的方案三：推荐版本用作强制目标版本（可降级）。Relkit 的计划才是版本的权威来源，用推荐版本去降级会和渠道发布冲突。

## 核对

- 壳：`desktop/src-tauri/src/updater.rs` 的 `start()`、`follow()`、`on_hint()`、`next_check_delay()`、`behind()`；`desktop/src-tauri/src/lib.rs` 的 `Activity`、`update-hint` 分支。
- sidecar：`src/tunnel-client.mjs` 的 `reportUpdateHint()`；`src/chat-bridge.mjs` 的 `turnsChanged()`；`src/main.mjs` 的 `reportActivity()`；`src/sea-entry.mjs`。
- 契约：hub `docs/architecture/contracts.md` v2.8，以及 `frame-agent-hello-ack.json` / `frame-agent-hello-nack.json`；本仓 `src/contract/` 中的拷贝。
- 前端：`desktop/src/components/update-section.tsx`、`desktop/src/lib/api.ts` 的 `UpdateView`。
