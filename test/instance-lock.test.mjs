/**
 * 并发实例的 agent 侧行为：
 * 1. hub 回 instance-conflict（可重试）时不能致命退出——否则后启动的实例直接死掉；
 * 2. 同一数据目录起第二个进程要在本地就被拦住，给出人话提示。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";

import { createTunnelClient } from "../src/tunnel-client.mjs";
import { acquireInstanceLock } from "../src/instance-lock.mjs";

const CARD = {
  name: "agent-a",
  description: "agent-a",
  version: "2.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [{ id: "skill-a", name: "skill-a", description: "skill-a", tags: [] }],
};

const RUNNER = {
  launch() { return { ok: true }; },
  cancel() { return { ok: true }; },
  resume() { return { ok: true }; },
};

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

/** 只做一件事的假 hub：数到第 N 次 hello 之前一直回指定的 nack，之后回 ack。 */
async function conflictHub({ conflicts, reason = "instance-conflict", retryable = true }) {
  const hellos = [];
  const server = createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  let remaining = conflicts;
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.body?.type !== "agent.hello") return;
      hellos.push(frame);
      const ops = (body) => ws.send(JSON.stringify({ v: 1, kind: "ops", msgId: `e-${Date.now()}`, ts: new Date().toISOString(), body }));
      if (remaining > 0) {
        remaining -= 1;
        ops({ type: "agent.hello.nack", reason, hubVersion: "2.1", ...(retryable ? { retryable: true } : {}) });
        return;
      }
      ops({ type: "agent.hello.ack", inFlightTaskIds: [] });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    hellos,
    port: server.address().port,
    async close() {
      for (const client of wss.clients) { try { client.close(); } catch { /* noop */ } }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("instance-conflict 属可重试：不触发致命退出，旧实例消失后自动接管", async () => {
  const hub = await conflictHub({ conflicts: 2 });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-conflict-"));
  let fatal = null;
  let exitCalled = false;
  const client = createTunnelClient({
    config: {
      ok: true,
      agentId: "agent-a",
      hubUrl: `ws://127.0.0.1:${hub.port}/tunnel`,
      agentToken: "agent-a-secret",
      contractVersion: "2.1",
    },
    card: CARD,
    targets: {},
    runner: RUNNER,
    stateDir,
    log: { info() {}, error() {} },
    onFatal(event) { fatal = event; },
  });
  const originalExit = process.exit;
  process.exit = () => { exitCalled = true; };
  try {
    await client.start();
    // 前两次被拒，第三次成功：说明在退避重试而非放弃
    await waitFor(() => client.registered, 15_000);
    assert.equal(fatal, null, "可重试拒绝不应走致命路径");
    assert.equal(exitCalled, false, "可重试拒绝不应退出进程");
    assert.ok(hub.hellos.length >= 3, `应至少重试到第 3 次 hello，实际 ${hub.hellos.length}`);
  } finally {
    process.exit = originalExit;
    client.close();
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("配置错误仍是致命：不可重试的 nack 触发 onFatal", async () => {
  const hub = await conflictHub({ conflicts: Number.MAX_SAFE_INTEGER, reason: "contract-major-mismatch", retryable: false });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-fatal-"));
  let fatal = null;
  const client = createTunnelClient({
    config: {
      ok: true,
      agentId: "agent-a",
      hubUrl: `ws://127.0.0.1:${hub.port}/tunnel`,
      agentToken: "agent-a-secret",
      contractVersion: "2.0",
    },
    card: CARD,
    targets: {},
    runner: RUNNER,
    stateDir,
    log: { info() {}, error() {} },
    onFatal(event) { fatal = event; },
  });
  try {
    await client.start();
    await waitFor(() => fatal !== null);
    assert.equal(fatal.code, "hello-nack");
    assert.equal(fatal.detail.reason, "contract-major-mismatch");
    assert.equal(client.registered, false);
    // 致命路径不重试：hello 只应发生一次
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(hub.hellos.length, 1);
  } finally {
    client.close();
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("单实例锁：第二个进程被拒并给出 pid", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-lock-"));
  try {
    const first = acquireInstanceLock({ stateDir, agentId: "agent-a", log: { error() {} } });
    assert.equal(first.ok, true);
    assert.equal(existsSync(first.file), true);

    // 同进程再取一次：pid 存活判定为"已有实例"，符合语义（同 pid 视为占用）
    const second = acquireInstanceLock({ stateDir, agentId: "agent-a", log: { error() {} } });
    assert.equal(second.ok, false);
    assert.match(second.reason, /已有实例在运行/);

    first.release();
    assert.equal(existsSync(first.file), false, "释放后锁文件应删除");

    const third = acquireInstanceLock({ stateDir, agentId: "agent-a", log: { error() {} } });
    assert.equal(third.ok, true);
    third.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("单实例锁：崩溃残留（死 pid）可被接管", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-lock-stale-"));
  try {
    const file = join(stateDir, "agent-agent-a.lock");
    // 用一个几乎不可能存在的 pid 模拟崩溃残留
    writeFileSync(file, JSON.stringify({ pid: 999_999, agentId: "agent-a", startedAt: new Date().toISOString() }));

    const lock = acquireInstanceLock({ stateDir, agentId: "agent-a", log: { error() {} } });
    assert.equal(lock.ok, true, "死 pid 的残留锁应被接管");
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(written.pid, process.pid);
    lock.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("单实例锁：不同 agentId 各持一把锁", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-lock-multi-"));
  try {
    const a = acquireInstanceLock({ stateDir, agentId: "agent-a", log: { error() {} } });
    const b = acquireInstanceLock({ stateDir, agentId: "agent-b", log: { error() {} } });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true, "不同身份不冲突");
    a.release();
    b.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
