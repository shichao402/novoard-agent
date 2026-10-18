/**
 * 首次接入配置向导（M6 F2 · 二进制分发的 setup 模式）：
 * agent.json 缺失时由 sea-entry 拉起（默认 127.0.0.1；Linux 非回环模式强制 UI Token）：
 *   GET  /setup            同一份 React 控制台的接入页（hub 地址 / 成员 ID / Agent Token）
 *   POST /api/setup/test   连通性探测：WS upgrade + Bearer——401 即 token 无效；不发 hello，hub 注册表零痕迹
 *   POST /api/setup/save   hubUrl 归一化 → 字段校验 → 写 agent.json(0600) → agents/<id>/targets.yaml 骨架（缺时）
 *                            → onReady(config) 热启动（免重启）→ 响应面板地址，响应完成后自动关向导
 * 写端点 Host/Origin 同源校验与 local-a2a 同纪律（sameOrigin 共享导出）。
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { serveConsole } from "./console-ui.mjs";
import { handleDesktopCors, sameOrigin } from "./local-a2a.mjs";
import { createUiAccess, uiLoginPage, validateUiConfig } from "./ui-access.mjs";
import { edition } from "./edition.mjs";

const SETUP_PORT_DEFAULT = edition.localPort;
/** frame-agent-hello 的 agentId 同款约束（保持向导期就拦住不合法 ID） */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 骨架 targets.yaml：id 用 <agentId>-smoke 前缀，避免与 hub 上已有成员的 skill id 冲突（hello nack skill-conflict）。 */
const skeletonTargets = (agentId) => `# Novoard · ${agentId} 首次接入骨架（setup 向导生成；在 ${edition.productName} 的 Target 页修改）
targets:
  ${agentId}-smoke:
    title: 冒烟自检（示例，可删改）
    steps:
      - script: echo novoard agent ready
    vars: {}
    expose: a2a
    audit: summary
    requiresApproval: false
    notify: on-failure
`;

/**
 * hub 地址归一化：用户只需填裸域名（novoard.firoyang.com）或 https(s) 地址，
 * 统一转 ws(s)://<host>/tunnel（隧道路径，契约 §4）；已带路径（如自定义反代前缀）则尊重不覆盖。
 */
export function normalizeHubUrl(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return { ok: false, reason: "hub 地址为空" };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`; // 裸域名按 https 假定
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: `hub 地址无法解析：${s}` };
  }
  if (u.protocol === "https:") u.protocol = "wss:";
  else if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol !== "ws:" && u.protocol !== "wss:") {
    return { ok: false, reason: `不支持的协议：${u.protocol}（仅 http(s)/ws(s)）` };
  }
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/tunnel";
  return { ok: true, url: u.toString() };
}

/**
 * 连通性探测：WS upgrade + Bearer。token 无效 → hub 401；可达且 token 有效 → open 即成功。
 * 刻意不发 agent.hello——探测连接零注册痕迹（不触发 member-event 通知、不留离线成员）。
 */
export function testConnection({ hubUrl, agentToken, timeoutMs = 6000, WebSocketImpl = WebSocket } = {}) {
  const norm = normalizeHubUrl(hubUrl);
  if (!norm.ok) return Promise.resolve({ ok: false, reason: norm.reason });
  const token = String(agentToken ?? "").trim();
  if (!token) return Promise.resolve({ ok: false, reason: "Agent Token 为空" });
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 握手前关闭可能抛错，忽略 */ }
      resolve(r);
    };
    const ws = new WebSocketImpl(norm.url, { headers: { Authorization: `Bearer ${token}` } });
    const timer = setTimeout(() => done({ ok: false, reason: "连接超时（hub 不可达或网络受限）" }), timeoutMs);
    ws.on("open", () => done({ ok: true, url: norm.url }));
    ws.on("error", (error) => {
      const msg = String(error?.message ?? error);
      if (/401|unauthorized/i.test(msg)) done({ ok: false, reason: "hub 拒绝（401）：token 无效或未在 hub 预置" });
      else if (/404/.test(msg)) done({ ok: false, reason: "地址不对（404）：确认填的是 hub 域名（隧道路径 /tunnel）" });
      else done({ ok: false, reason: `连接失败：${msg}` });
    });
  });
}

/** 配置落盘：校验 → 骨架 → agent.json(0600)。返回 { ok, config, configPath, agentDir } | { ok:false, errors }。 */
export function persistAgentConfig({ dir, hubUrl, agentId, agentToken, localPort, uiHost, uiToken, log = console } = {}) {
  if (!dir) return { ok: false, errors: ["缺少数据目录"] };
  const norm = normalizeHubUrl(hubUrl);
  if (!norm.ok) return { ok: false, errors: [norm.reason] };
  const id = String(agentId ?? "").trim();
  if (!AGENT_ID_RE.test(id)) {
    return { ok: false, errors: [`成员 ID 不合法：${id || "(空)"}（小写字母/数字/连字符，如 win-dev）`] };
  }
  const token = String(agentToken ?? "").trim();
  if (token.length < 8) return { ok: false, errors: ["Agent Token 至少 8 位（向 hub 管理员索取）"] };
  const portNumber = Number(localPort) || 0;
  if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
    return { ok: false, errors: [`面板端口不合法：${localPort}`] };
  }
  const ui = validateUiConfig({ host: uiHost ?? "127.0.0.1", token: uiToken ?? "" });
  if (!ui.ok) return { ok: false, errors: [ui.reason] };

  const agentDir = join(dir, "agents", id);
  mkdirSync(agentDir, { recursive: true });
  const targetsPath = join(agentDir, "targets.yaml");
  if (!existsSync(targetsPath)) {
    writeFileSync(targetsPath, skeletonTargets(id), "utf8");
    log.info?.(`[setup] 已生成骨架 targets.yaml：${targetsPath}`);
  }
  const config = {
    agentId: id,
    hubUrl: norm.url,
    agentToken: token,
    contractVersion: "2.1",
    localPort: portNumber,
    uiHost: ui.host,
    ...(ui.remote ? { uiToken: ui.token } : {}),
  };
  const configPath = join(dir, "agent.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  try { chmodSync(configPath, 0o600); } catch { /* 平台不支持 chmod 时忽略 */ }
  return { ok: true, config, configPath, agentDir };
}

export function createSetupWizard({ dir, port = SETUP_PORT_DEFAULT, host = "127.0.0.1", uiToken = "", uiRoot = null, onReady, log = console } = {}) {
  if (!dir) throw new Error("setup-wizard 需要 dir（数据目录，即运行 cwd）");
  const access = createUiAccess({ host, token: uiToken });
  let listenPort = port;

  function saveConfig(input = {}) {
    return persistAgentConfig({
      dir,
      log,
      hubUrl: input.hubUrl,
      agentId: input.agentId,
      agentToken: input.agentToken,
      localPort: input.localPort,
      uiHost: input.uiHost ?? access.host,
      uiToken: input.uiToken ?? access.token,
    });
  }

  const server = createServer(async (req, res) => {
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
      const body = await readJsonBody(req);
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
      return;
    }
    if (access.rejectUnauthorized(req, res, url)) return;

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(302, { Location: "/setup" });
      res.end();
      return;
    }
    if (serveConsole(uiRoot, req, res, url)) return;

    if (req.method === "POST" && url.pathname === "/api/setup/test") {
      if (!sameOrigin(req, { allowRemote: access.remote })) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "写端点来源不合法" })); return; }
      const body = await readJsonBody(req);
      if (!body.ok) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "JSON 解析失败" })); return; }
      const r = await testConnection({ hubUrl: body.data.hubUrl, agentToken: body.data.agentToken });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/setup/save") {
      if (!sameOrigin(req, { allowRemote: access.remote })) { res.writeHead(403, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "写端点来源不合法" })); return; }
      const body = await readJsonBody(req);
      if (!body.ok) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, reason: "JSON 解析失败" })); return; }
      const saved = saveConfig(body.data ?? {});
      if (!saved.ok) {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, errors: saved.errors }));
        return;
      }
      log.info?.(`[setup] agent.json 已写入（agentId=${saved.config.agentId}，hub=${saved.config.hubUrl}）`);
      let booted = null;
      if (onReady) {
        try {
          booted = await onReady(saved.config, saved);
        } catch (error) {
          log.error?.(`[setup] 启动失败：${error?.message ?? error}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, errors: [`启动失败：${error?.message ?? error}`] }));
          return;
        }
      }
      const panelUrl = booted?.localA2A?.server
        ? panelUrlFor(req, saved.config.uiHost, booted.localA2A.server.address().port)
        : null;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, agentId: saved.config.agentId, panelUrl }));
      // 响应送达后关向导：agent 自己的控制台接管本地端口
      res.on("finish", () => server.close(() => log.info?.("[setup] 向导已完成并关闭")));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, reason: "not found" }));
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.on("error", (error) => {
        if (server.listening) return;
        if (listenPort !== 0 && error?.code === "EADDRINUSE") {
          log.info?.(`[setup] 端口 ${listenPort} 被占用，回退自动分配`);
          listenPort = 0;
          server.listen(0, access.host);
          return;
        }
        reject(error);
      });
      server.listen(listenPort, access.host, () => resolve(server.address()));
    });
  }

  function close() {
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return { server, start, close, saveConfig, access };
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

function panelUrlFor(req, configuredHost, port) {
  let host = configuredHost;
  // 0.0.0.0/:: 是绑定地址，不是浏览器目标；远程 setup 沿用请求中的实际 LAN 地址。
  if (configuredHost === "0.0.0.0" || configuredHost === "::") {
    try {
      host = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      host = configuredHost;
    }
  }
  const printable = String(host).includes(":") && !String(host).startsWith("[") ? `[${host}]` : host;
  return `http://${printable}:${port}`;
}

