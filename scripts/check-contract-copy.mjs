/**
 * 契约自检（agent 仓版 / 锁定拷贝持有方）：
 * 契约 SSOT 在 hub 仓（docs/architecture/schemas/ + src/frames.mjs），
 * 本仓 src/contract/ 是锁定拷贝本体（升级 = 从 hub 仓拷贝后提交）。
 *
 * 门禁口径（需求 6）：
 *   1. 拷贝自身完整可用：schema 集合按目录动态发现，$id 与文件名一致
 *   2. 行为自检：合法帧过、非法帧拒、帧层开放、信封层封闭
 *   3. 以当前 SSOT 为准：设置 NOVOARD_HUB_ROOT 时与当前 SSOT 逐字节/逐语义比对
 *      （不再固定历史提交；SSOT 不可达时明确报错，而非默认通过）
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 契约版本从单一来源取（需求 4）：本文件不再自行声明字面量。
export { CONTRACT_VERSION } from "../src/contract/version.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(ROOT, "src", "contract", "schemas");
const FRAMES = join(ROOT, "src", "contract", "frames.mjs");
const HUB_ROOT = process.env.NOVOARD_HUB_ROOT ? resolve(ROOT, process.env.NOVOARD_HUB_ROOT) : "";

/**
 * 契约版本来源见 ../src/contract/version.mjs（单一来源）。
 * 本文件通过上面的 import 取用，不再维护自己的字面量。
 */

let fail = 0;

/** 目录动态发现：新增 / 重命名 / 删除 schema 都会反映到这里。 */
const schemaFiles = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (schemaFiles.length === 0) {
  console.error(`✗ 契约 schema 目录为空：${SCHEMA_DIR}`);
  fail++;
}

// 1. 拷贝自身完整性
for (const file of schemaFiles) {
  let schema;
  try {
    schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8"));
  } catch (err) {
    console.error(`✗ schema 非法 JSON：${file}（${err.message}）`);
    fail++;
    continue;
  }
  const expected = `novoard/${file}`;
  if (schema.$id !== expected) {
    console.error(`✗ schema $id 与文件名不一致：${file} 期望 ${expected}，实际 ${schema.$id}`);
    fail++;
  }
}
if (!existsSync(FRAMES)) {
  console.error("✗ src/contract/frames.mjs 缺失");
  fail++;
}

// 2. 与当前 SSOT 比对（需求 6：不再固定历史提交）
if (HUB_ROOT) {
  const hubSchemaDir = join(HUB_ROOT, "docs", "architecture", "schemas");
  const hubContracts = join(HUB_ROOT, "docs", "architecture", "contracts.md");
  const hubFrames = join(HUB_ROOT, "src", "frames.mjs");

  // SSOT 可达性：不可达必须报错，不能静默跳过
  if (!existsSync(hubSchemaDir)) {
    console.error(`✗ Hub SSOT 不可达：${hubSchemaDir}（NOVOARD_HUB_ROOT=${HUB_ROOT}）`);
    fail++;
  } else {
    const hubFiles = readdirSync(hubSchemaDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    // 双向差集：任一侧独有的文件都算未同步
    for (const file of hubFiles) {
      if (!schemaFiles.includes(file)) {
        console.error(`✗ 本仓缺少 schema：${file}（Hub SSOT 已新增，本仓未同步）`);
        fail++;
      }
    }
    for (const file of schemaFiles) {
      if (!hubFiles.includes(file)) {
        console.error(`✗ 本仓存在多余 schema：${file}（Hub SSOT 已删除或重命名，本仓未同步）`);
        fail++;
      }
    }
    for (const file of hubFiles) {
      if (!schemaFiles.includes(file)) continue;
      const hubText = readFileSync(join(hubSchemaDir, file), "utf8");
      const localText = readFileSync(join(SCHEMA_DIR, file), "utf8");
      if (hubText !== localText) {
        console.error(`✗ 契约 schema 漂移：${file}（本仓拷贝与 Hub SSOT 不一致）`);
        fail++;
      }
    }
  }

  if (!existsSync(hubContracts)) {
    console.error(`✗ Hub 契约文档不可达：${hubContracts}`);
    fail++;
  } else if (!readFileSync(hubContracts, "utf8").includes(`版本：v${CONTRACT_VERSION}`)) {
    console.error(`✗ Hub SSOT 版本与本仓 ${CONTRACT_VERSION} 不一致`);
    fail++;
  }

  if (!existsSync(hubFrames)) {
    console.error(`✗ Hub 校验器不可达：${hubFrames}`);
    fail++;
  } else {
    const localNorm = normalizeFrames(readFileSync(FRAMES, "utf8"));
    const hubNorm = normalizeFrames(readFileSync(hubFrames, "utf8"));
    if (localNorm !== hubNorm) {
      console.error("✗ frames.mjs 语义漂移：本仓校验器与 Hub SSOT 不一致");
      fail++;
    }
  }
}

// 3. 行为自检
if (fail === 0) {
  const { createFrameValidator } = await import(pathToFileURL(FRAMES).href);
  const validate = createFrameValidator();
  const now = new Date().toISOString();

  // 目录发现完整性：磁盘上每个 schema 都应已注册
  const registered = new Set(validate.schemaIds());
  for (const file of schemaFiles) {
    if (!registered.has(`novoard/${file}`)) {
      console.error(`✗ schema 未被注册：${file}（校验器未纳入该文件）`);
      fail++;
    }
  }

  const good = { v: 1, kind: "ops", msgId: "e-gate-1", ts: now, body: { type: "agent.ping", ts: now } };
  const badBody = { v: 1, kind: "ops", msgId: "e-gate-2", ts: now, body: { type: "agent.ping", agentId: "" } };
  const badEnvelope = { v: 1, kind: "ops", msgId: "e-gate-3", body: { type: "agent.ping", ts: now } };
  const hello = {
    type: "agent.hello",
    contractVersion: "2.1",
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
  };

  if (!validate.envelope(good).ok || !validate.opsBody("agent.ping", good.body).ok) {
    console.error("✗ 合法样例帧被拒：校验器行为异常");
    fail++;
  }
  if (validate.opsBody("agent.ping", badBody.body).ok || validate.envelope(badEnvelope).ok) {
    console.error("✗ 非法样例帧被放行：校验器行为异常");
    fail++;
  }

  // 契约 §0 字段演进策略：帧 body 层未知字段被忽略，信封层未知字段仍被拒
  if (!validate.opsBody("agent.hello", hello).ok) {
    console.error("✗ 合法 hello 帧被拒：校验器行为异常");
    fail++;
  }
  if (!validate.opsBody("agent.hello", { ...hello, "x-future-field": "v" }).ok) {
    console.error("✗ 帧层未知字段被拒：与契约 §0 开放演进策略不一致");
    fail++;
  }
  if (validate.envelope({ ...good, "x-future-field": "v" }).ok) {
    console.error("✗ 信封层未知字段被放行：信封应保持封闭");
    fail++;
  }
}

if (fail > 0) {
  console.error(`\n契约自检失败（${fail} 处）。契约 SSOT 在 hub 仓；同步方法见本文件头注释。`);
  process.exit(1);
}
console.log(
  `✓ 契约拷贝完整可用（${schemaFiles.length} schemas 目录发现 + 校验器行为自检${HUB_ROOT ? " + 当前 Hub SSOT 比对" : ""}），契约版本 ${CONTRACT_VERSION}`,
);

/** 归一化校验器源码：去注释、抹平两侧路径锚定差异，仅比对语义。 */
function normalizeFrames(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/return join\(here,[^;]*;\s*\}/g, 'return "<schema-dir>"; }')
    .replace(/return join\(process\.cwd\(\),[^;]*;\s*\}/g, 'return "<schema-dir>"; }')
    .replace(/\s+/g, " ")
    .trim();
}
