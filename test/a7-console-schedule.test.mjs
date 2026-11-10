/**
 * PRD-7 A6/A7 控制台接口：
 * /api/tiles 带诊断问题（problems）与定时信息（schedule/nextRun/lastScheduled，顶层 schedule 开关）
 * /api/schedule GET/PUT 与 /api/schedule/catch-up POST（同源校验 + 审计）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createLocalA2A } from "../src/local-a2a.mjs";

const runtime = { launch() { return { ok: true }; }, cancel() { return { ok: true }; }, resume() { return { ok: true }; } };

const targets = {
  daily: { title: "每日", expose: "a2a", schedule: "0 9 * * *", steps: [{ uses: "versionControl/svn-update" }] },
  plain: { title: "普通", expose: "local", steps: [{ script: "echo ok" }] },
};

function makeSchedule() {
  const state = { enabled: true, setCalls: [], catchUps: 0 };
  return {
    state,
    api: {
      status: () => ({
        enabled: state.enabled,
        timezone: "Asia/Shanghai",
        targets: [{ id: "daily", nextRun: "2026-11-11T01:00:00.000Z", last: { status: "completed", trigger: "schedule", slot: "2026-11-10T01:00:00.000Z", at: 1, taskId: "t1" } }],
      }),
      setEnabled: (v) => { state.enabled = v; state.setCalls.push(v); return { ok: true, enabled: v }; },
      catchUp: () => { state.catchUps += 1; return { ok: true, fired: [{ id: "daily", trigger: "catch-up", slot: "2026-11-10T01:00:00.000Z" }] }; },
    },
  };
}

async function withLocal(opts, fn) {
  const audits = [];
  const local = createLocalA2A({ targets, runtime, audit: (e) => audits.push(e), log: { info() {} }, ...opts });
  await local.start();
  const base = `http://127.0.0.1:${local.server.address().port}`;
  try {
    await fn(base, audits);
  } finally {
    await local.close();
  }
}

test("A7 /api/tiles：带 problems、定时信息和顶层开关", async () => {
  const sched = makeSchedule();
  const problem = { step: 1, uses: "versionControl/svn-update", code: "pack-missing", level: "error", message: "能力包 versionControl 没装", action: "到本机控制台点「安装」即可。" };
  await withLocal({ schedule: sched.api, diagnoseTarget: (t) => (t.title === "每日" ? [problem] : []) }, async (base) => {
    const body = await (await fetch(`${base}/api/tiles`)).json();
    assert.deepEqual(body.schedule, { enabled: true, timezone: "Asia/Shanghai" });
    const daily = body.tiles.find((t) => t.id === "daily");
    const plain = body.tiles.find((t) => t.id === "plain");
    assert.deepEqual(daily.problems, [problem]);
    assert.equal(daily.schedule, "0 9 * * *");
    assert.equal(daily.nextRun, "2026-11-11T01:00:00.000Z");
    assert.equal(daily.lastScheduled.status, "completed");
    assert.deepEqual(plain.problems, []);
    assert.equal("schedule" in plain, false, "没配定时的 tile 不带 schedule 字段");
  });
});

test("A7 /api/tiles：未装配诊断和调度时字段降级", async () => {
  await withLocal({}, async (base) => {
    const body = await (await fetch(`${base}/api/tiles`)).json();
    assert.equal(body.schedule, null);
    const daily = body.tiles.find((t) => t.id === "daily");
    assert.deepEqual(daily.problems, []);
    assert.equal(daily.nextRun, null);
    assert.equal(daily.lastScheduled, null);
  });
});

test("A7 /api/schedule：读、开关、补跑，写操作记审计", async () => {
  const sched = makeSchedule();
  await withLocal({ schedule: sched.api }, async (base, audits) => {
    const got = await (await fetch(`${base}/api/schedule`)).json();
    assert.equal(got.ok, true);
    assert.equal(got.enabled, true);

    const off = await fetch(`${base}/api/schedule`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    assert.equal(off.status, 200);
    assert.deepEqual(sched.state.setCalls, [false]);

    const bad = await fetch(`${base}/api/schedule`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: "no" }) });
    assert.equal(bad.status, 400);
    await bad.body?.cancel();

    const cu = await (await fetch(`${base}/api/schedule/catch-up`, { method: "POST" })).json();
    assert.equal(cu.ok, true);
    assert.deepEqual(cu.fired.map((f) => f.id), ["daily"]);

    const actions = audits.filter((e) => e.target === "schedule").map((e) => e.detail.action);
    assert.deepEqual(actions, ["disable", "catch-up"]);
  });
});

test("A7 /api/schedule：跨源写拒绝；未装配 404；未就绪 503", async () => {
  const sched = makeSchedule();
  await withLocal({ schedule: sched.api }, async (base) => {
    const evil = await fetch(`${base}/api/schedule`, { method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify({ enabled: false }) });
    assert.equal(evil.status, 403);
    await evil.body?.cancel();
    assert.deepEqual(sched.state.setCalls, []);
  });
  await withLocal({}, async (base) => {
    const r = await fetch(`${base}/api/schedule/catch-up`, { method: "POST" });
    assert.equal(r.status, 404);
    await r.body?.cancel();
  });
  const notReady = { status: () => null, setEnabled: () => ({ ok: false, reason: "定时调度还没启动" }), catchUp: () => ({ ok: false, reason: "定时调度还没启动" }) };
  await withLocal({ schedule: notReady }, async (base) => {
    const g = await fetch(`${base}/api/schedule`);
    assert.equal(g.status, 503);
    await g.body?.cancel();
    const c = await fetch(`${base}/api/schedule/catch-up`, { method: "POST" });
    assert.equal(c.status, 503);
    await c.body?.cancel();
  });
});
