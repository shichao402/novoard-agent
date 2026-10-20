/**
 * 装配层验证：同一数据目录起两次 createLiteAgent，第二个必须被单实例锁拦住。
 * 只走配置装载与锁，不连 hub（避免依赖网络），因此用不可达地址也能验证到锁这一层。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLiteAgent } from "../src/main.mjs";

const CARD_TARGETS = `targets:
  smoke-test:
    title: 冒烟
    steps:
      - script: echo ok
    expose: a2a
    audit: summary
    requiresApproval: false
    notify: on-failure
`;

test("装配层：同一数据目录第二个实例被单实例锁拦住", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-agent-single-"));
  const stateDir = join(dir, ".agent-state");
  const agentDir = join(dir, "agents", "mac-work");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "targets.yaml"), CARD_TARGETS);
  const configPath = join(dir, "agent.json");
  writeFileSync(configPath, JSON.stringify({
    agentId: "mac-work",
    hubUrl: "ws://127.0.0.1:1/tunnel",
    agentToken: "single-instance-token",
    contractVersion: "2.1",
    localPort: 0,
  }));

  let first = null;
  try {
    first = await createLiteAgent({ configPath, agentDir, stateDir, log: { info() {}, error() {} } });
    // 第二个进程（同 stateDir 同 agentId）：应当在连 hub 之前就被拦住
    await assert.rejects(
      () => createLiteAgent({ configPath, agentDir, stateDir, log: { info() {}, error() {} } }),
      /已有实例在运行/,
    );
  } finally {
    if (first) await first.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("装配层：第一个实例 stop 之后可以再启动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-agent-single-restart-"));
  const stateDir = join(dir, ".agent-state");
  const agentDir = join(dir, "agents", "mac-work");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "targets.yaml"), CARD_TARGETS);
  const configPath = join(dir, "agent.json");
  writeFileSync(configPath, JSON.stringify({
    agentId: "mac-work",
    hubUrl: "ws://127.0.0.1:1/tunnel",
    agentToken: "single-instance-token",
    contractVersion: "2.1",
    localPort: 0,
  }));

  try {
    const first = await createLiteAgent({ configPath, agentDir, stateDir, log: { info() {}, error() {} } });
    await first.stop();
    const second = await createLiteAgent({ configPath, agentDir, stateDir, log: { info() {}, error() {} } });
    await second.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
