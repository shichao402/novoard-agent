/** 单条工具结果写进记录的上限。读大文件时结果很长，界面只需要摘要和开头一段。 */
const TOOL_RESULT_LIMIT = 4000;

/**
 * 把 CodeBuddy SDK 消息收成界面事件。只保留用户能看懂的增量、正文和工具。
 * state 跨消息记住一轮里要隐藏的工具调用（AskUserQuestion 由问答卡片单独展示），同一次发送内共用一个。
 */
export function normalizeSdkMessage(message, state = { hidden: new Set() }) {
  if (!message || typeof message !== "object") return [];
  if (message.type === "stream_event") {
    const delta = message.event?.delta;
    if (message.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text) {
      return [{ kind: "delta", text: String(delta.text) }];
    }
    return [];
  }
  if (message.type === "assistant") {
    const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
    const events = [];
    const text = blocks.filter((block) => block?.type === "text" && block.text).map((block) => block.text).join("");
    if (text) events.push({ kind: "assistant", text });
    for (const block of blocks) {
      if (block?.type !== "tool_use") continue;
      if (block.name === "AskUserQuestion") {
        if (block.id) state.hidden.add(block.id);
        continue;
      }
      const event = { kind: "tool", name: String(block.name ?? "tool"), input: block.input ?? {} };
      if (block.id) event.toolUseId = String(block.id);
      events.push(event);
    }
    if (message.error) events.push({ kind: "error", text: String(message.error) });
    return events;
  }
  if (message.type === "user") {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    const events = [];
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      if (block.tool_use_id && state.hidden.has(block.tool_use_id)) continue;
      const event = { kind: "tool_result", text: toolResultText(block.content) };
      if (block.tool_use_id) event.toolUseId = String(block.tool_use_id);
      if (block.is_error === true) event.isError = true;
      events.push(event);
    }
    return events;
  }
  if (message.type === "result") {
    if (message.subtype === "success") {
      return [{ kind: "done", ok: message.is_error !== true, text: String(message.result ?? "") }];
    }
    const text = Array.isArray(message.errors) && message.errors.length ? message.errors.join("\n") : String(message.subtype ?? "执行失败");
    return [{ kind: "done", ok: false, text }];
  }
  if (message.type === "error") {
    // CLI 在会话层面失败时（如恢复不存在的会话）只发这一条就结束流，不会再有 result
    return [{ kind: "error", text: explainAgentError(message.error ?? "执行失败") }];
  }
  if (message.type === "system" && message.subtype === "init") {
    const mcp = (message.mcp_servers ?? []).map((item) => `${item.name}:${item.status}`).join(", ");
    return [{ kind: "status", text: `已连接 ${message.model || "模型"}${mcp ? ` · MCP ${mcp}` : ""}` }];
  }
  if (message.type === "system" && message.subtype === "task_started") {
    return [{ kind: "status", text: message.description ? `后台任务：${message.description}` : "后台任务已开始" }];
  }
  return [];
}

/**
 * 工具结果的正文。SDK 给的是字符串或内容块数组；MCP 工具还会把内容块数组再序列化成一段文本套一层，
 * 这里一并拆开，只留文字，图片记成占位。超长截断。
 */
export function toolResultText(content, depth = 0) {
  let text;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content.map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return String(block.text ?? "");
      if (block?.type === "image") return "[图片]";
      return "";
    }).join("\n");
  } else text = content == null ? "" : JSON.stringify(content);
  if (depth < 2 && /^\s*\[\s*\{\s*"type"\s*:/.test(text)) {
    try {
      const inner = JSON.parse(text);
      if (Array.isArray(inner)) return toolResultText(inner, depth + 1);
    } catch { /* 不是内容块数组，按原文 */ }
  }
  return text.length > TOOL_RESULT_LIMIT ? `${text.slice(0, TOOL_RESULT_LIMIT)}\n…（已截断，共 ${text.length} 字）` : text;
}

/**
 * CodeBuddy 那边没有这个会话。新建后一条消息都没发就重启会话进程时会这样：
 * CLI 只在首条消息后才落盘会话，恢复时报 No conversation found。
 */
export function isMissingConversation(message) {
  return Boolean(message && message.type === "error" && /no conversation found/i.test(String(message.error ?? "")));
}

export function explainAgentError(error) {
  const text = String(error?.message ?? error ?? "未知错误");
  if (/CLI not found|CLINotFound|CodeBuddy CLI not found/i.test(text)) {
    return "没有找到 CodeBuddy 运行时。确认本机已安装 CodeBuddy，或设置 CODEBUDDY_CODE_PATH 指向 CLI。";
  }
  if (/unauthorized|invalid api key|not logged|login required|authentication required|\/login|401/i.test(text)) {
    return `模型还没有可用的登录态。在终端登录 CodeBuddy，或设置 CODEBUDDY_API_KEY。国内版再加上 CODEBUDDY_INTERNET_ENVIRONMENT=internal。\n${text}`;
  }
  return text;
}
