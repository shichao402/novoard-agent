/**
 * 本地 Web 控制台访问策略。
 *
 * 回环监听沿用单用户本机边界，不增加登录步骤。
 * 非回环 uiHost 把同一套控制台暴露到机器网络或公网，必须配置独立 uiToken，
 * 并通过 HttpOnly 会话认证。该令牌不复用 hub agentToken。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const UI_SESSION_COOKIE = "novoard_ui_session";
export const DEFAULT_UI_HOST = "127.0.0.1";

export function isLoopbackHost(host) {
  const value = normalizeHost(host);
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

export function validateUiConfig({ host = DEFAULT_UI_HOST, token = "" } = {}) {
  const normalizedHost = normalizeHost(host);
  if (!isSupportedHost(normalizedHost)) {
    return { ok: false, reason: `uiHost 不合法：${host}（仅支持 localhost 或 IP 地址）` };
  }
  const normalizedToken = String(token ?? "");
  if (!isLoopbackHost(normalizedHost) && normalizedToken.length < 16) {
    return { ok: false, reason: "非回环 uiHost 必须配置至少 16 字符的独立 uiToken" };
  }
  return {
    ok: true,
    host: normalizedHost,
    token: normalizedToken,
    remote: !isLoopbackHost(normalizedHost),
  };
}

export function createUiAccess(options = {}) {
  const config = validateUiConfig(options);
  if (!config.ok) throw new Error(config.reason);
  const sessionValue = config.remote ? sessionFor(config.token) : "";

  function authorized(req) {
    if (!config.remote) return true;
    return cookieOf(req.headers.cookie, UI_SESSION_COOKIE) === sessionValue;
  }

  function authenticate(candidate) {
    if (!config.remote) return true;
    return safeEqual(String(candidate ?? ""), config.token);
  }

  function setCookieHeader() {
    return `${UI_SESSION_COOKIE}=${sessionValue}; HttpOnly; SameSite=Strict; Path=/`;
  }

  function clearCookieHeader() {
    return `${UI_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  /**
   * 未登录页面请求跳到 /login，API 请求返回 JSON 401。
   * 返回 true 表示响应已结束，调用方必须停止后续路由。
   */
  function rejectUnauthorized(req, res, url) {
    if (authorized(req)) return false;
    const wantsHtml = req.method === "GET"
      && !url.pathname.startsWith("/api/")
      && url.pathname !== "/a2a";
    if (wantsHtml) {
      res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
      res.end();
    } else {
      res.writeHead(401, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, reason: "UI authentication required" }));
    }
    return true;
  }

  return {
    ...config,
    authorized,
    authenticate,
    setCookieHeader,
    clearCookieHeader,
    rejectUnauthorized,
  };
}

export function uiLoginPage() {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novoard · Web 控制台登录</title>
<style>
  body { font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif; background: #0f1115; color: #e6e8ee; margin: 0; min-height: 100vh; display: grid; place-items: center; }
  .card { width: 380px; max-width: 88vw; padding: 28px; border: 1px solid #2b3240; border-radius: 14px; background: #151922; }
  h1 { margin: 0 0 6px; font-size: 18px; } p { color: #8b93a7; font-size: 12px; line-height: 1.6; }
  input, button { box-sizing: border-box; width: 100%; border-radius: 8px; padding: 10px; font-size: 13px; }
  input { color: #e6e8ee; background: #1a1e26; border: 1px solid #3a4252; margin: 10px 0; }
  button { color: white; background: #2d6cb5; border: 0; cursor: pointer; }
  #status { min-height: 18px; margin-top: 10px; color: #ff8b84; font-size: 12px; }
</style></head><body><div class="card">
  <h1>Novoard Web 控制台</h1>
  <p>此实例启用了非回环监听。请输入本机配置的独立 UI Token；它不是 Hub Agent Token。</p>
  <input id="token" type="password" autocomplete="current-password" placeholder="UI Token">
  <button id="login">登录</button><div id="status"></div>
</div><script>
  async function login(){
    var token=document.getElementById("token").value;
    var r=await fetch("/api/ui/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:token})});
    if(r.ok){location.replace("/");return;}
    var j=await r.json().catch(function(){return {};});
    document.getElementById("status").textContent=j.reason||"登录失败";
  }
  document.getElementById("login").onclick=login;
  document.getElementById("token").onkeydown=function(e){if(e.key==="Enter")login();};
</script></body></html>`;
}

function normalizeHost(host) {
  const value = String(host ?? DEFAULT_UI_HOST).trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  return value;
}

function isSupportedHost(host) {
  return host === "localhost" || isIP(host) !== 0;
}

function sessionFor(token) {
  return createHash("sha256").update(`novoard-ui-session-v1:${token}`).digest("base64url");
}

function cookieOf(raw, name) {
  for (const item of String(raw ?? "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) return item.slice(index + 1).trim();
  }
  return "";
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
