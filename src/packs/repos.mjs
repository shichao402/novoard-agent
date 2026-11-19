/**
 * 整仓来源（契约 v2.7）：Hub 只登记 git + branch，agent 自己扫描仓库里所有 toolset.json。
 *
 * - 整仓来源 = 没有 subdir、也没有包名覆盖的 packSources 条目；带 subdir 或 id 的旧条目仍按单包来源处理。
 * - 扫描用浅克隆 <packsDir>/.repos/<来源 key>/，结果写 <packsDir>/.repos/<来源 key>.json：
 *   { git, branch, commit, scannedAt, packs: [{ subdir?, id, displayName? }], error? }
 * - 扫描出的每个包根各成一个派生来源 { git, branch, subdir }，key 与旧版「手填子目录」的来源 key 相同，
 *   所以旧版装好的包升级后直接对上，不用重装。
 * - 「自动添加」是本机开关，存 <stateDir>/pack-repos.json：{ schemaVersion: 1, repos: { <key>: { autoAdd } } }。
 *
 * 这里只负责扫描与目录，安装交给 manager（它把 catalog 当成来源表使用）。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "./exec.mjs";
import { PACK_ID_PATTERN, sourceKeyOf } from "./sources-cache.mjs";

/** 默认 10 分钟：触发路径上发现缺包时，扫描结果超过这个时间就先重扫再找。 */
export const DEFAULT_STALE_MS = 10 * 60 * 1000;
const MAX_DEPTH = 5;
const SKIP_DIRS = new Set(["node_modules", "__pycache__", "venv", ".venv"]);

export function packReposPath(stateDir) {
  return join(stateDir, "pack-repos.json");
}

/** 没有 subdir、没有包名覆盖的来源按整仓扫描。 */
export function isRepoSource(source) {
  return Boolean(source) && !source.subdir && !source.id;
}

/**
 * 在目录里找包根：有 toolset.json 的目录算一个包，不再往里走；跳过隐藏目录与依赖目录，最多 5 层。
 * → [{ subdir?, id, displayName? }]，按 subdir 排序；id 不合法的包根也列出，id 置空，安装时会报错说明。
 */
export function findPackRoots(root) {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (existsSync(join(dir, "toolset.json"))) {
      const manifest = readManifest(join(dir, "toolset.json"));
      const entry = { id: manifest.id };
      if (rel) entry.subdir = rel;
      if (manifest.displayName) entry.displayName = manifest.displayName;
      if (manifest.problem) entry.problem = manifest.problem;
      out.push(entry);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const child = join(dir, name);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(child, rel ? `${rel}/${name}` : name, depth + 1);
    }
  };
  walk(root, "", 0);
  return out;
}

function readManifest(file) {
  try {
    const m = JSON.parse(readFileSync(file, "utf8"));
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    const displayName = typeof m?.displayName === "string" ? m.displayName : undefined;
    if (!PACK_ID_PATTERN.test(id) || id.length > 64) return { id: "", displayName, problem: "toolset.json 缺少合法 id" };
    return { id, displayName };
  } catch (error) {
    return { id: "", problem: `toolset.json 无法解析：${error.message}` };
  }
}

export function createPackRepos({ packsDir, sources, settingsFile = null, gitAuth = null, run = runCommand, env = process.env, log = console, now = () => Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  if (!packsDir) throw new Error("createPackRepos 需要 packsDir");
  const reposDir = join(packsDir, ".repos");
  const inflight = new Map();
  let settings = null;

  function git(args, cwd, url) {
    return run("git", args, { cwd, env: gitAuth && url ? gitAuth.envFor(url, env) : env });
  }

  // ---------- 本机设置（自动添加开关） ----------

  function loadSettings() {
    if (settings) return settings;
    settings = {};
    if (settingsFile && existsSync(settingsFile)) {
      try {
        const data = JSON.parse(readFileSync(settingsFile, "utf8"));
        if (data?.repos && typeof data.repos === "object") settings = data.repos;
      } catch (error) {
        log.warn?.(`[packs] ${settingsFile} 无法解析，自动添加开关按全关处理：${error.message}`);
      }
    }
    return settings;
  }

  function autoAddOf(key) {
    return loadSettings()[key]?.autoAdd === true;
  }

  function setAutoAdd(key, on) {
    const all = loadSettings();
    if (on) all[key] = { ...(all[key] ?? {}), autoAdd: true };
    else delete all[key];
    if (settingsFile) writeAtomic(settingsFile, JSON.stringify({ schemaVersion: 1, repos: all }, null, 2) + "\n");
    return autoAddOf(key);
  }

  // ---------- 扫描结果 ----------

  function scanFile(key) {
    return join(reposDir, `${key}.json`);
  }

  function readScan(key) {
    const file = scanFile(key);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }

  /** 来源换了地址或分支（key 不变的情况只会是大小写规整），旧结果不作数。 */
  function scanOf(repo) {
    const scan = readScan(repo.key);
    return scan && scan.branch === repo.branch ? scan : null;
  }

  /** 已登记的整仓来源，带扫描结果与自动添加开关。 */
  function list() {
    return (sources?.list?.() ?? []).filter(isRepoSource).map((s) => {
      const scan = scanOf(s);
      return {
        key: s.key,
        git: s.git,
        branch: s.branch,
        autoAdd: autoAddOf(s.key),
        scanning: inflight.has(s.key),
        scannedAt: scan?.scannedAt ?? null,
        commit: scan?.commit ?? null,
        packs: scan?.packs ?? [],
        ...(scan?.error ? { error: scan.error } : {}),
      };
    });
  }

  function get(key) {
    return list().find((r) => r.key === key) ?? null;
  }

  function isStale(repo) {
    if (!repo.scannedAt) return true;
    const at = Date.parse(repo.scannedAt);
    return !Number.isFinite(at) || now() - at > staleMs;
  }

  /** 扫描出的包根 → 可安装的派生来源。 */
  function derived() {
    const out = [];
    for (const repo of list()) {
      for (const p of repo.packs) {
        const s = { git: repo.git, branch: repo.branch, ...(p.subdir ? { subdir: p.subdir } : {}) };
        out.push({ key: sourceKeyOf(s), ...s, repo: repo.key, ...(p.id ? { found: p.id } : {}), ...(p.displayName ? { displayName: p.displayName } : {}) });
      }
    }
    return out;
  }

  // ---------- 扫描 ----------

  /** 浅克隆或拉取到 .repos/<key>，再找包根。同一来源并发扫描合并成一次。→ 最新的 repo 条目 */
  function scan(key) {
    const running = inflight.get(key);
    if (running) return running;
    const source = (sources?.list?.() ?? []).find((s) => s.key === key && isRepoSource(s));
    if (!source) return Promise.resolve(null);
    const p = doScan(source)
      .catch((error) => ({ error: error?.message ?? String(error) }))
      .then((result) => {
        const record = { git: source.git, branch: source.branch, scannedAt: new Date(now()).toISOString(), ...result };
        mkdirSync(reposDir, { recursive: true });
        writeAtomic(scanFile(key), JSON.stringify(record, null, 2) + "\n");
        inflight.delete(key);
        log.info?.(`[packs] 扫描 ${source.git}@${source.branch}：${record.error ? `失败 ${record.error}` : `找到 ${record.packs.length} 个包`}`);
        return get(key);
      });
    inflight.set(key, p);
    return p;
  }

  async function doScan(source) {
    const dir = join(reposDir, source.key);
    let ok = false;
    if (existsSync(join(dir, ".git"))) ok = await refresh(source, dir);
    if (!ok) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(reposDir, { recursive: true });
      const cloned = await git(["clone", "--depth", "1", "--branch", source.branch, "--", source.git, dir], reposDir, source.git);
      if (cloned.code !== 0) {
        rmSync(dir, { recursive: true, force: true });
        return { packs: readScan(source.key)?.packs ?? [], error: gitError(cloned, source.git) };
      }
    }
    const head = await git(["rev-parse", "--short", "HEAD"], dir);
    return { commit: head.code === 0 ? head.stdout.trim() : null, packs: findPackRoots(dir) };
  }

  async function refresh(source, dir) {
    if ((await git(["remote", "set-url", "origin", source.git], dir)).code !== 0) return false;
    if ((await git(["fetch", "--depth", "1", "origin", source.branch], dir, source.git)).code !== 0) return false;
    return (await git(["reset", "--hard", "FETCH_HEAD"], dir)).code === 0;
  }

  /** 扫描所有过期（或 force 时全部）的整仓来源。 */
  async function scanAll({ force = false } = {}) {
    const targets = list().filter((r) => force || isStale(r));
    return Promise.all(targets.map((r) => scan(r.key)));
  }

  /** 删掉 Hub 已不再登记的扫描缓存。 */
  function prune() {
    if (!existsSync(reposDir)) return;
    const keep = new Set(list().map((r) => r.key));
    for (const name of readdirSync(reposDir)) {
      const key = name.replace(/\.json$/, "");
      if (key.startsWith(".") || keep.has(key) || inflight.has(key)) continue;
      rmSync(join(reposDir, name), { recursive: true, force: true });
    }
  }

  return { list, get, derived, scan, scanAll, isStale, autoAddOf, setAutoAdd, prune, reposDir };
}

/**
 * 给 manager 用的来源表：单包来源（旧条目）+ 整仓扫描出的派生来源。
 * 整仓来源本身不是可装的包，不出现在 list 里；它对应的已装包由 repoFor 认领，避免扫描前被当成孤儿。
 */
export function createPackCatalog({ sources, repos }) {
  function list() {
    const seen = new Set();
    const out = [];
    for (const s of sources?.list?.() ?? []) {
      if (isRepoSource(s)) continue;
      seen.add(s.key);
      out.push(s);
    }
    for (const s of repos?.derived?.() ?? []) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      out.push(s);
    }
    return out;
  }

  function get(key) {
    return list().find((s) => s.key === key) ?? null;
  }

  /** 已装包的 meta 与某个整仓来源同仓同分支：按该仓认领。 */
  function repoFor(meta) {
    if (!meta?.git || !meta?.branch) return null;
    const repoKey = sourceKeyOf({ git: meta.git, branch: meta.branch });
    const repo = repos?.get?.(repoKey);
    if (!repo) return null;
    const s = { git: repo.git, branch: repo.branch, ...(meta.subdir ? { subdir: meta.subdir } : {}) };
    return { key: sourceKeyOf(s), ...s, repo: repo.key };
  }

  return { list, get, byOverride: (name) => sources?.byOverride?.(name) ?? null, repoFor };
}

function gitError(r, url) {
  if (r.spawnError) return "本机没有 git";
  const text = String(r.stderr || r.stdout || "").trim().split(/\r?\n/).filter(Boolean).slice(-4).join("\n");
  const auth = /authentication|could not read username|403|401|permission denied|terminal prompts disabled/i.test(text);
  return auth ? `${text}\n仓库可能是私有的：请在本机「设置 → Git 凭据」里为 ${url} 配置 token。` : text || "git 失败";
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
