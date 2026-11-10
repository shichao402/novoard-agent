// PRD-7 A5：能力包管理（安装、更新与 patch 备份、删除、来源缓存、用户在场时自动补装）。
// 来源用本地 bare git 仓，不碰网络。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentRuntime } from "../src/agent-runtime.mjs";
import { depsStatus, prepareDeps, requirementsHash } from "../src/packs/deps.mjs";
import { createPackManager } from "../src/packs/manager.mjs";
import { createPackRegistry } from "../src/packs/registry.mjs";
import { createSourcesCache, normalizeSource } from "../src/packs/sources-cache.mjs";
import { createTunnelClient } from "../src/tunnel-client.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";
import { createMockHub } from "./lib/mock-hub.mjs";

const tmp = (p = "novoard-pm-") => mkdtempSync(join(tmpdir(), p));
const quiet = { info() {}, warn() {}, error() {} };

function sh(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
}

const MANIFEST = {
  id: "demo",
  displayName: "演示包",
  schemaVersion: 1,
  runtime: "node",
  entry: "pack.mjs",
  tools: [{ id: "hello", displayName: "打招呼", idempotent: true }],
};
const ENTRY = "console.log('hello from ' + process.argv[2]);\n";

/** 建一个 bare 来源仓：包放在 packs/demo 子目录。→ { bare, work } */
function makeSource() {
  const base = tmp("novoard-pm-src-");
  const work = join(base, "work");
  const bare = join(base, "demo.git");
  mkdirSync(join(work, "packs", "demo"), { recursive: true });
  writeFileSync(join(work, "packs", "demo", "toolset.json"), JSON.stringify(MANIFEST, null, 2));
  writeFileSync(join(work, "packs", "demo", "pack.mjs"), ENTRY);
  sh(work, "init", "-q");
  sh(work, "add", ".");
  sh(work, "commit", "-q", "-m", "init");
  sh(base, "clone", "-q", "--bare", work, bare);
  sh(work, "remote", "add", "origin", bare);
  return { bare, work };
}

function setup({ withSource = true } = {}) {
  const src = makeSource();
  const state = tmp();
  const registry = createPackRegistry({ packsDir: join(state, "packs") });
  const sources = createSourcesCache({ file: join(state, "pack-sources.json"), log: quiet });
  if (withSource) sources.replace([{ id: "demo", git: src.bare, branch: "main", subdir: "packs/demo" }]);
  const changes = [];
  const manager = createPackManager({ registry, sources, log: quiet, onChange: (c) => changes.push(c) });
  return { src, state, registry, sources, manager, changes };
}

test("来源缓存：替换后落盘、重开可读；不合法条目丢弃；空数组清空", () => {
  const dir = tmp();
  const file = join(dir, "pack-sources.json");
  const a = createSourcesCache({ file, log: quiet });
  const r = a.replace([
    { id: "osg", git: "https://git.example/osg.git", branch: "main", subdir: "./tools/" },
    { id: "1bad", git: "x", branch: "main" },
    { id: "evil", git: "x", branch: "main", subdir: "../up" },
  ]);
  assert.deepEqual(r, { count: 1, dropped: 2 });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const b = createSourcesCache({ file, log: quiet });
  assert.deepEqual(b.get("osg"), { id: "osg", git: "https://git.example/osg.git", branch: "main", subdir: "tools" });
  b.replace([]);
  assert.deepEqual(createSourcesCache({ file, log: quiet }).list(), []);
  assert.equal(normalizeSource({ id: "x", git: "g", branch: "-x" }), null);
  assert.equal(normalizeSource({ id: "x", git: "g", branch: "main", subdir: "." }).subdir, undefined);
});

test("hello.ack 带 packSources 时缓存；缺省时保留旧缓存", async () => {
  const token = "pm-token";
  const config = (port) => ({ ok: true, agentId: "agent-a", hubUrl: `ws://127.0.0.1:${port}/tunnel`, agentToken: token, contractVersion: CONTRACT_VERSION });
  const card = { name: "agent-a", description: "a", version: "1.0.0", capabilities: { streaming: false, pushNotifications: true }, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [] };
  const runner = { launch: () => ({ ok: true }), cancel: () => ({ ok: true }), resume: () => ({ ok: true }) };
  const stateDir = tmp();
  const cache = createSourcesCache({ file: join(stateDir, "pack-sources.json"), log: quiet });
  const connect = async (packSources) => {
    const hub = await createMockHub({ tokens: { "agent-a": token }, packSources });
    const client = createTunnelClient({ config: config(hub.server.address().port), card, targets: {}, runner, stateDir, log: quiet, onFatal() {}, onPackSources: (list) => cache.replace(list) });
    await client.start();
    for (let i = 0; i < 200 && !client.registered; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(client.registered, true);
    await new Promise((r) => setTimeout(r, 50));
    client.close();
    await hub.close?.();
  };
  await connect([{ id: "osg", git: "https://git.example/osg.git", branch: "main" }]);
  assert.equal(cache.get("osg")?.git, "https://git.example/osg.git");
  await connect(undefined);
  assert.equal(createSourcesCache({ file: cache.file, log: quiet }).get("osg")?.branch, "main");
});

test("安装：clone 到 packs/<id>，包根取 subdir，记版本并通知变更", async () => {
  const { registry, manager, changes, src } = setup();
  const r = await manager.install("demo");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.version, sh(src.work, "rev-parse", "--short", "HEAD").trim());
  const pack = registry.get("demo");
  assert.equal(pack.ok, true, pack.reason);
  assert.ok(pack.root.endsWith(join("demo", "packs", "demo")));
  assert.deepEqual(registry.list(), ["demo"]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].result.ok, true);
  const [entry] = await manager.list();
  assert.equal(entry.installed, true);
  assert.equal(entry.depsReady, true);
  assert.equal(entry.version, r.version);
  // 临时克隆目录不残留
  assert.deepEqual(readdirSync(registry.packsDir).filter((n) => n.startsWith(".tmp-")), []);
});

test("更新：工作区有改动先存 patch，再 reset 到远端，工作区恢复干净", async () => {
  const { registry, manager, src } = setup();
  assert.equal((await manager.install("demo")).ok, true);
  const clone = registry.cloneDirOf("demo");
  writeFileSync(join(clone, "packs", "demo", "pack.mjs"), "console.log('local edit');\n");
  writeFileSync(join(src.work, "packs", "demo", "pack.mjs"), "console.log('v2');\n");
  sh(src.work, "commit", "-q", "-am", "v2");
  sh(src.work, "push", "-q", "origin", "main");

  const r = await manager.update("demo");
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.patch && existsSync(r.patch), "应生成 patch");
  assert.match(readFileSync(r.patch, "utf8"), /local edit/);
  assert.ok(r.patch.startsWith(manager.patchesDir));
  assert.equal(sh(clone, "status", "--porcelain").trim(), "");
  assert.equal(readFileSync(join(clone, "packs", "demo", "pack.mjs"), "utf8"), "console.log('v2');\n");
  assert.equal(r.version, sh(src.work, "rev-parse", "--short", "HEAD").trim());

  const again = await manager.update("demo");
  assert.equal(again.ok, true);
  assert.equal(again.patch, undefined, "工作区干净时不生成 patch");
});

test("来源未知、clone 失败、删除", async () => {
  const { manager, registry, sources, changes } = setup({ withSource: false });
  const unknown = await manager.install("demo");
  assert.equal(unknown.code, "source-unknown");
  sources.replace([{ id: "demo", git: join(tmp(), "nope.git"), branch: "main" }]);
  const bad = await manager.install("demo");
  assert.equal(bad.code, "git-failed");
  assert.equal(existsSync(registry.cloneDirOf("demo")), false);
  assert.deepEqual(readdirSync(registry.packsDir).filter((n) => n.startsWith(".tmp-")), []);
  assert.equal(changes.length, 2, "失败也要通知变更");

  const ok = setup();
  await ok.manager.install("demo");
  const removed = await ok.manager.remove("demo");
  assert.deepEqual(removed, { ok: true, id: "demo", removed: true });
  assert.equal(ok.registry.get("demo").ok, false);
  assert.equal(existsSync(join(ok.registry.packsDir, ".meta", "demo.json")), false);
});

test("同一个包的并发安装合并成一次", async () => {
  const { manager, changes } = setup();
  const [a, b] = await Promise.all([manager.install("demo"), manager.install("demo")]);
  assert.equal(a, b);
  assert.equal(a.ok, true);
  assert.equal(changes.length, 1);
});

test("python 依赖：建 venv、pip、写 .deps-ok；requirements 变化后视为未就绪", async () => {
  const root = tmp();
  const manifest = { runtime: "python", entry: "toolset.py" };
  writeFileSync(join(root, "toolset.py"), "");
  writeFileSync(join(root, "requirements.txt"), "requests==2.0\n");
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (args.includes("venv")) {
      mkdirSync(join(root, ".venv", "bin"), { recursive: true });
      writeFileSync(join(root, ".venv", "bin", "python"), "");
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  assert.equal(depsStatus(root, manifest).ready, false);
  const r = await prepareDeps(root, manifest, { run, platform: "darwin" });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(calls, ["python3 -m venv .venv", `${join(root, ".venv", "bin", "python")} -m pip install -r requirements.txt`]);
  assert.equal(readFileSync(join(root, ".venv", ".deps-ok"), "utf8").trim(), requirementsHash(root));
  assert.equal(depsStatus(root, manifest).ready, true);
  writeFileSync(join(root, "requirements.txt"), "requests==3.0\n");
  assert.match(depsStatus(root, manifest).reason, /requirements/);

  const winCalls = [];
  const winRoot = tmp();
  writeFileSync(join(winRoot, "toolset.py"), "");
  const failing = async (command, args) => {
    winCalls.push(`${command} ${args.join(" ")}`);
    return command === "py" ? { code: -1, spawnError: "ENOENT", stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "boom" };
  };
  const w = await prepareDeps(winRoot, manifest, { run: failing, platform: "win32" });
  assert.equal(w.ok, false);
  assert.deepEqual(winCalls, ["py -3 -m venv .venv", "python -m venv .venv"]);
});

test("手动触发缺包且来源已知：先安装再执行，进度显示「安装 demo…」；定时触发不安装", async () => {
  const { registry, manager, state } = setup();
  const steps = [{ uses: "demo/hello", cwd: state }];
  const runtime = createAgentRuntime({ targets: { t: { expanded: steps } }, log: quiet, packs: registry, packInstaller: manager });

  const scheduled = await new Promise((resolve) => {
    runtime.launch({ taskId: "task-s", skillId: "t", steps, trigger: "schedule", onTerminal: (s, d) => resolve({ s, d }) });
  });
  assert.equal(scheduled.s, "failed");
  assert.equal(registry.get("demo").ok, false, "定时触发不应安装");

  const progress = [];
  const manual = await new Promise((resolve) => {
    const r = runtime.launch({ taskId: "task-m", skillId: "t", steps, trigger: "manual", onProgress: (i, n, d) => progress.push(d), onTerminal: (s, d) => resolve({ s, d }) });
    assert.equal(r.reason, "installing-packs");
  });
  assert.equal(manual.s, "completed", manual.d);
  assert.ok(progress.includes("安装 demo…"), progress.join(" | "));
  assert.equal(registry.get("demo").ok, true);
  await runtime.shutdown();
});

test("控制台 API：GET /api/packs 列出，POST install/update，DELETE 删除，跨源写被拒", async () => {
  const { createLocalA2A } = await import("../src/local-a2a.mjs");
  const { manager } = setup();
  const audits = [];
  const local = createLocalA2A({ targets: {}, runtime: { launch: () => ({ ok: true }) }, audit: (e) => audits.push(e), log: quiet, packManager: manager });
  const { port } = await local.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    let body = await (await fetch(`${base}/api/packs`)).json();
    assert.deepEqual(body.packs.map((p) => [p.id, p.installed]), [["demo", false]]);
    const denied = await fetch(`${base}/api/packs/demo/install`, { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(denied.status, 403);
    const installed = await fetch(`${base}/api/packs/demo/install`, { method: "POST" });
    assert.equal(installed.status, 200);
    assert.equal((await installed.json()).ok, true);
    body = await (await fetch(`${base}/api/packs`)).json();
    assert.equal(body.packs[0].installed, true);
    assert.equal((await fetch(`${base}/api/packs/demo/update`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${base}/api/packs/nope/install`, { method: "POST" })).status, 404);
    const del = await (await fetch(`${base}/api/packs/demo`, { method: "DELETE" })).json();
    assert.equal(del.removed, true);
    assert.deepEqual(audits.map((a) => `${a.target}:${a.detail.action}:${a.outcome}`), ["pack:demo:install:completed", "pack:demo:update:completed", "pack:nope:install:failed", "pack:demo:remove:completed"]);
  } finally {
    await local.close();
  }
});
