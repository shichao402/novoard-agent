/**
 * 能力包来源缓存（PRD-7 A5）：Hub hello.ack.packSources 落到 <dataDir>/pack-sources.json，离线时使用缓存。
 * - ack 缺省 packSources：hub 没下发，保留旧缓存（调用方不调 replace）。
 * - ack 带空数组：清空。
 * 不合法的条目丢弃并记日志，不让整份来源失效。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const PACK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9-]*$/;

export function packSourcesPath(dataDir) {
  return join(dataDir, "pack-sources.json");
}

/** → 规整后的条目 | null（不合法） */
export function normalizeSource(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id ?? "").trim();
  const git = String(input.git ?? "").trim();
  const branch = String(input.branch ?? "").trim();
  if (!PACK_ID_PATTERN.test(id) || id.length > 64) return null;
  if (!git || git.startsWith("-")) return null;
  if (!branch || branch.startsWith("-") || /\s/.test(branch)) return null;
  const out = { id, git, branch };
  const rawSub = String(input.subdir ?? "").trim().replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (rawSub && rawSub !== ".") {
    if (rawSub.startsWith("/") || /^[A-Za-z]:/.test(rawSub) || rawSub.split("/").includes("..")) return null;
    out.subdir = rawSub;
  }
  return out;
}

export function createSourcesCache({ file, log = console } = {}) {
  let cache = null;

  function load() {
    if (cache) return cache;
    cache = new Map();
    if (!file || !existsSync(file)) return cache;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (const raw of Array.isArray(data?.sources) ? data.sources : []) {
        const s = normalizeSource(raw);
        if (s) cache.set(s.id, s);
      }
    } catch (error) {
      log.warn?.(`[packs] 来源缓存 ${file} 无法解析，按空处理：${error.message}`);
    }
    return cache;
  }

  function list() {
    return [...load().values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  function get(id) {
    return load().get(id) ?? null;
  }

  /** 用 hub 下发的整份来源替换缓存。→ { count, dropped } */
  function replace(sources) {
    const next = new Map();
    let dropped = 0;
    for (const raw of Array.isArray(sources) ? sources : []) {
      const s = normalizeSource(raw);
      if (s) next.set(s.id, s);
      else dropped += 1;
    }
    if (dropped > 0) log.warn?.(`[packs] hub 下发的能力包来源中有 ${dropped} 条不合法，已丢弃`);
    cache = next;
    if (file) writeAtomic(file, JSON.stringify({ schemaVersion: 1, sources: list() }, null, 2) + "\n");
    return { count: next.size, dropped };
  }

  return { list, get, replace, file };
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
