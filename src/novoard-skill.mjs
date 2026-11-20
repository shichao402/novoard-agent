/** 注入给本机会话的项目 skill。启动时写到会话工作目录，不要求用户手改配置。 */
import { edition } from "./edition.mjs";
import { MCP_TOOLS as T, targetFieldRules, stepRules, scheduleFieldRules, inputRules, poolRules } from "./novoard-skill-rules.mjs";

/** 落盘目录名。改名时把旧名加进 LEGACY，启动时会删掉旧目录，避免会话同时看到两份。 */
export const NOVOARD_SKILL_NAME = "novoard-agent-ops";
export const NOVOARD_SKILL_LEGACY_NAMES = ["novoard-agent"];

export const NOVOARD_SKILL = `---
name: ${NOVOARD_SKILL_NAME}
description: 在这台 ${edition.productName} 的本机会话里自己动手：改 Hub 和成员设置，增删改 Target，用能力包工具编排步骤，设定时任务，开关定时，执行 Target。用户说「每天几点帮我做 xxx」「装个包」「跑一下 xxx」或要改本机配置时使用。
---

# ${edition.productName} 本机操作

你跑在这台电脑的 ${edition.productName} 里。改配置和执行任务只用 MCP 工具 \`novoard\`，不要去改 agent.json、targets.yaml、schedule-state.json，也不要自己另写一套执行器或用系统 cron。

## 复杂配置建议换到编码会话

这个对话框适合单一意图的短指令：跑一下某个 Target、开关定时、看上次结果、改一个字段。

用户要你先翻项目或工作区（找脚本、找工程根）、设计多步骤的 Target、反复调整，或一次接好几个 Target 时，先用一句话建议他到 Cursor、With、CodeBuddy 这类编码工具里，用 \`novoard-manage\` skill 来配：那边看代码、改文件、看 diff 都更顺手，规则和这里同源。用户坚持在这里做就照常做，不要拒绝，也不要反复劝。

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
${targetFieldRules(T)}
### 步骤

${stepRules(T)}
## 定时

${scheduleFieldRules(T)}
设定时任务的顺序：

1. 用一句中文复述给用户：几点、哪几天、做什么、几点前必须结束、失败通不通知。用户确认后再保存。
2. \`novoard_upsert_target\` 保存。没说明要从 Hub 触发的，用 \`expose: a2a\` 也可以，卡片会出现在 Hub 上。
3. \`novoard_get_schedule\` 核对这个 Target 的 nextRun 和你复述的一致。
4. \`enabled\` 为 false 时，定时不会跑。告诉用户并询问是否打开，同意后 \`novoard_set_schedule\`。总开关影响本机全部定时 Target，不要自己默默打开或关闭。
5. 新建的任务先 \`novoard_run_target\` 手动跑一次，确认能跑通再交给定时。会写远端或耗时很长的，先问用户要不要现在跑。

## 运行时输入（inputs）

${inputRules()}
## 执行就是 A2A

要跑某个 Target 时调用 \`novoard_run_target\`，传入 Target id。它只会向本机 \`/a2a\` 发 \`message/send\`。不要用 Bash 直接跑 Target 里的命令或包里的工具来代替这次调用。

Target 声明了 \`inputs\`（\`novoard_status\` 里 \`inputs: true\`）时，先 \`novoard_target_inputs\` 看要哪些值和候选项，用户没说清的用 AskUserQuestion 让他从候选里挑，再 \`novoard_run_target\` 带 \`vars: { 输入名: 值 }\`。必填项没给又没有默认值，执行会当场失败并写明缺哪个。候选查询出错时（返回带 \`error\`），把原因告诉用户，请他直接给值。

需要确认的 Target，先告诉用户会执行什么，得到同意后再调用。跑完用 \`novoard_recent_activity\` 或 \`novoard_tail_logs\` 看结果。缺包、依赖没装好这类问题，日志和 \`novoard_list_packs\` 会写明原因，按原因处理（装包、更新包、请用户补凭据）。

## 工作副本池（workingCopyPool 包）

${poolRules(T)}
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
