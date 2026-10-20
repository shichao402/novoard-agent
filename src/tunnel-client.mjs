/**
 * 隧道客户端（契约 §4 agent 侧）：
 * 出站 wss + Bearer agentToken；hello 注册（card、contractVersion、inFlightTaskIds）；
 * 断线不影响在途任务，未确认上行帧本地 JSONL 缓存，重连后重放（同 msgId，hub 侧幂等去重，契约 §4.4）。
 * 下行 a2a 帧：message/send → runner 执行 → 上行 status-update 终态；tasks/cancel → runner.cancel()。
 * artifact（契约 2.0 §7）：上传携带 taskId + sha256，hub 校验 token 身份与任务 member 归属。
 * ops 心跳：agent.ping 定时（hub 侧 PING_TIMEOUT 60s，客户端 25s 间隔）。
 */
import WebSocket from "ws";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { reportAbandonedRuns } from "./run-trace.mjs";

const PING_INTERVAL_MS = 25_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

function callerParts(parts, text) {
  const outgoing = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== "object") continue;
    if (part.kind === "text" && typeof part.text === "string") outgoing.push({ kind: "text", text: part.text });
    else if (part.kind === "data" && part.data && typeof part.data === "object") outgoing.push({ kind: "data", data: part.data });
    else if (part.kind === "file") {
      const uri = typeof part.uri === "string" ? part.uri : part.file?.uri;
      if (typeof uri === "string" && uri) {
        const name = part.name || part.file?.name;
        outgoing.push({ kind: "file", uri, ...(name ? { name } : {}) });
      }
    }
  }
  if (!outgoing.some((part) => part.kind === "text")) outgoing.unshift({ kind: "text", text: String(text ?? "") });
  return outgoing;
}

export function createTunnelClient({ config, card, targets, runner, stateDir, runTraceDir, bootId = "", log = console, fetchImpl = fetch, onFatal, onAgentMessage, onAgentNotice } = {}) {
  if (!config?.ok) throw new Error(`lite-agent 配置无效：${config?.reason}`);
  const { agentId, hubUrl, agentToken, contractVersion } = config;
  const hubHttpUrl = new URL(hubUrl);
  hubHttpUrl.protocol = hubHttpUrl.protocol === "wss:" ? "https:" : "http:";
  const hubHttp = hubHttpUrl.origin;
  const stateDirResolved = stateDir ?? join(process.cwd(), ".agent-state");
  const replayFile = join(stateDirResolved, "replay.jsonl");
  /** taskId → 未确认上行帧（msgId 不变，重放去重靠 hub） */
  const pending = new Map();
  /** 委派查表（可热替换：editor 保存后 replaceTargets，与 runtime/localA2A 同步） */
  let currentTargets = targets;
  let ws = null;
  let connected = false;
  let registered = false;
  let stopped = false;

  /** 热替换委派查表（editor 保存路径）：新委派立即路由到新定义。 */
  function replaceTargets(next) {
    currentTargets = next;
  }
  /** msgId → 已被 hub ack 的taskId（ack 即可清缓存） */
  const ackedTasks = new Set();

  loadPendingFromDisk();

  function loadPendingFromDisk() {
    if (!existsSync(replayFile)) return;
    for (const line of readFileSync(replayFile, "utf8").trim().split("\n").filter(Boolean)) {
      try {
        const env = JSON.parse(line);
        if (env?.taskId && !ackedTasks.has(env.msgId)) pending.set(env.msgId, env);
      } catch {}
    }
  }

  function persistPending() {
    mkdirSync(stateDirResolved, { recursive: true });
    const lines = [...pending.values()].map((e) => JSON.stringify(e));
    writeFileSync(replayFile, lines.length ? lines.join("\n") + "\n" : "");
  }

  const send = (envelope) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(envelope));
  };

  const newMsgId = () => `e-${randomUUID().slice(0, 8)}`;

  /** 上行 a2a 帧：缓存 → 发送 → 等 ack。 */
  function uplink(taskId, body) {
    const msgId = newMsgId();
    const env = { v: 1, kind: "a2a", msgId, taskId, ts: new Date().toISOString(), body };
    pending.set(msgId, env);
    persistPending();
    send(env);
    return msgId;
  }

  function ops(body) {
    send({ v: 1, kind: "ops", msgId: newMsgId(), ts: new Date().toISOString(), body });
  }

  /** 把自然语言回复、完成报告或在场信号送回调用方。Hub 按任务上的调用方转发。 */
  function replyToCaller({ taskId, to, text, state = "completed", parts, contextId }) {
    if (!taskId || !to) return { ok: false, reason: "missing-caller" };
    const outgoing = callerParts(parts, text);
    uplink(taskId, {
      jsonrpc: "2.0",
      method: "message/notification",
      params: {
        message: {
          messageId: `msg-${randomUUID().slice(0, 8)}`,
          role: "agent",
          parts: outgoing,
          contextId: contextId || taskId,
          taskId,
          kind: "status-update",
          metadata: { lane: "agent", to },
          status: { state, message: String(text ?? ""), timestamp: new Date().toISOString() },
        },
      },
    });
    return { ok: true };
  }

  /** 向另一个成员发自然语言。from 由 Hub 按这条连接盖上。 */
  function askMember({ to, text, contextId }) {
    const target = String(to ?? "").trim();
    const body = String(text ?? "").trim();
    if (!target || !body) return { ok: false, reason: "empty" };
    if (!registered) return { ok: false, reason: "not-registered" };
    const taskId = `task-ask-${randomUUID().slice(0, 8)}`;
    send({
      v: 1,
      kind: "a2a",
      msgId: newMsgId(),
      taskId,
      ts: new Date().toISOString(),
      body: {
        jsonrpc: "2.0",
        method: "message/send",
        params: {
          message: {
            role: "user",
            parts: [{ kind: "text", text: body }],
            ...(contextId ? { contextId } : {}),
            metadata: { lane: "agent", to: target },
          },
        },
      },
    });
    return { ok: true, taskId };
  }

  /** 请 Hub 把一句话发给主人（企微）。发送动作在 Hub，本成员只提出请求。 */
  function notifyOwner(text) {
    const body = String(text ?? "").trim();
    if (!body) return { ok: false, reason: "empty" };
    if (!registered) return { ok: false, reason: "not-registered" };
    ops({ type: "notify.owner", text: body });
    return { ok: true };
  }

  /** card.update 上行（editor 保存路径）：帧结构按 frame-card-update schema（type + card）。 */
  function sendCardUpdate(cardOverride) {
    if (!registered) return { ok: false, reason: "not-registered" };
    ops({ type: "card.update", card: cardOverride ?? getCard() });
    return { ok: true };
  }

  async function uploadArtifact(taskId, { name, filePath, content }) {
    if (!/^task-[a-zA-Z0-9-]+$/.test(String(taskId))) throw new Error("artifact taskId 无效");
    const data = content === undefined
      ? (filePath ? readFileSync(filePath) : null)
      : Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    if (!data) throw new Error("artifact 无内容");
    if (data.length > 5 * 1024 * 1024) throw new Error("artifact 超过 5MB 上限");
    const digest = `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const res = await fetchImpl(`${hubHttp}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({
        taskId,
        name,
        content: data.toString("base64"),
        encoding: "base64",
        digest,
      }),
    });
    if (!res.ok) throw new Error(`artifact 上传失败：${res.status}`);
    return res.json();
  }

  /** card 热引用（editor 保存后装配层 replaceCard；hello/card.update 均取最新）。 */
  let currentCard = card;
  function getCard() { return currentCard; }
  function replaceCard(next) { currentCard = next; }

  /** 连接 + hello + 自动重连（指数退避封顶 30s）。 */
  async function start() {
    stopped = false;
    await connectOnce();
  }

  function connectOnce() {
    return new Promise((resolve) => {
      let settled = false;
      ws = new WebSocket(hubUrl, { headers: { Authorization: `Bearer ${agentToken}` } });
      ws.on("open", () => {
        connected = true;
        const inFlightTaskIds = [...new Set([
          ...[...pending.values()].map((envelope) => envelope.taskId),
          ...(runner.runningTasks ?? []).map((task) => task.id),
        ].filter(Boolean))];
        ops({
          type: "agent.hello",
          contractVersion,
          agentId,
          card: getCard(),
          inFlightTaskIds,
          ...(bootId ? { bootId } : {}),
        });
        resolve(true);
      });
      ws.on("message", handleDownlink);
      ws.on("close", () => {
        connected = false;
        registered = false;
        if (stopped) return;
        // 断线重连：在途任务继续跑，终态帧在缓存里等重连重放（契约 §4.4 第 1-2 条）
        scheduleReconnect();
      });
      ws.on("error", (error) => {
        log.error?.(`隧道连接错误：${error.message}`);
        if (!settled) { settled = true; resolve(false); }
      });
    });
  }

  let backoffMs = RETRY_BASE_MS;
  function backoff() {
    const v = backoffMs;
    backoffMs = Math.min(backoffMs * 2, RETRY_MAX_MS);
    return v;
  }

  /** 退避重连（断线与可重试 hello 拒绝共用）。unref：测试/CLI 不被无限重连挡住退出。 */
  function scheduleReconnect() {
    setTimeout(connectOnce, backoff()).unref?.();
  }

  function handleDownlink(raw) {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame.kind === "ops") {
      const body = frame.body ?? {};
      if (body.type === "agent.hello.nack") {
        // instance-conflict：同身份已有别的实例在线（契约 §4.1）。这不是配置错误，
        // 不能走致命退出——那会让后启动的实例直接死掉、用户只能手动重启。
        // 按可重试处理：退避后重连，旧连接若已消失（退出/心跳超时）就会接管成功。
        if (body.reason === "instance-conflict" || body.retryable === true) {
          log.error?.(`同一身份已有实例在线，退避后重试连接（当前退避 ${Math.round(backoffMs / 1000)}s）`);
          // 只关连接：close 处理器统一走 scheduleReconnect，避免这里再排一次造成并发连接
          try { ws?.close(1000, "instance-conflict"); } catch { /* 已关闭 */ }
          return;
        }
        const message = `hello 被拒：${body.reason}（hubVersion ${body.hubVersion ?? "?"}）——检查 contractVersion、Agent Token 与 agentId`;
        log.error?.(message);
        stopped = true;
        try { ws?.close(); } catch {}
        if (onFatal) {
          Promise.resolve(onFatal({ code: "hello-nack", message, detail: body })).catch((error) => {
            log.error?.(`fatal 回调失败：${error?.message ?? error}`);
          });
        } else {
          process.exit(1);
        }
        return;
      }
      if (body.type === "agent.hello.ack") {
        registered = true;
        backoffMs = RETRY_BASE_MS;
        // 重连对账：重放全部未确认上行帧（同 msgId，hub 幂等）
        for (const env of pending.values()) send(env);
        reportAbandonedRuns({
          root: runTraceDir,
          runningTaskIds: (runner.runningTasks ?? []).map((task) => task.id),
          onTrace: (taskId, event) => uplink(taskId, runTraceNotification(taskId, event)),
        });
        log.info?.(`已注册到 hub（agentId=${agentId}，重放 ${pending.size} 个未确认上行帧）`);
      }
      return;
    }
    if (frame.kind === "a2a") {
      handleDelegate(frame);
      return;
    }
    if (frame.kind === "ack") {
      pending.delete(frame.msgId);
      persistPending();
      if (frame.dedup) log.info?.(`hub 报告 ${frame.msgId} 为重复投递（dedup），本地缓存已清`);
      return;
    }
  }

  /** 委派处理：message/send 解析 target → runner.launch；tasks/cancel → runner.cancel；message/resume → runner.resume。 */
  function handleDelegate(env) {
    const body = env.body;
    if (body?.method === "tasks/cancel") {
      runner.cancel(env.taskId);
      return;
    }
    if (body?.method === "message/resume") {
      const r = runner.resume?.(env.taskId);
      if (!r?.ok) {
        uplink(env.taskId, statusNotification(env.taskId, "failed", `恢复失败：${r?.reason ?? "not-suspended"}`));
      }
      return;
    }
    if (body?.method === "message/notification") {
      const notice = body.params?.message ?? {};
      if (notice.metadata?.lane !== "agent") return;
      const text = notice.status?.message || firstText(notice.parts);
      Promise.resolve(onAgentNotice?.({
        from: String(notice.metadata.from ?? ""),
        taskId: env.taskId,
        contextId: notice.contextId || env.taskId,
        text,
        state: notice.status?.state ?? "",
        parts: Array.isArray(notice.parts) ? notice.parts : [],
      })).catch((error) => {
        log.error?.(`[peer] 记录对方回复失败：${error?.message ?? error}`);
      });
      return;
    }
    if (body?.method !== "message/send") return;
    const message = body.params?.message ?? {};
    if (message.metadata?.lane === "agent") {
      const text = firstText(message.parts);
      Promise.resolve(onAgentMessage?.({
        from: String(message.metadata.from ?? ""),
        taskId: env.taskId,
        contextId: message.contextId || env.taskId,
        text,
        parts: Array.isArray(message.parts) ? message.parts : [],
      })).catch((error) => {
        log.error?.(`[peer] 处理成员消息失败：${error?.message ?? error}`);
        uplink(env.taskId, statusNotification(env.taskId, "failed", `成员消息处理失败：${error?.message ?? error}`));
      });
      return;
    }
    const text = firstText(message.parts);
    const parsed = parseTriggerText(text);
    if (!parsed) {
      uplink(env.taskId, statusNotification(env.taskId, "failed", `无法解析委派文本：${text}`));
      return;
    }
    const { skillId, vars } = parsed;
    const runCfg = currentTargets?.[skillId];
    if (!runCfg) {
      uplink(env.taskId, statusNotification(env.taskId, "failed", `unknown target：${skillId}`));
      return;
    }
    runner.launch({
      taskId: env.taskId,
      skillId,
      vars: { ...runCfg.vars, ...vars },
      steps: runCfg.expanded,
      onTerminal: (state, detail) => {
        uplink(env.taskId, statusNotification(env.taskId, state, detail));
      },
      onTrace: (event) => {
        uplink(event.taskId || env.taskId, runTraceNotification(event.taskId || env.taskId, event));
      },
      onProgress: (i, n, d) => {
        // M4 F2 步骤级进度上行（非终态 status-update，hub SSE 透传给委派方）
        uplink(env.taskId, statusNotification(env.taskId, "working", `step ${i}/${n}：${d}`));
      },
    });
  }

  function runTraceNotification(taskId, event) {
    return {
      jsonrpc: "2.0",
      method: "message/notification",
      params: {
        message: {
          messageId: `msg-${randomUUID().slice(0, 8)}`,
          role: "agent",
          parts: [],
          contextId: taskId,
          taskId,
          kind: "run-trace",
          trace: event,
        },
      },
    };
  }

  /** A2A push notification 形状（契约 §4.3 agent 上行）。 */
  function statusNotification(taskId, state, message) {
    return {
      jsonrpc: "2.0",
      method: "message/notification",
      params: {
        message: {
          messageId: `msg-${randomUUID().slice(0, 8)}`,
          role: "agent",
          parts: [],
          contextId: taskId,
          taskId,
          kind: "status-update",
          status: { state, message: message ?? "", timestamp: new Date().toISOString() },
        },
      },
    };
  }

  function parseTriggerText(text) {
    const match = String(text).trim().match(/^run\s+([a-z0-9][a-z0-9-]*)(?:\s+(\{.*\}))?$/);
    if (!match) return null;
    let vars = {};
    if (match[2]) {
      try { vars = JSON.parse(match[2]); } catch { return null; }
    }
    return { skillId: match[1], vars };
  }

  function firstText(parts = []) {
    const part = (Array.isArray(parts) ? parts : []).find((p) => p?.kind === "text");
    return part?.text ?? "";
  }

  const pingTimer = setInterval(() => {
    if (connected) ops({ type: "agent.ping", ts: new Date().toISOString() });
  }, PING_INTERVAL_MS);
  pingTimer.unref?.(); // 不挡测试/CLI 进程退出（close() 时 clearInterval）

  function close() {
    stopped = true;
    clearInterval(pingTimer);
    ws?.close();
  }

  /** 本地磁贴触发的终态上行（ADR-0008：hub 在线时本地与全局状态同步；taskId 以 local- 前缀区分子序列） */
  function uplinkTerminal(taskId, state, message) {
    if (!TERMINAL_OK.has(state)) return;
    uplink(taskId, {
      jsonrpc: "2.0",
      method: "message/notification",
      params: {
        message: {
          messageId: `msg-${randomUUID().slice(0, 8)}`,
          role: "agent",
          parts: [],
          contextId: taskId,
          taskId,
          kind: "status-update",
          status: { state, message: message ?? "", timestamp: new Date().toISOString() },
        },
      },
    });
  }

  return { start, uplink, uplinkTerminal, uploadArtifact, ops, sendCardUpdate, replyToCaller, askMember, notifyOwner, replaceTargets, replaceCard, close, get connected() { return connected; }, get registered() { return registered; } };
}

const TERMINAL_OK = new Set(["completed", "failed", "canceled"]);
