/**
 * 能力包管理（PRD-7 A5 / A8）：安装、更新、删除、列出。git 逻辑照搬 cronkit src/core/toolset/manager.ts。
 *
 * 目录：
 *   <packsDir>/<包名>/                 git 克隆；包根 = 克隆目录 + subdir
 *   <packsDir>/.meta/<包名>.json       安装时的来源快照 { id, sourceKey, git, branch, subdir?, override? }，registry 据此定位包根
 *   <packsDir>/.patches/<包名>-<时间>.patch   更新前工作区有改动时的 git diff 备份
 *
 * 包名（契约 v2.5）：来源填了覆盖名就用它，否则克隆后读包根 toolset.json 的 id。
 * - 两个来源解析出同一包名：后装的那个拒绝（pack-name-conflict），提示在 Hub 填包名覆盖；
 * - 按包名安装（target 缺包时）：先找覆盖名相同的来源，找不到就依次安装尚未安装的无覆盖来源，直到出现该包；
 * - 对齐（reconcile）：已装目录名与来源应得的包名不一致时改名（例如旧版人填的 default → versionControl）。
 *
 * 来源只认 sources（hub 下发并缓存的 packSources）；更新时来源已被删除则退回 .meta 里的快照。
 * 私有仓凭据来自本机 gitAuth（按 URL 前缀），每次 git 调用单独注入，不读本机 credential helper。
 * 同一个包（或同一个来源）的并发操作合并成一次。
 * 每次 install/update/remove 结束（成功或失败）都调 onChange，装配层据此重派生 Card 并发 card.update。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "./exec.mjs";
import { depsStatus, prepareDeps } from "./deps.mjs";
import { parseUses } from "./registry.mjs";
import { PACK_ID_PATTERN, SOURCE_KEY_PATTERN, sourceKeyOf } from "./sources-cache.mjs";

export function createPackManager({ registry, sources, gitAuth = null, log = console, run = runCommand, platform = process.platform, env = process.env, onChange, now = () => new Date() } = {}) {
  const packsDir = registry?.packsDir;
  if (!packsDir) throw new Error("createPackManager 需要带 packsDir 的 registry");
  const inflight = new Map();
  /** 来源 key → 最近一次安装失败（列表里展示冲突等原因），成功后清除。 */
  const sourceProblems = new Map();

  const metaDir = join(packsDir, ".meta");
  const patchesDir = join(packsDir, ".patches");

  function git(args, cwd, url) {
    return run("git", args, { cwd, env: gitAuth && url ? gitAuth.envFor(url, env) : env });
  }

  function fail(code, reason) {
    return { ok: false, code, reason };
  }

  function gitFail(r, what, url) {
    if (r.spawnError) return fail("git-missing", "本机没有 git");
    const text = tail(r.stderr || r.stdout);
    const authHint = /authentication|could not read username|403|401|permission denied|terminal prompts disabled/i.test(text)
      ? `\n仓库可能是私有的：请在本机控制台「设置 → Git 凭据」里为 ${url ?? "该仓库"} 配置 token。`
      : "";
    return fail("git-failed", `${what}失败：${text}${authHint}`);
  }

  function writeMeta(name, source) {
    mkdirSync(metaDir, { recursive: true });
    const meta = {
      id: name,
      sourceKey: source.key ?? sourceKeyOf(source),
      git: source.git,
      branch: source.branch,
      ...(source.subdir ? { subdir: source.subdir } : {}),
      ...(source.id ? { override: source.id } : {}),
    };
    writeFileSync(join(metaDir, `${name}.json`), JSON.stringify(meta, null, 2) + "\n");
  }

  async function version(name) {
    const dir = registry.cloneDirOf(name);
    if (!existsSync(join(dir, ".git"))) return null;
    const r = await git(["rev-parse", "--short", "HEAD"], dir);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** 已装包名 → 来源 key（.meta 里的 sourceKey；旧版 meta 没有时按 git/branch/subdir 现算）。 */
  function installedByKey() {
    const out = new Map();
    for (const name of registry.list?.() ?? []) {
      const meta = registry.metaOf(name);
      if (!meta?.git || !meta?.branch) continue;
      out.set(meta.sourceKey ?? sourceKeyOf(meta), name);
    }
    return out;
  }

  /** 已装包当前对应的来源：按 meta 的来源 key 找，其次找覆盖名等于包名的来源。 */
  function sourceOfInstalled(name) {
    const meta = registry.metaOf(name);
    if (meta?.git && meta?.branch) {
      const s = sources?.get?.(meta.sourceKey ?? sourceKeyOf(meta));
      if (s) return s;
    }
    return sources?.byOverride?.(name) ?? null;
  }

  /** 单飞：同一个 key 同时只有一个操作在跑，后来的直接拿同一个结果。 */
  function single(key, op) {
    const running = inflight.get(key);
    if (running) return running;
    const p = op()
      .catch((error) => fail("unexpected", error?.message ?? String(error)))
      .then((result) => {
        inflight.delete(key);
        try { onChange?.({ id: result?.id ?? key, result }); } catch (error) { log.warn?.(`[packs] onChange 回调失败：${error?.message ?? error}`); }
        return result;
      });
    inflight.set(key, p);
    return p;
  }

  async function finishDeps(name, onProgress) {
    const pack = registry.get(name);
    if (!pack.ok) return { ...fail(pack.code, pack.reason), id: name };
    const deps = await prepareDeps(pack.root, pack.manifest, { run, platform, env, onProgress });
    if (!deps.ok) return { ...deps, id: name, version: await version(name) };
    return { ok: true, id: name, version: await version(name) };
  }

  function describeSource(source) {
    return `${source.git}${source.subdir ? ` / ${source.subdir}` : ""}@${source.branch}`;
  }

  function readManifestId(root) {
    try {
      const id = JSON.parse(readFileSync(join(root, "toolset.json"), "utf8"))?.id;
      return typeof id === "string" ? id.trim() : "";
    } catch {
      return "";
    }
  }

  /** 安装一个来源：克隆 → 解析包名 → 查重 → 放到 packs/<包名>。已装则转为更新。 */
  async function doInstallSource(source, onProgress, nameHint = null) {
    const existing = installedByKey().get(source.key);
    if (existing) return doUpdate(existing, onProgress);
    mkdirSync(packsDir, { recursive: true });
    const tmp = join(packsDir, `.tmp-${source.key}-${randomUUID().slice(0, 8)}`);
    const label = source.id ?? nameHint ?? describeSource(source);
    onProgress?.(`安装 ${label}…`);
    log.info?.(`[packs] 安装 ${label}：git clone --branch ${source.branch} ${source.git}`);
    const cloned = await git(["clone", "--branch", source.branch, "--", source.git, tmp], packsDir, source.git);
    if (cloned.code !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      return gitFail(cloned, "git clone ", source.git);
    }
    const root = source.subdir ? join(tmp, ...source.subdir.split("/")) : tmp;
    if (!existsSync(join(root, "toolset.json"))) {
      rmSync(tmp, { recursive: true, force: true });
      return fail("manifest-missing", `来源 ${describeSource(source)} 下没有 toolset.json，请检查子目录`);
    }
    const name = source.id ?? readManifestId(root);
    if (!PACK_ID_PATTERN.test(name) || name.length > 64) {
      rmSync(tmp, { recursive: true, force: true });
      return fail("manifest-invalid", `来源 ${describeSource(source)} 的 toolset.json 缺少合法 id；可以在 Hub 来源的「高级 → 包名覆盖」里指定包名`);
    }
    const dir = registry.cloneDirOf(name);
    if (existsSync(dir)) {
      rmSync(tmp, { recursive: true, force: true });
      const owner = registry.metaOf(name);
      const ownerText = owner?.git ? `来源 ${describeSource(owner)}` : "本机已有的同名目录";
      return { ...fail("pack-name-conflict", `包名 ${name} 已被${ownerText}占用；如需并装，请在 Hub 为 ${describeSource(source)} 填写「包名覆盖」`), id: name };
    }
    renameSync(tmp, dir);
    writeMeta(name, source);
    onProgress?.(`准备 ${name} 依赖…`);
    const result = await finishDeps(name, onProgress);
    log.info?.(`[packs] 安装 ${name} ${result.ok ? `完成 ${result.version}` : `依赖未就绪：${result.reason}`}`);
    return result;
  }

  /** 工作区有改动时把 git diff 存成 patch。→ patch 路径 | null */
  async function backupLocalChanges(name, dir) {
    const status = await git(["status", "--porcelain", "--untracked-files=no"], dir);
    if (status.code !== 0 || !status.stdout.trim()) return null;
    const diff = await git(["diff", "HEAD"], dir);
    if (diff.code !== 0 || !diff.stdout.trim()) return null;
    mkdirSync(patchesDir, { recursive: true });
    const file = join(patchesDir, `${name}-${stamp(now())}.patch`);
    writeFileSync(file, diff.stdout);
    log.info?.(`[packs] ${name} 工作区有改动，已备份到 ${file}`);
    return file;
  }

  async function doUpdate(name, onProgress) {
    const dir = registry.cloneDirOf(name);
    if (!existsSync(join(dir, ".git"))) return doInstallByName(name, onProgress);
    const source = sourceOfInstalled(name) ?? registry.metaOf(name);
    if (!source?.git || !source?.branch) return { ...fail("source-unknown", `不知道能力包 ${name} 从哪里更新，请在 Hub 管理台添加来源`), id: name };
    onProgress?.(`更新 ${name}…`);
    const seturl = await git(["remote", "set-url", "origin", source.git], dir);
    if (seturl.code !== 0) return gitFail(seturl, "git remote set-url ", source.git);
    const patch = await backupLocalChanges(name, dir);
    const fetched = await git(["fetch", "origin", source.branch], dir, source.git);
    if (fetched.code !== 0) return gitFail(fetched, "git fetch ", source.git);
    const reset = await git(["reset", "--hard", `origin/${source.branch}`], dir);
    if (reset.code !== 0) return gitFail(reset, "git reset ", source.git);
    writeMeta(name, source);
    const result = await finishDeps(name, onProgress);
    log.info?.(`[packs] 更新 ${name} ${result.ok ? `完成 ${result.version}` : `依赖未就绪：${result.reason}`}`);
    return patch ? { ...result, patch } : result;
  }

  /** 还没装、可能提供该包名的来源：覆盖名相同的优先；否则所有无覆盖的未装来源。 */
  function candidatesFor(name) {
    const override = sources?.byOverride?.(name);
    if (override) return installedByKey().has(override.key) ? [] : [override];
    const installed = installedByKey();
    return (sources?.list?.() ?? []).filter((s) => !s.id && !installed.has(s.key));
  }

  async function doInstallByName(name, onProgress) {
    if (existsSync(join(registry.cloneDirOf(name), ".git"))) return doUpdate(name, onProgress);
    const candidates = candidatesFor(name);
    if (!candidates.length) return { ...fail("source-unknown", `不知道能力包 ${name} 从哪里安装，请在 Hub 管理台添加来源`), id: name };
    let lastFailure = null;
    for (const source of candidates) {
      const r = await runSourceInstall(source, onProgress, candidates.length === 1 ? name : null);
      if (r.ok && r.id === name) return r;
      if (!r.ok && r.id === name) return r;
      if (!r.ok) lastFailure = r;
    }
    if (registry.get(name).ok) return { ok: true, id: name, version: await version(name) };
    if (lastFailure) return { ...lastFailure, id: name, reason: `没有找到提供 ${name} 的来源；其中一个来源安装失败：${lastFailure.reason}` };
    return { ...fail("source-unknown", `已登记的来源里没有能力包 ${name}，请在 Hub 管理台添加来源`), id: name };
  }

  /** 安装来源并记录成败（列表展示用）。 */
  async function runSourceInstall(source, onProgress, nameHint = null) {
    const r = await doInstallSource(source, onProgress, nameHint);
    if (r.ok) sourceProblems.delete(source.key);
    else sourceProblems.set(source.key, { code: r.code, reason: r.reason });
    return r;
  }

  /**
   * 安装：ref 是来源 key（src-xxxxxxxxxxxx，控制台对未装来源点「安装」）或包名（target 缺包）。
   */
  function install(ref, { onProgress } = {}) {
    if (SOURCE_KEY_PATTERN.test(ref)) {
      const source = sources?.get?.(ref);
      if (!source) return single(ref, async () => fail("source-unknown", `来源 ${ref} 不存在，可能已在 Hub 删除`));
      return single(ref, () => runSourceInstall(source, onProgress));
    }
    return single(ref, () => doInstallByName(ref, onProgress));
  }

  function update(name, { onProgress } = {}) {
    return single(name, () => doUpdate(name, onProgress));
  }

  function remove(name) {
    return single(name, async () => {
      const dir = registry.cloneDirOf(name);
      const existed = existsSync(dir);
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(metaDir, `${name}.json`), { force: true });
      log.info?.(`[packs] 删除 ${name}${existed ? "" : "（本来就不在）"}`);
      return { ok: true, id: name, removed: existed };
    });
  }

  /**
   * 对齐：已装包的目录名与来源应得的包名不一致时改名；旧版 meta 补上 sourceKey。
   * 应得包名 = 来源覆盖名 ?? toolset.json 的 id。目标名已被占用或包正忙时跳过。→ 改名记录 [{ from, to }]
   */
  function reconcile({ notify = true } = {}) {
    const renamed = [];
    for (const name of registry.list?.() ?? []) {
      if (inflight.has(name)) continue;
      const meta = registry.metaOf(name);
      if (!meta?.git || !meta?.branch) continue;
      const key = meta.sourceKey ?? sourceKeyOf(meta);
      const source = sources?.get?.(key) ?? null;
      const pack = registry.get(name);
      const want = source?.id ?? (pack.ok ? String(pack.manifest.id) : name);
      const snapshot = source ?? { ...meta, key };
      if (want === name || !PACK_ID_PATTERN.test(want) || existsSync(registry.cloneDirOf(want))) {
        if (!meta.sourceKey || (source && (meta.override ?? undefined) !== (source.id ?? undefined))) writeMeta(name, snapshot);
        continue;
      }
      try {
        renameSync(registry.cloneDirOf(name), registry.cloneDirOf(want));
        rmSync(join(metaDir, `${name}.json`), { force: true });
        writeMeta(want, snapshot);
        renamed.push({ from: name, to: want });
        log.info?.(`[packs] 能力包目录 ${name} 改名为 ${want}（与来源包名对齐）`);
      } catch (error) {
        log.warn?.(`[packs] 能力包 ${name} 改名为 ${want} 失败：${error?.message ?? error}`);
      }
    }
    if (renamed.length && notify) {
      try { onChange?.({ id: renamed[0].to, result: { ok: true, renamed } }); } catch {}
    }
    return renamed;
  }

  /** 已装的包 + 尚未安装的来源。 */
  async function list() {
    const out = [];
    const installed = installedByKey();
    for (const name of [...(registry.list?.() ?? [])].sort()) {
      const pack = registry.get(name);
      const source = sourceOfInstalled(name);
      const meta = registry.metaOf(name);
      const entry = { id: name, sourceKey: source?.key ?? meta?.sourceKey ?? null, installed: pack.ok, source: source ?? null, busy: inflight.has(name) };
      if (!source && meta?.git) entry.orphan = true;
      if (pack.ok) {
        entry.version = await version(name);
        entry.displayName = pack.manifest.displayName ?? name;
        const deps = depsStatus(pack.root, pack.manifest);
        entry.depsReady = deps.ready;
        if (!deps.ready) entry.depsReason = deps.reason;
      } else {
        entry.problem = pack.reason;
      }
      if (gitAuth && (source ?? meta)?.git) entry.credential = gitAuth.describe((source ?? meta).git);
      out.push(entry);
    }
    for (const source of sources?.list?.() ?? []) {
      if (installed.has(source.key)) continue;
      const entry = { id: source.id ?? null, sourceKey: source.key, installed: false, source, busy: inflight.has(source.key) || (source.id ? inflight.has(source.id) : false) };
      const problem = sourceProblems.get(source.key);
      if (problem) {
        entry.problem = problem.reason;
        entry.problemCode = problem.code;
      }
      if (gitAuth) entry.credential = gitAuth.describe(source.git);
      out.push(entry);
    }
    return out;
  }

  /** steps 里引用到、本机没装的包名。 */
  function missingPacks(steps) {
    const ids = new Set();
    for (const step of Array.isArray(steps) ? steps : []) {
      const ref = typeof step?.uses === "string" ? parseUses(step.uses) : null;
      if (ref && !registry.get(ref.packId).ok) ids.add(ref.packId);
    }
    return [...ids];
  }

  /** 有没有来源可能提供该包名（覆盖名命中，或还有未装的无覆盖来源）。 */
  function canProvide(name) {
    return candidatesFor(name).length > 0;
  }

  /**
   * 用户在场时的自动补装：缺包且可能有来源就装；没有来源的跳过，交给执行时报 pack-missing。
   * → { ok: true, installed: [...] } | { ok: false, code, reason }
   */
  async function ensureFor(steps, { onProgress } = {}) {
    const installedNow = [];
    for (const name of missingPacks(steps)) {
      if (!canProvide(name)) continue;
      const r = await install(name, { onProgress });
      if (!r.ok) return { ...r, reason: `安装能力包 ${name} 失败：${r.reason}` };
      installedNow.push(name);
    }
    return { ok: true, installed: installedNow };
  }

  /** 是否有需要先装的包（可能有来源才算）。 */
  function needsInstall(steps) {
    return missingPacks(steps).some((name) => canProvide(name));
  }

  return { install, update, remove, list, version, missingPacks, needsInstall, ensureFor, canProvide, reconcile, patchesDir };
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function tail(text) {
  return String(text ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
}

