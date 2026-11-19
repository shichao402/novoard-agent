/**
 * 聊天记录 → 界面。纯函数，不持有状态。
 *
 * 界面只是会话记录（jsonl）的视图：历史接口和实时推送给的都是记录里的行，
 * 每行带 seq（行号），按 seq 合并去重。界面上的一切（气泡、是否在跑、
 * 问答和授权是否还能答）都从这些行推出来，本地不另造。
 */
import { applyToolEvent, settleCalls } from "./chat-tools.mjs";

/** 把新收到的行并进已有记录：按 seq 去重、排序。没有 seq 的行（老数据）保持原位追加。 */
export function mergeLog(log, events) {
  const incoming = (Array.isArray(events) ? events : []).filter(Boolean);
  if (incoming.length === 0) return log;
  const bySeq = new Map();
  const loose = [];
  for (const row of [...log, ...incoming]) {
    if (Number.isInteger(row.seq)) bySeq.set(row.seq, row);
    else loose.push(row);
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return loose.length ? [...ordered, ...loose] : ordered;
}

/** 最后一条 turn 行说了算；记录里还没有 turn 行（老会话、或历史只取了尾部）时用会话索引上的 running。 */
export function turnRunning(log, fallback = false) {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const row = log[index];
    if (row?.kind === "turn") return row.state === "running";
  }
  return Boolean(fallback);
}

/** 当前这一轮的进度：开始时间、最后一行的时间、正在跑的工具。没有在跑时返回 null。 */
export function turnProgress(log, running, fallbackStartedAt) {
  if (!running) return null;
  let startedAt = fallbackStartedAt || "";
  let start = 0;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const row = log[index];
    if (row?.kind === "turn" && row.state === "running") {
      startedAt = row.at || startedAt;
      start = index;
      break;
    }
  }
  const last = log[log.length - 1];
  let calls = [];
  for (let index = start; index < log.length; index += 1) {
    const row = log[index];
    if (row?.kind === "tool" || row?.kind === "tool_result") {
      if (row.kind === "tool" && row.name === "AskUserQuestion") continue;
      calls = applyToolEvent(calls, row);
    }
  }
  const runningCall = [...calls].reverse().find((call) => call.status === "running");
  return {
    startedAt,
    lastAt: last?.at || startedAt,
    tool: runningCall?.title || "",
  };
}

function textBubble(role, text, key) {
  return { id: `${role}-${key}`, role, text };
}

function toBubble(event, key) {
  if (event.kind === "peer" && event.text) return textBubble("user", event.from ? `${event.from}：${event.text}` : event.text, key);
  if (event.kind === "user" && event.text) return textBubble("user", event.text, key);
  if (event.kind === "assistant" && event.text) return textBubble("assistant", event.text, key);
  if (event.kind === "error" && event.text) return textBubble("error", event.text, key);
  if (event.kind === "status" && event.text) return textBubble("status", event.text, key);
  if (event.kind === "done" && event.ok === false && event.text) return textBubble("error", event.text, key);
  return null;
}

/** 一轮结束了：没答的问答、没批的授权、没回结果的工具都收尾。 */
function settle(bubbles) {
  for (let index = 0; index < bubbles.length; index += 1) {
    const item = bubbles[index];
    if (item.role === "question" && item.pending) bubbles[index] = { ...item, pending: false, skipped: true };
    else if (item.role === "approval" && !item.decision) bubbles[index] = { ...item, decision: "cancel" };
    else if (item.role === "tools") {
      const calls = settleCalls(item.calls);
      if (calls !== item.calls) bubbles[index] = { ...item, calls };
    }
  }
}

/**
 * 记录 → 气泡。气泡 id 取自记录（seq / questionId / approvalId），同一份记录每次推出同样的 id，
 * 这样滚动区按 id 记的高度、展开状态都不会因为重算而错位。
 */
export function buildBubbles(log, running = false) {
  const bubbles = [];
  const questions = new Map();
  const approvals = new Map();
  // 旧记录里 AskUserQuestion 的结果没带 id，紧跟在问答之后，跳过一条
  let skipLegacyAnswer = false;
  log.forEach((event, index) => {
    if (!event) return;
    const key = Number.isInteger(event.seq) ? event.seq : `i${index}`;
    if (event.kind === "turn") {
      if (event.state !== "idle") return;
      settle(bubbles);
      if (event.outcome === "interrupted") bubbles.push(textBubble("status", "这一轮已停止", key));
      return;
    }
    if (event.kind === "question" && event.questionId) {
      if (questions.has(event.questionId)) return;
      const item = {
        id: `question-${event.questionId}`,
        role: "question",
        questionId: event.questionId,
        questions: event.questions ?? [],
        pending: true,
      };
      questions.set(event.questionId, bubbles.length);
      bubbles.push(item);
      skipLegacyAnswer = true;
      return;
    }
    if (event.kind === "answer" && event.questionId) {
      const at = questions.get(event.questionId);
      if (at !== undefined) bubbles[at] = { ...bubbles[at], pending: false, answers: event.answers, skipped: Boolean(event.skipped) };
      return;
    }
    if (event.kind === "tool_result" && !event.toolUseId && skipLegacyAnswer) {
      skipLegacyAnswer = false;
      return;
    }
    if (event.kind === "tool" || event.kind === "assistant") skipLegacyAnswer = false;
    if (event.kind === "approval" && event.approvalId) {
      if (approvals.has(event.approvalId)) return;
      approvals.set(event.approvalId, bubbles.length);
      bubbles.push({
        id: `approval-${event.approvalId}`,
        role: "approval",
        approvalId: event.approvalId,
        tool: event.tool || "工具",
        summary: event.summary || "",
        detail: event.detail || "",
        reason: event.reason || "",
      });
      return;
    }
    if (event.kind === "approval_result" && event.approvalId) {
      const at = approvals.get(event.approvalId);
      if (at !== undefined) bubbles[at] = { ...bubbles[at], decision: event.decision ?? "cancel" };
      return;
    }
    if (event.kind === "tool" && event.name === "AskUserQuestion") return;
    if (event.kind === "tool" || event.kind === "tool_result") {
      // 结果可能落在中间夹了状态行的更早一组里，按 id 往回找
      if (event.kind === "tool_result" && event.toolUseId) {
        for (let cursor = bubbles.length - 1; cursor >= 0; cursor -= 1) {
          const item = bubbles[cursor];
          if (item.role === "tools" && item.calls.some((call) => call.toolUseId === event.toolUseId)) {
            bubbles[cursor] = { ...item, calls: applyToolEvent(item.calls, event) };
            return;
          }
        }
      }
      const last = bubbles[bubbles.length - 1];
      if (last && last.role === "tools") bubbles[bubbles.length - 1] = { ...last, calls: applyToolEvent(last.calls, event) };
      else bubbles.push({ id: `tools-${key}`, role: "tools", calls: applyToolEvent([], event) });
      return;
    }
    const next = toBubble(event, key);
    if (next) bubbles.push(next);
  });
  if (!running) settle(bubbles);
  return bubbles;
}
