// 契约 v2.7：整仓来源。Hub 只给 git + branch，agent 扫描仓库里所有 toolset.json；懒添加与自动添加。
// 来源用本地 bare git 仓，不碰网络。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPackManager } from "../src/packs/manager.mjs";
import { createPackRegistry } from "../src/packs/registry.mjs";
import { createPackCatalog, createPackRepos, findPackRoots, isRepoSource } from "../src/packs/repos.mjs";
import { createSourcesCache, sourceKeyOf } from "../src/packs/sources-cache.mjs";

const tmp = (p = "novoard-repos-") => mkdtempSync(join(tmpdir(), p));
const quiet = { info() {}, warn() {}, error() {} };

function sh(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
}

function writePack(work, subdir, id) {
  const dir = subdir ? join(work, ...subdir.split("/")) : work;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "toolset.json"), JSON.stringify({ id, displayName: `${id} 包`, schemaVersion: 1, runtime: "node", entry: "pack.mjs", tools: [{ id: "hello" }] }, null, 2));
  writeFileSync(join(dir, "pack.mjs"), "console.log('hi');\n");
}

/** 一个仓里两个包：packs/alpha、packs/beta；外加一个 node_modules 里的假包（不该被扫到）。 */
function makeRepo() {
  const base = tmp("novoard-repos-src-");
  const work = join(base, "work");
  const bare = join(base, "multi.git");
  writePack(work, "packs/alpha", "alpha");
  writePack(work, "packs/beta", "beta");
  writePack(work, "node_modules/junk", "junk");
  sh(work, "init", "-q");
  sh(work, "add", "-f", ".");
  sh(work, "commit", "-q", "-m", "init");
  sh(base, "clone", "-q", "--bare", work, bare);
  sh(work, "remote", "add", "origin", bare);
  return { base, work, bare };
}

function setup(sourceList, { clock } = {}) {
  const state = tmp();
  const registry = createPackRegistry({ packsDir: join(state, "packs") });
  const sources = createSourcesCache({ file: join(state, "pack-sources.json"), log: quiet });
  sources.replace(sourceList);
  const repos = createPackRepos({ packsDir: registry.packsDir, sources, settingsFile: join(state, "pack-repos.json"), log: quiet, ...(clock ? { now: clock } : {}) });
  const catalog = createPackCatalog({ sources, repos });
  const changes = [];
  const manager = createPackManager({ registry, sources: catalog, repos, log: quiet, onChange: (c) => changes.push(c) });
  return { state, registry, sources, repos, catalog, manager, changes };
}

test("findPackRoots：找出所有包根，不进 node_modules 与隐藏目录，包根内不再往下找", () => {
  const dir = tmp();
  writePack(dir, "a", "a");
  writePack(dir, "a/nested", "nested");
  writePack(dir, "deep/x/y", "deep");
  writePack(dir, ".hidden", "hidden");
  writePack(dir, "node_modules/m", "m");
  mkdirSync(join(dir, "bad"));
  writeFileSync(join(dir, "bad", "toolset.json"), "{");
  const roots = findPackRoots(dir);
  assert.deepEqual(roots.map((r) => r.subdir), ["a", "bad", "deep/x/y"]);
  assert.equal(roots[0].id, "a");
  assert.equal(roots[1].id, "");
  assert.match(roots[1].problem, /无法解析/);
});

test("整仓来源判定：没有 subdir 且没有包名覆盖才算", () => {
  assert.equal(isRepoSource({ git: "g", branch: "main" }), true);
  assert.equal(isRepoSource({ git: "g", branch: "main", subdir: "x" }), false);
  assert.equal(isRepoSource({ git: "g", branch: "main", id: "x" }), false);
});

test("扫描整仓：列出仓里每个包，按 key 安装；派生 key 与旧版手填子目录的 key 相同", async () => {
  const src = makeRepo();
  const { manager, registry } = setup([{ git: src.bare, branch: "main" }]);
  const [repo] = manager.listRepos();
  assert.equal(repo.scannedAt, null);
  assert.equal((await manager.list()).length, 0, "扫描前没有可装的包");

  const scanned = await manager.scanRepo(repo.key);
  assert.equal(scanned.ok, true, scanned.reason);
  assert.deepEqual(scanned.repo.packs.map((p) => p.id), ["alpha", "beta"]);
  assert.deepEqual(scanned.added, [], "没开自动添加就只扫描");

  const listed = await manager.list();
  assert.deepEqual(listed.map((p) => [p.id, p.installed]), [["alpha", false], ["beta", false]]);
  const alphaKey = sourceKeyOf({ git: src.bare, branch: "main", subdir: "packs/alpha" });
  assert.equal(listed[0].sourceKey, alphaKey);

  const r = await manager.install(alphaKey);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.id, "alpha");
  assert.equal(registry.get("alpha").ok, true);
  assert.equal(registry.metaOf("alpha").subdir, "packs/alpha");
  const after = await manager.list();
  assert.equal(after.find((p) => p.id === "alpha").installed, true);
  assert.equal(after.find((p) => p.id === "alpha").orphan, undefined);
});

test("懒添加：target 缺包时，过期或没扫过的整仓先扫一遍再装", async () => {
  const src = makeRepo();
  let t = Date.parse("2026-11-19T10:00:00Z");
  const { manager, registry } = setup([{ git: src.bare, branch: "main" }], { clock: () => t });
  assert.equal(manager.canProvide("beta"), true, "还没扫过，可能提供");
  const steps = [{ uses: "beta/hello" }];
  assert.equal(manager.needsInstall(steps), true);
  const r = await manager.ensureFor(steps);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.installed, ["beta"]);
  assert.equal(registry.get("beta").ok, true);

  // 刚扫过、仓里也没有的包：不算有来源
  assert.equal(manager.canProvide("gamma"), false);
  const none = await manager.ensureFor([{ uses: "gamma/hello" }]);
  assert.deepEqual(none, { ok: true, installed: [] });

  // 仓里新加 gamma，扫描过期后按包名就能装上
  writePack(src.work, "packs/gamma", "gamma");
  sh(src.work, "add", ".");
  sh(src.work, "commit", "-q", "-m", "gamma");
  sh(src.work, "push", "-q", "origin", "main");
  t += 11 * 60 * 1000;
  assert.equal(manager.canProvide("gamma"), true);
  const g = await manager.install("gamma");
  assert.equal(g.ok, true, g.reason);
  assert.equal(registry.get("gamma").ok, true);
});

test("自动添加：开关存本机；扫描后装上仓里所有包，仓里新增的包在下一轮同步时补装", async () => {
  const src = makeRepo();
  const { manager, registry, repos, state } = setup([{ git: src.bare, branch: "main" }]);
  const [repo] = manager.listRepos();
  assert.equal(repo.autoAdd, false);
  assert.deepEqual(manager.setAutoAdd(repo.key, true), { ok: true, key: repo.key, autoAdd: true });
  const scanned = await manager.scanRepo(repo.key);
  assert.deepEqual(scanned.added.sort(), ["alpha", "beta"]);
  assert.equal(registry.get("alpha").ok && registry.get("beta").ok, true);

  writePack(src.work, "tools/gamma", "gamma");
  sh(src.work, "add", ".");
  sh(src.work, "commit", "-q", "-m", "gamma");
  sh(src.work, "push", "-q", "origin", "main");
  const synced = await manager.syncRepos({ force: true });
  assert.equal(synced.scanned, 1);
  assert.deepEqual(synced.added, ["gamma"]);
  assert.equal(registry.metaOf("gamma").subdir, "tools/gamma");

  // 开关跨重启保留
  const again = createPackRepos({ packsDir: registry.packsDir, sources: createSourcesCache({ file: join(state, "pack-sources.json"), log: quiet }), settingsFile: join(state, "pack-repos.json"), log: quiet });
  assert.equal(again.list()[0].autoAdd, true);
  assert.equal(repos.setAutoAdd(repo.key, false), false);
});

test("迁移：旧版按子目录装的包，Hub 改成整仓来源后不变成孤儿，更新照常", async () => {
  const src = makeRepo();
  const { manager, registry, sources, catalog } = setup([{ git: src.bare, branch: "main", subdir: "packs/alpha" }]);
  const r = await manager.install("alpha");
  assert.equal(r.ok, true, r.reason);

  sources.replace([{ git: src.bare, branch: "main" }]);
  const before = (await manager.list()).find((p) => p.id === "alpha");
  assert.equal(before.installed, true);
  assert.equal(before.orphan, undefined, "扫描前由整仓来源认领");
  assert.equal(before.source.repo, catalog.repoFor(registry.metaOf("alpha")).repo);

  const [repo] = manager.listRepos();
  await manager.scanRepo(repo.key);
  const listed = await manager.list();
  assert.deepEqual(listed.map((p) => [p.id, p.installed]), [["alpha", true], ["beta", false]], "已装的 alpha 不会重复列成未装");
  const u = await manager.update("alpha");
  assert.equal(u.ok, true, u.reason);
});

test("扫描失败：记录原因，保留上次结果；仓库删掉后扫描缓存被清理", async () => {
  const src = makeRepo();
  const { manager, repos } = setup([{ git: src.bare, branch: "main" }]);
  const [repo] = manager.listRepos();
  await manager.scanRepo(repo.key);
  execFileSync("git", ["--git-dir", src.bare, "branch", "-m", "main", "trunk"]);
  // 浅克隆目录还在，拉取失败后重克隆也失败
  const failed = await manager.scanRepo(repo.key);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "scan-failed");
  assert.deepEqual(failed.repo.packs.map((p) => p.id), ["alpha", "beta"], "失败时沿用上次扫到的包");

  const missingRepo = await manager.scanRepo("src-000000000000");
  assert.equal(missingRepo.code, "source-unknown");

  repos.prune();
  assert.equal(existsSync(join(repos.reposDir, `${repo.key}.json`)), true);
});
