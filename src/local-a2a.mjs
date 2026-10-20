/**
 * 本地 A2A / 控制台端点（ADR-0008 载体决策落地；M4 遗留项收口）：
 * agent 同进程起 HTTP 服务。Windows、macOS、Linux 用同一套接口。
 *   1. A2A JSON-RPC（POST /a2a）：磁贴/热键/托盘/CLI 的统一触发入口（PRD-1 触发路径统一），
 *      message/send 直连本地 runtime（不经 hub 隧道），tasks/get 查本地状态；
 *      actor = tile-client，lane = a2a，落 agent 侧审计（与 hub 侧同一份语义，ADR-0004）。
 *   2. 控制台 API，以及可选的同一份 React 控制台静态资源。界面不在这里另写一套。
 * 默认只监听回环。uiHost 配成非回环地址时，同一服务对机器网络或公网开放，并要求独立 uiToken。
 * 本地闭环（PRD-1 AC2）：hub 不在线时本端点完整可用；hub 在线时终态经隧道上行同步给 hub 队列。
 */
import { createServer } from "node:http";
import { isIP } from "node:net";
import { serveConsole } from "./console-ui.mjs";
import { createUiAccess, isLoopbackHost, uiLoginPage } from "./ui-access.mjs";
import { readJsonlTail } from "./jsonl.mjs";
import { pageLogFile } from "./log-page.mjs";
import { listShortcutRuns, shortcutRunFile } from "./shortcut-log.mjs";

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

/** 桌面壳页面来源：Windows 的 WebView 用 http(s)://tauri.localhost，
 *  macOS/Linux 则用自定义 scheme（tauri://localhost、ipc://localhost）——两者的 hostname 都是 localhost，
 *  只比对 hostname 会把 macOS 的壳页面误判成跨站，故单独按 scheme 识别。 */
const DESKTOP_SHELL_HOSTS = new Set(["tauri.localhost", "ipc.localhost"]);
const DESKTOP_SHELL_SCHEMES = new Set(["tauri:", "ipc:"]);

function isDesktopShellOrigin(parsed) {
  if (DESKTOP_SHELL_SCHEMES.has(parsed.protocol)) return isLoopbackHost(parsed.hostname);
  return DESKTOP_SHELL_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

/** 写端点同源校验（localhost HTTP 服务标准加固，setup 向导复用导出）：Host 必须本机回环；带 Origin 时必须同源。
 *  挡跨站表单 POST（浏览器不给跨域 PUT 发简单请求预检外的都带 Origin）与 DNS rebinding。
 *  桌面壳页面来自 tauri.localhost / tauri://localhost，只在请求 Host 已是回环时放行。 */
export function sameOrigin(req, { allowRemote = false } = {}) {
  let host = String(req.headers.host ?? "");
  if (host.startsWith("[")) host = host.slice(0, host.indexOf("]") + 1); // [::1] / [::1]:port
  else host = host.split(":")[0];
  const hostname = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (allowRemote) {
    if (hostname !== "localhost" && isIP(hostname) === 0) return false;
  } else if (!isLoopbackHost(hostname)) {
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    const originHost = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (originHost === hostname) return true;
    if (isLoopbackHost(hostname) && isDesktopShellOrigin(parsed)) return true;
    return false;
  }
  return true;
}

/** 桌面 WebView 与回环页面访问本机 API 时补上 CORS；其它来源不发允许头。 */
export function handleDesktopCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return false;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    parsed = null;
  }
  const originHost = parsed ? parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase() : "";
  const allowed = isLoopbackHost(originHost) || (parsed !== null && isDesktopShellOrigin(parsed));
  if (!allowed) {
    if (req.method === "OPTIONS") {
      res.writeHead(403);
      res.end();
      return true;
    }
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

export function createLocalA2A({ port = 0, host = "127.0.0.1", uiToken = "", uiRoot = null, targets, card, runtime, audit, log = console, triggerHook, store, onTargetsSaved, status, settings, codebuddy, activityFile, logFile, shortcutLogDir, chat, peer, profile } = {}) {
  const access = createUiAccess({ host, token: uiToken });
  const tasks = createLocalTasks();
  /** 热替换后的 targets 注册表（editor 保存后 onTargetsSaved 装配层刷新；与 runtime replaceTargets 同步） */
  let currentTargets = targets;
  const getTargets = () => currentTargets ?? {};

  /** 触发本地执行：生成 taskId → runtime.launch → 状态落本地表。 */
  function trigger({ skillId, vars = {} }) {
    const def = getTargets()[skillId];
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
    } else if (r.log) {
      task.log = r.log;
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

  function json(res, status, body) {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }

  const server = createServer((req, res) => {
    if (handleDesktopCors(req, res)) return;
    const url = new URL(req.url, "http://127.0.0.1");
    if (access.remote && req.method === "GET" && url.pathname === "/login") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(uiLoginPage());
      return;
    }
    if (access.remote && req.method === "POST" && url.pathname === "/api/ui/login") {
      if (!sameOrigin(req, { allowRemote: true })) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "登录请求来源不合法" }));
        return;
      }
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: body.reason }));
          return;
        }
        if (!access.authenticate(body.data?.token)) {
          res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: false, reason: "UI Token 无效" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Set-Cookie": access.setCookieHeader(),
        });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (access.rejectUnauthorized(req, res, url)) return;
    if (req.method === "GET" && url.pathname === "/api/runtime") {
      const live = status?.() ?? {};
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        phase: "agent",
        agentId: card?.name ?? null,
        uiRemote: access.remote,
        hubConnected: live.hubConnected === true,
        hubRegistered: live.hubRegistered === true,
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      if (!settings?.read) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "设置接口未装配" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, ...settings.read() }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/setup/test") {
      if (!settings?.test) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "连接测试未装配" }));
        return;
      }
      if (!sameOrigin(req, { allowRemote: access.remote })) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "写端点来源不合法" }));
        return;
      }
      readJsonBody(req).then(async (body) => {
        if (!body.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: body.reason }));
          return;
        }
        const result = await settings.test(body.data ?? {});
        res.writeHead(result.ok ? 200 : 422, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(result));
      });
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      if (!settings?.save) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "设置接口未装配" }));
        return;
      }
      if (!sameOrigin(req, { allowRemote: access.remote })) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, reason: "写端点来源不合法" }));
        return;
      }
      readJsonBody(req).then((body) => {
        if (!body.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, reason: body.reason }));
          return;
        }
        const saved = settings.save(body.data ?? {});
        if (!saved.ok) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, errors: saved.errors ?? [saved.reason] }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, restartRequired: true, agentId: saved.config.agentId }));
      });
      return;
    }
    // 编辑器数据源：盘上定义（YAML 原文 + 解析后 targets + 平台提示）
    if (req.method === "GET" && url.pathname === "/api/targets") {
      if (!store) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "编辑器未装配（store 缺失）" })); return; }
      const r = store.read();
      res.writeHead(r.ok ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
      return;
    }
    // 编辑器保存：校验 → 备份 → 原子写 → 热替换 + card.update（经 onTargetsSaved 回调到装配层）
    if (req.method === "PUT" && url.pathname === "/api/targets") {
      if (!store) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "编辑器未装配（store 缺失）" })); return; }
      if (!sameOrigin(req, { allowRemote: access.remote })) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "写端点来源不合法" })); return; }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, errors: ["JSON 解析失败"] })); return; }
        const saved = store.save(parsed);
        if (!saved.ok) { res.writeHead(422, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, errors: saved.errors ?? [saved.reason] })); return; }
        audit?.({ lane: "local", target: "targets", outcome: "accepted", detail: { via: "editor", count: Object.keys(saved.raw).length, targets: Object.keys(saved.raw) } });
        onTargetsSaved?.(saved);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: Object.keys(saved.raw).length }));
      });
      return;
    }
    // 磁贴数据：targets 全量 + 各 target 最近一次执行（US5 状态点/上次时间）
    if (req.method === "GET" && url.pathname === "/api/tiles") {
      const tiles = Object.entries(getTargets())
        .filter(([, t]) => t.expose !== "none")
        .map(([id, t]) => {
          const last = tasks.lastOf(id);
          return { id, title: t.title ?? id, requiresApproval: t.requiresApproval === true, concurrency: t.concurrency ?? 1, timeout: t.timeout ?? "10m", icon: t.icon ?? "▶", last: last ? { state: last.state, message: last.status.message, at: last.updatedAt, log: last.log ?? null } : null };
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
      if (!sameOrigin(req, { allowRemote: access.remote })) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32003, message: "请求来源不合法" } }));
        return;
      }
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
          if (!skillId || !getTargets()[skillId]) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32002, message: `unknown target: ${skillId}` } }));
            return;
          }
          const r = trigger({ skillId, vars });
          if (rpc.params?.message?.metadata?.forPeer && r.task?.id) peer?.watchRun(r.task.id, skillId);
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
    if (req.method === "GET" && url.pathname === "/api/activity") {
      const limit = Number(url.searchParams.get("limit") ?? 40);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, events: readJsonlTail(activityFile, Number.isFinite(limit) ? limit : 40).reverse() }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      const page = url.searchParams.get("page") ?? 1;
      const level = url.searchParams.get("level") ?? "all";
      const query = url.searchParams.get("q") ?? "";
      const pageSize = url.searchParams.get("pageSize") ?? undefined;
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, ...pageLogFile(logFile, { page, level, query, pageSize }) }));
      return;
    }
    const shortcutRuns = url.pathname.match(/^\/api\/shortcuts\/([a-z0-9][a-z0-9-]*)\/runs$/);
    if (req.method === "GET" && shortcutRuns) {
      if (!getTargets()[shortcutRuns[1]]) return json(res, 404, { ok: false, reason: "unknown target" });
      json(res, 200, { ok: true, retentionDays: 30, runs: listShortcutRuns(shortcutLogDir, shortcutRuns[1]) });
      return;
    }
    const shortcutLog = url.pathname.match(/^\/api\/shortcuts\/([a-z0-9][a-z0-9-]*)\/runs\/(task-[A-Za-z0-9-]+)$/);
    if (req.method === "GET" && shortcutLog) {
      const file = shortcutRunFile(shortcutLogDir, shortcutLog[1], shortcutLog[2]);
      if (!file) return json(res, 404, { ok: false, reason: "这次运行没有内部日志" });
      json(res, 200, { ok: true, log: `shortcuts/${shortcutLog[1]}/${shortcutLog[2]}.jsonl`, ...pageLogFile(file, { page: url.searchParams.get("page") ?? 1 }) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/codebuddy") {
      if (!codebuddy?.read) return json(res, 404, { ok: false, reason: "CodeBuddy 配置未装配" });
      json(res, 200, { ok: true, ...codebuddy.read() });
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/codebuddy") {
      if (!codebuddy?.save) return json(res, 404, { ok: false, reason: "CodeBuddy 配置未装配" });
      if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
      readJsonBody(req).then((body) => {
        if (!body.ok) return json(res, 400, { ok: false, reason: body.reason });
        const saved = codebuddy.save(body.data ?? {});
        if (!saved.ok) return json(res, 422, { ok: false, errors: saved.errors ?? [saved.reason] });
        chat?.reload?.();
        json(res, 200, { ok: true, ...saved.public });
      }).catch((error) => json(res, 500, { ok: false, message: error.message }));
      return;
    }
    if (url.pathname === "/api/agent/doctor" && req.method === "GET") {
      if (!chat) return json(res, 503, { ok: false, message: "会话能力未装配" });
      chat.doctor().then((result) => json(res, 200, result)).catch((error) => json(res, 503, { ok: false, message: error.message }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/profile") {
      json(res, 200, { ok: true, ...(profile?.read?.() ?? { role: "", introduction: "" }) });
      return;
    }
    if (req.method === "PUT" && url.pathname === "/api/profile") {
      if (!profile?.save) return json(res, 404, { ok: false, reason: "自我介绍未装配" });
      if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
      readJsonBody(req).then((body) => {
        if (!body.ok) return json(res, 400, { ok: false, reason: body.reason });
        const saved = profile.save(body.data ?? {});
        if (!saved.ok) return json(res, 422, { ok: false, reason: saved.reason });
        json(res, 200, saved);
      }).catch((error) => json(res, 500, { ok: false, message: error.message }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/peer/report") {
      if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
      readJsonBody(req).then((body) => {
        if (!body.ok) return json(res, 400, { ok: false, reason: body.reason });
        const result = peer?.report(body.data ?? {}) ?? { ok: false, reason: "会话能力未装配" };
        json(res, result.ok ? 200 : 409, result);
      }).catch((error) => json(res, 500, { ok: false, message: error.message }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/peer/ask") {
      if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
      readJsonBody(req).then((body) => {
        if (!body.ok) return json(res, 400, { ok: false, reason: body.reason });
        const result = peer?.ask?.({ to: body.data?.to, text: body.data?.text, contextId: body.data?.contextId }) ?? { ok: false, reason: "会话能力未装配" };
        json(res, result.ok ? 200 : 409, result);
      }).catch((error) => json(res, 500, { ok: false, message: error.message }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/peer/request") {
      if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
      json(res, 200, peer?.holdForDetail?.() ?? { ok: false, reason: "会话能力未装配" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/peer/presence") {
      if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
      readJsonBody(req).then((body) => {
        if (!body.ok) return json(res, 400, { ok: false, reason: body.reason });
        const result = peer?.presence(body.data?.text) ?? { ok: false, reason: "会话能力未装配" };
        json(res, result.ok ? 200 : 409, result);
      }).catch((error) => json(res, 500, { ok: false, message: error.message }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/peer/notify") {
      if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
      readJsonBody(req).then((body) => {
        if (!body.ok) return json(res, 400, { ok: false, reason: body.reason });
        json(res, 200, peer?.notifyOwner ? peer.notifyOwner(body.data?.text) : { ok: false, reason: "通知未装配" });
      }).catch((error) => json(res, 500, { ok: false, message: error.message }));
      return;
    }
    if (url.pathname === "/api/sessions" && req.method === "GET") {
      const peers = peer?.list?.() ?? [];
      const finish = (sessions) => {
        const byId = new Map(sessions.map((item) => [item.id, item]));
        for (const item of peers) byId.set(item.id, item);
        json(res, 200, { sessions: [...byId.values()] });
      };
      if (!chat) return finish([]);
      chat.list().then((result) => finish(result.sessions ?? [])).catch((error) => json(res, 503, { ok: false, message: error.message }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/sessions/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const unsubscribe = peer?.subscribe?.((event) => {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* 页面已离开 */ }
      });
      req.on("close", () => unsubscribe?.());
      return;
    }
    if (url.pathname === "/api/sessions" && req.method === "POST") {
      if (!chat) return json(res, 503, { ok: false, message: "会话能力未装配" });
      if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
      readJsonBody(req).then((body) => {
        const title = body.ok ? body.data?.title : undefined;
        return chat.create(title);
      }).then((result) => json(res, 201, result)).catch((error) => json(res, 503, { ok: false, message: error.message }));
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|interrupt|answer))?$/);
    if (sessionMatch) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      const action = sessionMatch[2];
      if (!chat && !(peer?.has?.(sessionId) && !action)) return json(res, 503, { ok: false, message: "会话能力未装配" });
      if (req.method === "GET" && !action) {
        if (peer?.has?.(sessionId)) return json(res, 200, peer.history(sessionId));
        if (!chat) return json(res, 404, { ok: false, message: "会话不存在" });
        chat.history(sessionId).then((result) => json(res, 200, result)).catch((error) => json(res, 503, { ok: false, message: error.message }));
        return;
      }
      if (req.method === "DELETE" && !action) {
        if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
        if (peer?.has?.(sessionId)) return json(res, 200, peer.remove(sessionId));
        if (!chat) return json(res, 404, { ok: false, message: "会话不存在" });
        chat.remove(sessionId).then((result) => json(res, 200, result)).catch((error) => json(res, 503, { ok: false, message: error.message }));
        return;
      }
      if (req.method === "POST" && action === "interrupt") {
        if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
        chat.interrupt(sessionId).then((result) => json(res, 200, result)).catch((error) => json(res, 503, { ok: false, message: error.message }));
        return;
      }
      if (req.method === "POST" && action === "answer") {
        if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
        if (!chat?.answer) return json(res, 503, { ok: false, message: "会话能力未装配" });
        readJsonBody(req).then((body) => {
          if (!body.ok) return json(res, 400, { ok: false, reason: body.reason });
          return chat.answer(sessionId, {
            questionId: body.data?.questionId,
            answers: body.data?.answers,
            skip: body.data?.skip === true,
          });
        }).then((result) => {
          if (!result) return;
          const status = result.ok ? 200 : result.gone ? 409 : 400;
          json(res, status, result.ok ? result : { ok: false, message: result.message || "这次提问已经结束" });
        }).catch((error) => json(res, 503, { ok: false, message: error.message }));
        return;
      }
      if (req.method === "POST" && action === "messages") {
        if (!sameOrigin(req, { allowRemote: access.remote })) return json(res, 403, { ok: false, reason: "写端点来源不合法" });
        readJsonBody(req, 256 * 1024).then(async (body) => {
          if (!body.ok) return json(res, 400, { ok: false, reason: body.reason });
          req.setTimeout(0);
          res.setTimeout(0);
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          try {
            const result = await chat.send(sessionId, body.data?.text ?? "", (event) => {
              if (res.writableEnded || res.destroyed) return;
              res.write(`data: ${JSON.stringify(event)}\n\n`);
            });
            res.write(`data: ${JSON.stringify({ kind: "result", session: result.session })}\n\n`);
            res.end();
          } catch (error) {
            res.write(`data: ${JSON.stringify({ kind: "error", text: error.message })}\n\n`);
            res.end();
          }
        });
        return;
      }
    }
    if (serveConsole(uiRoot, req, res, url)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  return {
    server,
    trigger,
    tasks,
    /** 热替换注册表（editor 保存路径）：磁贴/触发/A2A 查表即时切新定义。 */
    refreshTargets(next) {
      currentTargets = next;
    },
    start() {
      return new Promise((resolve) => server.listen(port, access.host, () => resolve(server.address())));
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(resolve);
        // SSE/keep-alive 连接不能阻塞桌面 sidecar 停机。
        server.closeAllConnections?.();
      });
    },
    access,
  };
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) tooLarge = true;
    });
    req.on("end", () => {
      if (tooLarge) {
        resolve({ ok: false, reason: "请求体过大" });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(body || "{}") });
      } catch {
        resolve({ ok: false, reason: "JSON 解析失败" });
      }
    });
    req.on("error", (error) => resolve({ ok: false, reason: error.message }));
  });
}
