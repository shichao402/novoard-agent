import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostProtocol } from "../src/host-protocol.mjs";
import { createUiAccess, validateUiConfig } from "../src/ui-access.mjs";
import { createSetupWizard } from "../src/setup-wizard.mjs";
import { createLocalA2A } from "../src/local-a2a.mjs";
import { loadAgentConfig } from "../src/config.mjs";
import { createAgentRuntime } from "../src/agent-runtime.mjs";

const UI_TOKEN = "ui-test-token-123456789";

test("宿主协议：NDJSON 事件、命令与 stdin 断开均可观测", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  const commands = [];
  let disconnected = false;
  output.on("data", (chunk) => { text += chunk; });

  const protocol = createHostProtocol({
    input,
    output,
    onCommand: async (command) => commands.push(command),
    onDisconnect: async () => { disconnected = true; },
  });
  protocol.emit("ui-ready", { view: "setup", url: "http://127.0.0.1:1/setup" });
  input.write('{"v":1,"type":"shutdown"}\n');
  input.end();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const event = JSON.parse(text.trim());
  assert.equal(event.v, 1);
  assert.equal(event.type, "ui-ready");
  assert.equal(commands[0].type, "shutdown");
  assert.equal(disconnected, true);
  protocol.close();
});

test("UI 配置：回环免 token，非回环强制独立 token", () => {
  assert.equal(validateUiConfig({ host: "127.0.0.1" }).ok, true);
  assert.equal(validateUiConfig({ host: "::1" }).ok, true);
  assert.equal(validateUiConfig({ host: "0.0.0.0" }).ok, false);
  assert.equal(validateUiConfig({ host: "0.0.0.0", token: UI_TOKEN }).remote, true);
  assert.throws(() => createUiAccess({ host: "192.168.1.5", token: "short" }), /至少 16/);
});

test("runtime 统一停机：清理挂起任务并拒绝新任务", async () => {
  const runtime = createAgentRuntime({
    targets: {
      guarded: {
        requiresApproval: true,
        vars: {},
        expanded: [{ script: "echo guarded" }],
      },
    },
    log: {},
  });
  const launched = runtime.launch({
    taskId: "task-shutdown-1",
    skillId: "guarded",
    vars: {},
    steps: [{ script: "echo guarded" }],
  });
  assert.equal(launched.reason, "input-required");
  assert.equal(runtime.runningTasks.length, 1);
  assert.deepEqual(await runtime.shutdown(), { ok: true, remaining: 0 });
  assert.equal(runtime.runningTasks.length, 0);
  assert.equal(runtime.launch({
    taskId: "task-shutdown-2",
    skillId: "guarded",
    vars: {},
    steps: [{ script: "echo guarded" }],
  }).reason, "agent-stopping");
});

test("配置加载：桌面环境变量可覆盖落盘的远程 UI 设置", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-config-ui-"));
  try {
    const configPath = join(dir, "agent.json");
    writeFileSync(configPath, JSON.stringify({
      agentId: "linux-headless",
      hubUrl: "ws://127.0.0.1:9999/tunnel",
      agentToken: "agent-token-123456",
      contractVersion: "2.0",
      uiHost: "0.0.0.0",
      uiToken: UI_TOKEN,
    }));
    const linux = loadAgentConfig({ configPath, env: {} });
    assert.equal(linux.ok, true);
    assert.equal(linux.uiRemote, true);

    const desktop = loadAgentConfig({
      configPath,
      env: { NOVOARD_UI_HOST: "127.0.0.1", NOVOARD_UI_TOKEN: "" },
    });
    assert.equal(desktop.ok, true);
    assert.equal(desktop.uiHost, "127.0.0.1");
    assert.equal(desktop.uiRemote, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("远程 setup：未登录重定向，UI Token 登录后可访问并持久化安全配置", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-remote-setup-"));
  const wizard = createSetupWizard({
    dir,
    port: 0,
    host: "0.0.0.0",
    uiToken: UI_TOKEN,
    log: { info() {}, error() {} },
  });
  try {
    const addr = await wizard.start();
    const base = `http://127.0.0.1:${addr.port}`;
    const blocked = await fetch(`${base}/setup`, { redirect: "manual" });
    assert.equal(blocked.status, 302);
    assert.equal(blocked.headers.get("location"), "/login");
    assert.equal((await fetch(`${base}/login`)).status, 200);

    const bad = await fetch(`${base}/api/ui/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ token: "wrong-token-value" }),
    });
    assert.equal(bad.status, 401);

    const login = await fetch(`${base}/api/ui/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ token: UI_TOKEN }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const page = await fetch(`${base}/setup`, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);

    const saved = wizard.saveConfig({
      hubUrl: "http://127.0.0.1:9999",
      agentId: "linux-headless",
      agentToken: "agent-token-123456",
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.config.uiHost, "0.0.0.0");
    assert.equal(saved.config.uiToken, UI_TOKEN);
  } finally {
    await wizard.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("远程 agent 控制台：页面、SSE/API 共用会话，写操作仍校验 Origin", async () => {
  const targets = {
    smoke: {
      title: "smoke",
      expose: "a2a",
      expanded: [{ script: "echo ok" }],
      vars: {},
    },
  };
  const runtime = {
    launch({ onTerminal }) {
      queueMicrotask(() => onTerminal?.("completed", ""));
      return { ok: true, reason: "working" };
    },
    cancel() { return { ok: true }; },
    resume() { return { ok: true }; },
  };
  const local = createLocalA2A({
    host: "0.0.0.0",
    port: 0,
    uiToken: UI_TOKEN,
    targets,
    card: { name: "linux-headless" },
    runtime,
    audit() {},
  });
  try {
    const addr = await local.start();
    const base = `http://127.0.0.1:${addr.port}`;
    assert.equal((await fetch(`${base}/api/tiles`)).status, 401);

    const login = await fetch(`${base}/api/ui/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ token: UI_TOKEN }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(`${base}/`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/editor`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/tiles`, { headers: { Cookie: cookie } })).status, 200);
    const health = await (await fetch(`${base}/api/runtime`, { headers: { Cookie: cookie } })).json();
    assert.equal(health.uiRemote, true);

    const rpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { parts: [{ kind: "text", text: "smoke" }] } },
    });
    const cross = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://evil.example.com" },
      body: rpcBody,
    });
    assert.equal(cross.status, 403);
    const allowed = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: base },
      body: rpcBody,
    });
    assert.equal(allowed.status, 200);
    assert.ok((await allowed.json()).result?.id);
  } finally {
    await local.close();
  }
});
