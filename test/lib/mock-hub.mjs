/**
 * 契约级 mock hub（agent 仓测试独立性的关键件）：
 * 只实现 agent 测试需要的行为面——Bearer 身份绑定、hello 注册、artifact 归属、
 * card 聚合、委派下发、终态上行（ack）、ping/pong、agent 重连重放。
 * 行为对齐 hub 仓 attachTunnel + registry（契约 §3 §4 §8）。
 * 契约漂移防线：mock 与 agent 同仓构建（contract/frames 校验帧合法性），
 * 真实 hub 兼容性由 hub 仓自己的 e2e 保障。
 */
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createFrameValidator } from "../../src/contract/frames.mjs";

export async function createMockHub({ port = 0, tokens = {}, log = { info() {}, error() {} } } = {}) {
  const validate = createFrameValidator();
  const members = new Map(); // agentId -> { ws, card, lastSeen }
  const tasks = new Map(); // taskId -> { state, target, member, events: [] }
  const frames = []; // 收到的全部 ops 帧（测试断言用）
  const tokenToAgent = new Map(Object.entries(tokens).map(([agentId, token]) => [String(token), agentId]));
  const artifacts = [];
  const pendingOffline = []; // hello 后需补下发的任务（模拟 M2 flush）
  const relays = [];
  const wecom = [];

  /** 委派对齐契约：a2a 信封（taskId 信封层）+ body message/send + run 文本（agent handleDelegate 同款解析） */
  function delegate(ws, { taskId, target, vars }) {
    const text = `run ${target}${vars && Object.keys(vars).length ? ` ${JSON.stringify(vars)}` : ""}`;
    const frame = {
      v: 1, kind: "a2a", msgId: `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: new Date().toISOString(), taskId,
      body: {
        jsonrpc: "2.0", method: "message/send",
        params: { message: { messageId: `msg-${Date.now()}`, role: "user", parts: [{ kind: "text", text }] } },
      },
    };
    try {
      ws.send(JSON.stringify(frame));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  /** Hub 盖上调用方身份后，把自然语言交给目标成员。from 只来自这里，不接受报文里自带的 from。 */
  function ask(ws, { taskId, from, text }) {
    const frame = {
      v: 1, kind: "a2a", msgId: `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: new Date().toISOString(), taskId,
      body: {
        jsonrpc: "2.0", method: "message/send",
        params: {
          message: {
            messageId: `msg-${Date.now()}`,
            role: "user",
            parts: [{ kind: "text", text: String(text ?? "") }],
            contextId: taskId,
            metadata: { lane: "agent", from },
          },
        },
      },
    };
    try {
      ws.send(JSON.stringify(frame));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  const httpServer = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/api/cards") {
      const token = String(req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
      if (!tokenToAgent.get(token)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "agent token required" }));
        return;
      }
      const cards = [...members.entries()].map(([agentId, member]) => ({ agentId, card: member.card }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cards }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/artifacts") {
      const token = String(req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
      const agentId = tokenToAgent.get(token);
      if (!agentId) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "agent token required" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const payload = JSON.parse(body || "{}");
        const task = tasks.get(payload.taskId);
        if (!task || task.member !== agentId) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "task not found" }));
          return;
        }
        const content = Buffer.from(String(payload.content ?? ""), "base64");
        const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
        if (payload.encoding !== "base64" || payload.digest !== digest) {
          res.writeHead(422, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "digest-mismatch" }));
          return;
        }
        artifacts.push({ ...payload, member: agentId, target: task.target });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({
          artifact: {
            name: payload.name,
            parts: [{ kind: "file", uri: `/api/artifacts/art_mock_${artifacts.length}` }],
            metadata: { taskId: payload.taskId, member: agentId, target: task.target, digest: payload.digest },
          },
        }));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/trigger" || req.method === "POST" && url.pathname === "/api/trigger") {
      // 简化触发：body { target } → 委派给 owner → 状态机 working → 终态由 agent ack 驱动
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { target, vars } = JSON.parse(body || "{}");
          const member = [...members.values()].find((m) => m.card?.skills?.some((s) => s.id === target));
          if (!member) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, reason: "no-such-skill" }));
            return;
          }
          const taskId = `task-mock-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const agentId = [...members.entries()].find(([, m]) => m === member)?.[0];
          const sent = delegate(member.ws, { taskId, target, vars });
          tasks.set(taskId, { state: sent.ok ? "working" : "failed", target, member: agentId, events: [] });
          res.writeHead(sent.ok ? 202 : 502, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: sent.ok, taskId, reason: sent.reason ?? null }));
        } catch (error) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: error.message }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  function sendOps(ws, body) {
    const frame = { v: 1, kind: "ops", msgId: `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: new Date().toISOString(), body };
    const env = validate.envelope(frame);
    if (!env.ok) return { ok: false, reason: "envelope invalid" };
    try {
      ws.send(JSON.stringify({ ...frame, body }));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/tunnel") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    // 鉴权对齐真实 hub（契约 §8）：Bearer agent token，错 token 回 HTTP 401
    const header = req.headers.authorization ?? "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    const token = match?.[1] ?? url.searchParams.get("token") ?? "";
    const authenticatedAgentId = tokenToAgent.get(token);
    if (!authenticatedAgentId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    req.authenticatedAgentId = authenticatedAgentId;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    const authenticatedAgentId = req.authenticatedAgentId;
    let memberId = null;
    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      const env = validate.envelope(frame);
      if (!env.ok) return;
      frames.push(frame);
      // a2a 上行（终态/进度 notification）：状态机翻 tasks + 回信封 ack（契约 §4.4）
      if (frame.kind === "a2a" && frame.body?.method === "message/notification") {
        const status = frame.body.params?.message?.status;
        const taskId = frame.taskId;
        const t = tasks.get(taskId);
        if (t) {
          const state = status?.state;
          if (state && state !== "working") t.state = state;
          t.events.push(frame.body);
        }
        const to = frame.body.params?.message?.metadata?.to;
        if (to) {
          relays.push({ to, taskId, body: frame.body });
          const caller = members.get(to);
          if (caller?.ws && caller.ws !== ws) {
            try { caller.ws.send(JSON.stringify(frame)); } catch { /* 调用方刚断开 */ }
          }
        }
        ws.send(JSON.stringify({ v: 1, kind: "ack", msgId: `ack-${frame.msgId}`, dedup: false }));
        return;
      }
      if (frame.body?.type === "agent.hello") {
        const hello = frame.body;
        if (!validate.opsBody("agent.hello", hello).ok) {
          ws.close(4002, "hello-invalid");
          return;
        }
        if (hello.agentId !== authenticatedAgentId) {
          sendOps(ws, { type: "agent.hello.nack", reason: "agent-identity-mismatch", hubVersion: "2.0" });
          return;
        }
        memberId = hello.agentId;
        members.set(hello.agentId, { ws, card: hello.card, lastSeen: Date.now() });
        // 确认对齐契约 §3：ops 帧 agent.hello.ack（agent 侧据 body.type 翻 registered）
        ws.send(JSON.stringify({ v: 1, kind: "ops", msgId: `e-helloack-${Date.now()}`, ts: new Date().toISOString(), body: { type: "agent.hello.ack", inFlightTaskIds: hello.inFlightTaskIds ?? [] } }));
        // 信封 ack 一并回（未确认帧重放机制的应答）
        ws.send(JSON.stringify({ v: 1, kind: "ack", msgId: `ack-${frame.msgId}`, dedup: false }));
        // M2 flush 模拟：hello 后补下发 pendingOffline
        for (const t of pendingOffline.filter((t2) => t2.member === hello.agentId)) {
          delegate(ws, { taskId: t.taskId, target: t.target ?? t.skillId, vars: t.vars });
        }
      } else if (frame.body?.type === "agent.ping") {
        ws.send(JSON.stringify({ v: 1, kind: "ack", msgId: `ack-${frame.msgId}`, dedup: false }));
      } else if (frame.body?.type === "card.update") {
        const m = members.get(frame.body.agentId ?? memberId);
        if (m) {
          m.card = frame.body.card;
          ws.send(JSON.stringify({ v: 1, kind: "ack", msgId: `ack-${frame.msgId}`, dedup: false }));
        }
      } else if (frame.body?.type === "notify.owner") {
        wecom.push({ from: memberId, text: String(frame.body.text ?? ""), at: new Date().toISOString() });
        ws.send(JSON.stringify({ v: 1, kind: "ack", msgId: `ack-${frame.msgId}`, dedup: false }));
      } else if (frame.body?.type === "task.terminal") {
        const t = tasks.get(frame.body.taskId);
        if (t) {
          t.state = frame.body.state;
          t.events.push(frame.body);
        }
        ws.send(JSON.stringify({ v: 1, kind: "ack", msgId: `ack-${frame.msgId}`, body: { ack: frame.msgId, for: "task.terminal" } }));
      }
    });
    ws.on("close", () => {
      if (memberId) members.delete(memberId);
    });
  });

  const instance = {
    server: httpServer,
    wss,
    async close() {
      for (const [, m] of members) try { m.ws.close(); } catch { /* noop */ }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
    /** 测试断言面：成员注册表、任务状态、收到的帧 */
    get members() { return members; },
    get tasks() { return tasks; },
    get frames() { return frames; },
    get artifacts() { return artifacts; },
    get relays() { return relays; },
    get wecom() { return wecom; },
    listCards() {
      return [...members.entries()].map(([agentId, member]) => ({ agentId, card: member.card }));
    },
    /** 智脑选定成员后发自然语言。from 由 Hub 盖章。 */
    ask(agentId, { from, text, taskId }) {
      const member = members.get(agentId);
      if (!member) return { ok: false, reason: "member-offline" };
      const tid = taskId ?? `task-mock-${Date.now()}`;
      const sent = ask(member.ws, { taskId: tid, from, text });
      if (sent.ok) tasks.set(tid, { state: "working", target: "converse", member: agentId, caller: from, events: [] });
      return { ...sent, taskId: tid };
    },
    /** 手动委派（契约形态 a2a message/send，绕过 HTTP） */
    delegateTo(agentId, { taskId, target, vars }) {
      const m = members.get(agentId);
      if (!m) return { ok: false, reason: "member-offline" };
      const tid = taskId ?? `task-mock-${Date.now()}`;
      const r = delegate(m.ws, { taskId: tid, target, vars });
      if (r.ok) tasks.set(tid, { state: "working", target, member: agentId, events: [] });
      return r;
    },
    /** 模拟 M2：挂起离线任务供 hello flush 验证 */
    queueOffline(task) {
      pendingOffline.push(task);
    },
  };
  // 构造即监听（对齐真实 createHub：返回时 server 已 listen，address() 可用）
  await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", () => resolve()));
  return instance;
}
