import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInputMemory, createInputService } from "../src/inputs.mjs";
import { INPUT_USAGE_LIMIT, rankInputChoices, validInputUsage } from "../src/input-usage.mjs";

const target = { inputs: [{ name: "branch", choices: ["trunk", "release", "feature"] }, { name: "note", required: false }] };
const at = Date.UTC(2026, 10, 24);

function withMemory(run) {
  const dir = mkdtempSync(join(tmpdir(), "novoard-usage-"));
  try { return run(join(dir, "input-memory.json")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test("使用历史：同值每次受理也累计，last 格式不变，重新打开不丢失，空值不计数", () => {
  withMemory((file) => {
    let time = at;
    const memory = createInputMemory({ file, now: () => time++ });
    memory.remember("open", target, { branch: "trunk", note: "", other: "ignored" });
    memory.remember("open", target, { branch: "trunk" });
    memory.remember("open", target, { branch: "feature" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { "open.branch": "feature", "open.note": "" });
    assert.deepEqual(createInputMemory({ file }).getHistory("open", "branch"), [
      { value: "feature", count: 1, lastUsedAt: at + 2 }, { value: "trunk", count: 2, lastUsedAt: at + 1 },
    ]);
    assert.deepEqual(memory.getHistory("open", "note"), []);
    assert.deepEqual(memory.getHistory("other", "branch"), []);
    assert.equal(existsSync(`${memory.usageFile}.tmp`), false);
  });
});

test("使用历史：旧 last 无需迁移且不编造时间，坏历史文件不影响 last 与后续写入", () => {
  withMemory((file) => {
    writeFileSync(file, JSON.stringify({ "open.branch": "release" }));
    const memory = createInputMemory({ file, now: () => at });
    assert.deepEqual(memory.getHistory("open", "branch"), [{ value: "release", count: 1, lastUsedAt: 0 }]);
    writeFileSync(memory.usageFile, "{broken");
    assert.equal(memory.get("open", "branch"), "release");
    memory.remember("open", target, { branch: "release" });
    assert.deepEqual(memory.getHistory("open", "branch"), [{ value: "release", count: 2, lastUsedAt: at }]);
    assert.equal(memory.get("open", "branch"), "release");
  });
});

test("使用历史：每个输入最多保留 100 个最近使用值", () => {
  withMemory((file) => {
    let time = at;
    const memory = createInputMemory({ file, now: () => time++ });
    for (let i = 0; i < INPUT_USAGE_LIMIT + 5; i++) memory.remember("open", target, { branch: `b${i}` });
    const history = memory.getHistory("open", "branch");
    assert.equal(history.length, INPUT_USAGE_LIMIT);
    assert.equal(history[0].value, "b104");
    assert.equal(history.at(-1).value, "b5");
  });
});

test("使用历史排序：最近与频次加权，旧高频不永久置顶，没用过保持来源顺序", () => {
  const choices = ["untouched-a", "old", "recent", "frequent", "untouched-b"].map((value) => ({ value }));
  const history = [
    { value: "old", count: 10000, lastUsedAt: at - 90 * 86400000 },
    { value: "recent", count: 1, lastUsedAt: at },
    { value: "frequent", count: 4, lastUsedAt: at },
    { value: "gone", count: 100, lastUsedAt: at },
  ];
  const ranked = rankInputChoices(choices, history, at);
  assert.deepEqual(ranked.map((choice) => choice.value), ["frequent", "recent", "old", "untouched-a", "untouched-b"]);
  assert.deepEqual(ranked[0].usage, { count: 4, lastUsedAt: at });
  assert.deepEqual(rankInputChoices(choices, [], at), choices);
  assert.equal(choices[3].usage, undefined, "不修改查询来源对象");
});

test("使用历史：无效记录被忽略，键值不会污染对象原型", () => {
  assert.deepEqual(validInputUsage([null, { value: "", count: 1, lastUsedAt: at }, { value: "bad", count: -1, lastUsedAt: at }]), []);
  const choices = [{ value: "__proto__" }, { value: "a" }];
  assert.equal(rankInputChoices(choices, [{ value: "__proto__", count: 1, lastUsedAt: at }], at)[0].usage.count, 1);
});

test("候选描述：静态候选排序，查询描述不会累计历史，不加入消失的候选", async () => {
  const history = [{ value: "feature", count: 2, lastUsedAt: at }, { value: "gone", count: 8, lastUsedAt: at }];
  let reads = 0;
  const service = createInputService({ memory: { getHistory: () => { reads++; return history; } } });
  const described = await service.describe("open", target);
  assert.deepEqual(described.inputs[0].choices.map((choice) => choice.value), ["feature", "trunk", "release"]);
  assert.equal(reads, 1);
  assert.deepEqual((await service.queryChoices("open", target, "branch")).choices.map((choice) => choice.value), ["feature", "trunk", "release"]);
  assert.equal(history[0].count, 2);
});
