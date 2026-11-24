/** 主动拉取已配置 Hub 的来源；成员 token 只读，绝不代理来源管理。 */
import { normalizeSource, sourceKeyOf } from "./sources-cache.mjs";

export function createHubSourceSync({ config, sources, manager, fetchImpl = globalThis.fetch } = {}) {
  let pending = null;
  async function perform() {
    let url;
    try {
      url = new URL(config.hubUrl);
      if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("invalid URL");
      }
      const plain = ["http:", "ws:"].includes(url.protocol);
      if (plain && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("HTTPS required");
      url.protocol = plain ? "http:" : "https:";
      // 与现有 tunnel/artifact HTTP 门一致，使用已配置 Hub 的 origin。
      url = new URL("/api/agent/pack-sources", url.origin);
    } catch {
      return { ok: false, code: "invalid-hub-url", reason: "Hub 地址必须使用 HTTPS/WSS（回环调试除外），且不得嵌入凭据或查询参数" };
    }
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${config.agentToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return { ok: false, code: "hub-source-sync-failed", reason: `Hub 来源同步返回 HTTP ${response.status}；请检查服务版本或成员权限，旧缓存未改变` };
      }
      if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("not JSON");
      let raw = "";
      let bytes = 0;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 512 * 1024) throw new Error("oversized response");
        raw += decoder.decode(chunk, { stream: true });
      }
      raw += decoder.decode();
      const body = JSON.parse(raw);
      if (!Array.isArray(body.sources) || body.sources.length > 512) throw new Error("invalid source list");
      const keys = new Set();
      const names = new Set();
      for (const source of body.sources) {
        validateWireSource(source);
        const normalized = normalizeSource(source);
        if (!normalized || keys.has(sourceKeyOf(normalized)) || (normalized.id && names.has(normalized.id))) throw new Error("invalid or duplicate source");
        if ("key" in source) throw new Error("unexpected management key");
        keys.add(normalized.key);
        if (normalized.id) names.add(normalized.id);
      }
      const saved = sources.replace(body.sources);
      manager.reconcile();
      // 只更新来源。扫描沿用打开 packs 页面时的受保护管理流程，不擅自触发 autoAdd。
      const repos = manager.listRepos();
      return { ok: true, count: saved.count, repos: repos.map((repo) => ({ key: repo.key, git: repo.git, branch: repo.branch, autoAdd: repo.autoAdd === true })), note: "来源已同步，无需重连；使用 packs 查看扫描结果，安装需另行授权" };
    } catch {
      return { ok: false, code: "hub-source-sync-failed", reason: "无法取得合法的 Hub 来源清单，或缓存写入失败；请检查网络、本机日志与 Hub 版本" };
    }
  }
  return {
    sync() {
      if (!pending) pending = perform().finally(() => { pending = null; });
      return pending;
    },
  };
}

/** 新 HTTP 入口严格校验整份 wire，不沿用握手缓存的容错丢弃语义。 */
function validateWireSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("invalid source");
  for (const field of Object.keys(source)) {
    if (!["git", "branch", "id", "subdir"].includes(field)) throw new Error("unexpected field");
    if (typeof source[field] !== "string" || !source[field].trim() || source[field].length > 512 || /[\u0000-\u001f\u007f]/.test(source[field])) throw new Error("invalid field");
  }
  if (typeof source.git !== "string" || typeof source.branch !== "string" || /\s/.test(source.git)) throw new Error("invalid source");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source.git)) {
    const url = new URL(source.git);
    if (url.password || url.search || url.hash || (["https:", "http:"].includes(url.protocol) && url.username)) throw new Error("credentials in source");
  }
}
