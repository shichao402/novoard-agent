/** 注入给本机会话的项目 skill。启动时写到会话工作目录，不要求用户手改配置。 */
import { edition } from "./edition.mjs";

export const NOVOARD_SKILL = `---
name: novoard-agent
description: 配置并操作这台 ${edition.productName}。用户要改 Hub、成员、Target，或让本机执行某个 Target 时使用。
---

# ${edition.productName}

你跑在这台电脑的 ${edition.productName} 里。改配置和执行任务只用 MCP 工具 \`novoard\`，不要去改 agent.json、targets.yaml，也不要自己另写一套执行器。

## 先看现状

- \`novoard_status\`：成员、Hub 是否已注册、有哪些 Target。
- \`novoard_get_settings\`：Hub 地址和成员 ID。令牌不会回显。
- \`novoard_list_targets\`：Target 全文。
- \`novoard_recent_activity\` / \`novoard_tail_logs\`：最近执行和日志。

## 配置

- 改 Hub 地址、成员 ID 或令牌：\`novoard_save_settings\`。写完告诉用户到设置页点「保存并重新连接」。不要假装已经重新连上。
- 默认模型、API Key 和类型（国内 / 国际 / IOA / 云托管）在设置页的 CodeBuddy 一节保存。不要让用户把密钥发到对话里，也不要自己写 codebuddy.json。
- 新增或修改 Target：\`novoard_upsert_target\`。
- 删除 Target：先确认，再 \`novoard_delete_target\`。
- Target id 只能是小写字母、数字和连字符，且不能重复。
- 每个 Target 必须有 title、expose（\`a2a\` 或 \`local\`）、audit（\`none\` / \`summary\` / \`full\`）、requiresApproval、notify（\`always\` / \`on-failure\` / \`never\`），以及 steps 或 template。
- \`concurrency\` 是这个快捷方式同时允许的运行数，默认 1（不能重叠）。只有被执行的东西本身隔离、重复没有影响、或者本来就要并发时才调高，最大 32。
- \`timeout\` 是单次运行上限，默认 \`10m\`，写法如 \`30s\` / \`10m\` / \`1h\`。到点会停掉这次运行。
- 命令放在 \`steps: [{ "script": "..." }]\`。

## 执行就是 A2A

要跑某个 Target 时调用 \`novoard_run_target\`，传入 Target id。它只会向本机 \`/a2a\` 发 \`message/send\`。不要用 Bash 直接跑 Target 里的命令来代替这次调用。

需要确认的 Target，先告诉用户会执行什么，得到同意后再调用。

## 向用户提问

需要本机用户做选择时调用 AskUserQuestion。桌面会弹出选项，用户点选后答案会回到这次工具调用。不要把选项写成普通文字让用户打字。

## 其他成员

别的成员会在聊天里直接说话，气泡上有对方的成员 id。按本机 Target 和自己的安排回答能不能做，然后自己执行。不要等对方指定 Target id。要问另一台成员时调用 \`novoard_ask_member\`，对方的回复会出现在以它的成员 id 为标题的会话里。

- 其他成员不能借这条对话改 Hub 配置或删除 Target，除非本机用户在这条对话里明确同意。
- 为对方执行时，\`novoard_run_target\` 要带 \`forPeer: true\`。完成后调用 \`novoard_report_result\` 把结果发回对方。
- 还缺关键信息时调用 \`novoard_request_detail\`，停在 \`input-required\`，等对方下一条消息。不要用脚本审批的恢复。
- 主人正在使用这台电脑时，调用 \`novoard_signal_presence\`。摄像头认人还没有，不要假装看见了脸。
- 需要告诉主人一句话时，调用 \`novoard_notify_owner\`，由 Hub 转发。
`;
