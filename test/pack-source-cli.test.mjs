import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const CLI = fileURLToPath(new URL("../skills/novoard-manage/scripts/novoard.py", import.meta.url));
const TOKEN = "nvp_0123456789abcdef_" + "x".repeat(43);
const KEY = "ps-0123456789ab";
const SOURCE = { key: KEY, git: "git@example.com:team/pack.git", branch: "main", id: "Custom", subdir: "packs/custom" };
async function fixture(handler) {
  const calls = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const call = { method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null };
    calls.push(call);
    res.setHeader("Content-Type", "application/json");
    handler(call, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, base: `http://127.0.0.1:${server.address().port}`, async close() { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}
function run(base, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.NOVOARD_TEST_PYTHON || (process.platform === "win32" ? "python" : "python3"), [CLI, "pack-sources", ...args, "--hub", base], { env: { ...process.env, PYTHONIOENCODING: "utf-8", NOVOARD_HUB_PAT: TOKEN, NOVOARD_HUB_PAT_FILE: "", ...extraEnv }, windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("CLI test timeout")); }, 10_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test("来源 CLI list/add/update/remove 请求准确，修改保留 id/subdir 和未指定字段", async () => {
  const c = await fixture((call, res) => {
    if (call.method === "GET") res.end(JSON.stringify({ sources: [SOURCE] }));
    else res.end(JSON.stringify({ ok: true, source: { key: KEY, ...call.body }, removed: call.method === "DELETE" }));
  });
  try {
    assert.equal((await run(c.base, ["list"])).code, 0);
    assert.equal((await run(c.base, ["add", "--git", SOURCE.git])).code, 0);
    assert.deepEqual(c.calls.at(-1).body, { git: SOURCE.git, branch: "main" });
    assert.equal((await run(c.base, ["update", "--key", KEY, "--git", "git@example.com:team/new.git"])).code, 0);
    assert.deepEqual(c.calls.at(-1).body, { git: "git@example.com:team/new.git", branch: "main", id: "Custom", subdir: "packs/custom" });
    assert.equal((await run(c.base, ["update", "--key", KEY, "--branch", "dev"])).code, 0);
    assert.deepEqual(c.calls.at(-1).body, { git: SOURCE.git, branch: "dev", id: SOURCE.id, subdir: SOURCE.subdir });
    assert.equal((await run(c.base, ["remove", "--key", KEY, "--confirm"])).code, 0);
    assert.equal(c.calls.at(-1).method, "DELETE");
    assert.equal(c.calls.at(-1).url, "/api/pack-sources/" + KEY);
    assert.ok(c.calls.every((call) => call.auth === "Bearer " + TOKEN));
  } finally { await c.close(); }
});

test("无删除确认、错误 key、非法地址和参数拒绝于请求前", async () => {
  const c = await fixture((_call, res) => res.end("{}"));
  try {
    for (const args of [["remove", "--key", KEY], ["update", "--key", "src-0123456789ab", "--branch", "dev"], ["update", "--key", KEY], ["add", "--git", "https://user:pass@example.com/x.git"], ["add", "--git", "https://example.com/x.git?token=secret"], ["add", "--git", "https://[bad/x"], ["list", "--branch", "main"]]) {
      const result = await run(c.base, args);
      assert.equal(result.code, 1);
      assert.ok(!result.stderr.includes("Traceback"));
    }
    assert.equal(c.calls.length, 0);
  } finally { await c.close(); }
});

test("PAT 文件优先环境变量，非法和不可读凭据失败不泄漏", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-cli-pat-"));
  const file = join(dir, "source.pat");
  writeFileSync(file, "\ufeff" + TOKEN + "\n", { mode: 0o600 });
  const c = await fixture((_call, res) => res.end('{"sources":[]}'));
  try {
    assert.equal((await run(c.base, ["list"], { NOVOARD_HUB_PAT_FILE: file, NOVOARD_HUB_PAT: "invalid-env" })).code, 0);
    assert.equal(c.calls[0].auth, "Bearer " + TOKEN);
    for (const env of [{ NOVOARD_HUB_PAT: "member-token" }, { NOVOARD_HUB_PAT_FILE: join(dir, "missing") }]) {
      const result = await run(c.base, ["list"], env);
      assert.equal(result.code, 1);
      assert.ok(!(result.stdout + result.stderr).includes(TOKEN));
    }
    assert.equal(c.calls.length, 1);
  } finally { await c.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("HTTP 权限/版本错误不输出响应秘密，也不重试写请求", async () => {
  for (const status of [401, 403, 404, 409, 503]) {
    const c = await fixture((_call, res) => { res.statusCode = status; res.end(JSON.stringify({ secret: TOKEN })); });
    try {
      const result = await run(c.base, ["add", "--git", SOURCE.git]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(`HTTP ${status}`));
      assert.ok(!(result.stdout + result.stderr).includes(TOKEN));
      assert.equal(c.calls.length, 1);
    } finally { await c.close(); }
  }
});

test("重定向不带 PAT 跟随，成功响应中的完整令牌也脱敏", async () => {
  const sink = await fixture((_call, res) => res.end("{}"));
  const c = await fixture((_call, res) => { res.statusCode = 302; res.setHeader("Location", sink.base + "/capture"); res.end("{}"); });
  try {
    assert.equal((await run(c.base, ["list"])).code, 1);
    assert.equal(sink.calls.length, 0);
  } finally { await c.close(); await sink.close(); }
  const echo = await fixture((_call, res) => res.end(JSON.stringify({ sources: [], token: TOKEN })));
  try {
    const result = await run(echo.base, ["list"]);
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.includes(TOKEN));
    assert.match(result.stdout, /REDACTED/);
  } finally { await echo.close(); }
});

test("非 JSON、超大响应和非 HTTPS 远程地址失败", async () => {
  for (const oversized of [false, true]) {
    const c = await fixture((_call, res) => { if (!oversized) res.setHeader("Content-Type", "text/html"); res.end(oversized ? '"' + "x".repeat(512 * 1024) + '"' : "not JSON"); });
    try { assert.equal((await run(c.base, ["list"])).code, 1); } finally { await c.close(); }
  }
  const result = await run("http://example.com", ["list"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HTTP 仅限回环/);
});
