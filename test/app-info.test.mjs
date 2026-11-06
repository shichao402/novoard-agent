/**
 * 契约 v2.3 agent.hello.app：agent 上报自身程序版本。
 *
 * - 版本优先取壳注入的 NOVOARD_APP_VERSION（发布构建的 relkit 版本），否则回落 VERSION.json；
 * - 渠道取 NOVOARD_APP_CHANNEL（stable / dev），未注入时为 local（源码运行或未接入更新的构建）；
 * - hello 帧必须带上 app，且通过本仓锁定的 schema 校验。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import versionFile from "../VERSION.json" with { type: "json" };
import { appInfo } from "../src/app-info.mjs";
import { createTunnelClient } from "../src/tunnel-client.mjs";
import { createMockHub } from "./lib/mock-hub.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";

test("appInfo：未注入时回落 VERSION.json，渠道为 local", () => {
  assert.deepEqual(appInfo({ env: {}, platform: "win32", arch: "x64" }), {
    version: versionFile.version,
    channel: "local",
    platform: "win32-x64",
  });
});

test("appInfo：壳注入的版本与渠道优先，空白值视为未注入", () => {
  assert.deepEqual(
    appInfo({ env: { NOVOARD_APP_VERSION: "0.3.5", NOVOARD_APP_CHANNEL: "stable" }, platform: "darwin", arch: "arm64" }),
    { version: "0.3.5", channel: "stable", platform: "darwin-arm64" },
  );
  const blank = appInfo({ env: { NOVOARD_APP_VERSION: "  ", NOVOARD_APP_CHANNEL: "" }, platform: "linux", arch: "x64" });
  assert.equal(blank.version, versionFile.version);
  assert.equal(blank.channel, "local");
});

test("hello 帧携带 app", async () => {
  const hub = await createMockHub({ tokens: { "agent-a": "agent-a-secret" } });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-app-info-"));
  const port = hub.server.address().port;
  const app = { version: "0.3.4", channel: "dev", platform: "win32-x64" };
  const client = createTunnelClient({
    config: {
      ok: true,
      agentId: "agent-a",
      hubUrl: `ws://127.0.0.1:${port}/tunnel`,
      agentToken: "agent-a-secret",
      contractVersion: CONTRACT_VERSION,
    },
    card: {
      name: "agent-a",
      description: "agent-a",
      version: "2.0.0",
      capabilities: { streaming: false, pushNotifications: true },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [],
    },
    targets: {},
    runner: { launch() { return { ok: true }; }, cancel() { return { ok: true }; }, resume() { return { ok: true }; } },
    stateDir,
    app,
    log: { info() {}, error() {} },
  });
  try {
    await client.start();
    const deadline = Date.now() + 3000;
    while (!client.registered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(client.registered, true, "带 app 的 hello 必须通过 hub 校验并注册");
    const hello = hub.frames.find((frame) => frame.body?.type === "agent.hello");
    assert.deepEqual(hello.body.app, app);
  } finally {
    client.close();
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
