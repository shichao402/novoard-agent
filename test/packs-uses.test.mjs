// PRD-7 A3 / A4：uses step 调能力包、重试语义、取消回收进程树、路径锁排队、运行窗口硬截止。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentRuntime } from "../src/agent-runtime.mjs";
import { createPackRegistry } from "../src/packs/registry.mjs";
import { createPathLocks, normalizePathKey } from "../src/path-locks.mjs";
import { createRunner } from "../src/runner.mjs";

const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures-packs");
const packs = createPackRegistry({ packsDir: PACKS_DIR });
const tmp = (p = "novoard-uses-") => mkdtempSync(join(tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runSteps(steps, extra = {}) {
  const outputs = [];
  const details = [];
  const runner = createRunner({
    steps,
    packs,
    onOutput: (stream, text) => outputs.push(`${stream}:${text}`),
    onDetail: (i, m) => details.push([i, m]),
    ...extra,
  });
  return { runner, outputs, details, done: runner.run() };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test("uses step 按协议拼 argv：tool、--project-root、kebab 参数、数组展开、布尔", async () => {
  const root = tmp();
  const { outputs, done } = runSteps([{
    uses: "fake/ok",
    cwd: root,
    with: { name: "{{who}}", count: 3, dryFlag: true, tags: ["x", "y"], mode: "b" },
  }], { vars: { who: "alice" } });
  const r = await done;
  assert.equal(r.ok, true, r.stderr);
  const line = outputs.find((o) => o.includes("argv="));
  const argv = JSON.parse(line.slice(line.indexOf("argv=") + 5));
  assert.deepEqual(argv, ["--project-root", root, "--name", "alice", "--count", "3", "--dry-flag", "--tags", "x", "--tags", "y", "--mode", "b"]);
});

test("工具退出非 0 时 step 失败，原因取结果描述", async () => {
  const r = await runSteps([{ uses: "fake/fail", cwd: tmp() }]).done;
  assert.equal(r.ok, false);
  assert.match(r.stderr, /故意失败/);
});

test("stdout 里的 progress 行经 onDetail 送出，不混进普通输出", async () => {
  const { outputs, details, done } = runSteps([{ uses: "fake/progress", cwd: tmp() }]);
  const r = await done;
  assert.equal(r.ok, true, r.stderr);
  assert.deepEqual(details, [[1, "更新文件 1/2 50%"], [1, "更新文件 2/2 100%"]]);
  const text = outputs.join("");
  assert.ok(text.includes("中间普通行"));
  assert.equal(text.includes("\"type\":\"progress\""), false);
});

test("取消 uses step 会回收整棵进程树", { skip: process.platform === "win32" && "Windows 验收按要求暂缓" }, async () => {
  const dir = tmp();
  const pidFile = join(dir, "pids.json");
  const { runner, done } = runSteps([{ uses: "fake/sleep", cwd: dir, with: { ms: 30000, pidFile } }]);
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await sleep(100);
  const { self, child } = JSON.parse(readFileSync(pidFile, "utf8"));
  assert.ok(alive(self) && alive(child));
  runner.cancel();
  const r = await done;
  assert.equal(r.state, "canceled");
  for (let i = 0; i < 35 && (alive(self) || alive(child)); i++) await sleep(100);
  assert.equal(alive(self), false, "工具进程仍在");
  assert.equal(alive(child), false, "孙进程仍在");
});

test("幂等工具按 retry 重试；非幂等工具忽略 retry 只跑一次", async () => {
  const dir = tmp();
  const flaky = join(dir, "flaky");
  const r1 = await runSteps([{ uses: "fake/flaky", cwd: dir, retry: 1, retryInterval: "1s", with: { counter: flaky } }]).done;
  assert.equal(r1.ok, true, r1.stderr);
  assert.equal(readFileSync(flaky, "utf8"), "2");

  const once = join(dir, "once");
  const { outputs, done } = runSteps([{ uses: "fake/once", cwd: dir, retry: 3, retryInterval: "1s", with: { counter: once } }]);
  const r2 = await done;
  assert.equal(r2.ok, false);
  assert.equal(readFileSync(once, "utf8"), "1");
  assert.match(outputs.join(""), /非幂等，忽略 retry=3/);
});

test("包没装、平台不支持、参数不对都直接失败不重试", async () => {
  const dir = tmp();
  const missing = await runSteps([{ uses: "nope/x", cwd: dir, retry: 2 }]).done;
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /本机未安装能力包 nope/);

  if (process.platform !== "win32") {
    const plat = await runSteps([{ uses: "fake/winonly", cwd: dir }]).done;
    assert.equal(plat.ok, false);
    assert.match(plat.stderr, /不支持/);
  }

  const bad = await runSteps([{ uses: "fake/ok", cwd: dir, with: { mode: "c" } }]).done;
  assert.equal(bad.ok, false);
  assert.match(bad.stderr, /mode/);
});

test("路径锁：先来后到，排队不拒绝，排队中可撤销", async () => {
  const locks = createPathLocks();
  const a = locks.acquire(["/w/a"]);
  assert.equal(a.immediate, true);
  const b = locks.acquire(["/w/a", "/w/b"]);
  assert.equal(b.immediate, false);
  assert.deepEqual(b.blockedBy, ["/w/a"]);
  // c 只要 /w/b，但 b 排在前面想要 /w/b，c 不能插队
  const c = locks.acquire(["/w/b"]);
  assert.equal(c.immediate, false);
  const order = [];
  b.ready.then(() => order.push("b"));
  c.ready.then(() => order.push("c"));
  a.release();
  await sleep(10);
  assert.deepEqual(order, ["b"]);
  b.release();
  await sleep(10);
  assert.deepEqual(order, ["b", "c"]);
  c.release();
  c.release();

  const d = locks.acquire(["/w/a"]);
  const e = locks.acquire(["/w/a"]);
  e.release();
  d.release();
  assert.equal(locks.acquire(["/w/a"]).immediate, true);
  assert.equal(normalizePathKey("C:\\Work\\A", "win32"), normalizePathKey("c:/work/a", "win32"));
});

function holdTargets(cwdA, cwdB, mark) {
  const base = { title: "t", expose: "local", audit: "none", requiresApproval: false, notify: "never" };
  return {
    one: { ...base, steps: [{ uses: "fake/hold", cwd: cwdA, with: { ms: 400, mark } }] },
    two: { ...base, steps: [{ uses: "fake/hold", cwd: cwdB, with: { ms: 400, mark } }] },
  };
}

function launchAndWait(runtime, taskId, skillId, extra = {}) {
  let resolve;
  const terminal = new Promise((r) => { resolve = r; });
  const steps = runtime.targets?.()?.[skillId]?.steps;
  const res = runtime.launch({
    taskId,
    skillId,
    vars: {},
    steps: steps ?? extra.steps,
    onTerminal: (state, summary) => { if (state !== "input-required") resolve({ state, summary }); },
    ...extra,
  });
  return { res, terminal };
}

test("同一工作区的独占工具排队执行，不同工作区并行", async () => {
  const dir = tmp();
  const mark = join(dir, "mark");
  const same = join(dir, "ws");
  const targets = holdTargets(same, same, mark);
  const runtime = createAgentRuntime({ targets, packs, log: { info() {} } });
  const progress = [];
  const a = launchAndWait(runtime, "t1", "one", { steps: targets.one.steps });
  const b = launchAndWait(runtime, "t2", "two", { steps: targets.two.steps, onProgress: (i, n, m) => progress.push(m) });
  assert.equal(a.res.reason, "working");
  assert.equal(b.res.reason, "queued");
  assert.match(progress[0], /^排队中：等待 .*ws 释放$/);
  assert.equal((await a.terminal).state, "completed");
  assert.equal((await b.terminal).state, "completed");
  const lines = readFileSync(mark, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
  assert.deepEqual(lines, ["start", "end", "start", "end"]);

  const mark2 = join(dir, "mark2");
  const t2 = holdTargets(join(dir, "x"), join(dir, "y"), mark2);
  const rt2 = createAgentRuntime({ targets: t2, packs, log: { info() {} } });
  const c = launchAndWait(rt2, "t3", "one", { steps: t2.one.steps });
  const d = launchAndWait(rt2, "t4", "two", { steps: t2.two.steps });
  assert.equal(d.res.reason, "working");
  await Promise.all([c.terminal, d.terminal]);
  const kinds = readFileSync(mark2, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
  assert.deepEqual(kinds.slice(0, 2), ["start", "start"]);
});

test("排队中的任务可以取消，锁不受影响", async () => {
  const dir = tmp();
  const same = join(dir, "ws");
  const targets = holdTargets(same, same, join(dir, "mark"));
  const runtime = createAgentRuntime({ targets, packs, log: { info() {} } });
  const a = launchAndWait(runtime, "q1", "one", { steps: targets.one.steps });
  const b = launchAndWait(runtime, "q2", "two", { steps: targets.two.steps });
  assert.equal(b.res.reason, "queued");
  assert.equal(runtime.cancel("q2").ok, true);
  assert.equal((await b.terminal).state, "canceled");
  assert.equal((await a.terminal).state, "completed");
  const c = launchAndWait(runtime, "q3", "two", { steps: targets.two.steps });
  assert.equal(c.res.reason, "working");
  await c.terminal;
});

test("到运行窗口硬截止时停掉任务，终态 failed 并说明原因", async () => {
  const dir = tmp();
  const base = { title: "t", expose: "local", audit: "none", requiresApproval: false, notify: "never" };
  const targets = { slow: { ...base, steps: [{ uses: "fake/sleep", cwd: dir, with: { ms: 30000 } }] } };
  const runtime = createAgentRuntime({ targets, packs, log: { info() {} } });
  const t = launchAndWait(runtime, "d1", "slow", { steps: targets.slow.steps, deadlineAt: Date.now() + 500, deadlineLabel: "07:00", trigger: "schedule" });
  assert.equal(t.res.ok, true);
  const end = await t.terminal;
  assert.equal(end.state, "failed");
  assert.match(end.summary, /已到运行窗口硬截止 07:00/);
});
