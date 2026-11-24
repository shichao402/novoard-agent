import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentRuntime, skipLine } from "../src/agent-runtime.mjs";
import { createRunner, isWhenTrue } from "../src/runner.mjs";

/** step 级 when（契约 v2.9，ADR-0024）。 */

test("when 假值：空串、false、0、no、off，不分大小写、忽略首尾空白", () => {
  for (const value of ["", " ", "false", "FALSE", " False ", "0", "no", "No", "off", "OFF", undefined, null]) {
    assert.equal(isWhenTrue(value), false, `应为假：${JSON.stringify(value)}`);
  }
  for (const value of ["true", "1", "yes", "on", "rider", "false-ish", "00"]) {
    assert.equal(isWhenTrue(value), true, `应为真：${JSON.stringify(value)}`);
  }
});

function collect(steps, vars) {
  const started = [];
  const skipped = [];
  const runner = createRunner({
    steps,
    timeoutMs: 15_000,
    onStepStart: (event) => started.push(event.index),
    onStepSkip: (event) => skipped.push(event),
  });
  return runner.run(vars).then((result) => ({ result, started, skipped }));
}

test("when 为假的步骤跳过：不起进程、不写 step/start，整次仍算完成", async () => {
  const { result, started, skipped } = await collect(
    [{ script: "echo one" }, { script: "echo two", when: "{{openRider}}" }, { script: "echo three", when: "{{openUnity}}" }],
    { openRider: "false", openUnity: "true" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.state, "completed");
  assert.deepEqual(started, [1, 3]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].index, 2);
  assert.equal(skipped[0].command, "echo two");
  assert.equal(skipped[0].value, "false");
});

test("when 插值无来源照常失败，不当作假", async () => {
  const { result, started } = await collect([{ script: "echo x", when: "{{nope}}" }], {});
  assert.equal(result.ok, false);
  assert.equal(result.step, 1);
  assert.match(result.stderr, /\{\{nope\}\} 无来源/);
  assert.deepEqual(started, []);
});

test("when 可以写字面值，也可以和文字拼接", async () => {
  const { started } = await collect(
    [{ script: "echo a", when: "off" }, { script: "echo b", when: "{{x}}-on" }],
    { x: "" },
  );
  assert.deepEqual(started, [2]);
});

test("跳过行格式稳定，桌面端靠它识别已跳过", () => {
  assert.equal(skipLine(3, "openApp rider", "false"), '[step 3] 已跳过 openApp rider（when 为 "false"）');
});

test("运行时：跳过的步骤写一行带 step 的日志，不进运行记录", async () => {
  const root = mkdtempSync(join(tmpdir(), "novoard-when-"));
  const traceRoot = mkdtempSync(join(tmpdir(), "novoard-when-trace-"));
  const steps = [{ script: "echo first" }, { openApp: "rider", when: "{{openRider}}" }];
  const runtime = createAgentRuntime({
    shortcutLogDir: root,
    runTraceDir: traceRoot,
    log: { info() {}, warn() {} },
    targets: {
      prep: { title: "prep", expose: "local", audit: "none", requiresApproval: false, notify: "never", steps },
    },
  });
  const launched = runtime.launch({ taskId: "task-when", skillId: "prep", vars: { openRider: "0" }, steps });
  assert.equal(launched.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const lines = readFileSync(join(root, "prep", "task-when.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const skip = lines.find((line) => String(line.msg).includes("已跳过"));
  assert.ok(skip, "应有跳过行");
  assert.equal(skip.step, 2);
  assert.equal(skip.msg, '[step 2] 已跳过 openApp rider（when 为 "0"）');
  const trace = readFileSync(join(traceRoot, "task-when.jsonl"), "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(trace.some((event) => event.index === 2), false);
  assert.equal(trace.at(-1).state, "completed");
});
