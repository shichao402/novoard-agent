/**
 * 契约可观测性测试（agent 侧，契约 §0）。
 *
 * 覆盖三件在真实故障里会直接决定排障速度的事：
 * 1. hello 与 ack 都记录 msgId 与双方契约版本——两侧日志能按同一 msgId 对齐
 * 2. frame.reject 分支可达且记录 refMsgId——曾被 return 挡成死代码，hub 的拒绝完全不可见
 * 3. 被拒的 a2a 帧必须退出重放队列——否则每次重连都重发同一帧，永远被拒、日志被刷满
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

const TOKEN = "observability-agent-token";

function configFor(port) {
  return {
    ok: true,
    agentId: "agent-a",
    hubUrl: `ws://127.0.0.1:${port}/tunnel`,
    agentToken: TOKEN,
    contractVersion: CONTRACT_VERSION,
  };
}

function baseRunner() {
  return { launch() { return { ok: true }; }, cancel() { return { ok: true }; }, resume() { return { ok: true }; } };
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

test("hello 发出后记录 msgId 与本端契约版本，注册成功后记录 hub 版本", async () => {
  const hub = await createMockHub({ tokens: { "agent-a": TOKEN }, hubContractVersion: "2.3" });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-obs-hello-"));
  const logs = [];
  let client;
  try {
    client = createTunnelClient({
      config: configFor(hub.server.address().port),
      card: CARD,
      targets: {},
      runner: baseRunner(),
      stateDir,
      log: { info(message) { logs.push(String(message)); }, error(message) { logs.push(`ERR ${message}`); } },
      onFatal() {},
    });
    await client.start();
    await waitFor(() => client.registered);

    const helloLog = logs.find((l) => l.includes("发出 hello"));
    assert.ok(helloLog, `应记录 hello 发出：${JSON.stringify(logs)}`);
    assert.match(helloLog, /msgId=e-[0-9a-f]{8}/, `hello 日志应带 msgId：${helloLog}`);
    assert.ok(helloLog.includes(`contractVersion=${CONTRACT_VERSION}`), `hello 日志应带本端版本：${helloLog}`);

    const ackLog = logs.find((l) => l.includes("已注册到 hub"));
    assert.ok(ackLog, `应记录注册成功：${JSON.stringify(logs)}`);
    // 双方版本同时出现在一行：单侧升级后出现行为差异时，先看这行就知道两侧各停在哪个契约
    assert.ok(ackLog.includes(`本端 contractVersion=${CONTRACT_VERSION}`), `注册日志应带本端版本：${ackLog}`);
    assert.ok(ackLog.includes("hubVersion 2.3"), `注册日志应带对端版本：${ackLog}`);
    assert.match(ackLog, /msgId=e-[0-9a-f]{8}/, `注册日志应带 msgId 以便与 hub 日志关联：${ackLog}`);
  } finally {
    try { client?.close?.(); } catch { /* 已关闭 */ }
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("hub 回 frame.reject：出错日志记录 refMsgId 与原因，分支确实可达", async () => {
  const hub = await createMockHub({ tokens: { "agent-a": TOKEN } });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-obs-reject-"));
  const errors = [];
  let client;
  try {
    client = createTunnelClient({
      config: configFor(hub.server.address().port),
      card: CARD,
      targets: {},
      runner: baseRunner(),
      stateDir,
      log: { info() {}, error(message) { errors.push(String(message)); } },
      onFatal() {},
    });
    await client.start();
    await waitFor(() => client.registered);

    // 让 hub 拒绝该 task 的上行帧
    hub.rejectA2aFor("task-reject-me");
    client.uplink("task-reject-me", {
      jsonrpc: "2.0",
      method: "message/notification",
      params: { message: { messageId: "msg-1", role: "agent", parts: [{ kind: "text", text: "done" }], status: { state: "completed" } } },
    });

    await waitFor(() => errors.some((e) => e.includes("上行帧被 hub 拒绝")));
    const rejectLog = errors.find((e) => e.includes("上行帧被 hub 拒绝"));
    assert.ok(rejectLog.includes("ops-schema-mismatch"), `应记录拒绝原因：${rejectLog}`);
    assert.match(rejectLog, /refMsgId=e-[0-9a-f]{8}/, `应记录可关联的 refMsgId：${rejectLog}`);
  } finally {
    try { client?.close?.(); } catch { /* 已关闭 */ }
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("被拒的 a2a 帧退出重放队列，不再无限重放", async () => {
  const hub = await createMockHub({ tokens: { "agent-a": TOKEN } });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-obs-drop-"));
  const replayFile = join(stateDir, "replay.jsonl");
  let client;
  try {
    client = createTunnelClient({
      config: configFor(hub.server.address().port),
      card: CARD,
      targets: {},
      runner: baseRunner(),
      stateDir,
      log: { info() {}, error() {} },
      onFatal() {},
    });
    await client.start();
    await waitFor(() => client.registered);

    hub.rejectA2aFor("task-drop-me");
    client.uplink("task-drop-me", {
      jsonrpc: "2.0",
      method: "message/notification",
      params: { message: { messageId: "msg-2", role: "agent", parts: [{ kind: "text", text: "done" }], status: { state: "completed" } } },
    });

    // 先确认它进了缓存（重放机制本来就依赖这一步）
    await waitFor(() => existsSync(replayFile) && readFileSync(replayFile, "utf8").includes("task-drop-me"));

    // 被拒后必须从缓存消失：否则下次重连会把同一帧再发一遍，永远被拒
    await waitFor(() => {
      const text = existsSync(replayFile) ? readFileSync(replayFile, "utf8") : "";
      return !text.includes("task-drop-me");
    }, 5000);
    const after = existsSync(replayFile) ? readFileSync(replayFile, "utf8") : "";
    assert.ok(!after.includes("task-drop-me"), `被拒帧应退出重放缓存，实际：${after}`);
  } finally {
    try { client?.close?.(); } catch { /* 已关闭 */ }
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
