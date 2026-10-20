/**
 * M5 桌面载体（PRD-1 + ADR-0008）测试：
 * F1/F2-入口：localhost A2A 端点——磁贴触发（message/send）、SSE 进度、tasks/get/cancel/approve
 * AC2：本地闭环——无 hub 连接（tunnel 未启动/断开）时触发照常工作
 * F5：open-instance 模板收编（health + openApp）
 * US5：磁贴状态（/api/tiles 数据源）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createLocalA2A } from "../src/local-a2a.mjs";
import { createAgentRuntime } from "../src/agent-runtime.mjs";
import { loadTargets, expandSteps, deriveCard } from "../src/card.mjs";

function tmpAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "novoard-m5-"));
  writeFileSync(join(dir, "targets.yaml"), `targets:
  smoke-test:
    title: 冒烟
    steps:
      - script: echo ok
    vars: {}
    expose: a2a
    audit: summary
    requiresApproval: false
    notify: on-failure
  slow-target:
    title: 慢任务
    steps:
      - script: sleep 0.4 && echo step1
      - script: sleep 0.4 && echo step2
    vars: {}
    expose: a2a
    audit: summary
    requiresApproval: false
    notify: on-failure
  approval-target:
    title: 需审批
    steps:
      - script: echo approved-run
    vars: {}
    expose: local
    audit: summary
    requiresApproval: true
    notify: on-failure
`);
  return dir;
}

function makeStack() {
  const agentDir = tmpAgentDir();
  const loaded = loadTargets({ agentDir });
  assert.ok(loaded.ok, loaded.reason);
  const expanded = expandSteps({ targets: loaded.targets, agentDir });
  assert.ok(expanded.ok, expanded.reason);
  const runtime = createAgentRuntime({ targets: expanded.targets, log: { info() {} } });
  const audits = [];
  const local = createLocalA2A({ targets: expanded.targets, runtime, audit: (e) => audits.push(e), log: { info() {} } });
  return { agentDir, runtime, local, audits, cleanup: () => rmSync(agentDir, { recursive: true, force: true }) };
}

async function rpc(local, method, params) {
  const port = local.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/a2a`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return res.json();
}

test("M5 磁贴触发：message/send → 执行 → completed；US5 状态可查", async () => {
  const { local, audits, cleanup } = makeStack();
  await local.start();
  try {
    const body = await rpc(local, "message/send", { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "smoke-test" }] } });
    assert.ok(body.result?.id, JSON.stringify(body));
    const id = body.result.id;
    assert.equal(body.result.status.state, "submitted");

    await new Promise((r) => setTimeout(r, 500));
    const got = await rpc(local, "tasks/get", { id });
    assert.equal(got.result.status.state, "completed");

    // US5：/api/tiles 有最近执行状态
    const port = local.server.address().port;
    const tilesRes = await fetch(`http://127.0.0.1:${port}/api/tiles`);
    const { tiles, tasks } = await tilesRes.json();
    const smoke = tiles.find((t) => t.id === "smoke-test");
    assert.equal(smoke.last.state, "completed");
    assert.ok(tasks.some((t) => t.id === id && t.state === "completed"));

    // 审计：submitted + completed（lane a2a，via localhost-a2a）
    assert.ok(audits.some((e) => e.outcome === "submitted" && e.detail?.via === "localhost-a2a"));
    assert.ok(audits.some((e) => e.outcome === "completed"));
  } finally {
    await local.close();
    cleanup();
  }
});

test("M5 AC2 本地闭环：unknown target 明确拒绝；触发不依赖 hub", async () => {
  const { local, cleanup } = makeStack();
  await local.start();
  try {
    const bad = await rpc(local, "message/send", { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "no-such-thing" }] } });
    assert.equal(bad.error.code, -32002);
    assert.match(bad.error.message, /unknown target/);

    // 慢任务触发后立刻 SSE 订阅：无 hub 参与也能收步骤进度（AC2 + M4 SSE 语义本地版）
    const trigger = await rpc(local, "message/send", { message: { messageId: "m2", role: "user", parts: [{ kind: "text", text: "slow-target" }] } });
    const port = local.server.address().port;
    const es = await fetch(`http://127.0.0.1:${port}/api/stream/${trigger.result.id}`);
    assert.match(es.headers.get("content-type"), /text\/event-stream/);
    const reader = es.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const states = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { done, value } = await Promise.race([reader.read(), new Promise((_, rj) => setTimeout(() => rj(new Error("t")), 5000))]);
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (line) {
          const f = JSON.parse(line.slice(6));
          states.push(f.status.state);
          if (f.final) { reader.cancel().catch(() => {}); }
        }
      }
      if (states.some((s) => s === "completed")) break;
    }
    assert.ok(states.includes("working"), `SSE 应含 working 进度帧：${states.join(",")}`);
    assert.ok(states.includes("completed"), `SSE 应含 completed 终态：${states.join(",")}`);
  } finally {
    await local.close();
    cleanup();
  }
});

test("M5 审批门本地版：requiresApproval 挂起 → tasks/approve → completed", async () => {
  const { local, cleanup } = makeStack();
  await local.start();
  try {
    const trigger = await rpc(local, "message/send", { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "approval-target" }] } });
    const id = trigger.result.id;
    await new Promise((r) => setTimeout(r, 200));
    const got = await rpc(local, "tasks/get", { id });
    assert.equal(got.result.status.state, "input-required");

    const approve = await rpc(local, "tasks/approve", { id, decision: "approve" });
    assert.equal(approve.result.status.state, "working");
    await new Promise((r) => setTimeout(r, 400));
    const done = await rpc(local, "tasks/get", { id });
    assert.equal(done.result.status.state, "completed");
  } finally {
    await local.close();
    cleanup();
  }
});

test("M5 cancel：运行中任务取消 → canceled", async () => {
  const { local, cleanup } = makeStack();
  await local.start();
  try {
    const trigger = await rpc(local, "message/send", { message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "slow-target" }] } });
    const id = trigger.result.id;
    await new Promise((r) => setTimeout(r, 150));
    const cancel = await rpc(local, "tasks/cancel", { id });
    assert.equal(cancel.result.status.state, "canceled");
    await new Promise((r) => setTimeout(r, 600));
    const got = await rpc(local, "tasks/get", { id });
    assert.equal(got.result.status.state, "canceled");
  } finally {
    await local.close();
    cleanup();
  }
});

test("M5 F5 open-instance 模板：装载/展开通过，模板引用合法（fixture）", async () => {
  // fixture 化：模板结构性验证用自带样例（舰队真实定义已迁入本仓 test/fixtures/mac-*）
  const agentDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tpl-agent");
  const loaded = loadTargets({ agentDir });
  assert.ok(loaded.ok, loaded.reason);
  const expanded = expandSteps({ targets: loaded.targets, agentDir });
  assert.ok(expanded.ok, expanded.reason);
  assert.ok(expanded.targets["open-demo"], "open-demo 应存在");
  assert.equal(expanded.targets["open-demo"].expanded.length, 2, "open-instance 模板两步：health + openApp");
  assert.match(expanded.targets["open-demo"].expanded[0].script, /curl/);
  assert.match(expanded.targets["open-demo"].expanded[0].script, /\{\{url\}\}/, "health 步骤保留 url 占位（运行期插值）");
  assert.equal(expanded.targets["open-demo"].expanded[1].openApp, "{{url}}");
  // 运行期插值：vars（target 层 url=http://localhost:5173）传入后 resolved
  const resolved = expanded.targets["open-demo"].expanded[1].openApp.replace(/\{\{(\w+)\}\}/g, (_, k) => expanded.targets["open-demo"].vars[k]);
  assert.equal(resolved, "http://localhost:5173");
  // card 派生：open-demo 进 skills（expose: a2a）
  const card = deriveCard({ agentId: "tpl-agent", targets: loaded.targets });
  assert.ok(card.skills.some((s) => s.id === "open-demo"));
});

test("M5 控制台静态资源由本机服务提供", async () => {
  const { local, cleanup } = makeStack();
  await local.start();
  const uiDir = mkdtempSync(join(tmpdir(), "novoard-ui-"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>Novoard Agent</title><div id=\"root\"></div>");
  writeFileSync(join(uiDir, "app.js"), "export default 1;\n");
  const withUi = createLocalA2A({
    targets: {},
    runtime: { launch() { return { ok: true }; }, cancel() { return { ok: true }; }, resume() { return { ok: true }; } },
    audit() {},
    log: { info() {} },
    uiRoot: uiDir,
  });
  await withUi.start();
  try {
    const bare = local.server.address().port;
    const missing = await fetch(`http://127.0.0.1:${bare}/`);
    assert.equal(missing.status, 404);
    await missing.body?.cancel();

    const port = withUi.server.address().port;
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /id="root"/);
    const asset = await fetch(`http://127.0.0.1:${port}/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), /javascript/);
    const escaped = await fetch(`http://127.0.0.1:${port}/%2e%2e/%2e%2e/package.json`);
    assert.equal(escaped.status, 404);
  } finally {
    await local.close();
    await withUi.close();
    cleanup();
    rmSync(uiDir, { recursive: true, force: true });
  }
});
