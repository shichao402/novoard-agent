import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../src/session-store.mjs";
import { createCardOrder, toolUseIds } from "../src/card-order.mjs";

const askStep = {
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "三件事一起定一下：" },
      { type: "tool_use", id: "call-1", name: "AskUserQuestion", input: { questions: [] } },
    ],
  },
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "card-order-"));
  const store = createSessionStore(dir);
  store.upsert({ id: "s1", title: "t", createdAt: "", updatedAt: "" });
  return { dir, store, cards: createCardOrder() };
}

function kinds(store) {
  return store.messages("s1").map((row) => `${row.seq}:${row.kind}`);
}

test("权限请求先于同一步正文到达时，卡片仍排在正文之后", () => {
  const { dir, store, cards } = setup();
  try {
    cards.card("call-1", () => store.append("s1", { kind: "question", questionId: "call-1", questions: [] }));
    assert.equal(store.messages("s1").length, 0, "正文还没落盘，卡片先不写");
    store.append("s1", { kind: "assistant", text: "三件事一起定一下：" });
    cards.step(toolUseIds(askStep));
    assert.deepEqual(kinds(store).map((row) => row.split(":")[1]), ["assistant", "question"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("正文先到时卡片立即写，授权卡同样适用", () => {
  const { dir, store, cards } = setup();
  try {
    store.append("s1", { kind: "assistant", text: "要跑一条命令" });
    cards.step(["call-2"]);
    cards.card("call-2", () => store.append("s1", { kind: "approval", approvalId: "call-2" }));
    assert.deepEqual(kinds(store).map((row) => row.split(":")[1]), ["assistant", "approval"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("没有 tool_use id 时不等待，直接写卡片", () => {
  let written = 0;
  createCardOrder().card("", () => { written += 1; });
  assert.equal(written, 1);
});

test("只从 assistant 消息里取 tool_use id", () => {
  assert.deepEqual(toolUseIds(askStep), ["call-1"]);
  assert.deepEqual(toolUseIds({ type: "user", message: { content: [{ type: "tool_use", id: "x" }] } }), []);
});

test("worker 的问答卡和授权卡都经排序写入，正文落盘后放行", async () => {
  const { readFileSync } = await import("node:fs");
  const worker = readFileSync(new URL("../src/chat-worker.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(worker, /^\s*publish\([^)]*kind: "(question|approval)"/m, "卡片不能绕过排序直接写");
  assert.match(worker, /showCard\([^\n]*kind: "question"/);
  assert.match(worker, /showCard\([^\n]*kind: "approval"/);
  assert.match(worker, /turn\.cards\.step\(toolUseIds\(message\)\)/);
});
