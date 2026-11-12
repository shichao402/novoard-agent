/**
 * PRD-7 A9 Target 表单：cron 往返、草稿 ⇄ 定义不丢字段、表单校验、/api/packs/tools。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createLocalA2A } from "../src/local-a2a.mjs";
import { buildCron, describeCron, isValidCron, nextRuns, parseSchedule } from "../desktop/src/lib/cron.mjs";
import { cleanWith, indexTools, newDraft, newStep, toDef, toDraft, validateDraft, validateDrafts } from "../desktop/src/lib/target-draft.mjs";

test("A9 cron：表单能表示的表达式解析后再生成保持不变", () => {
  for (const cron of ["10 2 * * *", "30 9 * * 1,3,5", "15 * * * *", "*/10 9-18 * * *"]) {
    const parsed = parseSchedule(cron);
    assert.ok(parsed, `${cron} 应能被表单表示`);
    assert.equal(buildCron(parsed), cron);
  }
  assert.equal(parseSchedule("0 0 1 * *"), null, "按月这类留给自定义模式");
  assert.equal(describeCron("10 2 * * *").includes("02:10"), true);
});

test("A9 cron：有效性与时区内的下次运行", () => {
  assert.equal(isValidCron("10 2 * * *", "Asia/Shanghai"), true);
  assert.equal(isValidCron("10 2 * *", "Asia/Shanghai"), false, "必须 5 段");
  assert.equal(isValidCron("61 2 * * *", "Asia/Shanghai"), false);
  const runs = nextRuns("0 9 * * *", "Asia/Shanghai", 2, new Date("2026-11-12T00:00:00Z"));
  assert.deepEqual(runs, ["2026-11-12T01:00:00.000Z", "2026-11-13T01:00:00.000Z"]);
});

const full = {
  title: "每日更新",
  expose: "a2a",
  audit: "summary",
  requiresApproval: true,
  approvalTtl: "20m",
  notify: "on-failure",
  offline: "reject",
  concurrency: 1,
  timeout: "1h",
  lostTtl: "10m",
  schedule: "10 2 * * *",
  oncePerDay: false,
  deadline: "08:00",
  vars: { project: "osg" },
  steps: [
    { uses: "versionControl/svn-update", with: { paths: ["client", "server"], depth: "infinity" }, cwd: "D:/osg", retry: 2, retryInterval: "30s" },
    { script: "echo done", cwd: "D:/osg", env: { FOO: "1" } },
    { openApp: "Unity Hub" },
    { openPath: "D:/osg/logs" },
    { template: "warmup" },
  ],
};

test("A9 toDef：表单往返不丢 schedule/oncePerDay/deadline/uses/多步/env/vars", () => {
  const def = toDef(toDraft("daily", full), full);
  assert.deepEqual(def, full);
});

test("A9 toDef：没表单控件的字段沿用上次定义，关掉定时后定时字段一并去掉", () => {
  const previous = { ...full, futureField: "keep" };
  const draft = { ...toDraft("daily", previous), schedule: "" };
  const def = toDef(draft, previous);
  assert.equal(def.futureField, "keep");
  assert.equal("schedule" in def, false);
  assert.equal("oncePerDay" in def, false);
  assert.equal("deadline" in def, false);
});

test("A9 toDef：整 target 引用模板时保持 template；新建草稿补 vars", () => {
  const tpl = { title: "模板", expose: "local", audit: "none", requiresApproval: false, notify: "never", template: "warmup", vars: {} };
  const def = toDef(toDraft("tpl", tpl), tpl);
  assert.equal(def.template, "warmup");
  assert.equal("steps" in def, false);
  const fresh = toDef(newDraft([]));
  assert.deepEqual(fresh.vars, {});
  assert.deepEqual(fresh.steps, [{ uses: "" }]);
});

test("A9 cleanWith：去掉空串、空数组和数组里的空项", () => {
  assert.deepEqual(cleanWith({ a: "", b: "  ", c: [], d: ["x", "", " "], e: false, f: 0, g: Number.NaN, h: undefined, i: "v" }), {
    d: ["x"],
    e: false,
    f: 0,
    i: "v",
  });
});

const packs = [
  {
    id: "versionControl",
    displayName: "版本控制",
    tools: [
      {
        id: "svn-commit",
        displayName: "SVN 提交",
        remoteWrite: true,
        params: [
          { name: "message", type: "string", required: true, label: "提交说明" },
          { name: "timeout", type: "string", format: "duration", default: "10m" },
          { name: "count", type: "number" },
          { name: "until", type: "string", format: "time" },
        ],
      },
    ],
  },
];

function usesDraft(withValues, requiresApproval = false) {
  const draft = newDraft([]);
  const step = { ...newStep("uses"), uses: "versionControl/svn-commit", with: withValues };
  return { ...draft, requiresApproval, steps: [step] };
}

test("A9 校验：必填参数、远端写要求确认、时长与时间格式", () => {
  const tools = indexTools(packs);
  const errors = validateDraft(usesDraft({ timeout: "ten", count: Number.NaN, until: "25:00" }), { tools, timezone: "Asia/Shanghai" });
  assert.ok(errors.some((e) => e.includes("「提交说明」必填")));
  assert.ok(errors.some((e) => e.includes("执行前需要在 Hub 上确认")));
  assert.ok(errors.some((e) => e.includes("timeout") && e.includes("30s")));
  assert.ok(errors.some((e) => e.includes("HH:mm")));
  assert.deepEqual(validateDraft(usesDraft({ message: "ok", until: "07:30" }, true), { tools, timezone: "Asia/Shanghai" }), []);
});

test("A9 校验：未装的包不阻止保存；步骤、定时、重试和 ID 重复", () => {
  const missing = { ...newDraft([]), steps: [{ ...newStep("uses"), uses: "other/tool", with: { x: 1 } }] };
  assert.deepEqual(validateDraft(missing, { tools: new Map() }), []);

  const bad = { ...newDraft([]), schedule: "nope", deadline: "8点", timeout: "ten", steps: [{ ...newStep("uses"), uses: "a/b", retry: "11", retryInterval: "soon" }, newStep("script")] };
  const errors = validateDraft(bad, { timezone: "Asia/Shanghai" });
  for (const text of ["重试次数", "重试间隔", "命令为空", "运行超时", "定时表达式无效", "硬截止"]) {
    assert.ok(errors.some((e) => e.includes(text)), `应提示${text}`);
  }

  const a = { ...toDraft("same", full) };
  const found = validateDrafts([a, { ...a }], { tools: new Map(), timezone: "Asia/Shanghai" });
  assert.equal(found.length, 1);
  assert.equal(found[0].index, 1);
  assert.match(found[0].errors[0], /ID 重复/);
});

test("A9 /api/packs/tools：列出已装包的工具清单、平台、时区和定时开关", async () => {
  const manifests = {
    versionControl: { displayName: "版本控制", tools: [{ id: "svn-update", displayName: "SVN 更新", remoteWrite: false, params: [{ name: "paths", type: "string[]", format: "path" }] }] },
    general: { tools: [{ id: "quit-idle", platforms: ["win32"], description: "退出空闲进程" }] },
  };
  const packRegistry = {
    list: () => ["versionControl", "general", "broken"],
    get: (id) => (manifests[id] ? { ok: true, manifest: manifests[id] } : { ok: false, code: "manifest-invalid" }),
  };
  const schedule = { status: () => ({ enabled: true, timezone: "Asia/Shanghai", targets: [] }) };
  const local = createLocalA2A({ targets: {}, runtime: { launch: () => ({ ok: true }) }, audit() {}, log: { info() {} }, packRegistry, schedule });
  await local.start();
  try {
    const body = await (await fetch(`http://127.0.0.1:${local.server.address().port}/api/packs/tools`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.platform, process.platform);
    assert.equal(body.timezone, "Asia/Shanghai");
    assert.equal(body.scheduleEnabled, true);
    assert.deepEqual(body.packs.map((p) => p.id), ["general", "versionControl"], "按名排序，坏包不列");
    assert.deepEqual(body.packs[0].tools[0], { id: "quit-idle", displayName: "quit-idle", description: "退出空闲进程", remoteWrite: false, platforms: ["win32"], params: [] });
    assert.equal(body.packs[1].tools[0].params[0].format, "path");
  } finally {
    await local.close();
  }
});
