/**
 * 本地 A2A 端点（ADR-0008 载体决策落地；M4 遗留项收口）：
 * mac-home agent 同进程起 127.0.0.1:<port> HTTP 服务，承担两个职责——
 *   1. localhost A2A JSON-RPC 端点（POST /a2a）：磁贴/热键/托盘/CLI 的统一触发入口（PRD-1 触发路径统一），
 *      message/send 直连本地 runtime（不经 hub 隧道），tasks/get 查本地状态；
 *      actor = tile-client，lane = a2a，落 agent 侧审计（与 hub 侧同一份语义，ADR-0004）。
 *   2. 零构建磁贴面板（GET /）：PRD-1 F1 磁贴视图 + SSE 进度（M4 message/stream 语义的本地版）。
 * 本地闭环（PRD-1 AC2）：hub 不在线时本端点完整可用；hub 在线时终态经隧道上行同步给 hub 队列。
 * 鉴权：仅监听 127.0.0.1（本机边界即鉴权边界，契约 §8 单用户试点语义）。
 */
import { createServer } from "node:http";

const TERMINAL = new Set(["completed", "failed", "canceled", "rejected"]);

/** 本地任务表：taskId → { state, status, submittedAt, updatedAt, target, title } （磁贴状态数据源，PRD-1 US5） */
function createLocalTasks() {
  const tasks = new Map();
  return {
    put(task) { tasks.set(task.id, task); },
    get(id) { return tasks.get(id) ?? null; },
    list() { return [...tasks.values()].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1)); },
    lastOf(target) {
      let last = null;
      for (const t of tasks.values()) if (t.target === target && (!last || t.submittedAt > last.submittedAt)) last = t;
      return last;
    },
  };
}

export function createLocalA2A({ port = 0, targets, card, runtime, audit, log = console, triggerHook } = {}) {
  const tasks = createLocalTasks();

  /** 触发本地执行：生成 taskId → runtime.launch → 状态落本地表。 */
  function trigger({ skillId, vars = {} }) {
    const def = targets[skillId];
    if (!def) return { ok: false, reason: `unknown target: ${skillId}` };
    // taskId 用 task-local- 前缀：过 hub 信封 ^task- 校验（终态上行镜像合法），且与 hub 序列（task-YYYYMMDD-NNN）不撞形
    const id = `task-local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const task = {
      id, target: skillId, title: def.title ?? skillId,
      state: "submitted", status: { state: "submitted", message: "" },
      submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    tasks.put(task);
    audit?.({ lane: "a2a", target: skillId, taskId: id, outcome: "submitted", detail: { via: "localhost-a2a" } });
    const r = runtime.launch({
      taskId: id, skillId, vars,
      steps: def.expanded,
      onTerminal: (state, detail) => {
        task.state = state;
        task.status = { state, message: detail ?? "" };
        task.updatedAt = new Date().toISOString();
        emit(id);
        audit?.({ lane: "a2a", target: skillId, taskId: id, outcome: state, detail: { via: "localhost-a2a" } });
        triggerHook?.(state, skillId, id); // hub 在线时终态上行同步（tunnel-client 提供）
      },
      onProgress: (i, n, d) => {
        task.state = "working";
        task.status = { state: "working", message: d };
        task.updatedAt = new Date().toISOString();
        emit(id);
      },
    });
    if (!r.ok) {
      task.state = "failed";
      task.status = { state: "failed", message: r.reason };
      audit?.({ lane: "a2a", target: skillId, taskId: id, outcome: "failed", detail: { reason: r.reason } });
    }
    return { ok: true, task };
  }

  // SSE 订阅（M4 subscribe 语义本地版）：taskId → Set<res>
  const sseListeners = new Map();
  function emit(taskId) {
    const task = tasks.get(taskId);
    for (const res of sseListeners.get(taskId) ?? []) {
      try { res.write(`data: ${JSON.stringify({ kind: "status-update", taskId, status: task.status, final: TERMINAL.has(task.state) })}\n\n`); } catch {}
    }
    if (TERMINAL.has(task.state)) {
      for (const res of sseListeners.get(taskId) ?? []) try { res.end(); } catch {}
      sseListeners.delete(taskId);
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    // 磁贴面板（PRD-1 F1）：零构建单页，读同一份 targets 注册表
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(tilePage());
      return;
    }
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(JSON.stringify({ name: "Novoard Tiles", short_name: "Novoard", start_url: "/", display: "standalone", background_color: "#0f1115", theme_color: "#0f1115" }));
      return;
    }
    // 磁贴数据：targets 全量 + 各 target 最近一次执行（US5 状态点/上次时间）
    if (req.method === "GET" && url.pathname === "/api/tiles") {
      const tiles = Object.entries(targets)
        .filter(([, t]) => t.expose !== "none")
        .map(([id, t]) => {
          const last = tasks.lastOf(id);
          return { id, title: t.title ?? id, requiresApproval: t.requiresApproval === true, icon: t.icon ?? "▶", last: last ? { state: last.state, message: last.status.message, at: last.updatedAt } : null };
        });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ tiles, tasks: tasks.list().slice(0, 20) }));
      return;
    }
    // SSE：订阅指定 task（GET /api/stream/:id）
    if (req.method === "GET" && url.pathname.startsWith("/api/stream/")) {
      const id = url.pathname.slice("/api/stream/".length);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const task = tasks.get(id);
      if (task && TERMINAL.has(task.state)) {
        res.write(`data: ${JSON.stringify({ kind: "status-update", taskId: id, status: task.status, final: true })}\n\n`);
        res.end();
        return;
      }
      if (task) res.write(`data: ${JSON.stringify({ kind: "status-update", taskId: id, status: task.status, final: false })}\n\n`);
      if (!sseListeners.has(id)) sseListeners.set(id, new Set());
      sseListeners.get(id).add(res);
      req.on("close", () => sseListeners.get(id)?.delete(res));
      return;
    }
    // A2A JSON-RPC（POST /a2a）：磁贴/热键/托盘/CLI 统一触发入口
    if (req.method === "POST" && url.pathname === "/a2a") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let rpc;
        try { rpc = JSON.parse(body); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); return; }
        if (rpc.method === "message/send") {
          const parts = rpc.params?.message?.parts ?? [];
          const text = parts.map((p) => p?.text ?? "").join(" ").trim();
          const vars = {};
          for (const p of parts) if (p?.kind === "data" && p.data) Object.assign(vars, p.data);
          const m = text.match(/^(.+?)(?:@(\w+))?$/);
          const skillId = m?.[1]?.trim();
          if (!skillId || !targets[skillId]) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32002, message: `unknown target: ${skillId}` } }));
            return;
          }
          const r = trigger({ skillId, vars });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { id: r.task.id, status: r.task.status, contextId: "", kind: "task", history: [] } }));
          return;
        }
        if (rpc.method === "tasks/get") {
          const id = String(rpc.params?.id ?? "");
          const t = tasks.get(id);
          res.writeHead(200, { "Content-Type": "application/json" });
          if (!t) { res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32001, message: "task not found" } })); return; }
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { id: t.id, status: t.status, kind: "task", history: [] } }));
          return;
        }
        if (rpc.method === "tasks/cancel") {
          const id = String(rpc.params?.id ?? "");
          const t = tasks.get(id);
          if (!t) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32001, message: "task not found" } })); return; }
          runtime.cancel(id);
          t.state = "canceled";
          t.status = { state: "canceled", message: "canceled by tile" };
          t.updatedAt = new Date().toISOString();
          emit(id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { id: t.id, status: t.status, kind: "task", history: [] } }));
          return;
        }
        if (rpc.method === "tasks/approve" || rpc.method === "message/resume") {
          const id = String(rpc.params?.id ?? rpc.params?.taskId ?? "");
          const t = tasks.get(id);
          if (!t) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32001, message: "task not found" } })); return; }
          const r = runtime.resume?.(id) ?? { ok: false, reason: "not-suspended" };
          if (!r.ok) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32004, message: `恢复失败：${r.reason}` } })); return; }
          t.state = "working";
          t.status = { state: "working", message: "approval-resumed" };
          t.updatedAt = new Date().toISOString();
          emit(id);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { id: t.id, status: t.status, kind: "task", history: [] } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `method not found: ${rpc.method}` } }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  /** 零构建磁贴页（PRD-1 F1/US5；PWA 基础件）。 */
  function tilePage() {
    return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novoard 磁贴</title>
<link rel="manifest" href="/manifest.webmanifest">
<style>
  body { font-family: -apple-system, "PingFang SC", sans-serif; background: #0f1115; color: #e6e8ee; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b93a7; font-size: 12px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .tile { background: #1a1e26; border: 1px solid #262c38; border-radius: 12px; padding: 14px; cursor: pointer; transition: all .15s; }
  .tile:hover { border-color: #4a90d9; transform: translateY(-1px); }
  .tile .icon { font-size: 22px; }
  .tile .title { font-weight: 600; font-size: 14px; margin: 6px 0 4px; }
  .tile .meta { font-size: 11px; color: #8b93a7; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
  .dot.running, .dot.submitted { background: #f5a623; animation: pulse 1s infinite; }
  .dot.completed { background: #34c759; }
  .dot.failed, .dot.canceled, .dot.rejected { background: #ff5f57; }
  .dot.input-required { background: #4a90d9; }
  @keyframes pulse { 50% { opacity: .4; } }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #2a3040; padding: 8px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .3s; }
  .toast.show { opacity: 1; }
</style></head><body>
<h1>Novoard</h1><div class="sub">磁贴触发 · 本地闭环（hub 离线可用）</div>
<div class="grid" id="grid"></div>
<div class="toast" id="toast"></div>
<script>
  async function load() {
    const r = await fetch("/api/tiles");
    const { tiles } = await r.json();
    grid.innerHTML = tiles.map((t) => {
      const d = t.last?.state ?? "idle";
      const at = t.last?.at ? new Date(t.last.at).toLocaleTimeString() : "—";
      return \`<div class="tile" onclick="fire('\${t.id}')">
        <div class="icon">\${t.icon}</div><div class="title">\${t.title}</div>
        <div class="meta"><span class="dot \${d}"></span>\${d} · \${at}</div>
      </div>\`;
    }).join("");
  }
  async function fire(id) {
    toast(\`触发 \${id}…\`);
    const r = await fetch("/a2a", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { messageId: "m" + Date.now(), role: "user", parts: [{ kind: "text", text: id }] } } }) });
    const b = await r.json();
    if (b.error) { toast(b.error.message); return; }
    const es = new EventSource("/api/stream/" + b.result.id);
    es.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      toast(\`\${id}: \${f.status.state} \${f.status.message ?? ""}\`.slice(0, 80));
      if (f.final) { es.close(); load(); }
    };
  }
  function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 3000); }
  load();
  setInterval(load, 4000);
</script></body></html>`;
  }

  return {
    server,
    trigger,
    tasks,
    start() {
      return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address())));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
