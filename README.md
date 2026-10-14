# novoard-agent

Novoard 联邦执行 agent：跨平台（win / mac / linux）设备侧运行时。本地面板、target 可视化编辑器、runner、setup 接入向导，接入任意 Novoard hub。

> 从 [Novoard](https://github.com/shichao402/Novoard)（hub 侧）拆分而来，`src/` 历史经 `git subtree split` 完整保留。

## 架构

- 一份源码四平台分发：esbuild CJS bundle + Node SEA 注入，CI 一次跑 win32-x64 / darwin-arm64 / darwin-x64 / linux-x64 矩阵。
- 平台差异收敛在源码内（`process.platform` 分支）：script 步骤 win 走 `cmd.exe`，openApp/openPath 走 `start`。
- 契约锁定拷贝：`src/contract/`（九张 schema + frames 校验器），SSOT 在 hub 仓 `docs/architecture/schemas/`，升级 = 从 hub 仓拷贝 + 提交（`CONTRACT_VERSION` 注记）。CI 自检拷贝完整可用。
- 联邦成员 = 本程序 + 一份身份（`agent.json`：agentId + hubUrl + agentToken）。win-dev / mac-home / intranet-weekly 是同一二进制的不同身份，不是不同程序。

## 使用

首次运行：直接执行二进制（或 `npm start`）。exe 旁目录即数据目录：

- 无 `agent.json` 时自动开配置向导 `http://127.0.0.1:39870/setup`：填 hub 地址（如 `novoard.firoyang.com`）+ 成员 ID + Agent Token → 测试连接 → 保存启动。
- 面板与编辑器：启动日志打印端口（默认磁贴 `127.0.0.1:39871`，编辑器 `/editor`）。
- target 定义在 `agents/<agentId>/targets.yaml`，编辑器保存即校验热生效（不合法不上盘）。

Windows：未签名 exe 首跑弹 SmartScreen →"更多信息"→"仍要运行"。开机自启用任务计划程序，"起始于"填 exe 所在目录。

## 开发

```bash
npm install
npm test          # 契约自检 + 全量测试（30 项）
npm run build     # 本机平台 SEA 打包（build/dist/<platform>-<arch>/）
```

打 tag `v*` 触发 GitHub Release 四平台产物。

测试中的 mock hub（`test/lib/mock-hub.mjs`）按契约实现隧道行为面（Bearer 鉴权 / hello.ack / a2a 委派 / 终态上行 / card.update），agent 测试不依赖 hub 仓代码；跨端 e2e（真 hub + 真 agent）在 hub 仓跑。

## 仓库关系

| 仓库 | 职责 |
|---|---|
| Novoard（hub） | 注册表 / 队列 / 隧道 / dashboard / 企微 bot；契约 SSOT |
| novoard-agent（本仓） | 设备侧运行时：面板 / editor / runner / setup；契约锁定拷贝 |
