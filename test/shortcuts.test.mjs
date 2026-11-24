/**
 * ADR-0023 快捷预设：结构校验、与 targets 对照的问题提示、存储读写、本机接口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createShortcutStore, shortcutProblems, validateShortcuts } from "../src/shortcuts.mjs";
import { createLocalA2A } from "../src/local-a2a.mjs";

const quiet = { info() {}, warn() {}, error() {} };

const TARGETS = {
  "s2-workspace": {
    title: "准备 s2 工程",
    vars: { poolRoot: "D:/pool/s2" },
    inputs: [{ name: "branch", label: "分支" }, { name: "scene", required: false }],
    expanded: [{ script: "echo {{branch}}" }],
  },
};

test("validateShortcuts：归一 vars 为字符串、ask 去重、补齐缺省字段", () => {
  const r = validateShortcuts([
    { id: "s2-bug", label: " s2 验 bug ", target: "s2-workspace", vars: { branch: "s2_main", n: 3, on: true }, ask: ["branch", "branch"] },
    { id: "plain", label: "直接跑", target: "s2-workspace" },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.shortcuts[0], { id: "s2-bug", label: "s2 验 bug", target: "s2-workspace", vars: { branch: "s2_main", n: "3", on: "true" }, ask: ["branch"] });
  assert.deepEqual(r.shortcuts[1], { id: "plain", label: "直接跑", target: "s2-workspace", vars: {}, ask: [] });
});

test("validateShortcuts：非法 id、重复 id、空 label、非法 vars/ask 都报错并定位", () => {
  const r = validateShortcuts([
    { id: "Bad", label: "x", target: "t" },
    { id: "a", label: "", target: "t" },
    { id: "a", label: "y", target: "t", vars: { "1x": "v", ok: { deep: 1 } }, ask: "branch" },
  ]);
  assert.equal(r.ok, false);
  const text = r.errors.join("\n");
  assert.match(text, /shortcuts\[0\]\.id/);
  assert.match(text, /shortcuts\[1\]\.label/);
  assert.match(text, /shortcuts\[2\]\.id 重复/);
  assert.match(text, /键名不合法：1x/);
  assert.match(text, /vars\.ok 只能是/);
  assert.match(text, /shortcuts\[2\]\.ask 必须是数组/);
  assert.equal(validateShortcuts({}).ok, false);
});

test("shortcutProblems：target 不存在、ask 不是输入、预填既非输入也非变量", () => {
  assert.deepEqual(shortcutProblems({ target: "nope", vars: {}, ask: [] }, TARGETS), ["Target nope 不存在"]);
  assert.deepEqual(shortcutProblems({ target: "s2-workspace", vars: { branch: "x", poolRoot: "E:/p" }, ask: ["scene"] }, TARGETS), []);
  const problems = shortcutProblems({ target: "s2-workspace", vars: { mode: "x" }, ask: ["poolRoot"] }, TARGETS);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /poolRoot 不是这个 Target 的输入/);
  assert.match(problems[1], /mode 不是这个 Target 的输入或变量/);
});

test("createShortcutStore：保存后可读回；文件损坏按空处理；非法数据不落盘", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortcuts-"));
  try {
    const file = join(dir, "state", "shortcuts.json");
    const store = createShortcutStore({ file });
    assert.deepEqual(store.list(), []);
    const saved = store.save([{ id: "s2-bug", label: "s2 验 bug", target: "s2-workspace", ask: ["branch"] }]);
    assert.equal(saved.ok, true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
    assert.equal(store.list()[0].id, "s2-bug");
    assert.equal(store.save([{ id: "", label: "", target: "" }]).ok, false);
    assert.equal(store.list().length, 1, "非法数据不覆盖已有文件");
    writeFileSync(file, "{坏掉", "utf8");
    assert.deepEqual(store.list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET/PUT /api/shortcuts：读写、问题提示、非法数据 422", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shortcuts-api-"));
  const a2a = createLocalA2A({
    targets: TARGETS,
    card: { name: "t" },
    runtime: { launch: () => ({ ok: true }), snapshot: () => [] },
    log: quiet,
    shortcutStore: createShortcutStore({ file: join(dir, "shortcuts.json") }),
  });
  try {
    await a2a.start();
    const port = a2a.server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const empty = await (await fetch(`${base}/api/shortcuts`)).json();
    assert.deepEqual(empty, { ok: true, shortcuts: [], problems: {} });

    const put = await fetch(`${base}/api/shortcuts`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcuts: [
        { id: "s2-bug", label: "s2 验 bug", target: "s2-workspace", ask: ["branch"] },
        { id: "gone", label: "旧的", target: "deleted-target" },
      ] }),
    });
    assert.equal(put.status, 200);
    const body = await put.json();
    assert.equal(body.shortcuts.length, 2);
    assert.deepEqual(body.problems, { gone: ["Target deleted-target 不存在"] });

    const again = await (await fetch(`${base}/api/shortcuts`)).json();
    assert.equal(again.shortcuts[0].id, "s2-bug");

    const bad = await fetch(`${base}/api/shortcuts`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shortcuts: [{ id: "x" }] }) });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).errors.join("\n"), /label 不能为空/);
  } finally {
    await a2a.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /api/targets/:id/inputs?vars=：快捷的变量覆盖透传给候选查询，非法值丢弃", async () => {
  const seen = [];
  const a2a = createLocalA2A({
    targets: TARGETS,
    card: { name: "t" },
    runtime: { launch: () => ({ ok: true }), snapshot: () => [] },
    log: quiet,
    inputService: { describe: async (id, def, overrides) => { seen.push(overrides); return { id, title: def.title, inputs: [] }; } },
  });
  try {
    await a2a.start();
    const base = `http://127.0.0.1:${a2a.server.address().port}`;
    const vars = encodeURIComponent(JSON.stringify({ poolRoot: "E:/pool/s3", n: 2, deep: { x: 1 }, "bad key": "v" }));
    assert.equal((await fetch(`${base}/api/targets/s2-workspace/inputs?vars=${vars}`)).status, 200);
    assert.equal((await fetch(`${base}/api/targets/s2-workspace/inputs?vars=%7Bbroken`)).status, 200);
    assert.equal((await fetch(`${base}/api/targets/s2-workspace/inputs`)).status, 200);
    assert.deepEqual(seen, [{ poolRoot: "E:/pool/s3", n: "2" }, null, null]);
  } finally {
    await a2a.close();
  }
});
