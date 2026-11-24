/**
 * ADR-0020 磁贴运行时输入：
 * §4 resolveInputs 取值顺序与失败；last 只在受理后写入
 * §1 装载期校验（validateInputDefs）与 query 工具不得作步骤
 * §3 查询工具调用：成功、非 0、格式非法、超时都退化为可自由输入
 * 接口：/api/targets/:id/inputs、/api/tiles 的 inputs 标志；本机 /a2a 与 tunnel 委派都过 resolveInputs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInputMemory, createInputService, resolveInputs, normalizeChoices } from "../src/inputs.mjs";
import { validateInputDefs, validateUsesSteps, deriveCard } from "../src/card.mjs";
import { createLocalA2A } from "../src/local-a2a.mjs";
import { createTunnelClient } from "../src/tunnel-client.mjs";
import { createMockHub } from "./lib/mock-hub.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const BRANCH_TARGET = {
  title: "打开分支工程",
  vars: { poolRoot: "/pool" },
  inputs: [
    { name: "branch", label: "分支", choices: { uses: "fake/list-ok", cwd: "{{poolRoot}}" }, default: "last" },
    { name: "mode", label: "模式", choices: ["fast", "full"], default: "fast" },
    { name: "note", required: false },
  ],
  expanded: [{ script: "echo {{branch}}" }],
};

test("resolveInputs：传入值优先，其次 default/last；可空项缺省为空串", () => {
  const memory = { get: (t, n) => (t === "open" && n === "branch" ? "trunk" : undefined) };
  const a = resolveInputs({ targetId: "open", target: BRANCH_TARGET, vars: { branch: "release/1.0" }, memory });
  assert.deepEqual(a, { ok: true, vars: { branch: "release/1.0", mode: "fast", note: "" } });
  const b = resolveInputs({ targetId: "open", target: BRANCH_TARGET, vars: {}, memory });
  assert.equal(b.vars.branch, "trunk", "default: last 取上次值");
  const c = resolveInputs({ targetId: "open", target: BRANCH_TARGET, vars: { branch: "" }, memory });
  assert.equal(c.vars.branch, "trunk", "必填项传空串等同没传");
  const none = resolveInputs({ targetId: "plain", target: { vars: {} }, vars: { x: 1 } });
  assert.deepEqual(none, { ok: true, vars: { x: 1 } }, "没有 inputs 的 target 原样透传");
});

test("resolveInputs：必填缺值失败并写出 label；静态候选不允许自定义时拒绝列表外的值", () => {
  const miss = resolveInputs({ targetId: "open", target: BRANCH_TARGET, vars: {}, memory: { get: () => undefined } });
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.missing, [{ name: "branch", label: "分支" }]);
  assert.match(miss.reason, /缺少输入：分支（branch）/);

  const bad = resolveInputs({ targetId: "open", target: BRANCH_TARGET, vars: { branch: "b", mode: "turbo" } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /模式（mode）的值 turbo 不在候选项 fast、full 里/);

  const custom = { inputs: [{ name: "mode", choices: ["a"], allowCustom: true }] };
  assert.equal(resolveInputs({ targetId: "x", target: custom, vars: { mode: "z" } }).ok, true);
  const dynamic = { inputs: [{ name: "branch", choices: { uses: "fake/list-ok" } }] };
  assert.equal(resolveInputs({ targetId: "x", target: dynamic, vars: { branch: "any" } }).ok, true, "动态候选不在这里复核");
});

test("input-memory：只记 inputs 里的名字，原子写入，坏文件按空处理", () => {
  const dir = tmp("novoard-inputs-mem-");
  try {
    const file = join(dir, "sub", "input-memory.json");
    const memory = createInputMemory({ file });
    assert.equal(memory.get("open", "branch"), undefined);
    memory.remember("open", BRANCH_TARGET, { branch: "trunk", mode: "full", poolRoot: "/pool" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "open.branch": "trunk", "open.mode": "full" });
    assert.equal(createInputMemory({ file }).get("open", "branch"), "trunk");
    assert.equal(existsSync(`${file}.tmp`), false);
    writeFileSync(file, "{broken");
    assert.equal(memory.get("open", "branch"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInputDefs：重名、与 vars 冲突、非 query 工具、定时目标缺静态 default", () => {
  const tools = { "fake/list": { id: "list", kind: "query" }, "fake/act": { id: "act" } };
  const packs = { lookupTool: (p, t) => tools[`${p}/${t}`] ?? null };
  const targets = {
    a: { vars: { poolRoot: "/p" }, inputs: [{ name: "x" }, { name: "x" }, { name: "poolRoot" }] },
    b: { vars: {}, inputs: [{ name: "y", choices: { uses: "fake/act" } }, { name: "z", choices: { uses: "fake/list" } }, { name: "w", choices: { uses: "absent/tool" } }] },
    c: { vars: {}, schedule: { cron: "0 9 * * *" }, inputs: [{ name: "m", default: "last" }, { name: "n" }, { name: "o", default: "x" }, { name: "p", required: false }] },
  };
  const errors = validateInputDefs(targets, packs);
  assert.deepEqual(errors, [
    "targets.a.inputs[1]: name x 重复",
    "targets.a.inputs[2]: name poolRoot 与 vars 重名，请删掉其中一个",
    "targets.b.inputs[0]: fake/act 不是查询工具（kind: query），不能提供候选项",
    "targets.c.inputs[0]: 带 schedule 的 target，必填输入 m 需要静态 default（last 首次运行前没有值）",
    "targets.c.inputs[1]: 带 schedule 的 target，必填输入 n 需要静态 default（last 首次运行前没有值）",
  ]);
  assert.deepEqual(validateInputDefs(targets, null).length, 5 - 1, "没有 packs 时跳过工具种类检查");

  const stepErrors = validateUsesSteps({ s: { vars: {}, expanded: [{ uses: "fake/list" }] } }, packs);
  assert.match(stepErrors[0], /^targets\.s\.steps\[0\]: fake\/list 是查询工具/);
});

test("deriveCard：inputs 写进技能描述", () => {
  const card = deriveCard({ agentId: "a", targets: { open: { ...BRANCH_TARGET, expose: "a2a" } }, profile: { role: "", introduction: "x" } });
  const text = card.skills.find((s) => s.id === "open").description;
  assert.match(text, /输入：/);
  assert.match(text, /分支/);
  assert.match(text, /候选由本机查询/);
  assert.match(text, /fast/);
});

test("normalizeChoices：字符串与 {value,label,hint}，非法返回 null", () => {
  assert.deepEqual(normalizeChoices(["a", { value: "b", label: "B", hint: "h", extra: 1 }]), [{ value: "a" }, { value: "b", label: "B", hint: "h" }]);
  assert.equal(normalizeChoices("x"), null);
  assert.equal(normalizeChoices([{ label: "no value" }]), null);
});

/** 用 node runtime 的假能力包跑查询工具。 */
function fakePack() {
  const root = tmp("novoard-inputs-pack-");
  const entry = `
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const tool = argv[0];
const at = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const out = at("--result-json");
const write = (o) => out && writeFileSync(out, JSON.stringify(o));
if (tool === "list-ok") { write({ detail: "ok", choices: ["trunk", { value: "release/1.0", label: "1.0", hint: at("--project-root") }] }); process.exit(0); }
if (tool === "list-fail") { write({ detail: "svn 不可达" }); process.exit(1); }
if (tool === "list-bad") { write({ detail: "ok", choices: "trunk" }); process.exit(0); }
if (tool === "list-slow") { setTimeout(() => process.exit(0), 5000); }
`;
  writeFileSync(join(root, "toolset.mjs"), entry);
  const manifest = {
    runtime: "node",
    entry: "toolset.mjs",
    tools: ["list-ok", "list-fail", "list-bad", "list-slow"].map((id) => ({ id, kind: "query", params: [] })).concat([{ id: "act", params: [] }]),
  };
  const registry = {
    get: (id) => (id === "fake" ? { ok: true, manifest, root } : { ok: false, code: "pack-missing", reason: `本机未安装能力包 ${id}` }),
    lookupTool: (p, t) => (p === "fake" ? manifest.tools.find((x) => x.id === t) ?? null : null),
  };
  return { root, registry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function dynTarget(uses) {
  return { title: "t", vars: { poolRoot: "/pool" }, inputs: [{ name: "branch", label: "分支", choices: { uses, cwd: "{{poolRoot}}" } }] };
}

test("查询工具：成功返回候选，cwd 用 vars 插值", async () => {
  const { registry, cleanup } = fakePack();
  try {
    const svc = createInputService({ packs: registry, log: quiet });
    const d = await svc.describe("open", dynTarget("fake/list-ok"));
    assert.equal(d.inputs[0].dynamic, true);
    assert.equal(d.inputs[0].allowCustom, false);
    assert.deepEqual(d.inputs[0].choices, [{ value: "trunk" }, { value: "release/1.0", label: "1.0", hint: "/pool" }]);
    assert.equal(d.inputs[0].error, undefined);
  } finally {
    cleanup();
  }
});

test("查询工具：动态候选按使用历史加权，保留 label/hint，不重新加入消失的值", async () => {
  const { registry, cleanup } = fakePack();
  try {
    const memory = { getHistory: () => [
      { value: "release/1.0", count: 3, lastUsedAt: Date.now() },
      { value: "gone", count: 9, lastUsedAt: Date.now() },
    ] };
    const svc = createInputService({ packs: registry, memory, log: quiet });
    const result = await svc.describe("open", dynTarget("fake/list-ok"));
    assert.deepEqual(result.inputs[0].choices.map((choice) => choice.value), ["release/1.0", "trunk"]);
    assert.equal(result.inputs[0].choices[0].usage.count, 3);
    assert.equal(result.inputs[0].choices[0].label, "1.0");
    assert.equal(result.inputs[0].choices[0].hint, "/pool");
  } finally {
    cleanup();
  }
});

test("查询工具：非 0、格式非法、超时、非 query 工具、包未安装都退化为空列表 + 错误 + 允许自由输入", async () => {
  const { registry, cleanup } = fakePack();
  try {
    const svc = createInputService({ packs: registry, log: quiet, timeoutMs: 300 });
    const cases = [
      ["fake/list-fail", /svn 不可达/],
      ["fake/list-bad", /格式不对/],
      ["fake/list-slow", /查询超过 \d+ 秒没有返回/],
      ["fake/act", /不是查询工具/],
      ["absent/list", /本机未安装能力包 absent/],
    ];
    for (const [uses, why] of cases) {
      const r = await svc.queryChoices("open", dynTarget(uses), "branch");
      assert.deepEqual(r.choices, [], uses);
      assert.equal(r.allowCustom, true, uses);
      assert.match(r.error, why, uses);
    }
    const unknown = await svc.queryChoices("open", dynTarget("fake/list-ok"), "nope");
    assert.match(unknown.error, /没有输入 nope/);
  } finally {
    cleanup();
  }
});

async function rpc(port, method, params) {
  const res = await fetch(`http://127.0.0.1:${port}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

test("本机触发：/a2a 过 resolveInputs；缺值当场 failed 不启动、不写 last；受理后记 last；接口返回 inputs", async () => {
  const dir = tmp("novoard-inputs-local-");
  const memory = createInputMemory({ file: join(dir, "input-memory.json") });
  const launches = [];
  const runtime = { launch: (opts) => { launches.push(opts); return { ok: true }; } };
  const targets = {
    open: { ...BRANCH_TARGET, inputs: BRANCH_TARGET.inputs.map((i) => (i.name === "branch" ? { ...i, choices: ["trunk", "release/1.0"] } : i)) },
    plain: { title: "无输入", vars: {}, expanded: [{ script: "echo" }] },
  };
  const inputService = createInputService({ packs: null, memory, log: quiet });
  const audits = [];
  const local = createLocalA2A({ targets, runtime, audit: (e) => audits.push(e), log: quiet, inputMemory: memory, inputService });
  await local.start();
  const port = local.server.address().port;
  try {
    const failed = await rpc(port, "message/send", { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "open" }] } });
    assert.equal(failed.result.status.state, "failed");
    assert.match(failed.result.status.message, /缺少输入：分支（branch）/);
    assert.equal(launches.length, 0);
    assert.ok(audits.some((e) => e.outcome === "failed"));
    assert.equal(memory.get("open", "branch"), undefined, "失败不写 last");

    const ok = await rpc(port, "message/send", { message: { messageId: "m2", role: "user", parts: [{ kind: "text", text: "open" }, { kind: "data", data: { branch: "release/1.0" } }] } });
    assert.equal(ok.result.status.state, "submitted");
    assert.equal(launches.length, 1);
    assert.equal(launches[0].vars.branch, "release/1.0");
    assert.equal(launches[0].vars.mode, "fast");
    assert.equal(memory.get("open", "branch"), "release/1.0");

    const described = await (await fetch(`http://127.0.0.1:${port}/api/targets/open/inputs`)).json();
    assert.equal(described.ok, true);
    const branch = described.inputs.find((i) => i.name === "branch");
    assert.equal(branch.default, "release/1.0", "default: last 回显上次值");
    assert.deepEqual(branch.choices.map((c) => c.value), ["release/1.0", "trunk"], "最近受理的候选排在前面");
    assert.equal(branch.choices[0].usage.count, 1);
    assert.equal(described.inputs.find((i) => i.name === "note").required, false);

    const missing = await fetch(`http://127.0.0.1:${port}/api/targets/nope/inputs`);
    assert.equal(missing.status, 404);

    const { tiles } = await (await fetch(`http://127.0.0.1:${port}/api/tiles`)).json();
    assert.equal(tiles.find((t) => t.id === "open").inputs, true);
    assert.equal(tiles.find((t) => t.id === "plain").inputs, false);
  } finally {
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

test("Hub 委派：同样过 resolveInputs；缺值上行 failed 不启动；受理后记 last", async () => {
  const hub = await createMockHub({ tokens: { "agent-a": "agent-a-secret" } });
  const stateDir = tmp("novoard-inputs-tunnel-");
  mkdirSync(stateDir, { recursive: true });
  const memory = createInputMemory({ file: join(stateDir, "input-memory.json") });
  const launches = [];
  const runner = { launch: (opts) => { launches.push(opts); return { ok: true }; }, cancel: () => ({ ok: true }), resume: () => ({ ok: true }) };
  const targets = {
    open: { vars: { poolRoot: "/pool" }, inputs: [{ name: "branch", label: "分支" }], expanded: [{ script: "echo {{branch}}" }] },
  };
  const card = {
    name: "agent-a", description: "agent-a", version: "2.0.0",
    capabilities: { streaming: false, pushNotifications: true },
    defaultInputModes: ["text"], defaultOutputModes: ["text", "file"],
    skills: [{ id: "open", name: "open", description: "open", tags: [] }],
  };
  const client = createTunnelClient({
    config: { ok: true, agentId: "agent-a", hubUrl: `ws://127.0.0.1:${hub.server.address().port}/tunnel`, agentToken: "agent-a-secret", contractVersion: "2.7" },
    card, targets, runner, stateDir, log: quiet, inputMemory: memory,
  });
  try {
    await client.start();
    await waitFor(() => client.registered);
    assert.equal(hub.delegateTo("agent-a", { taskId: "task-mock-in-1", target: "open" }).ok, true);
    await waitFor(() => hub.tasks.get("task-mock-in-1")?.state === "failed");
    assert.equal(launches.length, 0);
    assert.equal(memory.get("open", "branch"), undefined);

    assert.equal(hub.delegateTo("agent-a", { taskId: "task-mock-in-2", target: "open", vars: { branch: "trunk" } }).ok, true);
    await waitFor(() => launches.length === 1);
    assert.equal(launches[0].vars.branch, "trunk");
    assert.equal(launches[0].vars.poolRoot, "/pool");
    assert.equal(memory.get("open", "branch"), "trunk");
  } finally {
    client.close();
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
