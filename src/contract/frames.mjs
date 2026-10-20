/**
 * 信封与帧校验（契约 §3 §4，本目录 schemas/ 为锁定拷贝）。
 * 本文件是 agent 侧契约子系统的内建拷贝：hub 仓 docs/ 是 SSOT，拷贝纪律见
 * scripts/check-contract-copy.mjs（CI 门禁：SSOT 变更未同步拷贝即红）。
 * ajv 以 draft 2020-12 入口加载本目录 schemas/ 全部 schema：
 * 目录动态发现 → 按 $id 全量注册（$ref 跨文件解析依赖注册顺序，先注册后取编译器）→ 按 $id 取用。
 * 不维护手工文件清单：新增 schema 文件自动纳入校验（契约 §0「字段演进策略」）。
 * 说明：`format: "date-time"` 未接 ajv-formats（依赖面封顶三个），ts 按不透明字符串处理。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv/dist/2020.js";

/**
 * 契约类型（由 scripts/gen-contract-types.mjs 从 schema 生成）。
 * 这些 typedef 让 JS 侧在启用 checkJs 时也能校验契约字段：拼错字段名、类型不符会直接报错，
 * 不必等到运行时（需求 2.4 / 2.5）。
 * @typedef {import("./generated/contract-types.d.ts").A2aEnvelope} A2aEnvelope
 * @typedef {import("./generated/contract-types.d.ts").FrameAgentHello} FrameAgentHello
 * @typedef {import("./generated/contract-types.d.ts").FrameAgentHelloAck} FrameAgentHelloAck
 * @typedef {import("./generated/contract-types.d.ts").FrameAgentHelloNack} FrameAgentHelloNack
 * @typedef {import("./generated/contract-types.d.ts").FrameAgentPing} FrameAgentPing
 * @typedef {import("./generated/contract-types.d.ts").FrameTelemetry} FrameTelemetry
 * @typedef {import("./generated/contract-types.d.ts").FrameCardUpdate} FrameCardUpdate
 * @typedef {import("./generated/contract-types.d.ts").FrameReject} FrameReject
 * @typedef {import("./generated/contract-types.d.ts").AgentCard} AgentCard
 * @typedef {import("./generated/contract-types.d.ts").Task} Task
 * @typedef {import("./generated/contract-types.d.ts").AuditEvent} AuditEvent
 * @typedef {import("./generated/contract-types.d.ts").Target} Target
 */

const SCHEMA_DIR = schemaDirFromModuleUrl();

/**
 * 模块相对路径锚定：本目录 schemas/（锁定拷贝本体）。
 * （CJS bundle 中 import.meta 为空对象——esbuild 警告口径；frames 仅在无内嵌 schema 时才触达读盘路径）
 */
function schemaDirFromModuleUrl() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "schemas");
  } catch {
    return join(process.cwd(), "src", "contract", "schemas");
  }
}

/**
 * SEA 二进制形态（M6 F2）：docs/ 不进 bundle，schema 由构建期嵌入
 * （build/embedded-schemas.gen.mjs，sea-entry 注入 globalThis）。
 * 校验逻辑与 dev 完全同一条路——仅数据源从读盘换成内嵌对象，编译与判据零差异。
 * 惰性求值：sea-entry 与 frames 的模块求值顺序不确定（bundle 依赖图排布），调用时读 globalThis 才稳。
 */
const embeddedSchemas = () => globalThis.__NOVOARD_EMBEDDED_SCHEMAS__ ?? null;

/**
 * 便捷入口对应的 schema $id。
 * 这是取用别名，不是文件清单——完整性由目录发现保证，新增 schema 无需改这里。
 */
const SCHEMA_IDS = {
  envelope: "novoard/a2a-envelope.json",
  agentHello: "novoard/frame-agent-hello.json",
  agentHelloAck: "novoard/frame-agent-hello-ack.json",
  agentHelloNack: "novoard/frame-agent-hello-nack.json",
  agentPing: "novoard/frame-agent-ping.json",
  telemetry: "novoard/frame-telemetry.json",
  cardUpdate: "novoard/frame-card-update.json",
  frameReject: "novoard/frame-reject.json",
  agentCard: "novoard/agent-card.json",
  task: "novoard/task.json",
  auditEvent: "novoard/audit-event.json",
  target: "novoard/target.json",
};

/** ops 帧 type → 便捷入口键（新增 ops 帧时在此登记分派）。 */
const OPS_TYPE_KEY = {
  "agent.hello": "agentHello",
  "agent.hello.ack": "agentHelloAck",
  "agent.hello.nack": "agentHelloNack",
  "agent.ping": "agentPing",
  telemetry: "telemetry",
  "card.update": "cardUpdate",
  "frame.reject": "frameReject",
};

export function createFrameValidator({ schemaDir = SCHEMA_DIR, schemas = embeddedSchemas() } = {}) {
  const ajv = new Ajv({ allErrors: true, strict: false });

  // 目录动态发现：枚举全部 schema 文件并按 $id 注册。
  // 新增或重命名 schema 时不再需要改本文件——这是消除手工清单的落点（需求 6）。
  const discovered = schemas
    ? Object.keys(schemas).sort().map((file) => [file, schemas[file]])
    : readdirSync(schemaDir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => [file, JSON.parse(readFileSync(join(schemaDir, file), "utf8"))]);

  const registeredIds = [];
  for (const [file, schema] of discovered) {
    const id = schema.$id ?? `novoard/${file}`;
    ajv.addSchema(schema, id);
    registeredIds.push(id);
  }

  const compiled = {};
  for (const [key, id] of Object.entries(SCHEMA_IDS)) {
    compiled[key] = ajv.getSchema(id);
  }

  return {
    /** 已注册的 schema $id（门禁与自检用：确认目录内文件全部纳入）。 */
    schemaIds() {
      return [...registeredIds].sort();
    },
    /** 校验隧道信封（v/kind/msgId + kind 条件约束）。 */
    envelope(frame) {
      return result(compiled.envelope, frame);
    },
    /** 校验 ops 帧 body（按 type 分派）。 */
    opsBody(type, body) {
      const key = OPS_TYPE_KEY[type];
      if (!key) return { ok: false, errors: [`unknown ops type: ${type}`] };
      return result(compiled[key], body);
    },
    /** 校验 agent.hello.nack 回执（出站前自检 / 入站校验）。 */
    agentHelloNack(frame) {
      return result(compiled.agentHelloNack, frame);
    },
    /** 校验 Agent Card（单成员或聚合）。 */
    agentCard(card) {
      return result(compiled.agentCard, card);
    },
    /** 校验 A2A task 对象。 */
    task(taskObj) {
      return result(compiled.task, taskObj);
    },
    /** 校验审计事件行。 */
    auditEvent(event) {
      return result(compiled.auditEvent, event);
    },
    /** 校验 agent targets 定义（YAML 转 JSON 后，纪律一启动自检同款）。 */
    targets(data) {
      return result(compiled.target, data);
    },
  };
}

function result(validate, data) {
  if (!validate) return { ok: false, errors: ["schema 未加载"] };
  const pass = validate(data);
  if (!pass) {
    return { ok: false, errors: validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`) };
  }
  return { ok: true, errors: [] };
}
