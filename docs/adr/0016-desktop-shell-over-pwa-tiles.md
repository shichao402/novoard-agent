# ADR-0016: 桌面载体由 PWA 磁贴转向 Tauri 壳

- 状态：Accepted
- 日期：2026-10-20
- 讨论来源：ADR 补录。Hub ADR-0008 于 2026-10-14 定的是"进程内 Web 面板 + PWA 磁贴 + Shortcuts.app 兜底，托盘不交付"，实际交付的却是 Tauri 壳加托盘（提交 `4edfd1d`，2026-10-15）。方案换了，但两仓都没有为新方案留痕，本仓 [ADR-0002](0002-single-process-carrier.md) 的讨论来源里也记着这件事。本 ADR 只补记这次转向，不改 ADR-0002 关于单进程与壳职责边界的结论。

## Context

Hub ADR-0008 做决策时，agent 只跑在 mac-home 一台机器上，形态是 M5 试点的本地磁贴面板。在那组约束下，浏览器 PWA 是合理的：零新增运行时、复用 hub Dashboard 的零构建技术、hub 离线时本地照常闭环。

随后两件事改变了约束：

1. M6 要把 agent 分发给 Windows 成员，M7 拆仓后目标形态是"装上就能用"，不要求用户先装 Node（[PRD-6](../prd/prd-6-distribution-and-shell.md) 方案一节）。
2. 三端一致成为明确目标：Windows、macOS 常驻托盘，Linux 无头，能力相同、接口相同（[ADR-0002](0002-single-process-carrier.md) Context 一节）。

PWA 磁贴在这两条约束下撑不住：

- PWA 的前提是浏览器常驻 tab。用户关掉浏览器，入口就消失，而托盘的诉求恰恰是"关窗不等于退出"。
- 开机自启、单实例互斥、托盘菜单、退出动作，这些系统集成能力浏览器给不了。
- 全局热键原先靠 macOS 的 Shortcuts.app 兜底。这个能力 Windows 没有对应物，三端一致无法成立。

代码现状也印证了这次转向已经落地：`desktop/src-tauri/src/lib.rs` 的 `run()` 注册了单实例插件，`build_tray()` 构建托盘图标与菜单，`initialize_autostart()` 处理登录启动，窗口关闭走 `WindowEvent::CloseRequested` 加 `api.prevent_close()` 收起而非退出。`desktop/src-tauri/tauri.conf.json` 里 `bundle.targets` 为 `all`，macOS 产出 `.app` 与 `.dmg`，Windows 产出 NSIS 安装包。

## Decision

桌面形态定为 Tauri 壳，磁贴并入壳内 WebView 托管的控制台，不再做独立 PWA 面板，也不依赖 Shortcuts.app 提供热键。壳仍然只做监管：启动并监管 sidecar、提供 WebView 窗口、托盘与单实例，业务逻辑一律留在 sidecar 内。这一条与 [ADR-0002](0002-single-process-carrier.md) 一致，本 ADR 只改外壳的选型与入口形态。

## Consequences

- 收益：托盘、开机自启、单实例、关窗不退出这些系统集成都由壳统一提供，三端行为一致；Windows 成员接入不再受 Shortcuts.app 缺失的阻碍；磁贴与对等触发共用同一常驻进程，入口成本不再依赖用户先开浏览器。
- 收益：Tauri 使用系统 WebView，不带 Chromium，安装包体积远小于 Electron。
- 代价：构建链引入 Rust 工具链与 cargo，CI 复杂度上升，`npm run desktop:check` 走的是 `cargo test`。
- 代价：各平台 WebView 行为存在差异，需要冒烟测试覆盖。
- 代价：当前 macOS 为 ad-hoc 签名、未公证，Windows 未做 Authenticode，首次运行需要用户在系统提示里手动确认。
- 被否决的替代方案一：坚持 PWA 磁贴加 Shortcuts.app 兜底。Windows 没有 Shortcuts.app 的对应能力，且入口依附浏览器 tab，无法满足关窗不退出与开机自启，与三端一致目标冲突。
- 被否决的替代方案二：Electron 壳。会带上整个 Chromium，体积翻几倍，且与 Hub ADR-0006 的零构建基线冲突。Hub ADR-0008 已否决过一次，此处维持否决。

## 核对

- 相关代码位置：`desktop/src-tauri/src/lib.rs` 的 `run()`、`build_tray()`、`initialize_autostart()`、`show_main_window()`；`desktop/src-tauri/tauri.conf.json` 的 `bundle.targets` 与 `bundle.macOS`。
- 若决策落地，需要同步改的文档：Hub `docs/architecture/overview.md` 的部署形态段、Hub `docs/adr/0008-desktop-shell-decision.md` 的接替标注、本仓 `docs/prd/prd-6-distribution-and-shell.md`。
