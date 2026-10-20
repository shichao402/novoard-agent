/**
 * 契约演进策略测试（契约 §0 字段演进策略）：
 * - 帧 body 层开放：未知字段被接受且原值保留（次版本可加可选字段）
 * - 信封层封闭：未知字段仍被拒
 * - 数据 schema 封闭：agent-card / task / audit-event / target 的未知字段被拒
 * - schema 集合按目录动态发现，新增文件不会因手工清单漏项而逃过校验
 * - agent.hello.nack 受 schema 约束且携带字段级错误路径
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createFrameValidator } from "../src/contract/frames.mjs";

const SCHEMA_DIR = join(process.cwd(), "src", "contract", "schemas");
const validate = createFrameValidator();

const CARD = {
  name: "agent-a",
  description: "agent-a",
  version: "2.0.0",
  capabilities: { streaming: false, pushNotifications: true },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  skills: [],
};

const HELLO = { type: "agent.hello", contractVersion: "2.1", agentId: "agent-a", card: CARD };
const NOW = "2026-01-01T00:00:00.000Z";

test("帧 body 层：未知字段被接受，不因次版本新增可选字段而拒收", () => {
  const frames = [
    ["agent.hello", { ...HELLO, "x-future-optional": "v" }],
    ["agent.ping", { type: "agent.ping", ts: NOW, "x-future-optional": 1 }],
    ["telemetry", { type: "telemetry", ts: NOW, cpuPct: 1, memPct: 2, diskPct: 3, swapPct: 4 }],
    ["card.update", { type: "card.update", card: CARD, "x-future-optional": true }],
  ];
  for (const [type, frame] of frames) {
    const r = validate.opsBody(type, frame);
    assert.equal(r.ok, true, `${type} 应接受未知字段，实际被拒：${JSON.stringify(r.errors)}`);
  }
});

test("帧 body 层：未知字段原值保留，转发场景不丢失对端扩展信息", () => {
  const frame = { ...HELLO, "x-future-optional": { nested: ["keep", 1] } };
  validate.opsBody("agent.hello", frame);
  assert.deepEqual(frame["x-future-optional"], { nested: ["keep", 1] });
});

test("信封层：未知字段仍被拒绝，信封是传输层最小共同约定", () => {
  const env = { v: 1, kind: "ops", msgId: "e-x", ts: NOW, body: { type: "agent.ping", ts: NOW }, "x-env": "v" };
  const r = validate.envelope(env);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("additional properties")), `错误应指出额外属性：${r.errors}`);
});

test("数据 schema 保持封闭：未知字段被拒", () => {
  assert.equal(validate.agentCard({ ...CARD, "x-unknown": 1 }).ok, false, "agent-card 应封闭");
  assert.equal(validate.auditEvent({ ts: NOW, actor: "a", lane: "ops", target: "t", outcome: "completed", "x-unknown": 1 }).ok, false, "audit-event 应封闭");
  assert.equal(
    validate.targets({ targets: { t: { title: "x", steps: [{ script: "echo" }], expose: "a2a", audit: "summary", requiresApproval: false, notify: "never", "x-unknown": 1 } } }).ok,
    false,
    "target 应封闭",
  );
  assert.equal(validate.task({ id: "task-1", kind: "task", status: { state: "completed" }, "x-unknown": 1 }).ok, false, "task 应封闭");
});

test("agent.hello.nack：结构受约束，可携带字段级错误路径", () => {
  const nack = {
    type: "agent.hello.nack",
    reason: "contract-schema-mismatch",
    hubVersion: "2.1",
    agentVersion: "2.1",
    retryable: false,
    detail: ["/card/skills/0 must NOT have additional properties"],
  };
  assert.equal(validate.agentHelloNack(nack).ok, true, "合法 nack 应通过");
  assert.equal(validate.agentHelloNack({ ...nack, reason: "unknown-reason" }).ok, false, "未知 reason 应被拒");
  assert.equal(validate.agentHelloNack({ type: "agent.hello.nack", reason: "contract-major-mismatch" }).ok, false, "缺 hubVersion 应被拒");
});

test("schema 集合按目录动态发现：目录内每个 json 均已注册并可校验", () => {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json")).sort();
  assert.ok(files.includes("frame-agent-hello-nack.json"), "目录应包含 nack schema");

  // 目录里每个 schema 的 $id 必须与其文件名对应，避免注册表与磁盘脱节
  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8"));
    assert.equal(schema.$id, `novoard/${file}`, `${file} 的 $id 应与文件名一致`);
  }
});
