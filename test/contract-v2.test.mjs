import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTunnelClient } from "../src/tunnel-client.mjs";
import { createMockHub } from "./lib/mock-hub.mjs";

const CARD = {
  name: "agent-a",
  description: "agent-a",
  version: "2.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text", "file"],
  skills: [{ id: "skill-a", name: "skill-a", description: "skill-a", tags: [] }],
};

const TARGETS = {
  "skill-a": {
    vars: {},
    expanded: [{ script: "echo ok" }],
  },
};

const RUNNER = {
  launch() { return { ok: true }; },
  cancel() { return { ok: true }; },
  resume() { return { ok: true }; },
};

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

test("契约 2.0：Bearer 身份绑定 agentId，hello 不再携带 token", async () => {
  const hub = await createMockHub({
    tokens: {
      "agent-a": "agent-a-secret",
      "agent-b": "agent-b-secret",
    },
  });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-v2-identity-"));
  const port = hub.server.address().port;
  let fatal = null;
  const client = createTunnelClient({
    config: {
      ok: true,
      agentId: "agent-b",
      hubUrl: `ws://127.0.0.1:${port}/tunnel`,
      agentToken: "agent-a-secret",
      contractVersion: "2.0",
    },
    card: { ...CARD, name: "agent-b" },
    targets: TARGETS,
    runner: RUNNER,
    stateDir,
    log: { info() {}, error() {} },
    onFatal(event) { fatal = event; },
  });
  try {
    await client.start();
    await waitFor(() => fatal?.detail?.reason === "agent-identity-mismatch");
    assert.equal(hub.members.has("agent-b"), false);
    const hello = hub.frames.find((frame) => frame.body?.type === "agent.hello");
    assert.equal(hello.body.agentId, "agent-b");
    assert.equal("token" in hello.body, false);
  } finally {
    client.close();
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("契约 2.0：hello 与重连会上报 runner 中的挂起任务", async () => {
  const hub = await createMockHub({ tokens: { "agent-a": "agent-a-secret" } });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-v2-inflight-"));
  const port = hub.server.address().port;
  const runner = {
    ...RUNNER,
    get runningTasks() {
      return [{ id: "task-input-required-1", state: "input-required" }];
    },
  };
  const client = createTunnelClient({
    config: {
      ok: true,
      agentId: "agent-a",
      hubUrl: `ws://127.0.0.1:${port}/tunnel`,
      agentToken: "agent-a-secret",
      contractVersion: "2.0",
    },
    card: CARD,
    targets: TARGETS,
    runner,
    stateDir,
    log: { info() {}, error() {} },
  });
  try {
    await client.start();
    await waitFor(() => client.registered);
    let helloFrames = hub.frames.filter((frame) => frame.body?.type === "agent.hello");
    assert.deepEqual(helloFrames[0].body.inFlightTaskIds, ["task-input-required-1"]);

    hub.members.get("agent-a").ws.close();
    await waitFor(() =>
      hub.frames.filter((frame) => frame.body?.type === "agent.hello").length >= 2,
    4_000);
    helloFrames = hub.frames.filter((frame) => frame.body?.type === "agent.hello");
    assert.deepEqual(helloFrames.at(-1).body.inFlightTaskIds, ["task-input-required-1"]);
  } finally {
    client.close();
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("契约 2.0：agent 上传 artifact 自动携带 taskId、base64 内容与 sha256", async () => {
  const hub = await createMockHub({ tokens: { "agent-a": "agent-a-secret" } });
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-agent-v2-artifact-"));
  const port = hub.server.address().port;
  const client = createTunnelClient({
    config: {
      ok: true,
      agentId: "agent-a",
      hubUrl: `ws://127.0.0.1:${port}/tunnel`,
      agentToken: "agent-a-secret",
      contractVersion: "2.0",
    },
    card: CARD,
    targets: TARGETS,
    runner: RUNNER,
    stateDir,
    log: { info() {}, error() {} },
  });
  try {
    await client.start();
    await waitFor(() => client.registered);
    const taskId = "task-mock-artifact-1";
    assert.equal(hub.delegateTo("agent-a", { taskId, target: "skill-a" }).ok, true);

    const result = await client.uploadArtifact(taskId, {
      name: "result.txt",
      content: "hello artifact",
    });
    assert.equal(result.artifact.metadata.taskId, taskId);
    assert.equal(result.artifact.metadata.member, "agent-a");
    assert.equal(hub.artifacts.length, 1);
    assert.equal(Buffer.from(hub.artifacts[0].content, "base64").toString(), "hello artifact");
    assert.equal(
      hub.artifacts[0].digest,
      `sha256:${createHash("sha256").update("hello artifact").digest("hex")}`,
    );

    hub.tasks.set("task-mock-foreign", {
      state: "working",
      target: "skill-b",
      member: "agent-b",
      events: [],
    });
    await assert.rejects(
      client.uploadArtifact("task-mock-foreign", { name: "forged.txt", content: "forged" }),
      /artifact 上传失败：404/,
    );
  } finally {
    client.close();
    await hub.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
