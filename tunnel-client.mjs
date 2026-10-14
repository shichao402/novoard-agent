/**
 * 隧道客户端（契约 §4 agent 侧）：
 * 出站 wss + Bearer agentToken；hello 注册（card、contractVersion、inFlightTaskIds）；
 * 断线不影响在途任务，未确认上行帧本地 JSONL 缓存，重连后重放（同 msgId，hub 侧幂等去重，契约 §4.4）。
 * 下行 a2a 帧：message/send → runner 执行 → 上行 status-update 终态；tasks/cancel → runner.cancel()。
 * artifact（契约 §7）：产出文件走 POST /api/artifacts（agent token 鉴权，5MB 上限）。
 * ops 心跳：agent.ping 定时（hub 侧 PING_TIMEOUT 60s，客户端 25s 间隔）。
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const PING_INTERVAL_MS = 25_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export function createTunnelClient({ config, card, targets, runner, stateDir, log = console, fetchImpl = fetch } = {}) {
  if (!config?.ok) throw new Error(`lite-agent 配置无效：${config?.reason}`);
  const { agentId, hubUrl, agentToken, contractVersion } = config;
  const hubHttp = hubUrl.replace(/^ws/, "http");
  const stateDirResolved = stateDir ?? join(process.cwd(), ".agent-state");
  const replayFile = join(stateDirResolved, "replay.jsonl");
  /** taskId → 未确认上行帧（msgId 不变，重放去重靠 hub） */
  const pending = new Map();
  let ws = null;
  let connected = false;
  let registered = false;
  let stopped = false;
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

  async function uploadArtifact(taskId, { name, filePath, content }) {
    const data = content ?? (filePath ? readFileSync(filePath, "utf8") : "");
    if (!data) throw new Error("artifact 无内容");
    const res = await fetchImpl(`${hubHttp}/api/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ name, data: String(data) }),
    });
    if (!res.ok) throw new Error(`artifact 上传失败：${res.status}`);
    return res.json();
  }

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
        const inFlightTaskIds = [...new Set([...pending.values()].map((e) => e.taskId))];
        ops({
          type: "agent.hello",
          contractVersion,
          agentId,
          token: agentToken,
          card,
          inFlightTaskIds,
        });
        resolve(true);
      });
      ws.on("message", handleDownlink);
      ws.on("close", () => {
        connected = false;
        registered = false;
        if (stopped) return;
        // 断线重连：在途任务继续跑，终态帧在缓存里等重连重放（契约 §4.4 第 1-2 条）
        setTimeout(connectOnce, backoff());
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

  function handleDownlink(raw) {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame.kind === "ops") {
      const body = frame.body ?? {};
      if (body.type === "agent.hello.nack") {
        log.error?.(`hello 被拒：${body.reason}（hubVersion ${body.hubVersion ?? "?"}）——检查 contractVersion 与 skill 冲突`);
        process.exit(1);
      }
      if (body.type === "agent.hello.ack") {
        registered = true;
        backoffMs = RETRY_BASE_MS;
        // 重连对账：重放全部未确认上行帧（同 msgId，hub 幂等）
        for (const env of pending.values()) send(env);
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
    if (body?.method !== "message/send") return;
    const message = body.params?.message ?? {};
    const text = firstText(message.parts);
    const parsed = parseTriggerText(text);
    if (!parsed) {
      uplink(env.taskId, statusNotification(env.taskId, "failed", `无法解析委派文本：${text}`));
      return;
    }
    const { skillId, vars } = parsed;
    const runCfg = targets?.[skillId];
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
      onProgress: (i, n, d) => {
        // M4 F2 步骤级进度上行（非终态 status-update，hub SSE 透传给委派方）
        uplink(env.taskId, statusNotification(env.taskId, "working", `step ${i}/${n}：${d}`));
      },
    });
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

  function close() {
    stopped = true;
    clearInterval(pingTimer);
    ws?.close();
  }

  return { start, uplink, uploadArtifact, ops, close, get connected() { return connected; }, get registered() { return registered; } };
}
