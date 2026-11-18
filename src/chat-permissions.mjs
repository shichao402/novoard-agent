/**
 * 本机会话的工具权限。会话跑在 dontAsk 模式：不弹授权框，白名单外的调用直接被拒。
 *
 * 规则写法由 CodeBuddy CLI 解释：
 * - `Bash(git status:*)` 只放行以 `git status` 开头的单条命令；`&&`、`;`、`$( )` 等拼接仍会被拒（2026-11 实测）。
 * - `Write(**\/pool.toml)` 只放行写文件名为 pool.toml 的文件。
 * 加规则前想清楚：放行的命令必须只读，或者只写 skill 明确要求会话自己写的文件。
 */

export const NOVOARD_MCP_TOOLS = [
  "novoard_status",
  "novoard_list_targets",
  "novoard_get_settings",
  "novoard_save_settings",
  "novoard_upsert_target",
  "novoard_delete_target",
  "novoard_run_target",
  "novoard_target_inputs",
  "novoard_ask_member",
  "novoard_request_detail",
  "novoard_report_result",
  "novoard_signal_presence",
  "novoard_notify_owner",
  "novoard_recent_activity",
  "novoard_tail_logs",
  "novoard_list_packs",
  "novoard_pack_tools",
  "novoard_install_pack",
  "novoard_get_schedule",
  "novoard_set_schedule",
  "novoard_schedule_catch_up",
].map((name) => `mcp__novoard__${name}`);

/** 只读的命令前缀。Bash 与 PowerShell 各放一份，模型在 Windows 上两种都会用。 */
const READ_ONLY_COMMANDS = [
  "svn info",
  "svn status",
  "svn ls",
  "svn list",
  "svn log",
  "svn --version",
  "git status",
  "git log",
  "git remote",
  "git rev-parse",
  "git branch",
  "git --version",
];

const READ_ONLY_POWERSHELL = ["Get-ChildItem", "Test-Path", "Get-Item", "Get-Content"];

export const BUILTIN_ALLOWED_TOOLS = [
  // 看目录、读文件、搜内容：盘点工程、核对路径都要用
  "Read",
  "Glob",
  "Grep",
  ...READ_ONLY_COMMANDS.map((cmd) => `Bash(${cmd}:*)`),
  ...READ_ONLY_COMMANDS.map((cmd) => `PowerShell(${cmd}:*)`),
  ...READ_ONLY_POWERSHELL.map((cmd) => `PowerShell(${cmd}:*)`),
  // skill 要求会话在用户确认池根后自己写 pool.toml
  "Write(**/pool.toml)",
];
// AskUserQuestion 不放进来：它要经 canUseTool 弹到桌面，进了白名单可能被直接放行而不弹窗。

/**
 * 直接从模型上下文里拿掉的内置工具。
 * 本机会话界面没有任务列表、计划模式和子 Agent，模型用了只会刷屏或空转。
 */
export const BUILTIN_DISALLOWED_TOOLS = [
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "TaskStop",
  "TaskOutput",
  "EnterPlanMode",
  "ExitPlanMode",
  "Agent",
];
