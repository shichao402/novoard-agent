/**
 * 契约自检（agent 仓版）：
 * 契约 SSOT 在 hub 仓（docs/architecture/schemas/ + src/frames.mjs），
 * 本仓 src/contract/ 是锁定拷贝本体（升级 = 从 hub 仓拷贝后提交，版本记录在 CONTRACT_VERSION）。
 * 本门禁校验拷贝自身完整可用；CI 还会通过 NOVOARD_HUB_ROOT 指向固定 Hub revision，
 * 逐字比较九张 schema，并对 frames.mjs 做去除注释与路径锚差异后的语义比较。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(ROOT, "src", "contract", "schemas");
const HUB_ROOT = process.env.NOVOARD_HUB_ROOT
  ? resolve(ROOT, process.env.NOVOARD_HUB_ROOT)
  : "";

/** 锁定拷贝的契约版本（来源 hub 仓 contracts.md SSOT；升级时同步改这里） */
export const CONTRACT_VERSION = "v2.1";

const SCHEMA_FILES = ["a2a-envelope.json", "frame-agent-hello.json", "frame-agent-ping.json", "frame-telemetry.json", "frame-card-update.json", "agent-card.json", "task.json", "audit-event.json", "target.json"];

let fail = 0;

for (const file of SCHEMA_FILES) {
  if (!existsSync(join(SCHEMA_DIR, file))) {
    console.error(`✗ 契约 schema 缺失：src/contract/schemas/${file}`);
    fail++;
  }
}
if (!existsSync(join(ROOT, "src", "contract", "frames.mjs"))) {
  console.error("✗ src/contract/frames.mjs 缺失");
  fail++;
}

if (HUB_ROOT) {
  const hubSchemaDir = join(HUB_ROOT, "docs", "architecture", "schemas");
  for (const file of SCHEMA_FILES) {
    const localFile = join(SCHEMA_DIR, file);
    const hubFile = join(hubSchemaDir, file);
    if (!existsSync(hubFile)) {
      console.error(`✗ Hub SSOT schema 缺失：${hubFile}`);
      fail++;
      continue;
    }
    if (existsSync(localFile) && readFileSync(localFile, "utf8") !== readFileSync(hubFile, "utf8")) {
      console.error(`✗ 契约 schema 漂移：${file} 与固定 Hub SSOT 不一致`);
      fail++;
    }
  }

  const hubContracts = join(HUB_ROOT, "docs", "architecture", "contracts.md");
  const hubFrames = join(HUB_ROOT, "src", "frames.mjs");
  if (!existsSync(hubContracts) || !readFileSync(hubContracts, "utf8").includes(`版本：${CONTRACT_VERSION}`)) {
    console.error(`✗ Hub SSOT 版本与 Agent ${CONTRACT_VERSION} 不一致`);
    fail++;
  }
  if (!existsSync(hubFrames)) {
    console.error(`✗ Hub SSOT frames 缺失：${hubFrames}`);
    fail++;
  } else {
    const localFrames = normalizeFrames(readFileSync(join(ROOT, "src", "contract", "frames.mjs"), "utf8"));
    const sourceFrames = normalizeFrames(readFileSync(hubFrames, "utf8"));
    if (localFrames !== sourceFrames) {
      console.error("✗ frames.mjs 语义漂移：Agent 锁定拷贝与固定 Hub SSOT 不一致");
      fail++;
    }
  }
}

// 行为自检：加载校验器，合法帧过、非法帧拒（与浏览器同口径的正反向样例）
if (fail === 0) {
  const require = createRequire(import.meta.url);
  const { createFrameValidator } = await import(pathToFileURL(join(ROOT, "src", "contract", "frames.mjs")).href);
  const validate = createFrameValidator();
  const good = { v: 1, kind: "ops", msgId: "e-gate-1", ts: new Date().toISOString(), body: { type: "agent.ping", ts: new Date().toISOString() } };
  const bad = { v: 1, kind: "ops", msgId: "e-gate-2", ts: new Date().toISOString(), body: { type: "agent.ping", agentId: "" } };
  const badEnvelope = { v: 1, kind: "ops", msgId: "e-gate-3", body: { type: "agent.ping", ts: new Date().toISOString() } };
  const hello = {
    type: "agent.hello",
    contractVersion: "2.0",
    agentId: "gate-agent",
    card: {
      name: "gate",
      description: "gate",
      version: "2.0.0",
      capabilities: { streaming: false, pushNotifications: true },
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      skills: [],
    },
    inFlightTaskIds: [],
  };
  if (!validate.envelope(good).ok || !validate.opsBody("agent.ping", good.body).ok) {
    console.error("✗ 合法样例帧被拒：校验器行为异常");
    fail++;
  }
  if (validate.opsBody("agent.ping", bad.body).ok || validate.envelope(badEnvelope).ok) {
    console.error("✗ 非法样例帧被放行：校验器行为异常");
    fail++;
  }
  if (!validate.opsBody("agent.hello", hello).ok || validate.opsBody("agent.hello", { ...hello, token: "legacy-token" }).ok) {
    console.error("✗ 契约 2.0 hello 身份字段行为异常");
    fail++;
  }
}

if (fail > 0) {
  console.error(`\n契约自检失败（${fail} 处）。契约 SSOT 在 hub 仓；升级方法见本文件头注释。`);
  process.exit(1);
}
console.log(`✓ 契约拷贝完整可用（${SCHEMA_FILES.length} schemas + frames 行为自检${HUB_ROOT ? " + 固定 Hub SSOT 对比" : ""}），锁定版本 ${CONTRACT_VERSION}`);

function normalizeFrames(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/return join\(here,[^;]*"schemas"\);/g, 'return "<schema-dir>";')
    .replace(/return join\(process\.cwd\(\),[^;]*"schemas"\);/g, 'return "<schema-dir>";')
    .replace(/\s+/g, " ")
    .trim();
}
