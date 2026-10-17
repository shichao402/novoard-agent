# novoard-agent

Novoard 联邦执行 Agent：安装在 Windows、macOS 或无头 Linux 机器上，提供本地控制台、target 编辑器和 runner，并注册到任意 Novoard Hub 接受远程委派。

> 从 [Novoard](https://github.com/shichao402/Novoard)（Hub 侧）拆分而来，`src/` 历史经 `git subtree split` 完整保留。

## 产品形态

- **Windows**：安装后常驻系统托盘。双击图标或选择“打开 Novoard”显示独立控制台窗口；关窗只隐藏，选择“退出”才停止 Agent。
- **macOS**：安装后常驻菜单栏，打开后使用与 Windows 基本一致的独立控制台窗口。
- **Linux**：保持无头 SEA 二进制，不创建托盘或桌面窗口。它跑的是同一套本机服务，默认只监听 `127.0.0.1`。
- **Hub**：三端使用同一契约注册到 Hub，均可从 Hub 控制台触发 target 并上报进度与终态。本地桌面壳不参与 Hub 隧道。

Windows/macOS 的桌面部分是独立 Tauri 轻壳：它启动并监管内置 SEA sidecar，窗口里是同一份 React 控制台。Linux 没有窗口，浏览器直接打开 sidecar 的地址。执行逻辑和接口没有桌面版分叉。

## 架构

- 统一服务：`src/` 经 esbuild 打成 CJS，再注入官方 Node SEA；Windows/macOS 将该 SEA 放进安装包，Linux 直接分发该 SEA。
- 联邦成员 = 本程序 + 一份身份（`agent.json`：agentId + hubUrl + agentToken）；不同机器仍运行同一套服务。
- 桌面宿主协议：sidecar 通过 stdout NDJSON 上报 `ui-ready` / `fatal` / `stopped`，通过 stdin 接受 `shutdown`；普通日志走 stderr。
- 桌面数据目录：Windows `%APPDATA%/com.novoard.agent/`，macOS `~/Library/Application Support/com.novoard.agent/`。卸载应用不会主动删除身份与 target。
- Linux 数据目录：仍为启动时工作目录，包含 `agent.json`、`agents/` 和 `.agent-state/`。
- 平台差异收敛在源码内：script 步骤在 Windows 走 `cmd.exe`，openApp/openPath 走 `start`；macOS/Linux 使用各自系统命令。
- 契约锁定拷贝：`src/contract/` 内含九张 schema 与 frames 校验器；当前锁定 v2.0，SSOT 位于 Hub 仓。CI 会检出工作流中固定 commit 的 Hub SSOT，逐字比较 schema，并对 frames 做排除路径锚差异后的语义比较；升级时必须同时更新拷贝、`CONTRACT_VERSION` 与固定 commit。

## Windows / macOS 使用

1. 安装并启动 **Novoard Agent**。首次启动会在独立窗口打开接入向导。
2. 填写 Hub 地址、成员 ID 和 Agent Token，测试连接后保存；同一窗口自动切换到本地控制台。
3. 托盘/菜单栏提供“打开 Novoard”“打开 Target 编辑器”“重启 Agent 服务”“登录时启动”和“退出”。
4. “登录时启动”首次运行默认开启，可随时从菜单取消。

契约 2.0 要求 Agent Token 在 Hub 端唯一绑定同一个成员 ID。target 定义在桌面数据目录的 `agents/<agentId>/targets.yaml`，编辑器保存即校验并热生效。

首版属于内测分发：Windows 安装包未做 Authenticode，可能出现 SmartScreen；macOS 使用 ad-hoc 签名、未 notarize，首次运行可能需要在系统安全设置中确认。

## Linux 无头使用

直接运行发行 zip 中的 `novoard-agent`。无 `agent.json` 时会启动 `127.0.0.1:39870/setup`；已有配置后，控制台端口取 `localPort`，为 `0` 时由系统动态分配并打印到日志。浏览器打开这个地址，看到的是和 Windows / macOS 同一套控制台。

推荐通过 SSH 转发访问默认的回环地址：

```bash
ssh -L 39870:127.0.0.1:39870 user@linux-host
# 本机浏览器打开 http://127.0.0.1:39870/setup
```

需要从其他机器或公网直接访问时，把监听地址配成非回环，并设置独立 UI Token：

```bash
NOVOARD_UI_HOST=0.0.0.0 \
NOVOARD_UI_TOKEN='至少十六字符的独立凭据' \
NOVOARD_LOCAL_PORT=39871 \
./novoard-agent
```

然后访问 `http://<主机>:39871/`，先用 UI Token 登录。`uiToken` 与 Hub Agent Token 相互独立；非回环监听缺少合格 token 时 Agent 会拒绝启动。这是明文 HTTP，公网使用时应放在自己的 TLS 反代后面。`uiHost`、`uiToken`、`localPort` 也可以写入权限为 `0600` 的本机 `agent.json`。

target 定义位于 `agents/<agentId>/targets.yaml`；编辑器保存会先校验，再热替换 runtime、磁贴和 Hub card，不合法内容不会落盘。

## 开发

```bash
npm install
npm test                 # 契约门禁 + Node 全量测试
npm run build            # 本机平台 SEA：build/dist/<platform>-<arch>/
npm run desktop:check    # Tauri/Rust 单测
npm run desktop:build    # SEA + sidecar staging + 当前桌面安装包
```

SEA 注入要求官方 Node 发行二进制；Homebrew 源码构建缺少 SEA fuse 时，可用 `NODE_SEA_BASE=/path/to/official/node npm run build`。

打 `v<semver>` tag 触发 Release；流水线会先把 npm 与 Tauri 安装包版本同步为该 tag：

- Windows x64：未签名 NSIS 安装包；
- macOS arm64 / x64：ad-hoc DMG；
- Linux x64：无头 SEA zip。

测试中的 mock Hub（`test/lib/mock-hub.mjs`）覆盖 Bearer token 与 `agentId` 绑定、无 token hello、A2A 委派、终态上行、card.update，以及带 taskId/base64/sha256 的 artifact 上传与跨 member 拒绝；运行时测试不依赖 Hub 实现，但 CI 契约门禁会只读检出固定 Hub revision 做锁定拷贝对比，跨端真 Hub e2e 仍由 Hub 仓负责。

## 仓库关系

- **Novoard（Hub）**：注册表、队列、隧道、Dashboard、企微 bot 与契约 SSOT。
- **novoard-agent（本仓）**：设备侧服务、桌面轻壳、本地控制台、editor、runner、setup 与契约锁定拷贝。
