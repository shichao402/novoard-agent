/**
 * hello 回执超时测试（契约 §4.2，需求 3.3 / 3.4）：
 * 对端静默丢弃 hello 时，agent 不能保持「看起来正常」的连接，
 * 必须在有限窗口内给出「疑似契约不兼容」的明确失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTunnelClient } from "../src/tunnel-client.mjs";
import { createMockHub } from "./lib/mock-hub.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";

const CARD = {
  name: "agent-a",
  description: "agent-a",
  version: "2.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [{ id: "skill-a", name: "skill-a", description: "skill-a", tags: [] }],
};

const TOKEN = "timeout-token";

function configFor(port) {
  return {
    ok: true,
    agentId: "agent-a",
    hubUrl: `ws://127.0.0.1:${port}/tunnel`,
    agentToken: TOKEN,
    contractVersion: CONTRACT_VERSION,
  };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

test("对端静默不回执：超时后报告疑似契约不兼容，不再是静默连接", async () => {
  // helloSilence：收到 hello 后不回 ack/nack、不断链，精确复现旧 hub 的静默丢弃
  const hub = await createMockHub({ tokens: { "agent-a": TOKEN }, helloSilence: true });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-hello-timeout-"));

  const logs = [];
  const fatals = [];
  let client;

  try {
    client = createTunnelClient({
      config: configFor(hub.server.address().port),
      card: CARD,
      targets: {},
      runner: { launch() { return { ok: true }; }, cancel() { return { ok: true }; }, resume() { return { ok: true }; } },
      stateDir,
      log: {
        info() {},
        error(message) { logs.push(String(message)); },
      },
      onFatal(info) { fatals.push(info); },
    });

    await client.start();

    // 10s 超时窗口 + 余量
    await waitFor(() => fatals.length > 0, 15_000);

    assert.equal(fatals[0].code, "hello-timeout", `应报告 hello-timeout，实际：${JSON.stringify(fatals[0])}`);
    assert.ok(fatals[0].message.includes("疑似契约不兼容"), `报错应明确指出疑似契约不兼容：${fatals[0].message}`);
    assert.ok(fatals[0].message.includes(CONTRACT_VERSION), "报错应带上本端契约版本，便于对照");
    assert.ok(
      logs.some((l) => l.includes("未在") || l.includes("疑似契约不兼容")),
      `日志应留下可查记录：${JSON.stringify(logs)}`,
    );
  } finally {
    try { await client?.stop?.(); } catch { /* 已停止 */ }
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("对端正常回 ack：不触发超时报错", async () => {
  const hub = await createMockHub({ tokens: { "agent-a": TOKEN } });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-hello-ack-"));

  const fatals = [];
  let client;

  try {
    client = createTunnelClient({
      config: configFor(hub.server.address().port),
      card: CARD,
      targets: {},
      runner: { launch() { return { ok: true }; }, cancel() { return { ok: true }; }, resume() { return { ok: true }; } },
      stateDir,
      log: { info() {}, error() {} },
      onFatal(info) { fatals.push(info); },
    });

    await client.start();
    // 超过超时窗口仍不应出现致命错误
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    assert.deepEqual(fatals, [], `正常 ack 不应触发致命错误：${JSON.stringify(fatals)}`);
  } finally {
    try { await client?.stop?.(); } catch { /* 已停止 */ }
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
