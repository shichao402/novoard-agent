import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../src/session-store.mjs";
import { explainAgentError, normalizeSdkMessage, toolResultText } from "../src/chat-events.mjs";
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

test("会话进程以宿主传入的环境为基础，而不是 GUI 进程环境", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-chat-env-"));
  const worker = join(dir, "worker.mjs");
  writeFileSync(worker, [
    'import { createInterface } from "node:readline";',
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    "  const msg = JSON.parse(line);",
    "  const result = { mark: process.env.NOVOARD_TEST_MARK ?? null, key: process.env.CODEBUDDY_API_KEY ?? null };",
    '  process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");',
    "});",
  ].join("\n"));
  const env = { ...process.env, NOVOARD_TEST_MARK: "from-login-shell", CODEBUDDY_API_KEY: "ck_from_shell" };
  delete env.NOVOARD_NODE;
  const bridge = createChatBridge({
    dataDir: dir,
    workerPath: worker,
    decEnvFile: join(dir, "missing.env"),
    env,
    log: {},
  });
  try {
    assert.equal(process.env.NOVOARD_TEST_MARK, undefined);
    bridge.setOrigin("http://127.0.0.1:1");
    const result = await bridge.list();
    assert.equal(result.mark, "from-login-shell");
    assert.equal(result.key, "ck_from_shell");
  } finally {
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("新建会话前发现 key 变了就重启会话进程，有请求进行中时不重启", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-chat-rotate-"));
  const worker = join(dir, "worker.mjs");
  writeFileSync(worker, [
    'import { createInterface } from "node:readline";',
    'createInterface({ input: process.stdin }).on("line", (line) => {',
    "  const msg = JSON.parse(line);",
    '  if (msg.op === "send") return;',
    "  const result = { pid: process.pid, key: process.env.CODEBUDDY_API_KEY ?? null };",
    '  process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");',
    "});",
  ].join("\n"));
  const decFile = join(dir, "novoard-agent.codebuddy.env");
  writeFileSync(decFile, "CODEBUDDY_API_KEY=ck_old\n");
  const env = { ...process.env };
  delete env.CODEBUDDY_API_KEY;
  delete env.NOVOARD_NODE;
  const logs = [];
  const bridge = createChatBridge({
    dataDir: dir,
    workerPath: worker,
    decEnvFile: decFile,
    env,
    log: { info: (m) => logs.push(m) },
  });
  try {
    bridge.setOrigin("http://127.0.0.1:1");
    const first = await bridge.create("a");
    assert.equal(first.key, "ck_old");
    assert.equal((await bridge.create("b")).pid, first.pid, "key 没变时复用会话进程");

    writeFileSync(decFile, "CODEBUDDY_API_KEY=ck_new\n");
    const rotated = await bridge.create("c");
    assert.notEqual(rotated.pid, first.pid, "key 变了应重启会话进程");
    assert.equal(rotated.key, "ck_new");
    assert.ok(logs.some((m) => m.includes("模型配置已变化")));
    assert.ok(logs.every((m) => !m.includes("ck_new")), "日志里不能出现 key 明文");

    const inflight = bridge.send("s1", "hi").catch(() => "rejected");
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(decFile, "CODEBUDDY_API_KEY=ck_third\n");
    const busy = await bridge.create("d");
    assert.equal(busy.pid, rotated.pid, "有请求进行中时不重启");
    assert.equal(busy.key, "ck_new");
    bridge.close();
    assert.equal(await inflight, "rejected");
  } finally {
    bridge.close();
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

test("工具调用与结果带 toolUseId，结果拆成纯文本，问答结果被过滤", () => {
  const state = { hidden: new Set() };
  const call = normalizeSdkMessage({
    type: "assistant",
    message: { content: [
      { type: "tool_use", id: "t1", name: "mcp__novoard__novoard_list_targets", input: {} },
      { type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [] } },
    ] },
  }, state);
  assert.deepEqual(call, [{ kind: "tool", name: "mcp__novoard__novoard_list_targets", input: {}, toolUseId: "t1" }]);
  const inner = JSON.stringify([{ type: "text", text: "{\"ok\":true}" }]);
  const results = normalizeSdkMessage({
    type: "user",
    message: { content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: inner }] },
      { type: "tool_result", tool_use_id: "q1", content: "用户选了 A" },
      { type: "tool_result", tool_use_id: "t2", content: "Permission denied", is_error: true },
    ] },
  }, state);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { kind: "tool_result", text: "{\"ok\":true}", toolUseId: "t1" });
  assert.equal(results[1].isError, true);
  assert.equal(results[1].toolUseId, "t2");
  const long = toolResultText("x".repeat(5000));
  assert.ok(long.length < 4100);
  assert.match(long, /已截断，共 5000 字/);
  assert.equal(toolResultText([{ type: "image" }]), "[图片]");
});

test("SDK 顶层 error 消息转成错误事件，恢复不存在的会话可被识别", async () => {
  const { isMissingConversation } = await import("../src/chat-events.mjs");
  const missing = { type: "error", error: "No conversation found with session ID: 01a1ee27-fb94-7ab3-b989-e3892f89b19b" };
  assert.equal(isMissingConversation(missing), true);
  assert.equal(isMissingConversation({ type: "error", error: "rate limited" }), false);
  assert.equal(isMissingConversation({ type: "result", subtype: "success" }), false);
  assert.equal(isMissingConversation(null), false);
  const events = normalizeSdkMessage({ type: "error", error: "rate limited" });
  assert.deepEqual(events, [{ kind: "error", text: "rate limited" }]);
  assert.equal(normalizeSdkMessage({ type: "error" })[0].kind, "error");
});

test("会话进程发送时遇到会话不存在会用同一 id 重建并重发", async () => {
  const { readFileSync } = await import("node:fs");
  const worker = readFileSync(new URL("../src/chat-worker.mjs", import.meta.url), "utf8");
  // 真实 SDK 无法在单测里替换，这里锁住重建分支的关键调用，防止被误删
  assert.match(worker, /isMissingConversation\(message\)/);
  assert.match(worker, /outcome\.missing[\s\S]*recreateSession\(sdk, request\.sessionId\)[\s\S]*session\.send\(text\)/);
  assert.match(worker, /function recreateSession[\s\S]*openSession\(sdk, id, false\)/);
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

test("ADR-0020：run_target 带 vars 走 data part，target_inputs 读输入描述，受理即失败时报错", async () => {
  const calls = [];
  let failNext = false;
  const fetchImpl = async (url, init) => {
    const path = String(url).replace("http://127.0.0.1:9", "");
    calls.push({ path, method: init?.method ?? "GET", body: init?.body });
    if (path === "/a2a") {
      const status = failNext ? { state: "failed", message: "缺少输入：分支（branch）" } : { state: "submitted" };
      return { ok: true, json: async () => ({ result: { id: "task-local-2", status } }) };
    }
    if (path === "/api/targets/open-branch/inputs") {
      return { ok: true, json: async () => ({ ok: true, id: "open-branch", inputs: [{ name: "branch", choices: [{ value: "exp" }] }] }) };
    }
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const opts = { origin: "http://127.0.0.1:9", fetchImpl };
  const described = JSON.parse(await dispatchNovoardTool("novoard_target_inputs", { id: "open-branch" }, opts));
  assert.equal(described.inputs[0].name, "branch");
  await assert.rejects(dispatchNovoardTool("novoard_target_inputs", { id: "../x" }, opts), /target 的 id/);
  await dispatchNovoardTool("novoard_run_target", { id: "open-branch", vars: { branch: "exp" } }, opts);
  const sent = JSON.parse(calls.at(-1).body);
  assert.deepEqual(sent.params.message.parts, [{ kind: "text", text: "open-branch" }, { kind: "data", data: { branch: "exp" } }]);
  await dispatchNovoardTool("novoard_run_target", { id: "open-branch" }, opts);
  assert.equal(JSON.parse(calls.at(-1).body).params.message.parts.length, 1);
  failNext = true;
  await assert.rejects(dispatchNovoardTool("novoard_run_target", { id: "open-branch" }, opts), /缺少输入/);
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
  for (const tool of ["novoard_list_packs", "novoard_pack_tools", "novoard_install_pack", "novoard_get_schedule", "novoard_set_schedule", "novoard_schedule_catch_up", "novoard_target_inputs"]) {
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
  const { NOVOARD_MCP_TOOLS } = await import("../src/chat-permissions.mjs");
  const worker = readFileSync(new URL("../src/chat-worker.mjs", import.meta.url), "utf8");
  const tools = readFileSync(new URL("../src/novoard-tools.mjs", import.meta.url), "utf8");
  const declared = [...worker.matchAll(/^\s*\["(novoard_[a-z_]+)",/gm)].map((m) => m[1]).sort();
  const allowed = NOVOARD_MCP_TOOLS.map((name) => name.replace(/^mcp__novoard__/, "")).sort();
  const handled = [...tools.matchAll(/name === "(novoard_[a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.ok(declared.length >= 20);
  assert.deepEqual(allowed, declared);
  assert.deepEqual(handled, declared);
  assert.match(worker, /allowedTools: \[\.\.\.NOVOARD_MCP_TOOLS, \.\.\.BUILTIN_ALLOWED_TOOLS\]/);
  assert.match(worker, /disallowedTools: BUILTIN_DISALLOWED_TOOLS/);
});

test("内置工具白名单只放行只读命令和 pool.toml，任务类工具被禁用", async () => {
  const { BUILTIN_ALLOWED_TOOLS, BUILTIN_DISALLOWED_TOOLS } = await import("../src/chat-permissions.mjs");
  for (const name of ["Read", "Glob", "Grep", "Bash(svn info:*)", "PowerShell(Get-ChildItem:*)", "Write(**/pool.toml)"]) {
    assert.ok(BUILTIN_ALLOWED_TOOLS.includes(name), `应放行 ${name}`);
  }
  // 不带限定的执行类工具一放行就等于全开
  for (const name of ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "AskUserQuestion"]) {
    assert.ok(!BUILTIN_ALLOWED_TOOLS.includes(name), `不应整体放行 ${name}`);
  }
  const writes = /\b(update|commit|revert|cleanup|checkout|switch|reset|push|pull|merge|rm|del|Remove-Item|Set-Content|Out-File|Move-Item|Copy-Item|Start-Process)\b/i;
  for (const rule of BUILTIN_ALLOWED_TOOLS.filter((name) => /^(Bash|PowerShell)\(/.test(name))) {
    assert.match(rule, /:\*\)$/, `${rule} 应为前缀规则`);
    assert.doesNotMatch(rule, writes, `${rule} 不应是写操作`);
  }
  for (const name of ["TaskCreate", "TaskUpdate", "EnterPlanMode", "Agent"]) {
    assert.ok(BUILTIN_DISALLOWED_TOOLS.includes(name), `应禁用 ${name}`);
  }
});

test("会话运行时打包清单包含 worker 依赖的全部本地模块", async () => {
  const { readFileSync } = await import("node:fs");
  const stage = readFileSync(new URL("../scripts/stage-agent-runtime.mjs", import.meta.url), "utf8");
  const files = JSON.parse(stage.match(/const FILES = (\[[^\]]+\])/)[1]);
  const seen = new Set();
  const queue = ["chat-worker.mjs"];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    for (const m of text.matchAll(/from "\.\/([a-z0-9.-]+\.mjs)"/g)) queue.push(m[1]);
  }
  for (const file of seen) assert.ok(files.includes(file), `打包清单缺 ${file}`);
});

test("本机会话被拒工具时停下来问用户", async () => {
  const { readFileSync } = await import("node:fs");
  const { NOVOARD_SKILL } = await import("../src/novoard-skill.mjs");
  const { permissionPrompt } = await import("../src/chat-approval.mjs");
  const worker = readFileSync(new URL("../src/chat-worker.mjs", import.meta.url), "utf8");
  assert.match(NOVOARD_SKILL, /## 工具权限/);
  assert.match(NOVOARD_SKILL, /工具被拒时/);
  assert.match(NOVOARD_SKILL, /不要换个工具或换个写法绕过去/);
  assert.match(NOVOARD_SKILL, /会话权限/);
  assert.match(worker, /permissionPrompt\(auth\.permission\)/);
  assert.match(permissionPrompt("readonly"), /被拒后不要换工具绕过、不要排后续计划/);
  assert.match(permissionPrompt("confirm"), /用户拒绝后不要换工具绕过、不要排后续计划/);
});
