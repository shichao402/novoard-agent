/**
 * 会话里工具调用的展示逻辑：把「调用」和「结果」两条事件配成一张卡片，给出中文标题、状态和一行摘要。
 * 纯函数，界面和测试共用。旧记录没有 toolUseId、结果是 JSON 字符串，这里一并兼容。
 */

const NOVOARD_TITLES = {
  novoard_status: () => "查看本机状态",
  novoard_list_targets: () => "读取 Target 列表",
  novoard_get_settings: () => "读取设置",
  novoard_save_settings: () => "保存设置",
  novoard_upsert_target: (input) => `保存 Target ${input.id ?? ""}`,
  novoard_delete_target: (input) => `删除 Target ${input.id ?? ""}`,
  novoard_run_target: (input) => `执行 Target ${input.id ?? ""}`,
  novoard_target_inputs: (input) => `查看 Target ${input.id ?? ""} 的输入`,
  novoard_ask_member: (input) => `询问成员 ${input.to ?? ""}`,
  novoard_request_detail: () => "向对方要补充信息",
  novoard_report_result: () => "回报结果",
  novoard_signal_presence: () => "上报主人在场",
  novoard_notify_owner: () => "通知主人",
  novoard_recent_activity: () => "查看最近执行",
  novoard_tail_logs: () => "查看日志",
  novoard_list_packs: () => "查看能力包",
  novoard_pack_tools: (input) => `查看能力包工具${input.pack ? ` ${input.pack}` : ""}`,
  novoard_install_pack: (input) => `${input.action === "update" ? "更新" : "安装"}能力包 ${input.key ?? ""}`,
  novoard_get_schedule: () => "查看定时",
  novoard_set_schedule: (input) => (input.enabled ? "打开定时" : "关闭定时"),
  novoard_schedule_catch_up: () => "补跑定时",
};

const SHELLS = new Set(["Bash", "PowerShell"]);

function clip(text, max) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function baseName(path) {
  const value = String(path ?? "");
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

/** 工具调用的中文标题，带上关键参数。 */
export function toolTitle(name, input) {
  const args = input && typeof input === "object" ? input : {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ""));
  if (mcp) {
    const titled = NOVOARD_TITLES[mcp[2]];
    if (titled) return clip(titled(args), 80);
    return clip(`${mcp[2]}（${mcp[1]}）`, 80);
  }
  switch (name) {
    case "Read": return `读取 ${baseName(args.file_path)}`;
    case "Write": return `写入 ${baseName(args.file_path)}`;
    case "Edit":
    case "MultiEdit": return `修改 ${baseName(args.file_path)}`;
    case "Glob": return clip(`查找 ${args.pattern ?? ""}${args.path ? `（${args.path}）` : ""}`, 80);
    case "Grep": return clip(`搜索 ${args.pattern ?? ""}${args.path ? `（${args.path}）` : ""}`, 80);
    case "Bash":
    case "PowerShell": return clip(`运行 ${args.command ?? ""}`, 80);
    case "Skill": return `加载技能 ${args.skill ?? ""}`;
    case "WebFetch": return clip(`打开 ${args.url ?? ""}`, 80);
    case "WebSearch": return clip(`搜索网页 ${args.query ?? ""}`, 80);
    case "TodoWrite": return "更新计划";
    default: return String(name || "工具");
  }
}

/** 旧记录里的结果是内容块数组序列化后的字符串，MCP 结果还会再套一层。拆成纯文本。 */
export function toolResultText(raw, depth = 0) {
  const text = String(raw ?? "");
  if (depth >= 2 || !/^\s*\[\s*\{\s*"type"\s*:/.test(text)) return text;
  try {
    const blocks = JSON.parse(text);
    if (!Array.isArray(blocks)) return text;
    const joined = blocks.map((block) => (block?.type === "text" ? String(block.text ?? "") : block?.type === "image" ? "[图片]" : "")).join("\n");
    return toolResultText(joined, depth + 1);
  } catch {
    return text;
  }
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/** 命令类工具的输出格式：Command / Stdout / Stderr / Exit Code。 */
function parseShell(text) {
  const stdout = /Stdout:([\s\S]*?)(?:\nStderr:|\nExit Code:|$)/.exec(text)?.[1] ?? "";
  const stderr = /Stderr:([\s\S]*?)(?:\nExit Code:|\nSignal:|$)/.exec(text)?.[1] ?? "";
  const exit = /Exit Code:\s*(-?\d+)/.exec(text)?.[1];
  const clean = (value) => (/^\s*\(empty\)\s*$/.test(value) ? "" : value);
  return { stdout: clean(stdout), stderr: clean(stderr), exit: exit === undefined ? null : Number(exit) };
}

/**
 * 结果的状态和一行摘要。
 * status：ok 成功 / error 失败 / denied 没有权限被拦下。
 */
export function classifyToolResult(name, raw, isError = false) {
  const text = toolResultText(raw);
  const denied = /Permission to use (\S+) has been denied/.exec(text);
  if (denied) return { status: "denied", summary: "未授权，已跳过。本机会话只放行只读查看，改动要写成 Target 由你确认后执行", detail: text };
  if (SHELLS.has(name) && /Exit Code:|Stdout:/.test(text)) {
    const shell = parseShell(text);
    if (shell.exit !== null && shell.exit !== 0) {
      return { status: "error", summary: clip(`退出码 ${shell.exit}${firstLine(shell.stderr) ? `：${firstLine(shell.stderr)}` : ""}`, 120), detail: text };
    }
    const lines = shell.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
    return { status: "ok", summary: lines > 1 ? `输出 ${lines} 行` : clip(firstLine(shell.stdout) || "完成，无输出", 120), detail: text };
  }
  if (isError || /^\s*Error:/.test(text)) {
    return { status: "error", summary: clip(firstLine(text).replace(/^Error:\s*/, "") || "失败", 120), detail: text };
  }
  if (name === "Read") {
    const lines = (text.match(/^\s*\d+→/gm) ?? []).length;
    return { status: "ok", summary: lines ? `${lines} 行` : "已读取", detail: text };
  }
  if (name === "Skill") return { status: "ok", summary: "已加载", detail: text };
  if (/^mcp__/.test(String(name ?? ""))) {
    try {
      const body = JSON.parse(text);
      if (body && typeof body === "object" && body.ok === false) {
        return { status: "error", summary: clip(body.error ?? body.message ?? "失败", 120), detail: text };
      }
      return { status: "ok", summary: "完成", detail: text };
    } catch { /* 不是 JSON，按纯文本 */ }
  }
  return { status: "ok", summary: clip(firstLine(text) || "完成", 120), detail: text };
}

let callSeq = 0;

/**
 * 把一条 tool / tool_result 事件并进调用列表，返回新列表。
 * 结果按 toolUseId 找调用；旧记录没有 id 时配给最早一个还在运行的调用；都配不上就单独成一项。
 */
export function applyToolEvent(calls, event) {
  if (event.kind === "tool") {
    callSeq += 1;
    return [...calls, {
      key: event.toolUseId || `call-${callSeq}`,
      toolUseId: event.toolUseId,
      name: String(event.name || "工具"),
      title: toolTitle(event.name, event.input),
      input: event.input,
      status: "running",
      summary: "",
      detail: "",
    }];
  }
  if (event.kind !== "tool_result") return calls;
  const index = event.toolUseId
    ? calls.findIndex((call) => call.toolUseId === event.toolUseId)
    : calls.findIndex((call) => call.status === "running");
  if (index < 0) {
    callSeq += 1;
    const result = classifyToolResult("", event.text, event.isError);
    return [...calls, { key: `result-${callSeq}`, name: "工具", title: "工具结果", status: result.status, summary: result.summary, detail: result.detail }];
  }
  const call = calls[index];
  const result = classifyToolResult(call.name, event.text, event.isError);
  const next = calls.slice();
  next[index] = { ...call, status: result.status, summary: result.summary, detail: result.detail };
  return next;
}

/** 一轮结束后还没有结果的调用（被中断、进程退出），标成未完成，不再转圈。 */
export function settleCalls(calls) {
  if (!calls.some((call) => call.status === "running")) return calls;
  return calls.map((call) => (call.status === "running" ? { ...call, status: "error", summary: "未完成，这一轮已结束" } : call));
}

/** 一组调用的标题，如「执行了 4 步 · 1 步未授权」。 */
export function groupTitle(calls) {
  const running = calls.filter((call) => call.status === "running").length;
  const failed = calls.filter((call) => call.status === "error").length;
  const denied = calls.filter((call) => call.status === "denied").length;
  const parts = [running ? `正在执行第 ${calls.length - running + 1} 步，共 ${calls.length} 步` : `执行了 ${calls.length} 步`];
  if (failed) parts.push(`${failed} 步失败`);
  if (denied) parts.push(`${denied} 步未授权`);
  return parts.join(" · ");
}
