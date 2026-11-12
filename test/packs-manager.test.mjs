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
  if (withSource) sources.replace([{ git: src.bare, branch: "main", subdir: "packs/demo" }]);
  const changes = [];
  const manager = createPackManager({ registry, sources, log: quiet, onChange: (c) => changes.push(c) });
  return { src, state, registry, sources, manager, changes };
}

test("来源缓存：替换后落盘、重开可读；不合法/重复条目丢弃；空数组清空；v1 缓存丢弃旧 id", () => {
  const dir = tmp();
  const file = join(dir, "pack-sources.json");
  const a = createSourcesCache({ file, log: quiet });
  const r = a.replace([
    { git: "https://git.example/osg.git", branch: "main", subdir: "./tools/" },
    { git: "https://GIT.example/osg", branch: "main", subdir: "tools" },
    { id: "1bad", git: "x", branch: "main" },
    { git: "x", branch: "main", subdir: "../up" },
    { id: "vc", git: "https://git.example/packs.git", branch: "main" },
    { id: "vc", git: "https://git.example/packs.git", branch: "dev" },
  ]);
  assert.deepEqual(r, { count: 2, dropped: 4 });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  const b = createSourcesCache({ file, log: quiet });
  const key = normalizeSource({ git: "https://git.example/osg.git", branch: "main", subdir: "tools" }).key;
  assert.match(key, /^src-[0-9a-f]{12}$/);
  assert.deepEqual(b.get(key), { key, git: "https://git.example/osg.git", branch: "main", subdir: "tools" });
  assert.equal(b.byOverride("vc")?.branch, "main");
  b.replace([]);
  assert.deepEqual(createSourcesCache({ file, log: quiet }).list(), []);
  assert.equal(normalizeSource({ git: "g", branch: "-x" }), null);
  assert.equal(normalizeSource({ git: "g", branch: "main", subdir: "." }).subdir, undefined);

  writeFileSync(file, JSON.stringify({ schemaVersion: 1, sources: [{ id: "default", git: "https://git.example/packs.git", branch: "main" }] }));
  const legacy = createSourcesCache({ file, log: quiet }).list();
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].id, undefined, "v1 的人填 id 不当覆盖名");
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
  await connect([{ git: "https://git.example/osg.git", branch: "main" }, { id: "vc", git: "https://git.example/packs.git", branch: "main" }]);
  assert.equal(cache.list().length, 2);
  assert.equal(cache.byOverride("vc")?.git, "https://git.example/packs.git");
  await connect(undefined);
  assert.equal(createSourcesCache({ file: cache.file, log: quiet }).byOverride("vc")?.branch, "main");
});

test("安装：按包名找来源，clone 后从 toolset.json 自动发现包名，包根取 subdir，记版本并通知变更", async () => {
  const { registry, manager, changes, src } = setup();
  const r = await manager.install("demo");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.version, sh(src.work, "rev-parse", "--short", "HEAD").trim());
  const pack = registry.get("demo");
  assert.equal(pack.ok, true, pack.reason);
  assert.ok(pack.root.endsWith(join("demo", "packs", "demo")));
  assert.deepEqual(registry.list(), ["demo"]);
  assert.equal(registry.metaOf("demo").sourceKey, normalizeSource({ git: src.bare, branch: "main", subdir: "packs/demo" }).key);
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
  sources.replace([{ git: join(tmp(), "nope.git"), branch: "main" }]);
  const bad = await manager.install("demo");
  assert.equal(bad.code, "git-failed");
  assert.match(bad.reason, /没有找到提供 demo 的来源/);
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
    assert.deepEqual(body.packs.map((p) => [p.id, p.installed]), [[null, false]], "未装来源包名待自动发现");
    const sourceKey = body.packs[0].sourceKey;
    const denied = await fetch(`${base}/api/packs/${sourceKey}/install`, { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(denied.status, 403);
    const installed = await fetch(`${base}/api/packs/${sourceKey}/install`, { method: "POST" });
    assert.equal(installed.status, 200);
    assert.equal((await installed.json()).ok, true);
    body = await (await fetch(`${base}/api/packs`)).json();
    assert.deepEqual(body.packs.map((p) => [p.id, p.installed, p.sourceKey]), [["demo", true, sourceKey]]);
    assert.equal((await fetch(`${base}/api/packs/demo/update`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${base}/api/packs/nope/install`, { method: "POST" })).status, 404);
    const del = await (await fetch(`${base}/api/packs/demo`, { method: "DELETE" })).json();
    assert.equal(del.removed, true);
    assert.deepEqual(audits.map((a) => `${a.target}:${a.detail.action}:${a.outcome}`), [`pack:${sourceKey}:install:completed`, "pack:demo:update:completed", "pack:nope:install:failed", "pack:demo:remove:completed"]);
  } finally {
    await local.close();
  }
});

test("包名覆盖：同一个包从两个分支并装；不填覆盖时第二个来源报重名冲突", async () => {
  const { src, registry, sources, manager } = setup({ withSource: false });
  sh(src.work, "checkout", "-q", "-b", "dev");
  sh(src.work, "push", "-q", "origin", "dev");
  const main = { git: src.bare, branch: "main", subdir: "packs/demo" };
  const dev = { git: src.bare, branch: "dev", subdir: "packs/demo" };
  sources.replace([main, dev]);
  const keys = [main, dev].map((s) => normalizeSource(s).key);
  const first = await manager.install(keys[0]);
  assert.equal(first.ok, true, first.reason);
  const second = await manager.install(keys[1]);
  assert.equal(second.code, "pack-name-conflict");
  assert.match(second.reason, /包名覆盖/);
  const listed = await manager.list();
  assert.equal(listed.find((p) => p.sourceKey === keys[1])?.problemCode, "pack-name-conflict");
  assert.deepEqual(readdirSync(registry.packsDir).filter((n) => n.startsWith(".tmp-")), []);

  sources.replace([main, { ...dev, id: "demoDev" }]);
  assert.equal(manager.canProvide("demoDev"), true);
  const viaName = await manager.install("demoDev");
  assert.equal(viaName.ok, true, viaName.reason);
  assert.deepEqual(registry.list().sort(), ["demo", "demoDev"]);
  assert.equal(registry.metaOf("demoDev").override, "demoDev");
  assert.equal(manager.canProvide("nothing"), false, "所有来源都已装，不再有候选");
});

test("对齐：旧版人填包名（default）的目录改名为 toolset.json 的 id；覆盖名变化时跟随", async () => {
  const { src, registry, sources, manager } = setup();
  const packsDir = registry.packsDir;
  mkdirSync(join(packsDir, ".meta"), { recursive: true });
  sh(packsDir, "clone", "-q", src.bare, "default");
  writeFileSync(join(packsDir, ".meta", "default.json"), JSON.stringify({ id: "default", git: src.bare, branch: "main", subdir: "packs/demo" }));
  assert.deepEqual(registry.list(), ["default"]);
  assert.deepEqual(manager.reconcile(), [{ from: "default", to: "demo" }]);
  assert.deepEqual(registry.list(), ["demo"]);
  assert.equal(registry.get("demo").ok, true);
  assert.ok(registry.metaOf("demo").sourceKey);
  assert.equal(manager.needsInstall([{ uses: "demo/hello" }]), false);

  sources.replace([{ git: src.bare, branch: "main", subdir: "packs/demo", id: "demo2" }]);
  assert.deepEqual(manager.reconcile(), [{ from: "demo", to: "demo2" }]);
  assert.deepEqual(manager.reconcile(), [], "已对齐时不再改名");
});

test("git 凭据：私有 HTTPS 来源调用 git 时注入 Authorization 头并清空本机 helper", async () => {
  const { createGitAuth } = await import("../src/packs/git-auth.mjs");
  const state = tmp();
  const gitAuth = createGitAuth({ file: join(state, "git-credentials.json"), log: quiet });
  gitAuth.upsert({ url: "https://git.example.com/team", token: "secret-token" });
  const registry = createPackRegistry({ packsDir: join(state, "packs") });
  const sources = createSourcesCache({ file: join(state, "pack-sources.json"), log: quiet });
  sources.replace([{ git: "https://git.example.com/team/packs.git", branch: "main" }]);
  const calls = [];
  const run = async (command, args, { env }) => {
    calls.push({ args, env });
    return { code: 128, stdout: "", stderr: "fatal: Authentication failed" };
  };
  const manager = createPackManager({ registry, sources, gitAuth, run, log: quiet, env: { PATH: "/usr/bin" } });
  const r = await manager.install(sources.list()[0].key);
  assert.equal(r.code, "git-failed");
  assert.match(r.reason, /设置 → Git 凭据/);
  const clone = calls.find((c) => c.args[0] === "clone");
  assert.equal(clone.env.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(clone.env.GIT_CONFIG_VALUE_0, "");
  assert.equal(clone.env.GIT_CONFIG_KEY_1, "http.https://git.example.com/team/packs.git.extraHeader");
  assert.equal(clone.env.GIT_CONFIG_VALUE_1, `Authorization: Basic ${Buffer.from("oauth2:secret-token").toString("base64")}`);
  assert.equal(clone.env.GIT_TERMINAL_PROMPT, "0");
  const [entry] = await manager.list();
  assert.deepEqual(entry.credential, { url: "https://git.example.com/team", username: "oauth2", tokenLastFour: "oken" });
});
