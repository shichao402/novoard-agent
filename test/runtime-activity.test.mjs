import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRuntime } from "../src/agent-runtime.mjs";

/** ADR-0018：桌面壳靠 activity 判断能否重启安装更新，执行中与审批挂起都要算进去。 */
const PAUSE = process.platform === "win32" ? "ping -n 2 127.0.0.1 >nul" : "sleep 1";

function target(extra = {}) {
  return { title: "t", expose: "local", audit: "none", notify: "never", steps: [{ script: PAUSE }], ...extra };
}

test("activity 随执行、审批挂起、恢复、结束变化，计数不变时不重复上报", async () => {
  const events = [];
  const runtime = createAgentRuntime({
    log: { info() {} },
    onActivity: (activity) => events.push(activity),
    targets: {
      run: target({ concurrency: 2, requiresApproval: false }),
      gate: target({ requiresApproval: true }),
    },
  });
  const steps = [{ script: PAUSE }];

  assert.deepEqual(runtime.activity(), { running: 0, pendingApproval: 0 });

  runtime.launch({ taskId: "t-run", skillId: "run", vars: {}, steps });
  runtime.launch({ taskId: "t-gate", skillId: "gate", vars: {}, steps });
  assert.deepEqual(runtime.activity(), { running: 1, pendingApproval: 1 });

  // 重复 taskId 不改变计数，不应再上报
  runtime.launch({ taskId: "t-run", skillId: "run", vars: {}, steps });
  assert.equal(events.length, 2);

  // 审批通过：挂起转执行
  assert.equal(runtime.resume("t-gate").ok, true);
  assert.deepEqual(runtime.activity(), { running: 2, pendingApproval: 0 });

  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.deepEqual(runtime.activity(), { running: 0, pendingApproval: 0 });
  assert.deepEqual(events, [
    { running: 1, pendingApproval: 0 },
    { running: 1, pendingApproval: 1 },
    { running: 2, pendingApproval: 0 },
    { running: 1, pendingApproval: 0 },
    { running: 0, pendingApproval: 0 },
  ]);
});

test("取消审批挂起的任务会立即把计数清零", () => {
  const events = [];
  const runtime = createAgentRuntime({
    log: { info() {} },
    onActivity: (activity) => events.push(activity),
    targets: { gate: target({ requiresApproval: true }) },
  });
  runtime.launch({ taskId: "t-gate", skillId: "gate", vars: {}, steps: [{ script: PAUSE }] });
  assert.equal(runtime.cancel("t-gate").ok, true);
  assert.deepEqual(events.at(-1), { running: 0, pendingApproval: 0 });
});

test("onActivity 抛错不影响任务执行", async () => {
  const runtime = createAgentRuntime({
    log: { info() {} },
    onActivity: () => { throw new Error("boom"); },
    targets: { run: target() },
  });
  const result = runtime.launch({ taskId: "t1", skillId: "run", vars: {}, steps: [{ script: PAUSE }] });
  assert.equal(result.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.deepEqual(runtime.activity(), { running: 0, pendingApproval: 0 });
});
