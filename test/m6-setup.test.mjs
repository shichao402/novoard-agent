/**
 * M6 F2 测试：setup 向导 + SEA 打包链路。
 * - normalizeHubUrl：裸域名 / https / ws / 带路径 / 非法输入
 * - testConnection：真 hub WS upgrade 探测（401 token 无效 / open 成功，零注册痕迹）
 * - createSetupWizard：骨架生成 + agent.json 0600 + save 后 onReady 热启动 + 向导自动关闭
 * - e2e：向导保存 → agent 真启动 → hub 注册（card 上报）→ editor 增改 target → card.update 到 hub
 * - schemas 内嵌等价性：EMBEDDED（模拟注入 globalThis）与读盘 createFrameValidator 校验行为一致
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeHubUrl, testConnection, createSetupWizard } from "../src/setup-wizard.mjs";
import { createLiteAgent } from "../src/main.mjs";
import { createMockHub } from "./lib/mock-hub.mjs";
import { createFrameValidator } from "../src/contract/frames.mjs";
import { sameOrigin } from "../src/local-a2a.mjs";
import { parse } from "yaml";

test("M6F2 normalizeHubUrl：裸域名 → wss://…/tunnel；已带路径尊重不覆盖", () => {
  assert.deepEqual(normalizeHubUrl("novoard.firoyang.com"), { ok: true, url: "wss://novoard.firoyang.com/tunnel" });
  assert.deepEqual(normalizeHubUrl("https://novoard.firoyang.com"), { ok: true, url: "wss://novoard.firoyang.com/tunnel" });
  assert.deepEqual(normalizeHubUrl("https://novoard.firoyang.com/novoard"), { ok: true, url: "wss://novoard.firoyang.com/novoard" });
  assert.deepEqual(normalizeHubUrl("ws://127.0.0.1:38666/tunnel"), { ok: true, url: "ws://127.0.0.1:38666/tunnel" });
  assert.deepEqual(normalizeHubUrl("http://127.0.0.1:38666"), { ok: true, url: "ws://127.0.0.1:38666/tunnel" });
  assert.ok(!normalizeHubUrl("").ok);
  assert.ok(!normalizeHubUrl("ftp://x").ok);
  assert.ok(!normalizeHubUrl("http://").ok);
});

test("M6F2 testConnection：真 hub 探测——错 token 401，正确 token open 成功；不发 hello 零注册痕迹", async () => {
  const hubDir = mkdtempSync(join(tmpdir(), "novoard-f2hub-"));
  let hub = null;
  try {
    hub = await createMockHub({ tokens: { probe: "agt-f2-test-conn-123456" } });
    const port = hub.server.address().port;

    const bad = await testConnection({ hubUrl: `ws://127.0.0.1:${port}/tunnel`, agentToken: "agt-wrong-token-000000" });
    assert.ok(!bad.ok);
    assert.match(bad.reason, /401|token/);

    const good = await testConnection({ hubUrl: `ws://127.0.0.1:${port}`, agentToken: "agt-f2-test-conn-123456" });
    assert.ok(good.ok, good.reason);
    assert.equal(good.url, `ws://127.0.0.1:${port}/tunnel`);

    // 零注册痕迹：探测连接不触发注册（mock members 空）
    assert.equal(hub.members.size, 0, "探测不应注册成员");
  } finally {
    if (hub) await hub.close();
    rmSync(hubDir, { recursive: true, force: true });
  }
});

test("M6F2 向导 save：骨架 targets.yaml + agent.json(0600) + onReady 热启动 + 向导关闭", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-f2wiz-"));
  let wizard = null;
  let booted = null;
  try {
    wizard = createSetupWizard({
      dir, port: 0,
      onReady: async (config) => {
        booted = config;
        return { localA2A: { server: { address: () => ({ port: 41234 }) } } };
      },
      log: { info() {} },
    });
    const addr = await wizard.start();
    const port = addr.port;

    // 页面可达
    const page = await fetch(`http://127.0.0.1:${port}/setup`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /首次接入/);

    // 根路径重定向到 /setup
    const root = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    assert.equal(root.status, 302);

    // 保存（字段不合法 → 422）
    const bad = await fetch(`http://127.0.0.1:${port}/api/setup/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubUrl: "novoard.firoyang.com", agentId: "Bad_ID", agentToken: "agt-xyz-123456" }),
    });
    const badBody = await bad.json().catch(() => ({}));
    assert.equal(bad.status, 422);
    assert.ok(badBody.errors?.length >= 1);

    // 保存（合法）
    const res = await fetch(`http://127.0.0.1:${port}/api/setup/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubUrl: "novoard.firoyang.com", agentId: "win-dev", agentToken: "agt-win-dev-token-0001", localPort: 0 }),
    });
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.ok);
    assert.equal(body.agentId, "win-dev");
    assert.equal(body.panelUrl, "http://127.0.0.1:41234");

    // onReady 已被调用且收到归一化配置
    assert.equal(booted.hubUrl, "wss://novoard.firoyang.com/tunnel");
    assert.equal(booted.agentId, "win-dev");

    // agent.json 落盘（0600）+ 骨架 targets.yaml 存在且 schema 合法
    const cfg = JSON.parse(readFileSync(join(dir, "agent.json"), "utf8"));
    assert.equal(cfg.hubUrl, "wss://novoard.firoyang.com/tunnel");
    const skeleton = readFileSync(join(dir, "agents", "win-dev", "targets.yaml"), "utf8");
    assert.match(skeleton, /win-dev-smoke/);
    const validator = createFrameValidator();
    const parsed = parse(skeleton);
    assert.ok(validator.targets(parsed).ok, "骨架应过 target schema");

    // 向导响应后自动关闭
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(wizard.server.listening === false, "向导应已关闭");

    // 跨源写 403（同纪律）
    const other = createSetupWizard({ dir: join(dir, "no-used"), port: 0, onReady: async () => ({}), log: { info() {} } });
    await other.start();
    const cross = await fetch(`http://127.0.0.1:${other.server.address().port}/api/setup/test`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example.com", Host: "evil.example.com" },
      body: JSON.stringify({ hubUrl: "x", agentToken: "y" }),
    });
    assert.equal(cross.status, 403);
    await other.close();
  } finally {
    try { await wizard?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M6F2 e2e：向导保存 → agent 热启动 → hub 注册 → editor 改 target → card.update 到 hub", async () => {
  const hubDir = mkdtempSync(join(tmpdir(), "novoard-f2e2e-"));
  const dataDir = mkdtempSync(join(tmpdir(), "novoard-f2data-"));
  const AGENT_TOKEN = "agt-f2-e2e-token-987654";
  let hub = null;
  let agent = null;
  try {
    hub = await createMockHub({ tokens: { "win-dev": AGENT_TOKEN } });
    const port = hub.server.address().port;

    let bootedAgent = null;
    const wizard = createSetupWizard({
      dir: dataDir, port: 0,
      onReady: async (config, saved) => {
        bootedAgent = await createLiteAgent({
          configPath: saved.configPath,
          agentDir: saved.agentDir,
          stateDir: join(dataDir, ".agent-state"),
          log: {},
        });
        return bootedAgent;
      },
      log: { info() {} },
    });
    await wizard.start();

    const res = await fetch(`http://127.0.0.1:${wizard.server.address().port}/api/setup/save`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubUrl: `http://127.0.0.1:${port}`, agentId: "win-dev", agentToken: AGENT_TOKEN }),
    });
    assert.equal(res.status, 200, JSON.stringify(await res.json().catch(() => ({}))));
    agent = bootedAgent;

    await new Promise((r) => setTimeout(r, 400));
    assert.ok(agent.tunnel.registered, "向导保存后应自动注册到 hub");
    assert.ok(hub.members.get("win-dev").card.skills.some((s) => s.id === "win-dev-smoke"), "骨架 skill 应已上报");

    // editor 改 target（可视化编辑在二进制形态同样可用）
    const localPort = agent.localA2A.server.address().port;
    const put = await fetch(`http://127.0.0.1:${localPort}/api/targets`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targets: {
          "deploy-project": {
            title: "部署 Windows 项目", steps: [{ script: "echo deploy ok" }], vars: {},
            expose: "a2a", audit: "summary", requiresApproval: false, notify: "on-failure",
          },
        },
      }),
    });
    assert.equal(put.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    const m2 = hub.members.get("win-dev");
    assert.ok(m2.card.skills.some((s) => s.id === "deploy-project"), "card.update 应已到 hub");
    assert.ok(!m2.card.skills.some((s) => s.id === "win-dev-smoke"), "骨架 skill 应被替换");
  } finally {
    await agent?.stop();
    if (hub) await hub.close();
    rmSync(hubDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("M6F2 schemas 内嵌等价：注入 globalThis 后 createFrameValidator 校验行为与读盘一致", async () => {
  const schemaFiles = ["a2a-envelope.json", "frame-agent-hello.json", "frame-agent-ping.json", "frame-telemetry.json", "frame-card-update.json", "agent-card.json", "task.json", "audit-event.json", "target.json"];
  const schemaDir = join(process.cwd(), "src", "contract", "schemas");
  const table = Object.fromEntries(schemaFiles.map((f) => [f, JSON.parse(readFileSync(join(schemaDir, f), "utf8"))]));

  // 直接以 schemas 参数注入（等价于 sea-entry 的 globalThis 路径，不污染全局做两轮）
  const diskValidator = createFrameValidator();
  const embeddedValidator = createFrameValidator({ schemas: table });

  const goodTarget = { targets: { "t-1": { title: "x", steps: [{ script: "echo" }], expose: "a2a", audit: "summary", requiresApproval: false, notify: "on-failure" } } };
  assert.equal(diskValidator.targets(goodTarget).ok, embeddedValidator.targets(goodTarget).ok);
  const badTarget = { targets: { "t-1": { title: "x" } } };
  assert.equal(diskValidator.targets(badTarget).ok, false);
  assert.equal(embeddedValidator.targets(badTarget).ok, false);
  assert.deepEqual(diskValidator.targets(badTarget).errors.map((e) => e.instancePath), embeddedValidator.targets(badTarget).errors.map((e) => e.instancePath));

  const hello = { type: "agent.hello", contractVersion: "2.0", agentId: "win-dev", card: { name: "win-dev", description: "d", version: "2.0.0", capabilities: { streaming: false, pushNotifications: true }, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [] } };
  assert.equal(diskValidator.opsBody("agent.hello", hello).ok, true);
  assert.equal(embeddedValidator.opsBody("agent.hello", hello).ok, true);
});

test("M6F2 sameOrigin 导出：跨源 Host 拒绝，本机回环放行", () => {
  assert.equal(sameOrigin({ headers: { host: "evil.example.com:80" } }), false);
  assert.equal(sameOrigin({ headers: { host: "127.0.0.1:39870" } }), true);
  assert.equal(sameOrigin({ headers: { host: "localhost:39870" } }), true);
  assert.equal(sameOrigin({ headers: { host: "127.0.0.1:39870", origin: "http://127.0.0.1:39870" } }), true);
  assert.equal(sameOrigin({ headers: { host: "127.0.0.1:39870", origin: "http://evil.example.com" } }), false);
});

test("M6F2 回归：/setup 向导页内嵌 JS 语法可解析（三页面全覆盖的最后一页）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-f2wizp-"));
  let wizard = null;
  try {
    wizard = createSetupWizard({ dir, port: 0, onReady: async () => {}, log: { info() {} } });
    const addr = await wizard.start();
    const html = await (await fetch(`http://127.0.0.1:${addr.port}/setup`)).text();
    const m = html.match(/<script>([\s\S]*)<\/script>/);
    assert.ok(m, "向导页应有内嵌 script 块");
    assert.doesNotThrow(() => new vm.Script(m[1]), "向导页内嵌 JS 必须可被解析");
  } finally {
    await wizard?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
