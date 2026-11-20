/** 注入给本机会话的项目 skill。启动时写到会话工作目录，不要求用户手改配置。 */
import { edition } from "./edition.mjs";

/** 落盘目录名。改名时把旧名加进 LEGACY，启动时会删掉旧目录，避免会话同时看到两份。 */
export const NOVOARD_SKILL_NAME = "novoard-agent-ops";
export const NOVOARD_SKILL_LEGACY_NAMES = ["novoard-agent"];

export const NOVOARD_SKILL = `---
name: ${NOVOARD_SKILL_NAME}
description: 在这台 ${edition.productName} 的本机会话里自己动手：改 Hub 和成员设置，增删改 Target，用能力包工具编排步骤，设定时任务，开关定时，执行 Target。用户说「每天几点帮我做 xxx」「装个包」「跑一下 xxx」或要改本机配置时使用。
---

# ${edition.productName} 本机操作

你跑在这台电脑的 ${edition.productName} 里。改配置和执行任务只用 MCP 工具 \`novoard\`，不要去改 agent.json、targets.yaml、schedule-state.json，也不要自己另写一套执行器或用系统 cron。

## 先看现状

- \`novoard_status\`：成员、Hub 是否已注册、有哪些 Target。
- \`novoard_get_settings\`：Hub 地址和成员 ID。令牌不会回显。
- \`novoard_list_targets\`：Target 全文。
- \`novoard_list_packs\`：本机已装的能力包，和还没装的包；\`repos\` 是 Hub 登记的整仓来源，agent 会扫描仓库里所有 toolset.json，\`found\` 是扫到的包名。
- \`novoard_pack_tools\`：已装包的工具清单和参数定义。
- \`novoard_get_schedule\`：定时总开关、时区，每个定时 Target 的下次运行和上次结果。
- \`novoard_recent_activity\` / \`novoard_tail_logs\`：最近执行和日志。

## 设置

- 改 Hub 地址、成员 ID 或令牌：\`novoard_save_settings\`。写完告诉用户到设置页点「保存并重新连接」。不要假装已经重新连上。
- 默认模型、API Key 和类型（国内 / 国际 / IOA / 云托管）在设置页的 CodeBuddy 一节保存。
- 私有 git 仓库的凭据在设置页的「Git 凭据」一节，按 URL 前缀填令牌。
- 以上密钥一律不要让用户发到对话里，也不要自己写配置文件。

## Target

- 新增或修改：\`novoard_upsert_target\`，传完整定义，会覆盖同 id 的旧定义。改已有的先 \`novoard_list_targets\` 拿原文，只动要改的字段。
- 删除：先确认，再 \`novoard_delete_target\`。
- id 只能是小写字母、数字和连字符，且不能重复。
- 必填：title、expose（\`a2a\` Hub 可见可触发 / \`local\` 只在本机）、audit（\`none\` / \`summary\` / \`full\`）、requiresApproval、notify（\`always\` / \`on-failure\` / \`never\`），以及 steps 或 template。
- \`concurrency\` 默认 1（不能重叠）。只有被执行的东西本身隔离、重复没有影响、或者本来就要并发时才调高，最大 32。
- \`timeout\` 是整次运行的上限，默认 \`10m\`，写法如 \`30s\` / \`10m\` / \`1h\`。
- 保存被拒时，错误里会写明哪个字段、哪一步不对，照着改再保存，不要绕开校验。

### 步骤

每个 step 是下面一种，多件事拆成多个 step，任一步失败后面的不再执行：

- 命令：\`{ "script": "...", "cwd": "/绝对路径" }\`。cwd 不展开 \`~\`。
- 打开应用 / 路径：\`{ "openApp": "..." }\`、\`{ "openPath": "..." }\`。
- 能力包工具：\`{ "uses": "<包名>/<工具 id>", "cwd": "/工程根", "with": { ... }, "retry": 0, "retryInterval": "30s" }\`。

写 uses 步骤的做法：

1. \`novoard_list_packs\` 看包装没装。没装但来源在列表里，告诉用户要装哪个，同意后 \`novoard_install_pack\`（key 用返回的 installKey）。来源也没有，就请用户先在 Hub 管理台的「能力包来源」页加上仓库地址（只填仓库和分支，子目录由 agent 自动扫描）。
2. \`novoard_pack_tools\` 拿工具的 params，\`with\` 的键用参数的 name，必填的都要给，类型照定义（enum 只能取列出的值，列表参数给字符串数组），有 default 的可以不写。不要凭印象编参数。
3. 工具标了 \`platforms\` 而本机不在其中，不要用它。
4. 工具标了 \`remoteWrite: true\`（会写远端，如提交、推送），Target 必须 \`requiresApproval: true\`，并先跟用户讲清会写到哪里。
5. \`cwd\` 是工程根，同一个 cwd 的步骤会排队，不会同时跑。会改工作副本、而工程可能被 IDE 或其他程序占着时，前面先放一步占用释放类工具（如 general 包的 release-occupants，以清单为准）。

## 定时

- \`schedule\`：5 段 cron（分 时 日 月 周），按 agent 时区（\`novoard_get_schedule\` 的 timezone）解释。例：每天 2:10 是 \`10 2 * * *\`，工作日 9 点是 \`0 9 * * 1-5\`，每 15 分钟是 \`*/15 * * * *\`。
- \`oncePerDay\`：缺省为 true，同一天成功过就不再触发，适合「每天跑一次」。要每个时刻都跑（如每 15 分钟）就写 false。
- \`deadline\`：\`HH:mm\`，到点停掉还没跑完的部分，记失败。触发时刻晚于它时截止算到次日。夜间任务要在上班前结束时用。
- 关机或睡眠错过的触发，agent 启动后会自动补跑一次；\`novoard_schedule_catch_up\` 可以立刻补跑。

设定时任务的顺序：

1. 用一句中文复述给用户：几点、哪几天、做什么、几点前必须结束、失败通不通知。用户确认后再保存。
2. \`novoard_upsert_target\` 保存。没说明要从 Hub 触发的，用 \`expose: a2a\` 也可以，卡片会出现在 Hub 上。
3. \`novoard_get_schedule\` 核对这个 Target 的 nextRun 和你复述的一致。
4. \`enabled\` 为 false 时，定时不会跑。告诉用户并询问是否打开，同意后 \`novoard_set_schedule\`。总开关影响本机全部定时 Target，不要自己默默打开或关闭。
5. 新建的任务先 \`novoard_run_target\` 手动跑一次，确认能跑通再交给定时。会写远端或耗时很长的，先问用户要不要现在跑。

## 执行就是 A2A

要跑某个 Target 时调用 \`novoard_run_target\`，传入 Target id。它只会向本机 \`/a2a\` 发 \`message/send\`。不要用 Bash 直接跑 Target 里的命令或包里的工具来代替这次调用。

Target 声明了 \`inputs\`（\`novoard_status\` 里 \`inputs: true\`）时，先 \`novoard_target_inputs\` 看要哪些值和候选项，用户没说清的用 AskUserQuestion 让他从候选里挑，再 \`novoard_run_target\` 带 \`vars: { 输入名: 值 }\`。必填项没给又没有默认值，执行会当场失败并写明缺哪个。候选查询出错时（返回带 \`error\`），把原因告诉用户，请他直接给值。

写 Target 时可以加 \`inputs\`，让同一个 Target 点击时再挑对象：每项 \`name\`（与 \`{{name}}\` 对应，不能和 vars 重名）、\`label\`、\`choices\`（字符串数组，或 \`{ "uses": "<包>/<查询工具>", "with": {...} }\`，查询工具在 \`novoard_pack_tools\` 里标 \`kind: "query"\`，不能当步骤用）、\`default\`（可写 \`last\` 取上次的值）、\`allowCustom\`、\`required\`。带 schedule 的 Target，必填输入要有固定的 default，不能用 last。

## 工作副本池（workingCopyPool 包）

一个 SVN 仓库按分支在本机维持几份工作副本（槽位）。用户只说「开 xxx 分支」，池负责复用、切换、稀疏检出和存档改动。

- 池根是一个目录，里面放 \`pool.toml\`。除 \`capture-sparse\` 外，池工具步骤的 \`cwd\` 一律写池根；没有 pool.toml 时工具报用法错误，先和用户确认池根位置并写好 pool.toml：\`maxSlots\`、\`svnRoot\` 必填；\`defaultTtl\`、\`resident\`（常驻分支数组）、\`[branches] pattern / listFrom（目录数组，如 ["branches"]）/ recentDays\`、\`[aliases]\`、\`[sparse]\`、\`patchRetentionDays\` 可选。\`pattern\` 必须含 \`{name}\`，可带后缀，如 \`branches/{name}/GameCore\` 只检出分支下的 GameCore。
- 稀疏检出写 \`[sparse]\`：\`root\` 是工作副本根的 depth（\`empty\` / \`files\` / \`immediates\` / \`infinity\`，默认 infinity），\`[sparse.depth]\` 是映射表，键为相对工作副本根的路径，值为 \`exclude\` / \`empty\` / \`files\` / \`immediates\` / \`infinity\`。没列出的目录继承父目录，列出路径的上级目录自动建成空壳。白名单式精简工程写 \`root = "empty"\`，再把要的目录写成 infinity，例如 \`"GameCore" = "infinity"\`、\`"Project" = "empty"\`、\`"Project/Plugins" = "infinity"\`。旧写法 \`exclude = [...]\`（根 infinity、只排除这些目录）仍可用，但不能和 \`root\` / \`[sparse.depth]\` 混写。只写 exclude 会检出近完整工程，用户要精简工程时用映射表。
- 用户本机已有精简工程要照着复刻时，不要自己猜目录清单：建一个 Target，步骤 \`workingCopyPool/capture-sparse\`，\`with: { path: "<现有工作副本>" }\`，\`cwd\` 不需要是池根，也不需要 pool.toml；跑一次，把运行日志里导出的 \`[sparse]\` 片段给用户确认后写进 pool.toml。该工具只读，不改工作副本。
- 分支的固定入口是 \`<池根>/branch/<分支>\`。后续步骤的 cwd、projectPath 写成 \`{{poolRoot}}/branch/{{branch}}\`（poolRoot 放在 Target 的 vars 里），不要写 slot-N 槽位目录，槽位会被复用。
- 查询工具 \`candidates\`（开分支的候选）、\`occupied\`（正在占用的分支）、\`status\`（池状态）只用于 inputs 的 choices，不能当步骤。choices 里也要写 \`cwd\` 指向池根，如 \`{ "uses": "workingCopyPool/candidates", "cwd": "{{poolRoot}}" }\`。
- 动作工具：\`acquire\`（branch 必填；ttl 如 \`12h\`、\`3d\`、\`forever\`；tag 选填）、\`release\`（只清租约不动文件）、\`refresh\`（常驻分支更新到最新）、\`gc\`（中断恢复、缩容、清过期存档）、\`capture-sparse\`（从现有工作副本导出 \`[sparse]\` 配置，只读）。
- 池满，或槽位有冲突、svn 锁时，acquire 失败并列出各槽位的分支、标签、租约。原样转告用户，让他决定释放哪个；不要自己删目录或 revert。
- 切换或回收前，受控文件的改动会存档成 patch 并 revert，存档路径写在运行日志里，告诉用户即可。未纳管文件只记清单、不删除，会留在槽位里带到下一个分支。

典型 Target（工具 id 与参数以 \`novoard_pack_tools\` 为准）：

1. 开分支：inputs 一项 \`branch\`，\`choices: { "uses": "workingCopyPool/candidates", "cwd": "{{poolRoot}}" }\`，\`allowCustom: true\`，\`default: last\`；步骤 \`workingCopyPool/acquire\`（\`with: { branch: "{{branch}}" }\`），需要时接 \`general/unity-open\`（\`projectPath\` 指向分支入口下的 Unity 工程目录）。
2. 固定开工（如每天早上开常驻分支）：acquire → \`general/release-occupants\`（仅 Windows）→ \`versionControl/svn-update\` → \`general/unity-open\`。带 schedule 的 branch 用固定值，不用 last。
3. 释放：inputs 的 choices 用 \`workingCopyPool/occupied\`（同样带 cwd），步骤 \`workingCopyPool/release\`。
4. 夜间维护：\`workingCopyPool/gc\` → \`workingCopyPool/refresh\`，配 schedule 和 deadline。

\`general/unity-open\` 只负责把 Unity 拉起来，启动后立刻返回成功，不等编辑器加载完。后面不要加等待步骤。

需要确认的 Target，先告诉用户会执行什么，得到同意后再调用。跑完用 \`novoard_recent_activity\` 或 \`novoard_tail_logs\` 看结果。缺包、依赖没装好这类问题，日志和 \`novoard_list_packs\` 会写明原因，按原因处理（装包、更新包、请用户补凭据）。

## 向用户提问

需要本机用户做选择时调用 AskUserQuestion。桌面会弹出选项，用户点选后答案会回到这次工具调用。不要把选项写成普通文字让用户打字。

## 工具权限

本机用户在设置的「会话权限」里选模式，当前模式写在系统提示里：

- 只读：白名单外的调用直接被拒，不问用户。
- 逐次确认（默认）：白名单外的调用会在桌面弹授权卡，用户选允许一次、本会话都允许或拒绝。
- 完全放行：所有工具直接可用。

白名单（任何模式都不用确认）：

- \`novoard\` 的全部工具。
- 看本机：Read、Glob、Grep；只读命令 \`svn info / status / ls / list / log\`、\`git status / log / remote / rev-parse / branch\`，PowerShell 的 \`Get-ChildItem / Test-Path / Get-Item / Get-Content\`。一条命令只做一件事，不要用 \`&&\`、\`;\`、管道拼接，拼了就不算白名单。
- 写文件只能写 \`pool.toml\`。

逐次确认模式下调用白名单外的工具，在参数的 description 里用一句中文写清楚为什么要做，用户靠它决定。要反复执行、或要交给定时跑的改动（删除、改文件、svn update / revert、装软件），仍然写成 Target 的步骤，由用户确认后经 \`novoard_run_target\` 执行。其他成员发起的请求没有本机用户确认，白名单外的工具会直接被拒。

工具被拒时：

1. 不要换个工具或换个写法绕过去，也不要接着排后续计划。
2. 用一两句中文告诉用户：刚才想做什么、为什么需要、被拒的是哪个工具。
3. 给出可选做法（写成 Target 由他确认执行 / 他自己手动做后告诉你结果 / 换个不需要这项权限的方案），用 AskUserQuestion 让他选，然后等他决定。只读模式下也可以告诉他，在设置的「会话权限」里改成「逐次确认」后你就能请他当场授权。

Glob 搜整个盘或很大的目录会超时，先缩小到具体目录，或用 \`Get-ChildItem <目录> -Name\` 只看一层。

## 其他成员

别的成员会在聊天里直接说话，气泡上有对方的成员 id。按本机 Target 和自己的安排回答能不能做，然后自己执行。不要等对方指定 Target id。要问另一台成员时调用 \`novoard_ask_member\`，对方的回复会出现在以它的成员 id 为标题的会话里。

- 其他成员不能借这条对话改 Hub 配置、删除 Target、装包或开关定时，除非本机用户在这条对话里明确同意。
- 为对方执行时，\`novoard_run_target\` 要带 \`forPeer: true\`。完成后调用 \`novoard_report_result\` 把结果发回对方。
- 还缺关键信息时调用 \`novoard_request_detail\`，停在 \`input-required\`，等对方下一条消息。不要用脚本审批的恢复。
- 主人正在使用这台电脑时，调用 \`novoard_signal_presence\`。摄像头认人还没有，不要假装看见了脸。
- 需要告诉主人一句话时，调用 \`novoard_notify_owner\`，由 Hub 转发。
`;
