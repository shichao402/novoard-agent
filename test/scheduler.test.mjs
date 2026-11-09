// PRD-7 A2：调度器语义（准点窗口、去重、补跑、硬截止、可重试拒绝、总开关、启动补跑、残留记录）。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createScheduleState } from "../src/schedule-state.mjs";
import { createScheduler, deadlineAtFromCron, hhmm } from "../src/scheduler.mjs";

const TZ = "Asia/Shanghai";
/** 上海本地时间 → epoch（UTC+8，无夏令时）。 */
const sh = (date, time) => Date.parse(`${date}T${time}:00+08:00`);
const quiet = { info() {}, warn() {}, error() {} };

function setup({ targets, enabled = true, launchResult, ...opts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "novoard-sched-"));
  const clock = { t: sh("2026-11-09", "00:00") };
  const state = createScheduleState({ file: join(dir, "schedule-state.json"), now: () => clock.t });
  if (enabled) state.setEnabled(true);
  const calls = [];
  const scheduler = createScheduler({
    getTargets: () => targets,
    state,
    timezone: TZ,
    now: () => clock.t,
    log: quiet,
    launch: (input) => {
      calls.push(input);
      const r = typeof launchResult === "function" ? launchResult(input, calls.length) : launchResult;
      return r ?? { ok: true, taskId: `task-${calls.length}` };
    },
    ...opts,
  });
  return { dir, clock, state, scheduler, calls };
}

const T = (extra) => ({ title: "t", steps: [{ script: "true" }], ...extra });

test("准点触发一次，同一天不再重复", () => {
  const { clock, scheduler, calls } = setup({ targets: { nightly: T({ schedule: "10 2 * * *" }) } });
  clock.t = sh("2026-11-09", "02:09");
  assert.equal(scheduler.tick().length, 0);
  clock.t = sh("2026-11-09", "02:10") + 5_000;
  assert.equal(scheduler.tick().length, 1);
  assert.equal(calls[0].trigger, "schedule");
  clock.t = sh("2026-11-09", "02:11");
  assert.equal(scheduler.tick().length, 0);
  assert.equal(calls.length, 1);
});

test("停机错过准点窗口后，tick 不补，catchUp 补一次且 trigger=catch-up", () => {
  const { clock, scheduler, calls } = setup({ targets: { nightly: T({ schedule: "10 2 * * *" }) } });
  clock.t = sh("2026-11-09", "08:00");
  assert.equal(scheduler.tick().length, 0);
  const fired = scheduler.catchUp();
  assert.equal(fired.length, 1);
  assert.equal(calls[0].trigger, "catch-up");
  assert.equal(scheduler.catchUp().length, 0, "补过不再补");
});

test("oncePerDay:false 时每个触发时刻各跑一次", () => {
  const { clock, scheduler, calls } = setup({ targets: { poll: T({ schedule: "*/15 0-7 * * *", oncePerDay: false }) } });
  for (const time of ["00:00", "00:00", "00:15", "00:15", "00:30"]) {
    clock.t = sh("2026-11-09", time) + 1_000;
    scheduler.tick();
  }
  assert.equal(calls.length, 3);
});

test("deadline 换算：当天截止与跨午夜取次日", () => {
  const sameDay = deadlineAtFromCron("07:00", TZ, new Date(sh("2026-11-09", "02:10")));
  assert.equal(sameDay, sh("2026-11-09", "07:00"));
  const nextDay = deadlineAtFromCron("07:00", TZ, new Date(sh("2026-11-09", "23:30")));
  assert.equal(nextDay, sh("2026-11-10", "07:00"));
  assert.equal(hhmm(TZ, nextDay), "07:00");
  assert.equal(deadlineAtFromCron(undefined, TZ, new Date()), undefined);
});

test("触发时带上 deadlineAt：准点按当前时刻，补跑按原定时刻", () => {
  const { clock, scheduler, calls } = setup({ targets: { nightly: T({ schedule: "30 23 * * *", deadline: "07:00" }) } });
  clock.t = sh("2026-11-09", "23:30") + 1_000;
  scheduler.tick();
  assert.equal(calls[0].deadlineAt, sh("2026-11-10", "07:00"));
  assert.equal(calls[0].deadlineLabel, "07:00");
});

test("失败后是否在补跑时重来由 retryFailedOnCatchUp 决定", () => {
  for (const retry of [false, true]) {
    const { clock, scheduler, calls } = setup({
      targets: { nightly: T({ schedule: "10 2 * * *" }) },
      retryFailedOnCatchUp: retry,
    });
    clock.t = sh("2026-11-09", "02:10") + 1_000;
    scheduler.tick();
    calls[0].onState("failed");
    clock.t = sh("2026-11-09", "08:00");
    scheduler.catchUp();
    assert.equal(calls.length, retry ? 2 : 1, `retryFailedOnCatchUp=${retry}`);
  }
});

test("进行中或已完成的不会重触发", () => {
  const { clock, scheduler, calls } = setup({ targets: { nightly: T({ schedule: "10 2 * * *" }) }, retryFailedOnCatchUp: true });
  clock.t = sh("2026-11-09", "02:10") + 1_000;
  scheduler.tick();
  calls[0].onState("working");
  assert.equal(scheduler.catchUp().length, 0);
  calls[0].onState("completed");
  assert.equal(scheduler.catchUp().length, 0);
});

test("可重试的拒绝不留去重记录，下个 tick 重试", () => {
  const { clock, state, scheduler, calls } = setup({
    targets: { nightly: T({ schedule: "10 2 * * *" }) },
    launchResult: (_input, n) => (n === 1 ? { ok: false, retryable: true, reason: "并发已满（1/1）" } : { ok: true, taskId: "t2" }),
  });
  clock.t = sh("2026-11-09", "02:10") + 1_000;
  assert.equal(scheduler.tick().length, 0);
  assert.equal(state.getKey("nightly|2026-11-09"), null);
  clock.t += 20_000;
  assert.equal(scheduler.tick().length, 1);
  assert.equal(state.getKey("nightly|2026-11-09").taskId, "t2");

  const hard = setup({ targets: { nightly: T({ schedule: "10 2 * * *" }) }, launchResult: { ok: false, reason: "unknown target" } });
  hard.clock.t = sh("2026-11-09", "02:10") + 1_000;
  hard.scheduler.tick();
  assert.equal(hard.state.getKey("nightly|2026-11-09").status, "failed");
});

test("总开关关闭时 tick 不触发，手动补跑照样执行", () => {
  const { clock, scheduler, calls } = setup({ targets: { nightly: T({ schedule: "10 2 * * *" }) }, enabled: false });
  clock.t = sh("2026-11-09", "02:10") + 1_000;
  assert.equal(scheduler.tick().length, 0);
  assert.equal(scheduler.catchUp().length, 1);
  assert.equal(calls[0].trigger, "schedule", "仍在准点窗口内，来源记 schedule");
});

test("启动后定时补跑一次；总开关关闭时不补", () => {
  for (const enabled of [true, false]) {
    const pending = [];
    const timers = {
      setInterval: () => ({}),
      clearInterval() {},
      setTimeout: (fn, ms) => { pending.push({ fn, ms }); return {}; },
      clearTimeout() {},
    };
    const { clock, scheduler, calls } = setup({ targets: { nightly: T({ schedule: "10 2 * * *" }) }, enabled, timers });
    clock.t = sh("2026-11-09", "08:00");
    scheduler.start();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].ms, 60_000);
    pending[0].fn();
    assert.equal(calls.length, enabled ? 1 : 0);
    scheduler.stop();
  }
});

test("超过 catchUpPreviousDays 的错过项不补", () => {
  const { clock, scheduler, calls } = setup({ targets: { weekly: T({ schedule: "10 2 * * 1" }) }, catchUpPreviousDays: 1 });
  // 2026-11-09 是周一；到周四补跑时上次触发已是 3 天前
  clock.t = sh("2026-11-12", "08:00");
  assert.equal(scheduler.catchUp().length, 0);
  assert.equal(calls.length, 0);
});

test("status 给出下次运行和最近一次记录", () => {
  const { clock, scheduler } = setup({ targets: { nightly: T({ schedule: "10 2 * * *" }), manual: T() } });
  clock.t = sh("2026-11-09", "02:10") + 1_000;
  scheduler.tick();
  const s = scheduler.status();
  assert.equal(s.timezone, TZ);
  assert.equal(s.targets.length, 1);
  assert.equal(s.targets[0].nextRun, new Date(sh("2026-11-10", "02:10")).toISOString());
  assert.equal(s.targets[0].last.status, "queued");
});

test("重新装载时残留的 queued/running 记为 failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-sched-"));
  const file = join(dir, "schedule-state.json");
  const at = Date.now();
  writeFileSync(file, JSON.stringify({
    version: 1,
    enabled: true,
    keyed: { "a|2026-11-09": { status: "running", at }, "b|2026-11-09": { status: "completed", at } },
  }));
  const state = createScheduleState({ file });
  assert.equal(state.enabled, true);
  assert.equal(state.getKey("a|2026-11-09").status, "failed");
  assert.equal(state.getKey("a|2026-11-09").note, "进程异常退出");
  assert.equal(state.getKey("b|2026-11-09").status, "completed");
});
