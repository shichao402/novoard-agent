/**
 * 其他成员发来的自然语言。
 * 会话出现在现有聊天页；回复、完成结果和在场信号都经隧道回到调用方。
 * 本机模型可用时由它作答，否则按自我介绍和 Target 说明能力。
 */
import { createSessionStore } from "./session-store.mjs";

export function composeReply({ text, profile, targets }) {
  const abilities = Object.entries(targets ?? {})
    .filter(([, target]) => target?.expose !== "local")
    .map(([id, target]) => {
      const title = target.title || id;
      return target.schedule ? `${title}（安排 ${target.schedule}）` : title;
    });
  const introduction = profile?.introduction || "这台电脑上的 agent";
  const asking = /能|可以|准备|能力|谁/.test(String(text ?? ""));
  const head = asking ? "可以。这些能力由我自己安排，不需要指定 Target。" : "收到。";
  const list = abilities.length ? abilities.join("；") : "还没有对外公布的能力";
  return `${head}\n${introduction}\n我现在能做：${list}`;
}

export function createPeerTalk({ agentId, profile, targets, tunnel, chat, stateDir, log = console, replyWith } = {}) {
  const store = createSessionStore(stateDir);
  const listeners = new Set();
  const watched = new Map();
  const modelSessions = new Map();
  let caller = null;
  let replyState = "completed";
  let currentProfile = profile ?? { role: "", introduction: "" };
  let currentTargets = targets ?? {};
  let currentChat = chat ?? null;

  function emit(event) {
    for (const listener of listeners) {
      try { listener(event); } catch (error) { log.warn?.(`[peer] 订阅回调失败：${error.message}`); }
    }
  }

  function sessionIdFor(from) {
    const clean = String(from || "unknown").replace(/[^a-zA-Z0-9._-]/g, "") || "unknown";
    return `peer-${clean}`;
  }

  function touch(id, title, preview) {
    const now = new Date().toISOString();
    const current = store.get(id);
    const entry = {
      id,
      title,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      preview: String(preview ?? "").slice(0, 80),
      peer: true,
    };
    store.upsert(entry);
    return entry;
  }

  function append(id, event) {
    store.append(id, event);
    emit({ kind: "message", sessionId: id, event });
  }

  function visibleText(text, parts) {
    const lines = [];
    if (text) lines.push(String(text));
    for (const part of Array.isArray(parts) ? parts : []) {
      if (part?.kind === "text" && part.text && part.text !== text) lines.push(part.text);
      else if (part?.kind === "data" && part.data) lines.push(JSON.stringify(part.data));
      else if (part?.kind === "file") lines.push(part.uri || part.file?.uri || part.name || "文件");
    }
    return lines.join("\n");
  }

  function normalizeAnswer(value) {
    if (value && typeof value === "object") {
      return {
        text: String(value.text ?? ""),
        state: value.state === "input-required" ? "input-required" : replyState,
        parts: value.parts,
      };
    }
    return { text: String(value ?? ""), state: replyState, parts: undefined };
  }

  async function answer(message) {
    if (replyWith) return replyWith({ ...message, profile: currentProfile, targets: currentTargets, agentId });
    if (currentChat?.send) {
      try {
        return await askModel(message);
      } catch (error) {
        log.warn?.(`[peer] 模型未能作答，改用本机能力说明：${error.message}`);
      }
    }
    return composeReply({ text: message.text, profile: currentProfile, targets: currentTargets });
  }

  async function askModel({ from, text, peerSessionId }) {
    const title = from || "其他成员";
    let sessionId = modelSessions.get(peerSessionId);
    if (!sessionId) {
      const created = await currentChat.create(title);
      sessionId = created?.session?.id;
      if (!sessionId) throw new Error("没有会话");
      modelSessions.set(peerSessionId, sessionId);
    }
    let reply = "";
    const prompt = [
      `来自成员 ${title} 的消息：`,
      text,
      "",
      "按本机 Target 和自己的安排回答。不要改 Hub 配置，也不要删除 Target，除非本机用户在这条对话里明确同意。",
      "还缺关键信息时调用 novoard_request_detail，等对方下一条消息，不要用脚本审批的恢复。",
      "要执行时调用 novoard_run_target。完成后调用 novoard_report_result。主人在这台电脑上时调用 novoard_signal_presence。",
    ].join("\n");
    await currentChat.send(sessionId, prompt, (event) => {
      if (event?.kind === "assistant" && event.text) reply = event.text;
    });
    if (!reply.trim()) throw new Error("模型没有给出回复");
    return reply.trim();
  }

  function sendBack(text, state, parts) {
    if (!caller?.taskId || !tunnel?.replyToCaller) return { ok: false, reason: "no-caller" };
    tunnel.replyToCaller({
      taskId: caller.taskId,
      to: caller.from,
      text,
      state,
      parts,
      contextId: caller.contextId || caller.taskId,
    });
    return { ok: true };
  }

  async function receive({ from, taskId, contextId, text, parts }) {
    const speaker = String(from || "").trim() || "未知成员";
    const id = sessionIdFor(speaker);
    const shown = visibleText(text, parts);
    const entry = touch(id, speaker, shown);
    emit({ kind: "session", session: entry, focus: true });
    append(id, { kind: "peer", from: speaker, text: shown });
    caller = { from: speaker, taskId, contextId: contextId || taskId };
    replyState = "completed";
    append(id, { kind: "status", text: "正在回复" });
    const reply = normalizeAnswer(await answer({ from: speaker, text: shown, taskId, contextId: caller.contextId, peerSessionId: id }));
    const state = reply.state === "input-required" ? "input-required" : "completed";
    append(id, { kind: "assistant", text: reply.text });
    touch(id, speaker, reply.text);
    sendBack(reply.text, state, reply.parts);
    return { ok: true, sessionId: id, reply: reply.text, state };
  }

  function report(input) {
    const text = typeof input === "string" ? input : input?.text;
    const parts = typeof input === "string" ? undefined : input?.parts;
    const body = String(text ?? "").trim();
    if (!body) return { ok: false, reason: "empty" };
    if (caller) append(sessionIdFor(caller.from), { kind: "status", text: `已向 ${caller.from} 报告：${body}` });
    return sendBack(`完成报告：${body}`, "completed", parts);
  }

  function holdForDetail() {
    replyState = "input-required";
    return { ok: true, state: "input-required" };
  }

  const contexts = new Map();

  function note({ from, text, taskId, contextId, state }) {
    const speaker = String(from || "").trim() || "未知成员";
    const id = sessionIdFor(speaker);
    const shown = String(text ?? "");
    const entry = touch(id, speaker, shown);
    emit({ kind: "session", session: entry, focus: true });
    append(id, { kind: "peer", from: speaker, text: shown, state: state || "" });
    if (contextId) contexts.set(speaker, contextId);
    caller = { from: speaker, taskId, contextId: contextId || taskId };
    return { ok: true, sessionId: id };
  }

  function ask({ to, text, contextId }) {
    const target = String(to || "").trim();
    const body = String(text || "").trim();
    if (!target || !body) return { ok: false, reason: "empty" };
    if (!tunnel?.askMember) return { ok: false, reason: "还不能向其他成员发话" };
    const id = sessionIdFor(target);
    const entry = touch(id, target, body);
    emit({ kind: "session", session: entry, focus: true });
    append(id, { kind: "assistant", text: body });
    const sent = tunnel.askMember({ to: target, text: body, contextId: contextId || contexts.get(target) || "" });
    return { ...sent, sessionId: id };
  }

  function presence(text) {
    const body = String(text ?? "").trim() || "主人已在这台电脑上";
    if (caller) append(sessionIdFor(caller.from), { kind: "status", text: `在场：${body}` });
    return sendBack(`在场：${body}`, "completed");
  }

  function watchRun(taskId, skillId) {
    if (!caller || !taskId) return;
    watched.set(taskId, skillId);
  }

  function reportRun(taskId, state, skillId) {
    const known = watched.get(taskId);
    if (!known) return { ok: false, reason: "not-watched" };
    watched.delete(taskId);
    const name = skillId || known;
    return report(`Target ${name} 已结束，状态 ${state}`);
  }

  return {
    receive,
    report,
    presence,
    holdForDetail,
    note,
    ask,
    watchRun,
    reportRun,
    list: () => store.list(),
    history(id) {
      return { session: store.get(id), messages: store.messages(id) };
    },
    has: (id) => Boolean(store.get(id)),
    remove(id) {
      store.remove(id);
      return { ok: true };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replaceProfile(next) { currentProfile = next ?? currentProfile; },
    replaceChat(next) { currentChat = next ?? null; },
    notifyOwner(text) {
      return tunnel?.notifyOwner?.(text) ?? { ok: false, reason: "通知未装配" };
    },
    replaceTargets(next) { currentTargets = next ?? {}; },
    get caller() { return caller; },
  };
}
