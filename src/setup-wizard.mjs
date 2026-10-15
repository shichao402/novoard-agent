/**
 * 首次接入配置向导（M6 F2 · 二进制分发的 setup 模式）：
 * agent.json 缺失时由 sea-entry 拉起（默认 127.0.0.1；Linux 非回环模式强制 UI Token）：
 *   GET  /setup            零构建单页表单（hub 地址 / 成员 ID / Agent Token / 面板端口可选）
 *   POST /api/setup/test   连通性探测：WS upgrade + Bearer——401 即 token 无效；不发 hello，hub 注册表零痕迹
 *   POST /api/setup/save   hubUrl 归一化 → 字段校验 → 写 agent.json(0600) → agents/<id>/targets.yaml 骨架（缺时）
 *                            → onReady(config) 热启动（免重启）→ 响应面板地址，响应完成后自动关向导
 * 写端点 Host/Origin 同源校验与 local-a2a 同纪律（sameOrigin 共享导出）。
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { sameOrigin } from "./local-a2a.mjs";
import { createUiAccess, uiLoginPage, validateUiConfig } from "./ui-access.mjs";

const SETUP_PORT_DEFAULT = 39870;
/** frame-agent-hello 的 agentId 同款约束（保持向导期就拦住不合法 ID） */
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 骨架 targets.yaml：id 用 <agentId>-smoke 前缀，避免与 hub 上已有成员的 skill id 冲突（hello nack skill-conflict）。 */
const skeletonTargets = (agentId) => `# Novoard · ${agentId} 首次接入骨架（setup 向导生成；用面板 /editor 可视化编辑，或直接改本文件）
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

export function createSetupWizard({ dir, port = SETUP_PORT_DEFAULT, host = "127.0.0.1", uiToken = "", onReady, log = console } = {}) {
  if (!dir) throw new Error("setup-wizard 需要 dir（数据目录，即运行 cwd）");
  const access = createUiAccess({ host, token: uiToken });
  let listenPort = port;

  /** 配置落盘：校验 → 骨架 → agent.json(0600)。返回 { ok, config, configPath, agentDir } | { ok:false, errors }。 */
  function saveConfig({ hubUrl, agentId, agentToken, localPort, uiHost, uiToken: nextUiToken } = {}) {
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
    const ui = validateUiConfig({
      host: uiHost ?? access.host,
      token: nextUiToken ?? access.token,
    });
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
      contractVersion: "2.0",
      localPort: portNumber,
      uiHost: ui.host,
      ...(ui.remote ? { uiToken: ui.token } : {}),
    };
    const configPath = join(dir, "agent.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    try { chmodSync(configPath, 0o600); } catch { /* 平台不支持 chmod 时忽略 */ }
    return { ok: true, config, configPath, agentDir };
  }

  const server = createServer(async (req, res) => {
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

    if (req.method === "GET" && (url.pathname === "/setup" || url.pathname === "/")) {
      if (url.pathname === "/") {
        res.writeHead(302, { Location: "/setup" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(setupPage());
      return;
    }

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
      // 响应送达后关向导：agent 自身的面板（磁贴 + /editor）接管本地端口
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

/** 零构建向导单页（同磁贴/编辑器纪律：无外部资源、暗色主题）。 */
function setupPage() {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novoard · 首次接入</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif; background: #0f1115; color: #e6e8ee; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #151922; border: 1px solid #262c38; border-radius: 14px; padding: 28px 30px; width: 440px; max-width: 92vw; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #8b93a7; font-size: 12px; margin-bottom: 18px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: #8b93a7; margin-bottom: 4px; }
  .field input { width: 100%; box-sizing: border-box; background: #1a1e26; color: #e6e8ee; border: 1px solid #3a4252; border-radius: 8px; padding: 8px 10px; font-size: 13px; }
  .field input:focus { outline: none; border-color: #4a90d9; }
  .hint { font-size: 11px; color: #8b93a7; margin-top: 4px; }
  .row { display: flex; gap: 8px; margin-top: 18px; }
  button { flex: 1; background: #2a3040; color: #e6e8ee; border: 1px solid #3a4252; border-radius: 8px; padding: 9px 0; font-size: 13px; cursor: pointer; }
  button:hover { border-color: #4a90d9; }
  button.primary { background: #2d6cb5; border-color: #2d6cb5; }
  button:disabled { opacity: .5; cursor: default; }
  .status { font-size: 12px; margin-top: 14px; min-height: 18px; word-break: break-all; }
  .status.ok { color: #34c759; } .status.err { color: #ff8b84; } .status.info { color: #8b93a7; }
  .links { margin-top: 14px; font-size: 13px; display: none; }
  .links a { color: #4a90d9; text-decoration: none; margin-right: 12px; }
</style></head><body>
<div class="card">
  <h1>Novoard agent · 首次接入</h1>
  <div class="sub">填写 hub 地址与凭据，测试通过后保存即启动（数据保存在本机 Agent 数据目录）</div>
  <div class="field"><label>hub 地址</label><input id="hubUrl" placeholder="novoard.firoyang.com" value="">
    <div class="hint">裸域名即可（自动 wss://…/tunnel），也可填完整 ws(s):// 地址</div></div>
  <div class="field"><label>成员 ID（agentId）</label><input id="agentId" placeholder="win-dev" value="">
    <div class="hint">小写字母/数字/连字符；hub Dashboard 按此展示成员</div></div>
  <div class="field"><label>Agent Token</label><input id="agentToken" type="password" placeholder="向 hub 管理员索取">
    <div class="hint">在 Hub 成员页创建；token 只绑定上方同一个 agentId</div></div>
  <div class="field"><label>面板端口（可选）</label><input id="localPort" placeholder="留空则自动分配" value=""></div>
  <div class="row">
    <button onclick="testConn()">测试连接</button>
    <button class="primary" id="saveBtn" onclick="save()">保存并启动</button>
  </div>
  <div class="status info" id="status">未连接</div>
  <div class="links" id="links"></div>
</div>
<script>
  function $(i){return document.getElementById(i);}
  function setStatus(cls,msg){var s=$("status");s.className="status "+cls;s.textContent=msg;}
  async function post(path,data){
    var r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
    var j=null;try{j=await r.json();}catch(e){}
    return {status:r.status,json:j};
  }
  async function testConn(){
    setStatus("info","测试中…");
    var r=await post("/api/setup/test",{hubUrl:$("hubUrl").value,agentToken:$("agentToken").value});
    if(r.json&&r.json.ok)setStatus("ok","连接成功：token 有效，通道可用（"+r.json.url+"）");
    else setStatus("err",(r.json&&(r.json.reason||(r.json.errors||[])[0]))||("测试失败：HTTP "+r.status));
  }
  async function save(){
    setStatus("info","保存并启动中…");
    var r=await post("/api/setup/save",{hubUrl:$("hubUrl").value,agentId:$("agentId").value,agentToken:$("agentToken").value,localPort:$("localPort").value});
    if(!r.json||!r.json.ok){setStatus("err",(r.json&&((r.json.errors||[])[0]||r.json.reason))||("保存失败：HTTP "+r.status));return;}
    $("saveBtn").disabled=true;
    setStatus("ok","已启动：成员 "+r.json.agentId+" 注册中（hub 在线时数秒内可见）");
    $("links").style.display="block";
    $("links").innerHTML=(r.json.panelUrl
      ?('<a href="'+r.json.panelUrl+'" target="_blank">磁贴面板</a><a href="'+r.json.panelUrl+'/editor" target="_blank">target 编辑器</a>')
      :"")+'<span class="hint">本向导页可关闭</span>';
  }
</script></body></html>`;
}
