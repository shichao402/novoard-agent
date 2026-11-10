/**
 * 能力包管理（PRD-7 A5）：安装、更新、删除、列出。git 逻辑照搬 cronkit src/core/toolset/manager.ts。
 *
 * 目录：
 *   <packsDir>/<id>/                 git 克隆；包根 = 克隆目录 + subdir
 *   <packsDir>/.meta/<id>.json       安装时的来源快照 { id, git, branch, subdir? }，registry 据此定位包根
 *   <packsDir>/.patches/<id>-<时间>.patch   更新前工作区有改动时的 git diff 备份
 *
 * 来源只认 sources（hub 下发并缓存的 packSources）；更新时来源已被删除则退回 .meta 里的快照。
 * 同一个包的并发操作合并成一次（install/update 共用 in-flight）。
 * 每次 install/update/remove 结束（成功或失败）都调 onChange，装配层据此重派生 Card 并发 card.update。
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "./exec.mjs";
import { depsStatus, prepareDeps } from "./deps.mjs";
import { parseUses } from "./registry.mjs";

export function createPackManager({ registry, sources, log = console, run = runCommand, platform = process.platform, env = process.env, onChange, now = () => new Date() } = {}) {
  const packsDir = registry?.packsDir;
  if (!packsDir) throw new Error("createPackManager 需要带 packsDir 的 registry");
  const inflight = new Map();

  const metaDir = join(packsDir, ".meta");
  const patchesDir = join(packsDir, ".patches");

  function git(args, cwd) {
    return run("git", args, { cwd, env });
  }

  function fail(code, reason) {
    return { ok: false, code, reason };
  }

  function gitFail(r, what) {
    if (r.spawnError) return fail("git-missing", "本机没有 git");
    return fail("git-failed", `${what}失败：${tail(r.stderr || r.stdout)}`);
  }

  function writeMeta(source) {
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, `${source.id}.json`), JSON.stringify(source, null, 2) + "\n");
  }

  async function version(id) {
    const dir = registry.cloneDirOf(id);
    if (!existsSync(join(dir, ".git"))) return null;
    const r = await git(["rev-parse", "--short", "HEAD"], dir);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  function sourceOf(id) {
    return sources?.get?.(id) ?? null;
  }

  /** 单飞：同一个包同时只有一个操作在跑，后来的直接拿同一个结果。 */
  function single(id, op) {
    const running = inflight.get(id);
    if (running) return running;
    const p = op()
      .catch((error) => fail("unexpected", error?.message ?? String(error)))
      .then((result) => {
        inflight.delete(id);
        try { onChange?.({ id, result }); } catch (error) { log.warn?.(`[packs] onChange 回调失败：${error?.message ?? error}`); }
        return result;
      });
    inflight.set(id, p);
    return p;
  }

  async function finishDeps(id, onProgress) {
    const pack = registry.get(id);
    if (!pack.ok) return fail(pack.code, pack.reason);
    const deps = await prepareDeps(pack.root, pack.manifest, { run, platform, env, onProgress });
    if (!deps.ok) return { ...deps, id, version: await version(id) };
    return { ok: true, id, version: await version(id) };
  }

  async function doInstall(id, onProgress) {
    const source = sourceOf(id);
    if (!source) return fail("source-unknown", `不知道能力包 ${id} 从哪里安装，请在 Hub 管理台添加来源`);
    const dir = registry.cloneDirOf(id);
    if (existsSync(join(dir, ".git"))) return doUpdate(id, onProgress);
    if (existsSync(dir)) return fail("dir-occupied", `${dir} 已存在但不是 git 仓库，请先删除`);
    mkdirSync(packsDir, { recursive: true });
    const tmp = join(packsDir, `.tmp-${id}-${randomUUID().slice(0, 8)}`);
    onProgress?.(`安装 ${id}…`);
    log.info?.(`[packs] 安装 ${id}：git clone --branch ${source.branch} ${source.git}`);
    const cloned = await git(["clone", "--branch", source.branch, "--", source.git, tmp], packsDir);
    if (cloned.code !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      return gitFail(cloned, "git clone ");
    }
    const root = source.subdir ? join(tmp, ...source.subdir.split("/")) : tmp;
    if (!existsSync(join(root, "toolset.json"))) {
      rmSync(tmp, { recursive: true, force: true });
      return fail("manifest-missing", `来源 ${source.git}${source.subdir ? ` 的 ${source.subdir}` : ""} 下没有 toolset.json`);
    }
    renameSync(tmp, dir);
    writeMeta(source);
    onProgress?.(`准备 ${id} 依赖…`);
    const result = await finishDeps(id, onProgress);
    log.info?.(`[packs] 安装 ${id} ${result.ok ? `完成 ${result.version}` : `依赖未就绪：${result.reason}`}`);
    return result;
  }

  /** 工作区有改动时把 git diff 存成 patch。→ patch 路径 | null */
  async function backupLocalChanges(id, dir) {
    const status = await git(["status", "--porcelain", "--untracked-files=no"], dir);
    if (status.code !== 0 || !status.stdout.trim()) return null;
    const diff = await git(["diff", "HEAD"], dir);
    if (diff.code !== 0 || !diff.stdout.trim()) return null;
    mkdirSync(patchesDir, { recursive: true });
    const file = join(patchesDir, `${id}-${stamp(now())}.patch`);
    writeFileSync(file, diff.stdout);
    log.info?.(`[packs] ${id} 工作区有改动，已备份到 ${file}`);
    return file;
  }

  async function doUpdate(id, onProgress) {
    const dir = registry.cloneDirOf(id);
    if (!existsSync(join(dir, ".git"))) return doInstall(id, onProgress);
    const source = sourceOf(id) ?? registry.metaOf(id);
    if (!source?.git || !source?.branch) return fail("source-unknown", `不知道能力包 ${id} 从哪里更新，请在 Hub 管理台添加来源`);
    onProgress?.(`更新 ${id}…`);
    const seturl = await git(["remote", "set-url", "origin", source.git], dir);
    if (seturl.code !== 0) return gitFail(seturl, "git remote set-url ");
    const patch = await backupLocalChanges(id, dir);
    const fetched = await git(["fetch", "origin", source.branch], dir);
    if (fetched.code !== 0) return gitFail(fetched, "git fetch ");
    const reset = await git(["reset", "--hard", `origin/${source.branch}`], dir);
    if (reset.code !== 0) return gitFail(reset, "git reset ");
    writeMeta({ id, git: source.git, branch: source.branch, ...(source.subdir ? { subdir: source.subdir } : {}) });
    const result = await finishDeps(id, onProgress);
    log.info?.(`[packs] 更新 ${id} ${result.ok ? `完成 ${result.version}` : `依赖未就绪：${result.reason}`}`);
    return patch ? { ...result, patch } : result;
  }

  function install(id, { onProgress } = {}) {
    return single(id, () => doInstall(id, onProgress));
  }

  function update(id, { onProgress } = {}) {
    return single(id, () => doUpdate(id, onProgress));
  }

  function remove(id) {
    return single(id, async () => {
      const dir = registry.cloneDirOf(id);
      const existed = existsSync(dir);
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(metaDir, `${id}.json`), { force: true });
      log.info?.(`[packs] 删除 ${id}${existed ? "" : "（本来就不在）"}`);
      return { ok: true, id, removed: existed };
    });
  }

  /** 已装的包与已知来源的并集。 */
  async function list() {
    const ids = new Set([...(registry.list?.() ?? []), ...(sources?.list?.() ?? []).map((s) => s.id)]);
    const out = [];
    for (const id of [...ids].sort()) {
      const pack = registry.get(id);
      const source = sourceOf(id);
      const entry = { id, installed: pack.ok, source, busy: inflight.has(id) };
      if (pack.ok) {
        entry.version = await version(id);
        entry.displayName = pack.manifest.displayName ?? id;
        const deps = depsStatus(pack.root, pack.manifest);
        entry.depsReady = deps.ready;
        if (!deps.ready) entry.depsReason = deps.reason;
      } else if (existsSync(registry.cloneDirOf(id))) {
        entry.problem = pack.reason;
      }
      out.push(entry);
    }
    return out;
  }

  /** steps 里引用到、本机没装的包 id。 */
  function missingPacks(steps) {
    const ids = new Set();
    for (const step of Array.isArray(steps) ? steps : []) {
      const ref = typeof step?.uses === "string" ? parseUses(step.uses) : null;
      if (ref && !registry.get(ref.packId).ok) ids.add(ref.packId);
    }
    return [...ids];
  }

  /**
   * 用户在场时的自动补装：缺包且来源已知就装；来源未知的跳过，交给执行时报 pack-missing。
   * → { ok: true, installed: [...] } | { ok: false, code, reason }
   */
  async function ensureFor(steps, { onProgress } = {}) {
    const installed = [];
    for (const id of missingPacks(steps)) {
      if (!sourceOf(id)) continue;
      const r = await install(id, { onProgress });
      if (!r.ok) return { ...r, reason: `安装能力包 ${id} 失败：${r.reason}` };
      installed.push(id);
    }
    return { ok: true, installed };
  }

  /** 是否有需要先装的包（来源已知才算）。 */
  function needsInstall(steps) {
    return missingPacks(steps).some((id) => sourceOf(id));
  }

  return { install, update, remove, list, version, missingPacks, needsInstall, ensureFor, patchesDir };
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function tail(text) {
  return String(text ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
}
