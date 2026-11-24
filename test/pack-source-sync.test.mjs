import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHubSourceSync } from "../src/packs/hub-sync.mjs";
import { createSourcesCache } from "../src/packs/sources-cache.mjs";
import { createLocalA2A } from "../src/local-a2a.mjs";
import { dispatchNovoardTool } from "../src/novoard-tools.mjs";
import { NOVOARD_MCP_TOOLS } from "../src/chat-permissions.mjs";
const SOURCE = { git: "git@example.com:group/pack.git", branch: "main" };
function stack(fetchImpl) {
  const changes = [];
  let reconciled = 0;
  const sync = createHubSourceSync({ config: { hubUrl: "wss://example.com/tunnel", agentToken: "private-test-token" }, sources: { replace(sources) { changes.push(sources); return { count: sources.length }; } }, manager: { reconcile() { reconciled++; }, listRepos() { return [{ key: "src-a", ...SOURCE }]; } }, fetchImpl });
  return { sync, changes, get reconciled() { return reconciled; } };
}
function json(value) { return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }); }

test("主动同步只用既有 Hub origin 和内部成员 token，无重定向且不自动安装", async () => {
  const calls = [];
  const c = stack(async (url, init) => { calls.push({ url: String(url), init }); return json({ sources: [SOURCE] }); });
  const result = await c.sync.sync();
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.deepEqual(c.changes, [[SOURCE]]);
  assert.equal(c.reconciled, 1);
  assert.equal(calls[0].url, "https://example.com/api/agent/pack-sources");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Authorization, "Bearer private-test-token");
  assert.ok(!JSON.stringify(result).includes("private-test-token"));
});

test("并发同步合并为同一请求", async () => {
  let resolve;
  let count = 0;
  const c = stack(() => { count++; return new Promise((r) => { resolve = r; }); });
  const a = c.sync.sync(); const b = c.sync.sync();
  assert.equal(a, b);
  resolve(json({ sources: [SOURCE] }));
  await Promise.all([a, b]);
  assert.equal(count, 1);
});

test("中文来源字段跨 UTF-8 chunk 边界也完整", async () => {
  const text = new TextEncoder().encode(JSON.stringify({ sources: [{ ...SOURCE, branch: "工作分支" }] }));
  const stream = new ReadableStream({ start(controller) { for (const byte of text) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const c = stack(async () => new Response(stream, { headers: { "Content-Type": "application/json" } }));
  assert.equal((await c.sync.sync()).ok, true);
  assert.equal(c.changes[0][0].branch, "工作分支");
});

test("空清单可同步，失败和部分非法清单不能覆盖缓存", async () => {
  for (const body of [null, { sources: null }, { sources: [SOURCE, {}] }, { sources: [SOURCE, SOURCE] }, { sources: [{ key: "ps-12345678", ...SOURCE }] }, { sources: [{ ...SOURCE, branch: 123 }] }, { sources: [{ ...SOURCE, git: "https://user:pass@example.com/repo.git" }] }, { sources: [{ ...SOURCE, git: "https://example.com/repo.git?token=x" }] }, { sources: [{ ...SOURCE, branch: "x\u0000" }] }, { sources: Array.from({ length: 513 }, () => SOURCE) }]) {
    const c = stack(async () => json(body));
    assert.equal((await c.sync.sync()).ok, false);
    assert.deepEqual(c.changes, []);
  }
  const failed = stack(async () => new Response("private-test-token", { status: 401 }));
  assert.equal((await failed.sync.sync()).ok, false);
  assert.deepEqual(failed.changes, []);
  const timeout = stack(async () => { throw new Error("network/private-test-token"); });
  const result = await timeout.sync.sync();
  assert.equal(result.ok, false);
  assert.ok(!result.reason.includes("private-test-token"));
  const empty = stack(async () => json({ sources: [] }));
  assert.equal((await empty.sync.sync()).count, 0);
  assert.deepEqual(empty.changes, [[]]);
});

test("非 JSON、超大响应和非法 UTF-8 不覆盖旧清单", async () => {
  for (const response of [new Response("{}"), new Response("x".repeat(512 * 1024 + 1), { headers: { "Content-Type": "application/json" } }), new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "application/json" } })]) {
    const c = stack(async () => response);
    assert.equal((await c.sync.sync()).ok, false);
    assert.deepEqual(c.changes, []);
  }
});

test("HTTP 同步必须回环，不接受 Hub URL 中的凭据", async () => {
  for (const hubUrl of ["http://example.com", "wss://user:pass@example.com/tunnel", "https://example.com/?token=x"]) {
    let called = false;
    const sync = createHubSourceSync({ config: { hubUrl }, fetchImpl: async () => { called = true; } });
    assert.equal((await sync.sync()).code, "invalid-hub-url");
    assert.equal(called, false);
  }
});

test("来源缓存原子写入失败时保留旧内存及磁盘快照", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-source-cache-"));
  const file = join(dir, "pack-sources.json");
  try {
    const cache = createSourcesCache({ file });
    cache.replace([SOURCE]);
    const before = readFileSync(file, "utf8");
    const old = cache.list();
    rmSync(file);
    mkdirSync(file);
    assert.throws(() => cache.replace([{ ...SOURCE, branch: "dev" }]));
    assert.deepEqual(cache.list(), old);
    rmSync(file, { recursive: true });
    writeFileSync(file, before);
    assert.deepEqual(createSourcesCache({ file }).list(), old);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("本机同步端点同源 + 空 JSON，审计不含 token；工具与端点对应", async () => {
  let calls = 0;
  const audit = [];
  const local = createLocalA2A({ targets: {}, runtime: {}, audit: (event) => audit.push(event), syncPackSources: async () => { calls++; return { ok: true, count: 1 }; }, log: { info() {} } });
  const address = await local.start();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    let response = await fetch(origin + "/api/pack-sources/sync", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 403);
    for (const body of [null, [], { hubUrl: "https://evil.example" }, { token: "external-token" }]) {
      response = await fetch(origin + "/api/pack-sources/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    assert.equal(calls, 0);
    const result = JSON.parse(await dispatchNovoardTool("novoard_sync_pack_sources", {}, { origin }));
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.equal(audit[0].detail.action, "sync");
    assert.ok(NOVOARD_MCP_TOOLS.includes("mcp__novoard__novoard_sync_pack_sources"));
  } finally { await local.close(); }
});

test("未装配主动同步的本机服务明确返回 503", async () => {
  const local = createLocalA2A({ targets: {}, runtime: {}, log: { info() {} } });
  const address = await local.start();
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/pack-sources/sync`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 503);
  } finally { await local.close(); }
});
