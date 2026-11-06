# ADR-0017: 桌面壳通过 Relkit 自动更新

- 状态：Accepted
- 日期：2026-11-03
- 讨论来源：用户要求“接入更新机制”，范围为全链路（CI 发布 + 托盘内检查、下载、安装、重启）。服务器 `https://publish.firoyang.com`；Release 档走 stable 渠道，Dev 档走 dev 渠道。取代 [PRD-6](../prd/prd-6-distribution-and-shell.md) 边界一节原有的“不做自动更新”。

## Context

PRD-6 首版的分发方式是“重新下载安装”。成员机器增多以后，每次修复都要逐台手动覆盖安装，版本漂移难以控制，也难以知道谁还停在旧版。

Relkit 已在其他宿主上落地，提供三样东西：服务器作为唯一事实源（版本、渠道、制品、签名），`relkit-updater` 作为唯一更新引擎（验签、比较版本、下载、原子替换、回滚记录），以及唯一的宿主契约 `relkit.updater.v2` proto。relkit 不再发布任何语言的 SDK（relkit ADR 0026）：宿主自己从 proto 生成类型，每次调用起一个引擎进程，stdin 写一个 ProtoJSON 请求，stdout 逐行读事件（protocol 5）。宿主只需声明产品、产出制品、内嵌 bootstrap，并在 UI 里调 check / download / apply / status。

## Decision

桌面壳（Windows NSIS、macOS .app）接入 Relkit，采用 IN_PLACE 安装：

- 宿主仓只放声明：`relkit.project.json`、`relkit.custody.json`、取工具脚本 `scripts/relkit_tool.py`、artifact producer `scripts/relkit_producer.mjs`。relkit 的版本、摘要、二进制、lock 一律不入库，构建时从服务器 `current` 取回并用根公钥验签（`scripts/stage-relkit.mjs`）。
- 渠道与档位一一对应：tag `v<semver>` 触发 stable（Release 档），手动触发 workflow 发 dev（Dev 档）。两档 identifier、端口、安装目录不同，可以并排安装，各自只收自己渠道的更新。
- 版本身份由 `scripts/relkit-version.mjs` 唯一计算：x.y.z 只取自根目录 `VERSION.json`（`novoard.version/1`），npm、Tauri、Cargo 清单是派生文件，由 `npm run version:sync` 写入并入库，`npm run version:check`（`npm test` 含）防漂移；stable tag 必须等于 `v<VERSION.json>`，CI 不再按 tag 改写清单。releaseCode 由 relkit 服务器分配（relkit ADR 0025）：release workflow 的 plan job 执行一次 `relkit release-code claim`，矩阵各平台共用该号；不再用 `git rev-list --count HEAD`。stable 为 `<x.y.z>+<code>`，dev 为 `<x.y.z>-dev.<code>+<code>`。Tauri、Cargo、NSIS 继续只用纯 semver，code 与 bootstrap 由 `build.rs` 在编译期注入。
- 引擎契约：`desktop/src-tauri/proto/updater/v2/updater.proto` 是 `relkit-updater proto` 的原样导出（`.gitattributes` 固定 LF），`build.rs` 用 prost-build + pbjson-build 生成严格 ProtoJSON 类型，`src/relkit_sidecar.rs` 是全部进程胶水。`scripts/stage-relkit.mjs` 取回验签引擎后再导出一次与副本逐字节比对，不一致即以 `updater proto drift` 失败。升级引擎契约 = 新引擎导出覆盖副本、适配宿主代码、跑测试、一起提交。
- 引擎跟版本走（relkit ADR 0027）：`relkit-updater` 作为 tauri externalBin 打进每个版本的安装内容（Windows 在 exe 旁，macOS 在 `.app/Contents/MacOS/`），宿主只调用同一份内容里的那个，不刷新、不共用。producer 在打 payload 前断言引擎在内。macOS 不用 SvnMergeTool 的 `Contents/Resources/runtime/`：0027 只约束“引擎在宿主自身内容里”，包内位置由宿主定；`Contents/MacOS/` 是 Apple 规定的辅助可执行文件位置，可执行文件放 `Resources` 会被 `codesign --strict` 告警（同 0027 §7.4），也是 Tauri externalBin 的默认落点。`sidecar_relpath` 据此填 `Contents/MacOS/relkit-updater`。2026-11-06 已在 macOS 真机按此布局完成 dev.41 → dev.42 应用内升级。
- 每个平台产出一对制品：installer（首次安装与手动兜底）与 payload（`payloadOf` 指向 installer）。Windows payload 是安装后目录树（`payload build --tree`）；macOS payload 是整个 `.app` 的 BUNDLE 单元（`payload build --bundle`，`relkit.payload/2`，保留软链），同时仍出 DMG。Windows 的 install_root 是 exe 所在目录，macOS 是 `.app` 包，`InstallSpec.display_name` 取档位产品名。
- 启动交接：壳在 `setup` 最先调用一次 `status()`，`host_must_exit` 为真立即退出让位给正在替换安装目录的 worker；问不到引擎（未接入、缺组件、引擎异常）一律放行。宿主不读引擎的会话或锁文件。
- macOS：`.app` 只读，运行期数据只写 dataDir；处于 App Translocation、在 DMG 内运行或 `.app` 所在目录不可写时停用更新，提示先拖进“应用程序”。最低系统版本 13.0（darwin 引擎为 cgo 构建）。producer 在打包前跑 `codesign --verify --deep --strict`。
- 壳内 `src-tauri/src/updater.rs` 是唯一调用引擎的地方：启动 60 秒后首检、此后每 6 小时检查一次；托盘“检查更新”与设置页“软件更新”区块共用同一状态，经 `update-status` 事件推送。安装时引擎要求宿主退出，壳走正常退出流程停掉 sidecar，由 worker 替换并重新拉起。
- 只有 CI 发布构建内嵌 bootstrap 与 releaseCode。本地构建、`desktop:*-deploy` 部署档不内嵌，更新功能自动停用并在设置页说明原因。
- 发布 token 只注入 publish job（GitHub secret `RELKIT_UPLOAD_TOKEN`），平台 job 只产出 ArtifactSet，不持 token。

## Consequences

- 收益：成员机器自动收敛到最新版；失败、回滚、需人工处理的状态在设置页可见；发版只需打 tag 或手动触发 workflow，宿主仓不随 relkit 升级改 CI。
- 代价：首次仍需手动安装一个带更新功能的版本；Windows payload 需要在 CI 里静默安装 NSIS 才能取到安装后目录树，producer 拒绝在非 CI 环境执行这一步。
- 引擎协议号与宿主严格相等，不一致时引擎答 `UPDATER_TOO_OLD/NEW`，设置页提示重新下载完整安装包。
- 前提：产品 `novoard-agent` 须先在服务器注册（服务器有 `publish` 块时注册即签发首个 Runtime Profile），否则 `bootstrap build` 返回 404，CI 无法产出。已于 2026-11-03 完成。
- Linux 无头不在本 ADR 范围，仍靠重新下载 zip。
