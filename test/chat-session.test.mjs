import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../src/session-store.mjs";
import { explainAgentError, normalizeSdkMessage } from "../src/chat-events.mjs";
import { dispatchNovoardTool } from "../src/novoard-tools.mjs";
import { createChatBridge, locateNode } from "../src/chat-bridge.mjs";
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

test("打包后的 Agent 从 PATH 找 Node，跳过 WindowsApps 目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-node-"));
  try {
    // 宿主可执行文件不是 node 本身时要从 PATH 找同平台的 node，文件名与分隔符都随平台变
    const spec = process.platform === "win32"
      ? { node: "node.exe", host: "novoard-agent.exe", sep: ";" }
      : { node: "node", host: "novoard-agent", sep: ":" };
    const store = join(dir, "WindowsApps");
    const real = join(dir, "nodejs");
    mkdirSync(store);
    mkdirSync(real);
    writeFileSync(join(store, spec.node), "");
    writeFileSync(join(real, spec.node), "");
    const executable = join(dir, spec.host);
    const found = locateNode(
      { PATH: `${store}${spec.sep}${real}` },
      { executable },
    );
    assert.equal(found, join(real, spec.node));
    assert.equal(locateNode({ PATH: store }, { executable }), null);
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
  const ask = normalizeSdkMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "AskUserQuestion", input: { questions: [] } }] },
  });
  assert.equal(ask.length, 0);
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

test("能力包与定时工具走对应的本机接口", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = String(url).replace("http://127.0.0.1:9", "");
    calls.push({ path, method: init?.method ?? "GET", body: init?.body });
    if (path === "/api/packs") {
      return { ok: true, json: async () => ({ ok: true, packs: [
        { id: "versionControl", sourceKey: "src-aaa", installed: true, version: "c31cb5b", source: { git: "https://x/p.git", subdir: "packs/versionControl" }, depsReady: true },
        { id: null, sourceKey: "src-bbb", installed: false, source: { git: "https://x/p.git", subdir: "packs/general" } },
      ] }) };
    }
    if (path === "/api/packs/tools") {
      return { ok: true, json: async () => ({ ok: true, platform: "darwin", timezone: "Asia/Shanghai", scheduleEnabled: false, packs: [{ id: "versionControl", tools: [] }, { id: "general", tools: [] }] }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const opts = { origin: "http://127.0.0.1:9", fetchImpl };
  const listed = JSON.parse(await dispatchNovoardTool("novoard_list_packs", {}, opts));
  assert.deepEqual(listed.packs.map((p) => p.installKey), ["versionControl", "src-bbb"]);
  const tools = JSON.parse(await dispatchNovoardTool("novoard_pack_tools", { pack: "general" }, opts));
  assert.deepEqual(tools.packs.map((p) => p.id), ["general"]);
  await assert.rejects(dispatchNovoardTool("novoard_pack_tools", { pack: "osg" }, opts), /没有装能力包 osg/);
  await dispatchNovoardTool("novoard_install_pack", { key: "src-bbb" }, opts);
  assert.deepEqual(calls.at(-1), { path: "/api/packs/src-bbb/install", method: "POST", body: "{}" });
  await dispatchNovoardTool("novoard_install_pack", { key: "versionControl", action: "update" }, opts);
  assert.equal(calls.at(-1).path, "/api/packs/versionControl/update");
  await assert.rejects(dispatchNovoardTool("novoard_install_pack", { key: "../x" }, opts), /installKey/);
  await dispatchNovoardTool("novoard_get_schedule", {}, opts);
  assert.deepEqual(calls.at(-1), { path: "/api/schedule", method: "GET", body: undefined });
  await dispatchNovoardTool("novoard_set_schedule", { enabled: true }, opts);
  assert.deepEqual(calls.at(-1), { path: "/api/schedule", method: "PUT", body: JSON.stringify({ enabled: true }) });
  await assert.rejects(dispatchNovoardTool("novoard_set_schedule", {}, opts), /enabled/);
  await dispatchNovoardTool("novoard_schedule_catch_up", {}, opts);
  assert.equal(calls.at(-1).path, "/api/schedule/catch-up");
});

test("本机会话 skill 名与内容覆盖能力包和定时", async () => {
  const { NOVOARD_SKILL, NOVOARD_SKILL_NAME, NOVOARD_SKILL_LEGACY_NAMES } = await import("../src/novoard-skill.mjs");
  assert.equal(NOVOARD_SKILL_NAME, "novoard-agent-ops");
  assert.ok(NOVOARD_SKILL_LEGACY_NAMES.includes("novoard-agent"));
  assert.match(NOVOARD_SKILL, new RegExp(`^---\\nname: ${NOVOARD_SKILL_NAME}\\n`));
  for (const tool of ["novoard_list_packs", "novoard_pack_tools", "novoard_install_pack", "novoard_get_schedule", "novoard_set_schedule", "novoard_schedule_catch_up"]) {
    assert.ok(NOVOARD_SKILL.includes(tool), `skill 应提到 ${tool}`);
  }
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

test("会话工具声明、白名单与实现一一对应", async () => {
  const { readFileSync } = await import("node:fs");
  const worker = readFileSync(new URL("../src/chat-worker.mjs", import.meta.url), "utf8");
  const tools = readFileSync(new URL("../src/novoard-tools.mjs", import.meta.url), "utf8");
  const declared = [...worker.matchAll(/^\s*\["(novoard_[a-z_]+)",/gm)].map((m) => m[1]).sort();
  const allowed = [...worker.matchAll(/"mcp__novoard__(novoard_[a-z_]+)"/g)].map((m) => m[1]).sort();
  const handled = [...tools.matchAll(/name === "(novoard_[a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.ok(declared.length >= 20);
  assert.deepEqual(allowed, declared);
  assert.deepEqual(handled, declared);
});
