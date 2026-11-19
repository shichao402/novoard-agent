/**
 * 本机会话的权限模式与就地授权。
 *
 * - readonly：CLI 跑 dontAsk，白名单外直接被拒，不问用户。
 * - confirm：CLI 跑 default，白名单外的调用经 canUseTool 弹到桌面，用户选允许一次 / 本会话允许 / 拒绝。
 * - full：同样跑 default，canUseTool 直接放行。不用 bypassPermissions，
 *   那样 CLI 不再回调 canUseTool，AskUserQuestion 就拿不到答案（2026-11 实测）。
 *
 * 其他成员发起的那一轮没有本机用户在看，confirm 下白名单外的调用直接拒绝，不弹卡。
 */

export const CHAT_PERMISSIONS = ["readonly", "confirm", "full"];
export const DEFAULT_CHAT_PERMISSION = "confirm";
export const APPROVAL_DECISIONS = ["once", "session", "deny"];

export function normalizeChatPermission(value) {
  return CHAT_PERMISSIONS.includes(value) ? value : DEFAULT_CHAT_PERMISSION;
}

/** CLI 的 permissionMode。 */
export function cliPermissionMode(permission) {
  return normalizeChatPermission(permission) === "readonly" ? "dontAsk" : "default";
}

/**
 * canUseTool 对非 AskUserQuestion 工具的处理。
 * → "allow" | "ask" | "deny-readonly" | "deny-peer"
 */
export function decideToolUse({ permission, peer = false, granted = false }) {
  const mode = normalizeChatPermission(permission);
  if (mode === "full") return "allow";
  if (mode === "readonly") return "deny-readonly";
  if (granted) return "allow";
  if (peer) return "deny-peer";
  return "ask";
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 授权卡上显示的内容：工具名、一行摘要、可展开的完整参数。 */
export function describeToolCall(toolName, input) {
  const tool = String(toolName || "工具");
  const value = input && typeof input === "object" ? input : {};
  let summary = "";
  if (typeof value.command === "string") summary = value.command;
  else if (typeof value.file_path === "string") summary = value.file_path;
  else if (typeof value.path === "string") summary = value.path;
  else if (typeof value.url === "string") summary = value.url;
  else if (typeof value.pattern === "string") summary = value.pattern;
  let detail = "";
  try {
    detail = JSON.stringify(value, null, 2);
  } catch {
    detail = String(value);
  }
  return {
    tool,
    summary: clip(summary.replace(/\s+/g, " ").trim(), 240),
    detail: clip(detail, 4000),
    reason: typeof value.description === "string" ? clip(value.description.trim(), 200) : "",
  };
}

export function createApprovalGate() {
  const pending = new Map();
  const grants = new Map();

  function isGranted(sessionId, tool) {
    return grants.get(sessionId)?.has(tool) === true;
  }

  function wait(approvalId, sessionId, tool, signal) {
    return new Promise((resolve, reject) => {
      if (pending.has(approvalId)) {
        reject(new Error("这次授权已经在等确认"));
        return;
      }
      const onAbort = () => settle(new Error("授权已取消"));
      function settle(error, value) {
        if (!pending.has(approvalId)) return;
        pending.delete(approvalId);
        signal?.removeEventListener?.("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      }
      if (signal?.aborted) {
        reject(new Error("授权已取消"));
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      pending.set(approvalId, { sessionId, tool, settle });
    });
  }

  function decide(approvalId, sessionId, decision) {
    const waiter = pending.get(approvalId);
    if (!waiter || (sessionId && waiter.sessionId && waiter.sessionId !== sessionId)) {
      return { ok: false, gone: true, message: "这次授权已经结束" };
    }
    if (!APPROVAL_DECISIONS.includes(decision)) return { ok: false, message: "未知的授权选项" };
    if (decision === "session") {
      const set = grants.get(waiter.sessionId) ?? new Set();
      set.add(waiter.tool);
      grants.set(waiter.sessionId, set);
    }
    waiter.settle(null, decision);
    return { ok: true };
  }

  function cancelSession(sessionId) {
    for (const waiter of [...pending.values()]) {
      if (waiter.sessionId === sessionId) waiter.settle(new Error("授权已取消"));
    }
  }

  function forgetSession(sessionId) {
    cancelSession(sessionId);
    grants.delete(sessionId);
  }

  return { wait, decide, isGranted, cancelSession, forgetSession };
}

/** 系统提示里关于工具权限的那段，按模式写。 */
export function permissionPrompt(permission) {
  const mode = normalizeChatPermission(permission);
  const whitelist = "白名单（不用确认）：novoard 全部工具；Read、Glob、Grep；只读命令 svn info/status/ls/list/log、git status/log/remote/rev-parse/branch；PowerShell 的 Get-ChildItem/Test-Path/Get-Item/Get-Content；写 pool.toml。看目录优先用 PowerShell 的 Get-ChildItem <目录> -Name 或 Glob，不要用 ls、dir、cat。一条命令只做一件事，不要用 &&、;、管道拼接。";
  if (mode === "full") {
    return [
      "当前权限模式：完全放行。用户在设置里允许了本机会话直接调用所有工具，不再逐次确认。",
      whitelist,
      "删除、覆盖、svn update/revert 这类改不回来的操作，先用一句话说明要做什么，再动手。",
    ].join("\n");
  }
  if (mode === "readonly") {
    return [
      "当前权限模式：只读。白名单外的工具调用会直接被拒，不会问用户。",
      whitelist,
      "删除、改文件、svn update/revert 这类改动写成 Target 步骤，用户确认后经 novoard_run_target 执行。",
      "被拒后不要换工具绕过、不要排后续计划。用一两句中文说明想做什么、被拒的是哪个工具，再用 AskUserQuestion 给出可选做法（写成 Target 由他确认执行 / 他自己手动做 / 换个方案），等他决定。用户想让你直接做的话，可以告诉他在设置的「会话权限」里改成「逐次确认」。",
    ].join("\n");
  }
  return [
    "当前权限模式：逐次确认。白名单外的工具调用会在桌面弹授权卡，用户可以允许一次、本会话都允许或拒绝。",
    whitelist,
    "调用白名单外的工具前，在工具参数的 description 里用一句中文写清楚为什么要做，用户靠它决定。",
    "用户拒绝后不要换工具绕过、不要排后续计划。用一两句中文说明想做什么，再用 AskUserQuestion 给出可选做法（写成 Target 由他确认执行 / 他自己手动做 / 换个方案），等他决定。",
    "其他成员发起的请求没有本机用户确认，白名单外的工具会直接被拒；需要时写成 Target 经 novoard_run_target 执行。",
  ].join("\n");
}
