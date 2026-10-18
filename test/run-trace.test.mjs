import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentRuntime } from "../src/agent-runtime.mjs";
import { createRunner } from "../src/runner.mjs";
import { listOpenRuns, openRunTrace, reportAbandonedRuns } from "../src/run-trace.mjs";

test("step/start 在命令启动前落盘", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-trace-order-"));
  const marker = join(dir, "marker.txt").replaceAll("\\", "/");
  const runner = createRunner({
    steps: [{ script: `node -e "process.exit(require('fs').existsSync('${marker}')?0:3)"` }],
    onStepStart() {
      writeFileSync(marker, "1");
    },
  });
  const result = await runner.run();
  assert.equal(result.ok, true);
});

test("一次运行按顺序写下四类事件，并且会上行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-trace-run-"));
  const seen = [];
  const runtime = createAgentRuntime({
    targets: { echo: { timeout: "10s", concurrency: 1 } },
    runTraceDir: dir,
    bootId: "boot-1",
    log: { info() {}, warn() {} },
  });
  const state = await new Promise((resolve, reject) => {
    const launched = runtime.launch({
      taskId: "task-20261018-001",
      skillId: "echo",
      vars: {},
      steps: [{ script: "node -e \"process.exit(0)\"" }],
      onTrace: (event) => seen.push(event.type),
      onTerminal: (next) => resolve(next),
    });
    if (!launched.ok) reject(new Error(launched.reason));
  });
  assert.equal(state, "completed");
  assert.deepEqual(seen, ["run/start", "step/start", "step/end", "run/end"]);
  const lines = readFileSync(join(dir, "task-20261018-001.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.type), seen);
  assert.equal(lines[0].bootId, "boot-1");
  assert.equal(lines[1].index, 1);
});

test("没有 run/end 的记录只上报尾巴，不继续执行", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-trace-tail-"));
  const trace = openRunTrace({ root: dir, taskId: "task-20261018-004" });
  trace.append({ type: "run/start", target: "novoard-agent-dev", bootId: "boot-old" });
  trace.append({ type: "step/start", index: 1, command: "npm run desktop:dev-deploy", target: "novoard-agent-dev" });
  const open = listOpenRuns(dir);
  assert.equal(open.length, 1);
  assert.equal(open[0].last.type, "step/start");

  const reported = [];
  reportAbandonedRuns({
    root: dir,
    onTrace: (taskId, event) => reported.push({ taskId, event }),
  });
  assert.equal(reported.length, 1);
  assert.equal(reported[0].taskId, "task-20261018-004");
  assert.equal(reported[0].event.type, "run/truncated");
  assert.equal(reported[0].event.last.type, "step/start");
  assert.equal(reported[0].event.last.command, "npm run desktop:dev-deploy");

  reportAbandonedRuns({
    root: dir,
    runningTaskIds: ["task-20261018-004"],
    onTrace: () => {
      throw new Error("仍在跑的任务不应当成断尾");
    },
  });
  const again = [];
  reportAbandonedRuns({ root: dir, onTrace: (_taskId, event) => again.push(event.seq) });
  assert.deepEqual(again, [reported[0].event.seq]);
});
