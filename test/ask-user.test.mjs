import { test } from "node:test";
import assert from "node:assert/strict";
import { createAskGate, formatAnswers, normalizeQuestions } from "../src/ask-user.mjs";
import { createLocalA2A } from "../src/local-a2a.mjs";

const sample = {
  questions: [
    {
      question: "用哪种方式？",
      header: "方式",
      options: [{ label: "本地", description: "在这台电脑上" }, { label: "跳过", description: "" }],
      multiSelect: false,
    },
    {
      question: "要保留哪些？",
      header: "保留",
      options: ["日志", { label: "产物", description: "构建结果" }],
      multiSelect: true,
    },
  ],
};

test("题目整理成界面能渲染的结构", () => {
  const questions = normalizeQuestions(sample);
  assert.equal(questions.length, 2);
  assert.equal(questions[1].options[0].label, "日志");
  assert.equal(questions[1].multiSelect, true);
  assert.deepEqual(normalizeQuestions({ questions: [{ options: [] }] }), []);
});

test("答案按问题原文回填，多选用逗号拼起来", () => {
  const questions = normalizeQuestions(sample);
  assert.deepEqual(formatAnswers(questions, { "用哪种方式？": "本地", q_1: ["日志", "产物"] }), {
    "用哪种方式？": "本地",
    "要保留哪些？": "日志, 产物",
  });
  assert.throws(() => formatAnswers(questions, { "用哪种方式？": "本地" }), /还没有回答/);
});

test("提问闸等到回答或取消", async () => {
  const gate = createAskGate();
  const questions = normalizeQuestions(sample);
  const pending = gate.wait("tool-1", "sess-1", questions);
  const accepted = gate.answer("tool-1", "sess-1", { answers: { "用哪种方式？": "本地", "要保留哪些？": "日志" } });
  assert.equal(accepted.ok, true);
  assert.deepEqual(await pending, { skip: false, answers: { "用哪种方式？": "本地", "要保留哪些？": "日志" } });
  assert.equal(gate.answer("tool-1", "sess-1", { skip: true }).gone, true);

  const again = createAskGate();
  const waiting = again.wait("tool-2", "sess-1", questions);
  again.cancelSession("sess-1");
  await assert.rejects(waiting, /提问已取消/);
  const skipped = again.wait("tool-3", "sess-1", questions);
  assert.equal(again.answer("tool-3", "sess-1", { skip: true }).ok, true);
  assert.equal((await skipped).skip, true);
});

test("回答提问走会话接口", async () => {
  let received = null;
  const local = createLocalA2A({
    port: 0,
    targets: {},
    runtime: { launch() { return { ok: true }; }, cancel() {} },
    log: { info() {}, warn() {} },
    chat: {
      answer(sessionId, body) {
        received = { sessionId, body };
        if (!body.questionId) return Promise.resolve({ ok: false, gone: true, message: "这次提问已经结束" });
        return Promise.resolve({ ok: true });
      },
    },
  });
  await local.start();
  try {
    const port = local.server.address().port;
    const ok = await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent("sess-1")}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1" },
      body: JSON.stringify({ questionId: "tool-1", answers: { "用哪种方式？": "本地" } }),
    });
    assert.equal(ok.status, 200);
    assert.equal(received.sessionId, "sess-1");
    assert.equal(received.body.answers["用哪种方式？"], "本地");
    const gone = await fetch(`http://127.0.0.1:${port}/api/sessions/sess-1/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ questionId: "" }),
    });
    assert.equal(gone.status, 409);
  } finally {
    await local.close();
  }
});
