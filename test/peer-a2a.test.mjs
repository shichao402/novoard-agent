/**
 * 成员之间的 A2A：Card 是自我介绍，Hub 转发自然语言，完成和在场回到调用方。
 * Target 精确调用仍走原来的 run 文本。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveCard, validateTargetsData } from "../src/card.mjs";
import { createPeerTalk } from "../src/peer-talk.mjs";
import { createTunnelClient } from "../src/tunnel-client.mjs";
import { createFrameValidator } from "../src/contract/frames.mjs";
import { createMockHub } from "./lib/mock-hub.mjs";

const OFFICE = {
  role: "office-pc",
  introduction: "我是主人的办公电脑管理 agent，负责本机工程环境。",
};

function officeTargets(title = "准备游戏工程") {
  return {
    "prepare-project": {
      title,
      expose: "a2a",
      schedule: "0 4 * * *",
      audit: "summary",
      requiresApproval: false,
      notify: "on-failure",
      steps: [{ script: "echo prepare" }],
      expanded: [{ script: "echo prepare" }],
    },
    "local-note": {
      title: "仅本机备忘",
      expose: "local",
      audit: "none",
      requiresApproval: false,
      notify: "never",
      steps: [{ script: "echo local" }],
      expanded: [{ script: "echo local" }],
    },
  };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timeout");
}

test("Card 介绍角色和能力，local Target 不进入，converse 不能被占用", () => {
  const card = deriveCard({ agentId: "pc-a", profile: OFFICE, targets: officeTargets() });
  const validate = createFrameValidator();
  assert.equal(validate.agentCard(card).ok, true, validate.agentCard(card).errors?.join("; "));
  assert.equal(card.description, OFFICE.introduction);
  const converse = card.skills.find((skill) => skill.id === "converse");
  assert.ok(converse);
  assert.ok(converse.tags.includes("kind:agent"));
  assert.ok(converse.tags.includes("role:office-pc"));
  assert.equal(converse["x-novoard-kind"], "agent");
  assert.equal(card["x-novoard-role"], "office-pc");
  const prepare = card.skills.find((skill) => skill.id === "prepare-project");
  assert.match(prepare.description, /准备游戏工程/);
  assert.match(prepare.description, /安排：0 4 \* \* \*/);
  assert.equal(card.skills.some((skill) => skill.id === "local-note"), false);

  const rejected = validateTargetsData({
    targets: {
      converse: {
        title: "占位",
        expose: "a2a",
        audit: "summary",
        requiresApproval: false,
        notify: "never",
        steps: [{ script: "echo no" }],
      },
    },
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /converse/);
});

test("两台办公电脑回应智脑，并在完成后和主人在场时回报；Target 通道不走对话", async () => {
  const hub = await createMockHub({
    tokens: { "pc-a": "token-a", "pc-b": "token-b" },
  });
  const port = hub.server.address().port;
  const dirs = [];
  const clients = [];
  const launches = [];

  function boot(agentId, token) {
    const stateDir = mkdtempSync(join(tmpdir(), `novoard-peer-${agentId}-`));
    dirs.push(stateDir);
    const targets = officeTargets(agentId === "pc-a" ? "准备游戏工程" : "同步分支工程");
    const card = deriveCard({ agentId, profile: OFFICE, targets });
    let peer;
    const client = createTunnelClient({
      config: {
        ok: true,
        agentId,
        hubUrl: `ws://127.0.0.1:${port}/tunnel`,
        agentToken: token,
        contractVersion: "2.0",
      },
      card,
      targets,
      runner: {
        launch(input) {
          launches.push({ agentId, ...input });
          return { ok: true };
        },
        cancel() { return { ok: true }; },
        resume() { return { ok: true }; },
      },
      stateDir,
      log: { info() {}, error() {} },
      onAgentMessage: (message) => peer.receive(message),
    });
    peer = createPeerTalk({
      agentId,
      profile: OFFICE,
      targets,
      tunnel: client,
      stateDir: join(stateDir, "peers"),
      log: { info() {}, warn() {}, error() {} },
    });
    clients.push({ client, peer, agentId });
    return client.start();
  }

  try {
    await boot("pc-a", "token-a");
    await boot("pc-b", "token-b");
    await waitFor(() => hub.members.size === 2);

    const listed = await fetch(`http://127.0.0.1:${port}/api/cards`, {
      headers: { Authorization: "Bearer token-a" },
    });
    assert.equal(listed.status, 200);
    const body = await listed.json();
    const offices = body.cards.filter((item) => item.card.skills.some((skill) => skill.tags?.includes("role:office-pc")));
    assert.deepEqual(offices.map((item) => item.agentId).sort(), ["pc-a", "pc-b"]);

    assert.equal(hub.ask("pc-a", { from: "cloud-brain", text: "发布前要集中处理 bug，你们能准备对应工程吗？", taskId: "task-mock-ask-a" }).ok, true);
    assert.equal(hub.ask("pc-b", { from: "cloud-brain", text: "你们有这些能力吗？", taskId: "task-mock-ask-b" }).ok, true);
    await waitFor(() => hub.relays.length >= 2);
    assert.equal(launches.length, 0);
    const replies = hub.relays.map((item) => item.body.params.message.parts[0].text).join("\n");
    assert.match(replies, /准备游戏工程/);
    assert.match(replies, /同步分支工程/);
    assert.equal(hub.relays.every((item) => item.to === "cloud-brain"), true);

    const pc = clients.find((item) => item.agentId === "pc-a");
    assert.equal(pc.peer.report({
      text: "工程已准备好",
      parts: [
        { kind: "data", data: { ready: true } },
        { kind: "file", uri: "/api/artifacts/art-1" },
      ],
    }).ok, true);
    assert.equal(pc.peer.presence("主人已到工位").ok, true);
    await waitFor(() => hub.relays.length >= 4);
    const follow = hub.relays.slice(2).map((item) => item.body.params.message.status.message).join("\n");
    assert.match(follow, /完成报告：工程已准备好/);
    const report = hub.relays.find((item) => item.body.params.message.status.message?.includes("完成报告"));
    assert.equal(report.body.params.message.parts.some((part) => part.kind === "data" && part.data.ready === true), true);
    assert.equal(report.body.params.message.parts.some((part) => part.kind === "file" && part.uri === "/api/artifacts/art-1"), true);
    assert.match(follow, /在场：主人已到工位/);
    assert.ok(pc.peer.list().some((session) => session.title === "cloud-brain"));

    assert.equal(hub.delegateTo("pc-a", { taskId: "task-mock-run-1", target: "prepare-project" }).ok, true);
    await waitFor(() => launches.length === 1);
    assert.equal(launches[0].skillId, "prepare-project");
    assert.equal(launches[0].agentId, "pc-a");

    assert.equal(pc.client.notifyOwner("已联系到办公电脑，工程会准备好。").ok, true);
    await waitFor(() => hub.wecom.length === 1);
    assert.match(hub.wecom[0].text, /工程会准备好/);
  } finally {
    for (const item of clients) item.client.close();
    await hub.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test("本机发出的话和对方的回复记在同一个会话", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-peer-ask-"));
  const sent = [];
  const peer = createPeerTalk({
    stateDir,
    log: { info() {}, warn() {}, error() {} },
    tunnel: {
      askMember(message) {
        sent.push(message);
        return { ok: true, taskId: "task-ask-1" };
      },
      replyToCaller() { return { ok: true }; },
    },
  });
  try {
    const asked = peer.ask({ to: "win-9070", text: "你们能准备工程吗？" });
    assert.equal(asked.ok, true);
    assert.equal(sent[0].to, "win-9070");
    assert.equal(sent[0].metadata, undefined);
    peer.note({ from: "win-9070", text: "可以。我能部署 Dev 版本。", taskId: "task-hub-1", contextId: "task-hub-1", state: "completed" });
    const messages = peer.history("peer-win-9070").messages.map((item) => item.text);
    assert.deepEqual(messages, ["你们能准备工程吗？", "可以。我能部署 Dev 版本。"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("缺信息时停在 input-required，下一条消息续上同一会话", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "novoard-peer-turn-"));
  const sent = [];
  const peer = createPeerTalk({
    stateDir,
    log: { info() {}, warn() {}, error() {} },
    tunnel: {
      replyToCaller(message) {
        sent.push(message);
        return { ok: true };
      },
    },
    replyWith({ text }) {
      if (String(text).includes("develop")) return "可以。我来准备 develop。";
      peer.holdForDetail();
      return "要准备哪个分支？";
    },
  });
  try {
    const first = await peer.receive({
      from: "cloud-brain",
      taskId: "task-1",
      contextId: "ctx-1",
      text: "你们能准备工程吗？",
    });
    assert.equal(first.state, "input-required");
    assert.equal(sent[0].state, "input-required");
    assert.equal(sent[0].contextId, "ctx-1");
    const second = await peer.receive({
      from: "cloud-brain",
      taskId: "task-1",
      contextId: "ctx-1",
      text: "develop 分支",
    });
    assert.equal(second.state, "completed");
    assert.equal(sent[1].text, "可以。我来准备 develop。");
    assert.equal(peer.list().length, 1);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
