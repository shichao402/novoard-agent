// PRD-7 A6：诊断六种 code、Card 排除、保存时 warnings、运行时以诊断文字失败、定时前预检。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDiagnoser, formatProblems, DIAG_CODES } from "../src/packs/diagnose.mjs";
import { createPackRegistry } from "../src/packs/registry.mjs";
import { deriveCard } from "../src/card.mjs";
import { createAgentRuntime } from "../src/agent-runtime.mjs";
import { createTargetsStore } from "../src/targets-store.mjs";
import { createScheduler } from "../src/scheduler.mjs";
import { createScheduleState } from "../src/schedule-state.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures-packs");
const quiet = { info() {}, warn() {}, error() {} };
const tmp = (p = "novoard-diag-") => mkdtempSync(join(tmpdir(), p));
const sourcesOf = (...ids) => ({ get: (id) => (ids.includes(id) ? { id, git: `https://example.invalid/${id}.git`, branch: "main" } : null) });

function diag({ packsDir = FIXTURES, sources = sourcesOf(), git = true, platform = "darwin" } = {}) {
  return createDiagnoser({ registry: createPackRegistry({ packsDir }), sources, platform, gitAvailable: () => git });
}

function codesOf(problems) {
  return problems.map((p) => p.code);
}

test("能跑的 uses step 和 script step 都没有问题", () => {
  const d = diag();
  assert.deepEqual(d.diagnoseSteps([{ script: "true" }, { uses: "fake/ok", cwd: "/x" }]), []);
});

test("pack-missing：没装、来源已知、有 git → 提示点「安装」", () => {
  const d = diag({ sources: sourcesOf("osg") });
  const problems = d.diagnoseSteps([{ uses: "osg/revert-generated" }]);
  assert.deepEqual(codesOf(problems), ["pack-missing"]);
  assert.equal(problems[0].level, "error");
  assert.equal(problems[0].step, 1);
  assert.match(problems[0].action, /点「安装」/);
});

test("git-missing：没装、来源已知、本机没有 git", () => {
  const problems = diag({ sources: sourcesOf("osg"), git: false }).diagnoseSteps([{ uses: "osg/revert-generated" }]);
  assert.deepEqual(codesOf(problems), ["git-missing"]);
  assert.match(problems[0].action, /安装 git/);
});

test("source-unknown：没装、Hub 也没登记来源（不探测 git）", () => {
  let probed = false;
  const d = createDiagnoser({ registry: createPackRegistry({ packsDir: FIXTURES }), sources: sourcesOf(), gitAvailable: () => { probed = true; return false; } });
  const problems = d.diagnoseSteps([{ uses: "osg/revert-generated" }]);
  assert.deepEqual(codesOf(problems), ["source-unknown"]);
  assert.match(problems[0].action, /能力包来源/);
  assert.equal(probed, false);
});

test("deps-not-ready：python 包没有 .venv / .deps-ok", () => {
  const packsDir = tmp();
  mkdirSync(join(packsDir, "py"));
  writeFileSync(join(packsDir, "py", "toolset.json"), JSON.stringify({ id: "py", schemaVersion: 1, runtime: "python", entry: "toolset.py", tools: [{ id: "a" }] }));
  writeFileSync(join(packsDir, "py", "toolset.py"), "print('x')\n");
  const problems = diag({ packsDir }).diagnoseSteps([{ uses: "py/a" }]);
  assert.deepEqual(codesOf(problems), ["deps-not-ready"]);
  assert.match(problems[0].message, /缺少 \.venv/);
  assert.match(problems[0].action, /更新/);
});

test("tool-missing：包里没有该工具；schemaVersion 高于本机也算", () => {
  assert.deepEqual(codesOf(diag().diagnoseSteps([{ uses: "fake/nope" }])), ["tool-missing"]);
  const packsDir = tmp();
  mkdirSync(join(packsDir, "future"));
  writeFileSync(join(packsDir, "future", "toolset.json"), JSON.stringify({ id: "future", schemaVersion: 99, runtime: "node", entry: "x.mjs", tools: [{ id: "a" }] }));
  const problems = diag({ packsDir }).diagnoseSteps([{ uses: "future/a" }]);
  assert.deepEqual(codesOf(problems), ["tool-missing"]);
  assert.match(problems[0].action, /升级 novoard-agent/);
});

test("platform-unsupported：工具只支持 win32，本机是 darwin", () => {
  const problems = diag({ platform: "darwin" }).diagnoseSteps([{ uses: "fake/winonly" }]);
  assert.deepEqual(codesOf(problems), ["platform-unsupported"]);
  assert.match(problems[0].message, /win32/);
  assert.deepEqual(diag({ platform: "win32" }).diagnoseSteps([{ uses: "fake/winonly" }]), []);
});

test("六种 code 都覆盖到了", () => {
  assert.deepEqual([...DIAG_CODES].sort(), ["deps-not-ready", "git-missing", "pack-missing", "platform-unsupported", "source-unknown", "tool-missing"]);
});

test("formatProblems 与预检文案格式一致；step 编号从 1 开始", () => {
  const problems = diag({ sources: sourcesOf("osg") }).diagnoseSteps([{ script: "true" }, { uses: "osg/revert-generated" }]);
  assert.equal(formatProblems(problems), "第 2 步 osg/revert-generated：本机未安装能力包 osg。\n到本机控制台点「安装」即可。");
});

test("diagnoseAll / unavailable 只收有问题的 target；deriveCard 排除它们", () => {
  const d = diag();
  const targets = {
    good: { title: "好", expose: "a2a", expanded: [{ uses: "fake/ok" }] },
    bad: { title: "坏", expose: "a2a", expanded: [{ uses: "nopack/x" }] },
  };
  assert.deepEqual(Object.keys(d.diagnoseAll(targets)), ["bad"]);
  assert.deepEqual(d.unavailable(targets), ["bad"]);
  const card = deriveCard({ agentId: "a1", targets, profile: { role: "", introduction: "x" }, unavailable: d.unavailable(targets) });
  assert.deepEqual(card.skills.map((s) => s.id), ["converse", "good"]);
});

test("保存时返回 warnings，Card 不含有问题的 target", () => {
  const agentDir = tmp();
  writeFileSync(join(agentDir, "targets.yaml"), "targets: {}\n");
  const store = createTargetsStore({ agentDir, agentId: "a1", log: quiet, packs: createPackRegistry({ packsDir: FIXTURES }), diagnoser: diag() });
  const saved = store.save({
    targets: {
      good: { title: "好", expose: "a2a", audit: "summary", requiresApproval: false, notify: "never", steps: [{ uses: "fake/ok", cwd: "/tmp" }] },
      bad: { title: "坏", expose: "a2a", audit: "summary", requiresApproval: false, notify: "never", steps: [{ uses: "fake/winonly", cwd: "/tmp" }] },
    },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.errors));
  assert.deepEqual(saved.warnings.map((w) => [w.target, w.code]), [["bad", "platform-unsupported"]]);
  assert.deepEqual(saved.card.skills.map((s) => s.id).sort(), ["converse", "good"]);
});

test("运行时：诊断有问题就直接失败，诊断文字作为失败原因，不起进程", async () => {
  const d = diag({ sources: sourcesOf("osg") });
  const steps = [{ uses: "osg/revert-generated", cwd: "/tmp" }];
  const runtime = createAgentRuntime({ targets: { t: { title: "t", expanded: steps } }, log: quiet, diagnose: (s) => d.diagnoseSteps(s) });
  const terminal = await new Promise((resolve) => {
    const r = runtime.launch({ taskId: "task-1", skillId: "t", steps, trigger: "schedule", onTerminal: (state, detail) => resolve({ state, detail }) });
    assert.equal(r.ok, true);
  });
  assert.equal(terminal.state, "failed");
  assert.equal(terminal.detail, "第 1 步 osg/revert-generated：本机未安装能力包 osg。\n到本机控制台点「安装」即可。");
  await runtime.shutdown();
});

test("预检：下次触发前 60 分钟内回调一次；窗口外、同一时刻再次 tick 都不回调；定时关闭不预检", () => {
  const dir = tmp("novoard-precheck-");
  const clock = { t: Date.parse("2026-11-09T01:00:00+08:00") };
  const state = createScheduleState({ file: join(dir, "s.json"), now: () => clock.t });
  state.setEnabled(true);
  const checks = [];
  const scheduler = createScheduler({
    getTargets: () => ({ nightly: { title: "夜间", schedule: "10 2 * * *", expanded: [{ script: "true" }] } }),
    state,
    timezone: "Asia/Shanghai",
    now: () => clock.t,
    log: quiet,
    launch: () => ({ ok: true }),
    onPrecheck: (info) => checks.push(info),
  });
  scheduler.tick();
  assert.equal(checks.length, 0, "70 分钟前不预检");
  clock.t = Date.parse("2026-11-09T01:15:00+08:00");
  scheduler.tick();
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, "nightly");
  assert.equal(checks[0].label, "02:10");
  clock.t = Date.parse("2026-11-09T01:30:00+08:00");
  scheduler.tick();
  assert.equal(checks.length, 1, "同一时刻只预检一次");
  scheduler.setEnabled(false);
  clock.t = Date.parse("2026-11-10T01:30:00+08:00");
  scheduler.tick();
  assert.equal(checks.length, 1, "定时关闭不预检");
});
