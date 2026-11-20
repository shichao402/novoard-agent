/**
 * ADR-0021 / PRD-8：运行历史从运行记录派生，叠加 runtime 在途快照。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentRuntime } from "../src/agent-runtime.mjs";
import { createLocalA2A } from "../src/local-a2a.mjs";
import { listRuns, openRunTrace, pruneRunTraces, readRun, summarizeRun } from "../src/run-trace.mjs";
import { createShortcutRun, readShortcutRunLines } from "../src/shortcut-log.mjs";

const quiet = { info() {}, warn() {}, error() {} };

function writeTrace(dir, taskId, events) {
  const trace = openRunTrace({ root: dir, taskId });
  for (const event of events) trace.append(event);
}

test("摘要：步骤耗时、失败步与终态", () => {
  const summary = summarizeRun([
    { seq: 1, ts: "2026-11-20T02:00:00.000Z", type: "run/start", target: "svn", trigger: "schedule", timeout: "3h" },
    { seq: 2, ts: "2026-11-20T02:00:01.000Z", type: "step/start", index: 1, command: "uses vc/cleanup" },
    { seq: 3, ts: "2026-11-20T02:00:04.000Z", type: "step/end", index: 1, exit: 0 },
    { seq: 4, ts: "2026-11-20T02:00:04.100Z", type: "step/start", index: 2, command: "uses vc/update" },
    { seq: 5, ts: "2026-11-20T02:00:09.000Z", type: "step/end", index: 2, exit: 2 },
    { seq: 6, ts: "2026-11-20T02:00:09.100Z", type: "run/end", state: "failed" },
  ], "task-1");
  assert.equal(summary.state, "failed");
  assert.equal(summary.trigger, "schedule");
  assert.equal(summary.steps.length, 2);
  assert.deepEqual(summary.failedStep, { index: 2, exit: 2 });
  assert.equal(summary.endedAt, "2026-11-20T02:00:09.100Z");
});

test("没有 run/start 的记录不算一次运行；没有 run/end 记为 open", () => {
  assert.equal(summarizeRun([{ seq: 1, type: "step/start", index: 1 }], "task-x"), null);
  const open = summarizeRun([{ seq: 1, ts: "t", type: "run/start", target: "a" }], "task-y");
  assert.equal(open.state, "open");
});

test("listRuns 按开始时间倒序、可按 target 过滤；pruneRunTraces 删过期记录", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-runs-"));
  writeTrace(dir, "task-a", [{ type: "run/start", target: "one", ts: "2026-11-20T01:00:00.000Z" }, { type: "run/end", state: "completed" }]);
  writeTrace(dir, "task-b", [{ type: "run/start", target: "two", ts: "2026-11-20T02:00:00.000Z" }]);
  const all = listRuns(dir);
  assert.equal(all.length, 2);
  assert.equal(all[0].taskId, "task-b");
  assert.deepEqual(listRuns(dir, { target: "one" }).map((r) => r.taskId), ["task-a"]);

  const old = (Date.now() - 31 * 24 * 3600 * 1000) / 1000;
  utimesSync(join(dir, "task-a.jsonl"), old, old);
  assert.equal(pruneRunTraces(dir), 1);
  assert.equal(readRun(dir, "task-a"), null);
  assert.equal(listRuns(dir).length, 1);
});

test("输出日志按步归属：setStep 之后的行带 step 字段", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-steplog-"));
  const run = createShortcutRun({ root: dir, targetId: "demo", taskId: "task-s1" });
  run.info("开始");
  run.setStep(1);
  run.output("stdout", "a\nb");
  run.setStep(0);
  run.info("结束");
  const { lines } = readShortcutRunLines(run.file);
  assert.deepEqual(lines.map((l) => [l.msg, l.step ?? 0]), [["开始", 0], ["a", 1], ["b", 1], ["结束", 0]]);
});

test("runtime.snapshot 给出在途运行的触发来源与当前步", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-snap-"));
  const logs = mkdtempSync(join(tmpdir(), "novoard-snap-log-"));
  const runtime = createAgentRuntime({ targets: { slow: { timeout: "10s" } }, runTraceDir: dir, shortcutLogDir: logs, log: quiet });
  let resolveEnd;
  const ended = new Promise((resolve) => { resolveEnd = resolve; });
  runtime.launch({
    taskId: "task-snap-1",
    skillId: "slow",
    trigger: "hub",
    steps: [{ script: "node -e \"setTimeout(()=>{},800)\"" }],
    onTerminal: (state) => resolveEnd(state),
  });
  await new Promise((r) => setTimeout(r, 200));
  const [item] = runtime.snapshot();
  assert.equal(item.taskId, "task-snap-1");
  assert.equal(item.target, "slow");
  assert.equal(item.trigger, "hub");
  assert.equal(item.state, "working");
  assert.equal(item.step, 1);
  assert.equal(item.total, 1);
  assert.equal(await ended, "completed");
  assert.deepEqual(runtime.snapshot(), []);
  const { lines } = readShortcutRunLines(join(logs, "slow", "task-snap-1.jsonl"));
  assert.ok(lines.every((line) => line.step === undefined || line.step === 1));
});

test("/api/runs：历史 + 在途；中断识别；详情带按步日志；取消写审计", async () => {
  const traces = mkdtempSync(join(tmpdir(), "novoard-api-runs-"));
  const logs = mkdtempSync(join(tmpdir(), "novoard-api-logs-"));
  writeTrace(traces, "task-done", [
    { type: "run/start", target: "svn", trigger: "schedule" },
    { type: "step/start", index: 1, command: "uses vc/update" },
    { type: "step/end", index: 1, exit: 0 },
    { type: "run/end", state: "completed" },
  ]);
  writeTrace(traces, "task-lost", [{ type: "run/start", target: "svn", trigger: "hub" }]);
  writeTrace(traces, "task-live", [{ type: "run/start", target: "svn", trigger: "manual" }]);
  const log = createShortcutRun({ root: logs, targetId: "svn", taskId: "task-done" });
  log.info("开始");
  log.setStep(1);
  log.info("At revision 1");

  const canceled = [];
  const runtime = {
    launch() { return { ok: true }; },
    resume() { return { ok: true }; },
    cancel(id) { canceled.push(id); return { ok: true, reason: "cancel-signal-sent" }; },
    snapshot() { return [{ taskId: "task-live", target: "svn", state: "working", trigger: "manual", startedAt: new Date().toISOString(), step: 1, total: 2, message: "", blockedBy: [] }]; },
  };
  const audits = [];
  const local = createLocalA2A({
    targets: { svn: { title: "SVN 更新", expose: "a2a", steps: [{ script: "echo" }] } },
    runtime,
    audit: (e) => audits.push(e),
    log: quiet,
    shortcutLogDir: logs,
    runTraceDir: traces,
  });
  await local.start();
  const base = `http://127.0.0.1:${local.server.address().port}`;
  try {
    const list = await (await fetch(`${base}/api/runs?target=svn`)).json();
    const states = Object.fromEntries(list.runs.map((r) => [r.taskId, r.state]));
    assert.deepEqual(states, { "task-done": "completed", "task-lost": "interrupted", "task-live": "working" });
    assert.equal(list.live.length, 1);
    assert.equal(list.runs.find((r) => r.taskId === "task-done").title, "SVN 更新");

    const detail = await (await fetch(`${base}/api/runs/task-done`)).json();
    assert.equal(detail.run.steps.length, 1);
    assert.deepEqual(detail.lines.map((l) => l.step ?? 0), [0, 1]);
    assert.equal(detail.run.log, "shortcuts/svn/task-done.jsonl");

    assert.equal((await fetch(`${base}/api/runs/task-nope`)).status, 404);

    const tiles = await (await fetch(`${base}/api/tiles`)).json();
    assert.equal(tiles.tiles[0].live.length, 1);
    assert.ok(tiles.tiles[0].last, "重启后磁贴仍有上次结果");

    const done = await fetch(`${base}/api/runs/task-done/cancel`, { method: "POST" });
    assert.equal(done.status, 409);
    const cancel = await fetch(`${base}/api/runs/task-live/cancel`, { method: "POST" });
    assert.equal(cancel.status, 200);
    assert.deepEqual(canceled, ["task-live"]);
    assert.ok(audits.some((a) => a.taskId === "task-live" && a.detail?.action === "cancel"));
    const cross = await fetch(`${base}/api/runs/task-live/cancel`, { method: "POST", headers: { Origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
  } finally {
    await local.close();
  }
  assert.ok(existsSync(join(traces, "task-done.jsonl")));
  assert.ok(readFileSync(join(traces, "task-done.jsonl"), "utf8").includes("run/end"));
});
