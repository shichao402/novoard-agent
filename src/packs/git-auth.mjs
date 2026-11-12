/**
 * 能力包仓库的 git 凭据（PRD-7 A8）：只在 agent 本机，不经过 hub。
 *
 * - 落盘 <stateDir>/git-credentials.json（0600，原子写），与 agent.json 里的 agentToken 同一安全级别；
 * - 条目 { url, username?, token }：url 是 HTTPS 前缀，可以细到组织或单个仓库；
 *   匹配规则：scheme + host（不分大小写）相同，路径按段做前缀匹配（末尾 .git 忽略），取最长的那条；
 * - 调 git 时用 GIT_CONFIG_COUNT 注入，不写任何 git 配置文件：
 *     credential.helper=        清空本机 helper，结果不依赖这台机器之前登录过什么
 *     http.<前缀>.extraHeader   命中凭据时带 Authorization: Basic，只作用于该前缀下的地址
 *   另设 GIT_TERMINAL_PROMPT=0、ssh BatchMode，缺凭据时立即失败而不是卡住等输入；
 * - 对外（控制台接口）只给 url、username、token 末四位，token 不回显。
 */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export function gitCredentialsPath(dataDir) {
  return join(dataDir, "git-credentials.json");
}

function invalid(message) {
  const error = new Error(message);
  error.code = "invalid-git-credential";
  return error;
}

/** 解析成 { origin, segments }；只接受 http(s)，不接受内嵌账号密码。→ null 表示不是可匹配的 HTTPS 地址 */
export function parseHttpUrl(text) {
  let url;
  try {
    url = new URL(String(text ?? "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length) segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, "");
  return { origin: `${url.protocol}//${url.host.toLowerCase()}`, segments: segments.filter(Boolean) };
}

/** 规范化凭据前缀：https://host[/路径]，去掉末尾 / 与 .git。 */
export function normalizePrefix(text) {
  const parsed = parseHttpUrl(text);
  if (!parsed) throw invalid("地址必须是 https:// 开头的仓库或组织地址，且不能带账号密码");
  return [parsed.origin, ...parsed.segments].join("/");
}

/** 默认用户名：GitHub 用 x-access-token，其余（GitLab、工蜂等）用 oauth2。 */
export function defaultUsername(prefix) {
  const parsed = parseHttpUrl(prefix);
  return parsed && /(^|\.)github\.com$/.test(parsed.origin.replace(/^https?:\/\//, "").replace(/:\d+$/, "")) ? "x-access-token" : "oauth2";
}

function cleanField(value, field, { max = 512 } = {}) {
  const text = String(value ?? "").trim();
  if (text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw invalid(`${field} 含非法字符或过长`);
  return text;
}

/** 在凭据列表里找与 gitUrl 匹配的最长前缀。→ 条目 | null */
export function matchCredential(entries, gitUrl) {
  const target = parseHttpUrl(gitUrl);
  if (!target) return null;
  let best = null;
  let bestLen = -1;
  for (const entry of entries) {
    const prefix = parseHttpUrl(entry.url);
    if (!prefix || prefix.origin !== target.origin) continue;
    if (prefix.segments.length > target.segments.length) continue;
    if (!prefix.segments.every((seg, i) => seg === target.segments[i])) continue;
    if (prefix.segments.length > bestLen) {
      best = entry;
      bestLen = prefix.segments.length;
    }
  }
  return best;
}

/** 在 baseEnv 已有的 GIT_CONFIG_COUNT 之后追加若干 key=value。 */
function appendGitConfig(env, pairs) {
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10);
  let n = Number.isFinite(start) && start > 0 ? start : 0;
  const out = { ...env };
  for (const [key, value] of pairs) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n += 1;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

export function createGitAuth({ file, log = console } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    cache = [];
    if (!file || !existsSync(file)) return cache;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (const raw of Array.isArray(data?.credentials) ? data.credentials : []) {
        try {
          const url = normalizePrefix(raw.url);
          const token = cleanField(raw.token, "token", { max: 4096 });
          if (!token) continue;
          cache.push({ url, username: cleanField(raw.username, "用户名") || defaultUsername(url), token });
        } catch {
          // 单条坏数据跳过，不影响其他条目
        }
      }
    } catch (error) {
      log.warn?.(`[git-auth] ${file} 无法解析，按无凭据处理：${error.message}`);
    }
    return cache;
  }

  function save(list) {
    cache = list;
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, JSON.stringify({ schemaVersion: 1, credentials: list }, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, file);
      if (process.platform !== "win32") chmodSync(file, 0o600);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  const masked = (c) => ({ url: c.url, username: c.username, tokenLastFour: c.token.slice(-4) });

  /** 控制台用：不含 token。 */
  function list() {
    return load().map(masked).sort((a, b) => a.url.localeCompare(b.url));
  }

  /**
   * 新增或按 url 覆盖。token 留空表示沿用原 token（只改用户名）；新增时必填。
   * originalUrl 用于编辑时改了地址。→ 脱敏后的条目
   */
  function upsert({ url, username, token, originalUrl } = {}) {
    const prefix = normalizePrefix(url);
    const from = originalUrl ? normalizePrefix(originalUrl) : prefix;
    const name = cleanField(username, "用户名") || defaultUsername(prefix);
    const secret = cleanField(token, "token", { max: 4096 });
    const current = load();
    const existing = current.find((c) => c.url === from) ?? null;
    if (!secret && !existing) throw invalid("token 不能为空");
    if (from !== prefix && current.some((c) => c.url === prefix)) throw invalid(`${prefix} 已有凭据`);
    const entry = { url: prefix, username: name, token: secret || existing.token };
    save([...current.filter((c) => c.url !== from && c.url !== prefix), entry]);
    return masked(entry);
  }

  function remove(url) {
    const prefix = normalizePrefix(url);
    const current = load();
    const next = current.filter((c) => c.url !== prefix);
    if (next.length === current.length) return false;
    save(next);
    return true;
  }

  /** 某个仓库地址会用哪条凭据（控制台展示用，不含 token）。 */
  function describe(gitUrl) {
    const hit = matchCredential(load(), gitUrl);
    return hit ? masked(hit) : null;
  }

  /** 调 git 时的环境：隔离本机 helper、禁止交互，命中凭据时注入 Authorization 头。 */
  function envFor(gitUrl, baseEnv = process.env) {
    const pairs = [["credential.helper", ""]];
    const hit = matchCredential(load(), gitUrl);
    if (hit) {
      const basic = Buffer.from(`${hit.username}:${hit.token}`).toString("base64");
      pairs.push([`http.${String(gitUrl).trim().replace(/\/+$/, "")}.extraHeader`, `Authorization: Basic ${basic}`]);
    }
    const env = appendGitConfig(baseEnv, pairs);
    env.GIT_TERMINAL_PROMPT = "0";
    if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    return env;
  }

  return { list, upsert, remove, describe, envFor, file };
}
