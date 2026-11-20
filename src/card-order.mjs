/**
 * 问答卡、授权卡要排在引出它的那条模型消息之后。
 *
 * CLI 的 stdout 本来是一条有序的管道，SDK 读行时把它拆成两路：普通消息进队列，
 * 等我们的 for-await 读到才落盘；can_use_tool 控制请求在读行时直接回调 canUseTool。
 * 所以权限请求常比同一步的正文先到，卡片会排到正文前面（2026-11-20 实测）。
 *
 * 两路用 tool_use id 对上：正文和卡片谁后到，谁把卡片写进记录。
 * 两边都在同一个事件循环里，不需要计时。一轮一个实例。
 */
export function createCardOrder() {
  /** 正文已落盘、卡片还没来的 tool_use id */
  const stepped = new Set();
  /** 卡片先到、正文还没落盘：tool_use id → 写卡片 */
  const waiting = new Map();

  /** canUseTool 要出卡片时调用。对应正文已落盘就立刻写，否则等 step。 */
  function card(toolUseId, write) {
    if (!toolUseId || stepped.delete(toolUseId)) {
      write();
      return;
    }
    waiting.set(toolUseId, write);
  }

  /** 一条 assistant 消息落盘后调用，带上它的全部 tool_use id。 */
  function step(toolUseIds) {
    for (const id of toolUseIds) {
      const write = waiting.get(id);
      if (!write) {
        stepped.add(id);
        continue;
      }
      waiting.delete(id);
      write();
    }
  }

  return { card, step };
}

/** SDK assistant 消息里的 tool_use id。 */
export function toolUseIds(message) {
  if (message?.type !== "assistant") return [];
  const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
  return blocks.filter((block) => block?.type === "tool_use" && block.id).map((block) => String(block.id));
}
