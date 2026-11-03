# ADR-0017: 桌面壳通过 Relkit 自动更新

- 状态：Accepted
- 日期：2026-11-03
- 讨论来源：用户要求“接入更新机制”，范围为全链路（CI 发布 + 托盘内检查、下载、安装、重启）。服务器 `https://publish.firoyang.com`；Release 档走 stable 渠道，Dev 档走 dev 渠道。取代 [PRD-6](../prd/prd-6-distribution-and-shell.md) 边界一节原有的“不做自动更新”。

## Context

PRD-6 首版的分发方式是“重新下载安装”。成员机器增多以后，每次修复都要逐台手动覆盖安装，版本漂移难以控制，也难以知道谁还停在旧版。

Relkit 已在其他宿主上落地，提供三样东西：服务器作为唯一事实源（版本、渠道、制品、签名），`relkit-updater` 作为唯一更新引擎（验签、比较版本、下载、原子替换、回滚记录），以及各语言的薄客户端（Rust 有 `sdk-rust`）。宿主只需声明产品、产出制品、内嵌 bootstrap，并在 UI 里调 open / check / download / apply。

## Decision

桌面壳（Windows NSIS、macOS .app）接入 Relkit，采用 IN_PLACE 安装：

- 宿主仓只放声明：`relkit.project.json`、`relkit.custody.json`、取工具脚本 `scripts/relkit_tool.py`、artifact producer `scripts/relkit_producer.mjs`。relkit 的版本、摘要、二进制、lock 一律不入库，构建时从服务器 `current` 取回并用根公钥验签（`scripts/stage-relkit.mjs`）。
- 渠道与档位一一对应：tag `v<semver>` 触发 stable（Release 档），手动触发 workflow 发 dev（Dev 档）。两档 identifier、端口、安装目录不同，可以并排安装，各自只收自己渠道的更新。
- 版本身份由 `scripts/relkit-version.mjs` 唯一计算：releaseCode 取 `git rev-list --count HEAD`；stable 为 `<semver>+<code>`，dev 为 `<base>-dev.<code>+<code>`。Tauri、Cargo、NSIS 继续只用纯 semver，code 与 bootstrap 由 `build.rs` 在编译期注入。
- 每个平台产出一对制品：installer（首次安装与手动兜底）与 payload（安装后的目录树，`payloadOf` 指向 installer）。Windows 的 install_root 是 exe 所在目录，macOS 是 `.app` 包。
- 壳内 `src-tauri/src/updater.rs` 是唯一调用引擎的地方：启动 60 秒后首检、此后每 6 小时检查一次；托盘“检查更新”与设置页“软件更新”区块共用同一状态，经 `update-status` 事件推送。安装时引擎要求宿主退出，壳走正常退出流程停掉 sidecar，由 worker 替换并重新拉起。
- 只有 CI 发布构建内嵌 bootstrap 与 releaseCode。本地构建、`desktop:*-deploy` 部署档不内嵌，更新功能自动停用并在设置页说明原因。
- 发布 token 只注入 publish job（GitHub secret `RELKIT_UPLOAD_TOKEN`），平台 job 只产出 ArtifactSet，不持 token。

## Consequences

- 收益：成员机器自动收敛到最新版；失败、回滚、需人工处理的状态在设置页可见；发版只需打 tag 或手动触发 workflow，宿主仓不随 relkit 升级改 CI。
- 代价：首次仍需手动安装一个带更新功能的版本；Windows payload 需要在 CI 里静默安装 NSIS 才能取到安装后目录树，producer 拒绝在非 CI 环境执行这一步。
- 前提：产品 `novoard-agent` 须先在服务器注册，并发布首个 Runtime Profile，否则 `bootstrap build` 返回 404，CI 无法产出。
- Linux 无头不在本 ADR 范围，仍靠重新下载 zip。
