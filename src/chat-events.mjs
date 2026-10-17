/** 把 CodeBuddy SDK 消息收成界面事件。只保留用户能看懂的增量、正文和工具。 */
export function normalizeSdkMessage(message) {
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
      if (block?.type === "tool_use") {
        events.push({ kind: "tool", name: String(block.name ?? "tool"), input: block.input ?? {} });
      }
    }
    if (message.error) events.push({ kind: "error", text: String(message.error) });
    return events;
  }
  if (message.type === "user") {
    const content = message.message?.content;
    if (!Array.isArray(content)) return [];
    return content.filter((block) => block?.type === "tool_result").map((block) => ({
      kind: "tool_result",
      text: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
    }));
  }
  if (message.type === "result") {
    if (message.subtype === "success") {
      return [{ kind: "done", ok: message.is_error !== true, text: String(message.result ?? "") }];
    }
    const text = Array.isArray(message.errors) && message.errors.length ? message.errors.join("\n") : String(message.subtype ?? "执行失败");
    return [{ kind: "done", ok: false, text }];
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
