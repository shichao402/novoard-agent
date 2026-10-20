/**
 * 历史契约版本的提示日志（契约 §0，需求 8.4）。
 *
 * 升级只换二进制不重装的环境里，agent.json 会留着旧的 contractVersion。
 * 该值不参与握手（版本来自代码常量），但用户看不到任何提示时，
 * 会以为改配置文件能把契约对齐——所以必须在启动时明确说一句它已被取代。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLiteAgent } from "../src/main.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";
import { createMockHub } from "./lib/mock-hub.mjs";

function targetsYaml() {
  return [
    "targets:",
    "  smoke:",
    "    title: 冒烟",
    "    steps:",
    "      - script: echo hi",
    "    expose: a2a",
    "    audit: summary",
    "    requiresApproval: false",
    "    notify: never",
    "",
  ].join("\n");
}

test("启动时提示 agent.json 中的历史契约版本已被取代", async () => {
  const hub = await createMockHub({ tokens: { "agent-a": "token-a" } });
  const dir = mkdtempSync(join(tmpdir(), "novoard-stale-contract-"));
  const agentDir = join(dir, "agent");
  const stateDir = join(dir, "state");
  const logs = [];
  let agent;
  try {
    // 造一个最小 agent 目录：targets.yaml + 带历史 contractVersion 的 agent.json
    const { mkdirSync } = await import("node:fs");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "targets.yaml"), targetsYaml(), "utf8");
    const configPath = join(dir, "agent.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        agentId: "agent-a",
        hubUrl: `ws://127.0.0.1:${hub.server.address().port}/tunnel`,
        agentToken: "token-a",
        contractVersion: "1.9",
      }),
      "utf8",
    );

    agent = await createLiteAgent({
      configPath,
      agentDir,
      stateDir,
      log: {
        info(message) { logs.push(String(message)); },
        error(message) { logs.push(`ERR ${message}`); },
        warn(message) { logs.push(`WARN ${message}`); },
      },
    });

    const notice = logs.find((l) => l.includes("1.9") && l.includes("已被忽略"));
    assert.ok(notice, `应提示历史版本号被取代：${JSON.stringify(logs.slice(0, 8))}`);
    assert.ok(notice.includes(CONTRACT_VERSION), `提示应给出当前契约版本：${notice}`);
  } finally {
    try { await agent?.stop?.(); } catch { /* 已停止 */ }
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
