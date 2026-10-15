/**
 * 契约自检（agent 仓版）：
 * 契约 SSOT 在 hub 仓（docs/architecture/schemas/ + src/frames.mjs），
 * 本仓 src/contract/ 是锁定拷贝本体（升级 = 从 hub 仓拷贝后提交，版本记录在 CONTRACT_VERSION）。
 * 本门禁只校验拷贝自身完整可用：九张 schema 齐全 + frames 可加载 + 校验样例帧行为正确。
 * 跨仓漂移防线：hub 仓 CI 的 check-contract-copy.mjs 对称校验其内建拷贝；
 * 两仓通过 CONTRACT_VERSION（下方常量 + package.json description 注记）对齐版本。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(ROOT, "src", "contract", "schemas");

/** 锁定拷贝的契约版本（来源 hub 仓 contracts.md SSOT；升级时同步改这里） */
export const CONTRACT_VERSION = "v1.1";

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

// 行为自检：加载校验器，合法帧过、非法帧拒（与浏览器同口径的正反向样例）
if (fail === 0) {
  const require = createRequire(import.meta.url);
  const { createFrameValidator } = await import(pathToFileURL(join(ROOT, "src", "contract", "frames.mjs")).href);
  const validate = createFrameValidator();
  const good = { v: 1, kind: "ops", msgId: "e-gate-1", ts: new Date().toISOString(), body: { type: "agent.ping", ts: new Date().toISOString() } };
  const bad = { v: 1, kind: "ops", msgId: "e-gate-2", ts: new Date().toISOString(), body: { type: "agent.ping", agentId: "" } };
  const badEnvelope = { v: 1, kind: "ops", msgId: "e-gate-3", body: { type: "agent.ping", ts: new Date().toISOString() } };
  if (!validate.envelope(good).ok || !validate.opsBody("agent.ping", good.body).ok) {
    console.error("✗ 合法样例帧被拒：校验器行为异常");
    fail++;
  }
  if (validate.opsBody("agent.ping", bad.body).ok || validate.envelope(badEnvelope).ok) {
    console.error("✗ 非法样例帧被放行：校验器行为异常");
    fail++;
  }
}

if (fail > 0) {
  console.error(`\n契约自检失败（${fail} 处）。契约 SSOT 在 hub 仓；升级方法见本文件头注释。`);
  process.exit(1);
}
console.log(`✓ 契约拷贝完整可用（${SCHEMA_FILES.length} schemas + frames 行为自检），锁定版本 ${CONTRACT_VERSION}`);
