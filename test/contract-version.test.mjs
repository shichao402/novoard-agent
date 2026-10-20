/**
 * 契约版本单一来源测试（契约 §0，需求 4）：
 * - 运行时版本来自契约常量，配置文件里的历史值不参与握手
 * - 历史版本号被忽略并可通过 staleContractVersion 观察，且不回写文件
 * - 版本号格式统一为不带 v 前缀
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentConfig } from "../src/config.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";

function withConfig(data) {
  const dir = mkdtempSync(join(tmpdir(), "novoard-config-version-"));
  const file = join(dir, "agent.json");
  writeFileSync(file, JSON.stringify(data), "utf8");
  return { dir, file };
}

const BASE = {
  agentId: "agent-a",
  hubUrl: "ws://127.0.0.1:1/tunnel",
  agentToken: "token-a",
};

test("契约版本来自常量，格式不带 v 前缀", () => {
  assert.match(CONTRACT_VERSION, /^\d+\.\d+$/, `版本应为 X.Y 形式：${CONTRACT_VERSION}`);
});

test("agent.json 中的历史版本号被忽略，运行时取契约常量", () => {
  const { dir, file } = withConfig({ ...BASE, contractVersion: "1.9" });
  try {
    const config = loadAgentConfig({ configPath: file, env: {} });
    assert.equal(config.ok, true, config.reason);
    assert.equal(config.contractVersion, CONTRACT_VERSION, "应使用契约常量而非配置文件值");
    assert.equal(config.version, CONTRACT_VERSION);
    assert.equal(config.staleContractVersion, "1.9", "历史值应可被观察，便于提示");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("历史版本号不回写配置文件，避免再次形成持久化来源", () => {
  const { dir, file } = withConfig({ ...BASE, contractVersion: "1.9" });
  try {
    const before = readFileSync(file, "utf8");
    loadAgentConfig({ configPath: file, env: {} });
    assert.equal(readFileSync(file, "utf8"), before, "读取配置不得改写文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("环境变量也不能覆盖契约版本", () => {
  const { dir, file } = withConfig(BASE);
  try {
    const config = loadAgentConfig({ configPath: file, env: { NOVOARD_CONTRACT_VERSION: "0.1" } });
    assert.equal(config.ok, true, config.reason);
    assert.equal(config.contractVersion, CONTRACT_VERSION, "环境变量不应成为版本来源");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置中无版本号时正常加载，staleContractVersion 为空", () => {
  const { dir, file } = withConfig(BASE);
  try {
    const config = loadAgentConfig({ configPath: file, env: {} });
    assert.equal(config.ok, true, config.reason);
    assert.equal(config.contractVersion, CONTRACT_VERSION);
    assert.equal(config.staleContractVersion, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
