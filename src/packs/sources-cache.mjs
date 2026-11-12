/**
 * 能力包来源缓存（PRD-7 A5 / A8）：Hub hello.ack.packSources 落到 <dataDir>/pack-sources.json，离线时使用缓存。
 * - ack 缺省 packSources：hub 没下发，保留旧缓存（调用方不调 replace）。
 * - ack 带空数组：清空。
 * 不合法的条目丢弃并记日志，不让整份来源失效。
 *
 * 契约 v2.5：来源身份是 git + branch + subdir（sourceKey 由它派生），id 只是可选的包名覆盖；
 * 包名缺省时由包管理器安装后从 toolset.json 读取。
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export const PACK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;
const KEY_PREFIX = "src-";
export const SOURCE_KEY_PATTERN = /^src-[0-9a-f]{12}$/;

export function packSourcesPath(dataDir) {
  return join(dataDir, "pack-sources.json");
}

/** 与 hub pack-sources.mjs 的 packSourceIdentity 同一规则：git 去尾 / 与 .git、host 不分大小写。 */
export function sourceIdentity(source) {
  let git = String(source.git).replace(/\/+$/, "").replace(/\.git$/i, "");
  git = git.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/]+)/i, (_, scheme, host) => `${scheme.toLowerCase()}${host.toLowerCase()}`);
  git = git.replace(/^([^@/:]+@)([^:/]+):/, (_, user, host) => `${user}${host.toLowerCase()}:`);
  return `${git}\n${source.branch}\n${source.subdir ?? ""}`;
}

/** 来源 key：身份的 sha1 前 12 位，跨重启、跨 hub 改名都稳定。 */
export function sourceKeyOf(source) {
  return KEY_PREFIX + createHash("sha1").update(sourceIdentity(source)).digest("hex").slice(0, 12);
}

/** → 规整后的条目 { key, git, branch, subdir?, id? } | null（不合法） */
export function normalizeSource(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id ?? "").trim();
  const git = String(input.git ?? "").trim();
  const branch = String(input.branch ?? "").trim();
  if (id && (!PACK_ID_PATTERN.test(id) || id.length > 64)) return null;
  if (!git || git.startsWith("-")) return null;
  if (!branch || branch.startsWith("-") || /\s/.test(branch)) return null;
  const out = { git, branch };
  const rawSub = String(input.subdir ?? "").trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (rawSub && rawSub !== ".") {
    if (rawSub.startsWith("/") || /^[A-Za-z]:/.test(rawSub) || rawSub.split("/").includes("..")) return null;
    out.subdir = rawSub;
  }
  if (id) out.id = id;
  return { key: sourceKeyOf(out), ...out };
}

export function createSourcesCache({ file, log = console } = {}) {
  let cache = null;

  /** 读入一组原始条目：不合法丢弃；同来源只留第一条；同覆盖名的后来者丢弃。 */
  function build(rawList) {
    const next = new Map();
    const names = new Set();
    let dropped = 0;
    for (const raw of Array.isArray(rawList) ? rawList : []) {
      const s = normalizeSource(raw);
      if (!s || next.has(s.key) || (s.id && names.has(s.id))) {
        dropped += 1;
        continue;
      }
      if (s.id) names.add(s.id);
      next.set(s.key, s);
    }
    return { next, dropped };
  }

  function load() {
    if (cache) return cache;
    cache = new Map();
    if (!file || !existsSync(file)) return cache;
    try {
      // v1 缓存的 id 是 hub 旧版要求人填的，常填错（如 default），不再当包名覆盖用
      const data = JSON.parse(readFileSync(file, "utf8"));
      const raw = Array.isArray(data?.sources) ? data.sources : [];
      cache = build(data?.schemaVersion === 1 ? raw.map(({ id: _old, ...rest } = {}) => rest) : raw).next;
    } catch (error) {
      log.warn?.(`[packs] 来源缓存 ${file} 无法解析，按空处理：${error.message}`);
    }
    return cache;
  }

  function list() {
    return [...load().values()].sort((a, b) => a.git.localeCompare(b.git) || (a.subdir ?? "").localeCompare(b.subdir ?? "") || a.branch.localeCompare(b.branch));
  }

  /** 按来源 key 取。 */
  function get(key) {
    return load().get(key) ?? null;
  }

  /** 填了该包名覆盖的来源。 */
  function byOverride(name) {
    for (const s of load().values()) if (s.id === name) return s;
    return null;
  }

  /** 用 hub 下发的整份来源替换缓存。→ { count, dropped } */
  function replace(sources) {
    const { next, dropped } = build(sources);
    if (dropped > 0) log.warn?.(`[packs] hub 下发的能力包来源中有 ${dropped} 条不合法或重复，已丢弃`);
    cache = next;
    if (file) writeAtomic(file, JSON.stringify({ schemaVersion: 2, sources: list().map(({ key: _k, ...s }) => s) }, null, 2) + "\n");
    return { count: next.size, dropped };
  }

  return { list, get, byOverride, replace, file };
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
