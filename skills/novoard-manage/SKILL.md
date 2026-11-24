---
name: novoard-manage
description: 在编码会话里配置和维护本机 novoard-agent：把项目脚本接成 target（Hub 卡片），用已装能力包编排步骤（如定时 SVN 更新、开分支、打开工程），设定时、装或更新能力包、手动触发、补跑、查执行记录和日志。用户说「把 xxx 脚本接到 novoard」「每天几点帮我做 xxx」「搞个定时跟踪 svn 的任务」「给 novoard 装个包」「跑一下 / 看看 novoard 上 xxx 的结果」时使用。不负责编写业务脚本本身，也不改 Hub 地址、令牌、Git 凭据和定时总开关。
---

<!-- 由 novoard-agent 仓 scripts/gen-manage-skill.mjs 生成，规则源在 src/novoard-skill-rules.mjs。不要直接改这份。 -->

# 配置和维护本机 novoard-agent

## 定位

novoard-agent 自带一个对话框，只适合发短指令（「跑一下 xxx」「看看上次结果」）。需要看项目、设计
步骤、反复调整的配置活，在编码会话里用本 skill 做。agent 内置会话自带另一份 skill（novoard-agent-ops），
两份由同一份规则源生成，只是入口不同：那边调 MCP 工具，这边调下面的 CLI。

完成标准：Hub 上看得到卡片，本机触发一次成功；配了定时的，`schedule` 里 nextRun 符合用户预期。

## 工具

[`scripts/novoard.py`](scripts/novoard.py)，只用标准库。Windows 上用 `python`。输出都是 JSON，失败时退出码非 0，
stderr 里是 agent 给的原因，照着改再试，不要绕开。

```text
python3 <skill>/scripts/novoard.py status                 身份、Hub 连接、总开关、每个 target 摘要
python3 <skill>/scripts/novoard.py targets [<id>]         target 全文
python3 <skill>/scripts/novoard.py schedule               时区、总开关、每个定时 target 的 nextRun 和上次结果
python3 <skill>/scripts/novoard.py packs                  已装能力包、可安装来源（installKey）
python3 <skill>/scripts/novoard.py pack-tools [<包名>]    工具清单与参数定义
python3 <skill>/scripts/novoard.py inputs <id>            运行时输入的候选项和默认值
python3 <skill>/scripts/novoard.py activity [--limit N]   最近执行记录
python3 <skill>/scripts/novoard.py log <id> [--lines N]   该 target 最近一次运行日志
python3 <skill>/scripts/novoard.py add --file <片段.yaml> [--replace]
python3 <skill>/scripts/novoard.py remove <id>
python3 <skill>/scripts/novoard.py install-pack <installKey> [--update]
python3 <skill>/scripts/novoard.py trigger <id> [--var 名=值 ...]
python3 <skill>/scripts/novoard.py catch-up               立即补跑错过的定时
```

每个子命令都接受 `--dev`，操作开发版 agent（`com.novoard.agent.dev`），默认是正式版（`com.novoard.agent`）。

所有写操作都经 agent 控制台接口完成：保存时校验 schema、备份 `targets.yaml.bak`、热生效并向 Hub
上报 `card.update`；执行一律走本机 `/a2a`。不要直接编辑 `agent.json`、`targets.yaml`、`schedule-state.json`，
改了也不会生效。不要用 Bash 直接跑 target 里的命令或包里的工具来代替 `trigger`，也不要另起系统 cron。

CLI 不提供、本 skill 也不做的事：开关定时总开关、改 Hub 地址或令牌、配 Git 凭据、删除能力包。遇到这些，
告诉用户去 agent 桌面端设置页操作。密钥不要让用户发进对话。

## 通用流程

1. 看现场：`status`。agent 没在跑就停下，让用户启动。记下 agentId 和时区。
2. 弄清要做的事，只问会改变结果、又查不到的：卡片标题（给建议值）、挂在正式版还是开发版、要不要审批、
   超时、要不要定时。要定时的话，用一句中文复述「几点、哪几天、做什么、几点前必须结束、失败通不通知」，
   确认后再写 cron。用户没提定时就不加。
3. 写片段到临时文件，`add --file`（改已有的用 `targets <id>` 拿原文，只改要改的字段，`add --replace`）。
   被拒时报错里写着字段和步骤，照着改。
4. 定时的：`add` 输出里核对 nextRun（UTC，换成用户时区再说）。总开关是关的，告诉用户到点不会跑，
   请他在设置页打开。
5. 手动 `trigger` 一次，`log <id>` 看结果，跑通再交给定时。会写远端或耗时很长的，先问用户要不要现在跑。
   返回 `input-required` 表示要审批或补输入，请用户在桌面端或 Hub 上处理。

删除 target 先跟用户确认。

## target 片段

顶层直接是 id，不写 `targets:`。

```yaml
<对象>-<动作>-<agentId>:
  title: 每天凌晨更新 GameCore
  expose: a2a
  audit: summary
  requiresApproval: false
  notify: on-failure
  concurrency: 1
  timeout: 30m
  steps:
    - uses: versionControl/svn-update
      cwd: /Users/<me>/workspace/GameCore
  schedule: "0 2 * * *"
  oncePerDay: true
  deadline: "07:30"
```

- id 只能是小写字母、数字和连字符。id 在 Hub 上全局唯一、先到先得，新建时带上本机 agentId 作后缀（`status` 里的 agentId），形如 `gamecore-daily-svn-update-imac5k2020`。
- 必填：title、expose（`a2a` Hub 可见可触发 / `local` 只在本机）、audit（`none` / `summary` / `full`）、requiresApproval、notify（`always` / `on-failure` / `never`），以及 steps 或 template。漏写会被拒。
- `concurrency` 默认 1（不能重叠）。只有被执行的东西本身隔离、重复没有影响、或者本来就要并发时才调高，最大 32。
- `timeout` 是整次运行的上限，默认 `10m`，写法如 `30s` / `10m` / `1h`。
- 保存被拒时，错误里会写明哪个字段、哪一步不对，照着改再保存，不要绕开校验。

字段以 agent 仓 `src/contract/schemas/target.json` 为准。

### 步骤

每个 step 是下面一种。多件事拆成多个 step，日志里能看出卡在哪一步；任一步失败，后面的不再执行。

- 命令：`{ script: "...", cwd: /绝对路径 }`。cwd 不展开 `~`。
- 打开应用或路径：`{ openApp: "..." }`、`{ openPath: "..." }`。
- 能力包工具：`{ uses: <包名>/<工具 id>, cwd: /工程根, with: {...}, retry: 0, retryInterval: 30s }`。

写 uses 步骤：

1. `packs` 看包装没装。没装但来源在列表里，告诉用户要装哪个，同意后 `install-pack <installKey>`。来源也没有，请用户先在 Hub 管理台的「能力包来源」页加上仓库地址（只填仓库和分支，子目录由 agent 自动扫描）。
2. `pack-tools <包名>` 拿工具的 params。`with` 的键用参数 name，必填都要给，类型照定义（enum 只取列出的值，列表参数给字符串数组），有 default 的可以不写。不要凭印象编参数。
3. 工具标了 `platforms` 而本机不在其中，不要用。
4. 工具标了 `remoteWrite: true`（会提交、推送等写远端），Target 必须 `requiresApproval: true`，并先跟用户讲清会写到哪里。
5. `cwd` 是工程根，同一 cwd 的步骤会排队，不会同时跑。会改工作副本、而工程可能被 IDE 或其他程序占着时，前面先放一步占用释放类工具（如 `general/release-occupants`，以清单为准）。
6. `kind: "query"` 的工具只能用在 inputs 的 choices 里，不能当步骤。

执行条件 `when`（script、openApp、openPath、uses 都能写，template 不能）：

- 同一个 Target 有几步「这次做、下次不做」（如开不开 Rider、要不要先 svn update）时，不要拆成两个 Target，给这几步写 `when: "{{开关输入名}}"`。
- `when` 先插值，结果去掉首尾空白后为空、`false`、`0`、`no`、`off`（不分大小写）时跳过这一步，其余值照常执行。跳过不算失败，日志里记一行「已跳过」。
- 只判断真假，不支持 `==`、`&&` 这类表达式；要按值分流，就让输入直接给出开关值。
- `{{name}}` 没有来源（inputs、vars、触发参数都没有）时整次运行失败，不会当作假。
- 示例：`{ openApp: rider, when: "{{openRider}}" }`，配一项开关输入 `openRider`。

### 定时

- `schedule`：5 段 cron（分 时 日 月 周），按 agent 时区（`schedule` 的 timezone）解释。例：每天 2:10 是 `10 2 * * *`，工作日 9 点是 `0 9 * * 1-5`，每 15 分钟是 `*/15 * * * *`。
- `oncePerDay`：缺省为 true，同一天成功过就不再触发，适合「每天跑一次」。要每个时刻都跑（如每 15 分钟）就写 false。
- `deadline`：`HH:mm`，到点停掉还没跑完的部分，记失败。触发时刻晚于它时截止算到次日。夜间任务要在上班前结束时用。
- agent 每 20 秒检查一次。关机或睡眠错过的触发，agent 启动约 60 秒后自动补跑一次（受 oncePerDay、deadline 约束）；`catch-up` 可以立刻补跑。
- 定时总开关关着时，所有定时 Target 到点都不会跑。

### 运行时输入（inputs）

同一个 Target 每次要不同参数（分支、渠道、环境）时，不要为每个值建一张卡，加 `inputs`。每项：

- `name`：与 `{{name}}` 对应，不能和 vars 重名。`{{name}}` 可以出现在 script、cwd、env、`with`、`when` 里。
- `label`：给人看的名字。
- `choices`：字符串数组，或 `{ uses: <包>/<查询工具>, cwd: <工程根>, with: {...} }`（查询工具在工具清单里标 `kind: "query"`）。
- `default`：固定值，或 `last`（取上次选的）。
- `allowCustom`、`required`。

开关输入：`choices: ["true", "false"]`，再给 `default`（如 `"false"`），桌面端显示为开关，配合步骤的 `when` 决定某几步跑不跑。

带 schedule 的 Target，必填输入要有固定的 default，不能用 last。

```yaml
  inputs:
    - name: branch
      label: 分支
      choices: [trunk, release]
      default: last
      allowCustom: true
      required: true
```

手动触发时先 `inputs <id>` 看候选，用户没说清的让他从候选里挑，再 `trigger <id> --var branch=xxx`。

## 场景：把项目脚本接成 target

1. 在当前项目里找到脚本，记下仓库绝对路径和脚本相对路径，确认有可执行位（没有就用 `bash ./x.sh`）。
   读一遍，弄清子命令、耗时、会不会重启或替换 agent 自己、有没有交互输入。
2. 用 agent 的环境试跑。agent 以登录 shell 环境执行脚本（`$SHELL -ilc` 取一次），所以这样模拟：

   ```text
   env -i HOME="$HOME" USER="$USER" SHELL="$SHELL" "$SHELL" -ilc 'cd <repo> && <script>'
   ```

   只读子命令（check、dry-run、--help）都跑一遍，会改东西的留到最后 `trigger`。
3. 脚本会替换或重启某个 agent 时，target 不能挂在那个 agent 上，否则跑到一半把自己杀掉。
4. 走通用流程第 3 到 5 步。脚本本身跑不通时，让用户回项目修好，不要在 target 里堆内联命令兜底。

前后需要「先更新代码」「再打开工程」这类通用动作时，在同一个 target 里加 `uses` 步骤，不用在脚本里重写。

## 场景：用能力包编排定时任务

例如「看看 workspace 里的项目，每天凌晨更新 SVN」：

1. 在工作区里确认工程根（有 `.svn` 的目录）。多个工程就问清是哪几个，每个工程一个 step 或一个 target。
2. `pack-tools versionControl` 拿 svn-update 的参数，按需填 `with`（如冲突策略）。
3. 定时按通用流程复述并确认，夜间任务配 `deadline`，保证上班前结束。
4. 先 `trigger` 跑一次，再交给定时。

## 工作副本池（workingCopyPool 包）

一个 SVN 仓库按分支在本机维持几份工作副本（槽位）。用户只说「开 xxx 分支」，池负责复用、切换、稀疏检出和存档改动。

- 池根是一个目录，里面放 `pool.toml`。除 `capture-sparse` 外，池工具步骤的 `cwd` 一律写池根；没有 pool.toml 时工具报用法错误，先和用户确认池根位置并写好 pool.toml：`maxSlots`、`svnRoot` 必填；`defaultTtl`、`resident`（常驻分支数组）、`[branches] pattern / listFrom（目录数组，如 ["branches"]）/ recentDays`、`[aliases]`、`[sparse]`、`patchRetentionDays` 可选。`pattern` 必须含 `{name}`，可带后缀，如 `branches/{name}/GameCore` 只检出分支下的 GameCore。
- 稀疏检出写 `[sparse]`：`root` 是工作副本根的 depth（`empty` / `files` / `immediates` / `infinity`，默认 infinity），`[sparse.depth]` 是映射表，键为相对工作副本根的路径，值为 `exclude` / `empty` / `files` / `immediates` / `infinity`。没列出的目录继承父目录，列出路径的上级目录自动建成空壳。白名单式精简工程写 `root = "empty"`，再把要的目录写成 infinity，例如 `"GameCore" = "infinity"`、`"Project" = "empty"`、`"Project/Plugins" = "infinity"`。旧写法 `exclude = [...]`（根 infinity、只排除这些目录）仍可用，但不能和 `root` / `[sparse.depth]` 混写。只写 exclude 会检出近完整工程，用户要精简工程时用映射表。
- 用户本机已有精简工程要照着复刻时，不要自己猜目录清单，也不要直接 `svn info -R` 去读（节点可能十几万）：用 `add` 建一个 `expose: local` 的 Target，步骤 `workingCopyPool/capture-sparse`，`with: { path: <现有工作副本> }`，`cwd` 不需要是池根，也不需要 pool.toml；`trigger` 跑一次，从 `log <id>` 里取导出的 `[sparse]` 片段，给用户确认后写进 pool.toml。该工具只读，不改工作副本。
- 分支的固定入口是 `<池根>/branch/<分支>`。后续步骤的 cwd、projectPath 写成 `{{poolRoot}}/branch/{{branch}}`（poolRoot 放在 Target 的 vars 里），不要写 slot-N 槽位目录，槽位会被复用。
- 查询工具 `candidates`（开分支的候选）、`occupied`（正在占用的分支）、`status`（池状态）只用于 inputs 的 choices，不能当步骤。choices 里也要写 `cwd` 指向池根，如 `{ uses: workingCopyPool/candidates, cwd: "{{poolRoot}}" }`。
- 动作工具：`acquire`（branch 必填；ttl 如 `12h`、`3d`、`forever`；tag 选填）、`release`（只清租约不动文件）、`refresh`（常驻分支更新到最新）、`gc`（中断恢复、缩容、清过期存档）、`capture-sparse`（从现有工作副本导出 `[sparse]` 配置，只读）。
- 池满，或槽位有冲突、svn 锁时，acquire 失败并列出各槽位的分支、标签、租约。原样转告用户，让他决定释放哪个；不要自己删目录或 revert。
- 切换或回收前，受控文件的改动会存档成 patch 并 revert，存档路径写在运行日志里，告诉用户即可。未纳管文件只记清单、不删除，会留在槽位里带到下一个分支。

典型 Target（工具 id 与参数以 `pack-tools <包名>` 为准）：

1. 开分支：inputs 一项 `branch`，`choices: { uses: workingCopyPool/candidates, cwd: "{{poolRoot}}" }`，`allowCustom: true`，`default: last`；步骤 `workingCopyPool/acquire`（`with: { branch: "{{branch}}" }`），需要时接 `general/unity-open`（`projectPath` 指向分支入口下的 Unity 工程目录）。要不要顺带开 Rider 等 IDE，用一项开关输入加该步的 `when`，不要再建一个 Target。
2. 固定开工（如每天早上开常驻分支）：acquire → `general/release-occupants`（仅 Windows）→ `versionControl/svn-update` → `general/unity-open`。带 schedule 的 branch 用固定值，不用 last。
3. 释放：inputs 的 choices 用 `workingCopyPool/occupied`（同样带 cwd），步骤 `workingCopyPool/release`。
4. 夜间维护：`workingCopyPool/gc` → `workingCopyPool/refresh`，配 schedule 和 deadline。

`general/unity-open` 只负责把 Unity 拉起来，启动后立刻返回成功，不等编辑器加载完。后面不要加等待步骤。

## 已知坑

- 脚本里的变量一律写 `${VAR}`。macOS 自带 bash 3.2 在 UTF-8 locale 下会把紧跟变量的中文全角字符当成变量名，
  `"$REF）"` 在 `set -u` 下报 unbound variable，终端里不一定复现。
- 脚本环境是 agent 启动时取的。新装工具或改了 shell 配置，要重启 agent。`logs/agent.jsonl` 里
  `[env] target 脚本环境：` 一行写着来源和 PATH，显示 `fallback` 时脚本最好自己 `export PATH`。
- 步骤用 `/bin/sh -c` 执行，进程组隔离，超时整组杀掉。脚本不能等交互输入。
- `add --replace` 只影响下一次运行，正在跑的不受影响。
- `add` 后 `cardUpdateReported: false` 通常是 agent 当前没连上 Hub，连上后会随注册带上新卡片。
- Windows：数据目录在 `%APPDATA%\com.novoard.agent[.dev]`；agent 沿用自身进程环境，不取登录 shell，
  试跑直接在 PowerShell 里 `cd <repo>; <script>`；步骤用 `cmd.exe /c` 执行。
- Windows 上 agent 0.3.6 之前 `openApp`/`openPath` 会挂到超时，且引号被转义成 `\"`。旧版上改用
  `script: powershell -NoProfile -Command Start-Process .\xxx.exe`，cwd 指到程序目录。

## 收尾

踩到会让下次走错的坑，记到 novoard-agent 仓：Target、步骤、定时、工作副本池这类两边共用的规则改
`src/novoard-skill-rules.mjs`，只和编码会话有关的改 `scripts/gen-manage-skill.mjs`；然后 `npm run skill:gen`，
把 `skills/novoard-manage/` 发布到 Dec。是 agent 行为问题就去仓里修代码。不要直接改 Dec 上的正文，也不要记进对话记忆。
