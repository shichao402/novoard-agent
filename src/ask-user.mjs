/**
 * AskUserQuestion 的题目整理和等待闸。
 * stream-json 下 canUseTool 如果只回复 allow、不带 answers，CLI 会丢掉这次放行，
 * 工具就停在没人回答。答案必须按原问题文本放进 updatedInput.answers。
 */

export function normalizeQuestions(input) {
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  const questions = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const question = String(item.question ?? "").trim();
    const header = String(item.header ?? "").trim();
    const text = question || header;
    if (!text) continue;
    const options = [];
    for (const option of Array.isArray(item.options) ? item.options : []) {
      if (typeof option === "string") {
        const label = option.trim();
        if (label) options.push({ label, description: "" });
        continue;
      }
      if (!option || typeof option !== "object") continue;
      const label = String(option.label ?? "").trim();
      if (!label) continue;
      options.push({ label, description: String(option.description ?? "").trim() });
    }
    questions.push({
      question: question || text,
      header: header || text.slice(0, 12),
      options,
      multiSelect: item.multiSelect === true,
    });
  }
  return questions;
}

export function formatAnswers(questions, answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error("回答格式不正确");
  }
  const keyMap = new Map();
  questions.forEach((question, index) => {
    keyMap.set(question.question, question.question);
    keyMap.set(`q_${index}`, question.question);
  });
  const found = new Map();
  for (const [key, value] of Object.entries(answers)) {
    if (key.startsWith("_")) continue;
    const question = keyMap.get(key);
    if (!question) continue;
    const text = Array.isArray(value)
      ? value.map((item) => String(item).trim()).filter(Boolean).join(", ")
      : String(value ?? "").trim();
    if (text) found.set(question, text);
  }
  const missing = questions.find((question) => !found.get(question.question));
  if (missing) throw new Error(`还没有回答：${missing.question}`);
  return Object.fromEntries(questions.map((question) => [question.question, found.get(question.question)]));
}

export function createAskGate() {
  const pending = new Map();

  function wait(questionId, sessionId, questions, signal) {
    return new Promise((resolve, reject) => {
      if (pending.has(questionId)) {
        reject(new Error("这个问题已经在等回答"));
        return;
      }
      const onAbort = () => settle(new Error("提问已取消"));
      function settle(error, value) {
        if (!pending.has(questionId)) return;
        pending.delete(questionId);
        signal?.removeEventListener?.("abort", onAbort);
        if (error) reject(error);
        else resolve(value);
      }
      if (signal?.aborted) {
        reject(new Error("提问已取消"));
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      pending.set(questionId, { sessionId, questions, settle });
    });
  }

  function answer(questionId, sessionId, payload) {
    const waiter = pending.get(questionId);
    if (!waiter || (sessionId && waiter.sessionId && waiter.sessionId !== sessionId)) {
      return { ok: false, gone: true, message: "这次提问已经结束" };
    }
    if (!payload?.skip) {
      try {
        formatAnswers(waiter.questions, payload?.answers);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "回答格式不正确" };
      }
    }
    waiter.settle(null, { skip: payload?.skip === true, answers: payload?.answers });
    return { ok: true };
  }

  function cancelSession(sessionId) {
    const cancelled = [];
    for (const [questionId, waiter] of pending) {
      if (waiter.sessionId === sessionId) {
        cancelled.push(questionId);
        waiter.settle(new Error("提问已取消"));
      }
    }
    return cancelled;
  }

  return { wait, answer, cancelSession };
}
