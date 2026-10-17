import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../src/session-store.mjs";
import { explainAgentError, normalizeSdkMessage } from "../src/chat-events.mjs";
import { dispatchNovoardTool } from "../src/novoard-tools.mjs";
import { createChatBridge } from "../src/chat-bridge.mjs";
import { createLocalA2A } from "../src/local-a2a.mjs";

test("会话可以创建、追加、列出和删除", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-sessions-"));
  try {
    const store = createSessionStore(dir);
    store.upsert({ id: "s1", title: "新对话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", preview: "" });
    store.append("s1", { kind: "user", text: "列出 Target" });
    store.upsert({ id: "s1", title: "列出 Target", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:01:00.000Z", preview: "列出 Target" });
    assert.equal(store.list()[0].title, "列出 Target");
    assert.equal(store.messages("s1")[0].text, "列出 Target");
    store.remove("s1");
    assert.equal(store.list().length, 0);
    assert.equal(store.messages("s1").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SDK 消息收成界面事件", () => {
  const delta = normalizeSdkMessage({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好" } } });
  assert.deepEqual(delta, [{ kind: "delta", text: "你好" }]);
  const assistant = normalizeSdkMessage({
    type: "assistant",
    message: { content: [{ type: "text", text: "已执行" }, { type: "tool_use", name: "novoard_run_target", input: { id: "smoke" } }] },
  });
  assert.equal(assistant[0].kind, "assistant");
  assert.equal(assistant[1].name, "novoard_run_target");
  const done = normalizeSdkMessage({ type: "result", subtype: "error_during_execution", errors: ["未登录"] });
  assert.equal(done[0].ok, false);
  assert.match(explainAgentError(new Error("CodeBuddy CLI not found")), /没有找到 CodeBuddy/);
});

test("配置工具经本机接口执行，跑 Target 只走 A2A", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (String(url).endsWith("/a2a")) {
      return { ok: true, json: async () => ({ result: { id: "task-local-1", status: { state: "submitted" } } }) };
    }
    if (String(url).endsWith("/api/targets") && (!init || !init.method || init.method === "GET")) {
      return { ok: true, json: async () => ({ ok: true, targets: { smoke: { title: "冒烟" } } }) };
    }
    return { ok: true, json: async () => ({ ok: true, count: 1 }) };
  };
  const ran = JSON.parse(await dispatchNovoardTool("novoard_run_target", { id: "smoke" }, { origin: "http://127.0.0.1:9", fetchImpl }));
  assert.equal(ran.via, "a2a");
  assert.equal(ran.taskId, "task-local-1");
  assert.match(calls[0].body, /message\/send/);
  assert.match(calls[0].body, /"text":"smoke"/);
  await dispatchNovoardTool("novoard_upsert_target", { id: "smoke", target: { title: "冒烟" } }, { origin: "http://127.0.0.1:9", fetchImpl });
  assert.equal(calls.at(-1).method, "PUT");
});

test("会话桥可以创建、发送并删除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-bridge-"));
  const worker = join(dir, "fake-worker.mjs");
  writeFileSync(worker, `import { createInterface } from "node:readline";
const sessions = [];
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "list") return write({ id: request.id, result: { sessions } });
  if (request.op === "create") {
    const session = { id: "sess-1", title: "新对话", createdAt: "", updatedAt: "", preview: "" };
    sessions.push(session);
    return write({ id: request.id, result: { session } });
  }
  if (request.op === "send") {
    write({ id: request.id, event: { kind: "delta", text: "好" } });
    write({ id: request.id, event: { kind: "tool", name: "novoard_run_target" } });
    return write({ id: request.id, result: { ok: true, session: sessions[0] } });
  }
  if (request.op === "delete") {
    sessions.splice(0, sessions.length);
    return write({ id: request.id, result: { ok: true } });
  }
  write({ id: request.id, error: "unknown" });
});
function write(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
`);
  const bridge = createChatBridge({ dataDir: dir, workerPath: worker, nodePath: process.execPath, log: { info() {}, warn() {} } });
  bridge.setOrigin("http://127.0.0.1:9");
  try {
    const created = await bridge.create("新对话");
    assert.equal(created.session.id, "sess-1");
    const events = [];
    await bridge.send("sess-1", "跑冒烟", (event) => events.push(event));
    assert.deepEqual(events.map((event) => event.kind), ["delta", "tool"]);
    await bridge.remove("sess-1");
    const listed = await bridge.list();
    assert.equal(listed.sessions.length, 0);
  } finally {
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("执行记录从审计文件读出，重启后还在", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-activity-"));
  const file = join(dir, "audit.jsonl");
  writeFileSync(file, `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", target: "smoke", outcome: "completed" })}\n`);
  const local = createLocalA2A({
    activityFile: file,
    runtime: { launch() { return { ok: true }; }, cancel() {} },
    log: { info() {} },
  });
  await local.start();
  try {
    const port = local.server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/activity`);
    const body = await response.json();
    assert.equal(body.events[0].target, "smoke");
    assert.equal(body.events[0].outcome, "completed");
  } finally {
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
