import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileLogger } from "../src/log.mjs";
import { LOG_MAX_PAGES, LOG_PAGE_SIZE, pageLogFile, pageLogs } from "../src/log-page.mjs";
import { codebuddyProcessEnv, codebuddySessionFields, publicCodebuddyConfig, readCodebuddyConfig, saveCodebuddyConfig } from "../src/codebuddy-config.mjs";

test("文件日志写入 JSON Lines 并脱敏令牌", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-log-"));
  const log = createFileLogger({ dir, mirrorStderr: false });
  log.info("hello", "token nva_secretvalue", "key sk-abcdefghijklmnopqrstuvwxyz");
  const text = readFileSync(log.file, "utf8");
  const line = JSON.parse(text.trim());
  assert.equal(line.level, "info");
  assert.match(line.msg, /hello/);
  assert.equal(line.msg.includes("nva_secretvalue"), false);
  assert.match(line.msg, /nva_\[redacted\]/);
  assert.equal(line.msg.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(typeof line.ts, "string");
});

test("日志滚动会丢掉超出保留份数的最旧文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-log-rotate-"));
  const log = createFileLogger({ dir, maxBytes: 40, keep: 3 });
  for (let i = 0; i < 12; i += 1) log.info(`line ${i} ${"x".repeat(30)}`);
  log.info("tail");
  assert.equal(existsSync(log.file), true);
  assert.equal(existsSync(`${log.file}.1`), true);
  assert.equal(existsSync(`${log.file}.3`), false);
});

test("日志分页最多只给出限定页数，第 1 页是最新", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-log-page-"));
  const file = join(dir, "agent.jsonl");
  const count = LOG_PAGE_SIZE * LOG_MAX_PAGES + 10;
  const lines = Array.from({ length: count }, (_, index) => JSON.stringify({ ts: `2026-01-01T00:00:00.${String(index).padStart(4, "0")}Z`, level: index % 5 === 0 ? "error" : "info", msg: `event ${index}` }));
  writeFileSync(file, `${lines.join("\n")}\n`);
  const first = pageLogFile(file, { page: 1 });
  assert.equal(first.pageSize, LOG_PAGE_SIZE);
  assert.equal(first.maxPages, LOG_MAX_PAGES);
  assert.equal(first.totalPages, LOG_MAX_PAGES);
  assert.equal(first.lines[0].msg, `event ${count - 1}`);
  const beyond = pageLogFile(file, { page: 99 });
  assert.equal(beyond.page, LOG_MAX_PAGES);
  const errors = pageLogs(lines.map((line) => JSON.parse(line)), { page: 1, level: "error" });
  assert.ok(errors.lines.every((line) => line.level === "error"));
  assert.ok(errors.total <= LOG_PAGE_SIZE * LOG_MAX_PAGES);
});

test("日志分页按请求的每页条数切分", () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ ts: String(index).padStart(2, "0"), level: "info", msg: `event ${index}` }));
  const page = pageLogs(rows, { page: 2, pageSize: 8 });
  assert.equal(page.pageSize, 8);
  assert.equal(page.lines.length, 8);
  assert.equal(page.totalPages, 4);
  assert.equal(page.lines[0].msg, "event 16");
  assert.equal(pageLogs(rows, { page: 1, pageSize: 9999 }).pageSize, 200);
});

test("CodeBuddy 配置可保存模型、类型和密钥，读回时不带密钥原文", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-codebuddy-"));
  const file = join(dir, "codebuddy.json");
  const saved = saveCodebuddyConfig(file, { model: "hy4-preview", environment: "external", apiKey: "sk-secretvalue1234" });
  assert.equal(saved.environment, "external");
  const pub = publicCodebuddyConfig(readCodebuddyConfig(file));
  assert.equal(pub.model, "hy4-preview");
  assert.equal(pub.hasApiKey, true);
  assert.equal(JSON.stringify(pub).includes("sk-secretvalue1234"), false);
  const kept = saveCodebuddyConfig(file, { model: "other", environment: "internal", apiKey: "" });
  assert.equal(kept.apiKey, "sk-secretvalue1234");
  assert.equal(kept.environment, "internal");
  const env = codebuddyProcessEnv(kept, { CODEBUDDY_API_KEY: "old" });
  assert.equal(env.CODEBUDDY_API_KEY, "sk-secretvalue1234");
  assert.equal(env.NOVOARD_CODEBUDDY_MODEL, "other");
  assert.deepEqual(codebuddySessionFields(env), { environment: "internal", model: "other" });
});
