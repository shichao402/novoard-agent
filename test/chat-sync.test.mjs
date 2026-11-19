import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeOpenTurns, createSessionStore } from "../src/session-store.mjs";
import { createChatBridge } from "../src/chat-bridge.mjs";
import { createLocalA2A } from "../src/local-a2a.mjs";
import { buildBubbles, mergeLog, turnProgress, turnRunning } from "../desktop/src/lib/chat-log.mjs";

const quiet = { info() {}, warn() {} };

test("记录每行带 seq，重开存储后接着编号；未结束的轮次可以收尾", () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-store-seq-"));
  try {
    const store = createSessionStore(dir);
    store.upsert({ id: "s1", title: "a", createdAt: "", updatedAt: "", preview: "", running: true });
    const first = store.append("s1", { kind: "user", text: "hi" });
    const second = store.append("s1", { kind: "turn", state: "running" });
    assert.equal(first.seq + 1, second.seq);
    assert.ok(first.at);
    const reopened = createSessionStore(dir);
    const third = reopened.append("s1", { kind: "assistant", text: "好" });
    assert.equal(third.seq, second.seq + 1, "重开后不能重新从头编号");
    assert.deepEqual(reopened.messages("s1").map((row) => row.seq), [first.seq, second.seq, third.seq]);

    const closed = closeOpenTurns(reopened, "进程没了");
    assert.equal(closed.length, 1);
    assert.equal(closed[0].session.running, false);
    const tail = reopened.messages("s1").slice(-2);
    assert.deepEqual(tail.map((row) => row.kind), ["error", "turn"]);
    assert.equal(tail[1].state, "idle");
    assert.equal(tail[1].outcome, "error");
    assert.equal(closeOpenTurns(reopened, "再收一次").length, 0, "已收尾的不再重复写");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeWorker(dir) {
  const worker = join(dir, "fake-worker.mjs");
  writeFileSync(worker, `import { createInterface } from "node:readline";
const turns = new Map();
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.op === "list") return write({ id: request.id, result: { pid: process.pid } });
  if (request.op === "send") {
    if (request.text === "crash") process.exit(3);
    if (turns.has(request.sessionId)) return write({ id: request.id, error: "上一轮还没结束", code: "busy" });
    turns.set(request.sessionId, request.id);
    write({ broadcast: { kind: "message", sessionId: request.sessionId, event: { kind: "user", text: request.text, seq: 1 } } });
    return write({ id: request.id, accepted: true });
  }
  if (request.op === "interrupt") {
    const turn = turns.get(request.sessionId);
    turns.delete(request.sessionId);
    if (turn) write({ id: turn, result: { ok: true, outcome: "interrupted" } });
    return write({ id: request.id, result: { ok: true } });
  }
  write({ id: request.id, error: "unknown" });
});
function write(payload) { process.stdout.write(JSON.stringify(payload) + "\\n"); }
`);
  return worker;
}

test("会话桥：受理回执、忙时拒绝、广播订阅、有轮次时延后重启", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-bridge-sync-"));
  const bridge = createChatBridge({ dataDir: dir, workerPath: fakeWorker(dir), nodePath: process.execPath, log: quiet });
  bridge.setOrigin("http://127.0.0.1:9");
  const pushed = [];
  const off = bridge.subscribe((payload) => pushed.push(payload));
  try {
    const before = (await bridge.list()).pid;
    let accepted = false;
    let finished = false;
    const turn = bridge.send("s1", "第一轮", null, { onAccepted: () => { accepted = true; } }).then((result) => { finished = true; return result; });
    while (!accepted) await new Promise((r) => setTimeout(r, 10));
    assert.equal(finished, false, "受理在前，轮次结束在后");
    assert.equal(pushed[0]?.kind, "message");
    assert.equal(pushed[0]?.event?.text, "第一轮");

    await assert.rejects(bridge.send("s1", "第二轮"), (error) => error.code === "busy");

    assert.deepEqual(bridge.reload(), { deferred: true }, "有轮次在跑时不重启");
    assert.equal((await bridge.list()).pid, before);

    await bridge.interrupt("s1");
    assert.equal((await turn).outcome, "interrupted");
    assert.notEqual((await bridge.list()).pid, before, "最后一轮结束后按新配置重启");
    assert.deepEqual(bridge.reload(), { deferred: false });
  } finally {
    off();
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("会话进程意外退出时，没跑完的轮次写进记录并推给界面", async () => {
  const dir = mkdtempSync(join(tmpdir(), "novoard-bridge-exit-"));
  const store = createSessionStore(join(dir, "sessions"));
  store.upsert({ id: "s1", title: "a", createdAt: "", updatedAt: "", preview: "", running: true });
  store.append("s1", { kind: "turn", state: "running" });
  const bridge = createChatBridge({ dataDir: dir, workerPath: fakeWorker(dir), nodePath: process.execPath, log: quiet });
  bridge.setOrigin("http://127.0.0.1:9");
  const pushed = [];
  bridge.subscribe((payload) => pushed.push(payload));
  try {
    await assert.rejects(bridge.send("s1", "crash"));
    for (let i = 0; i < 50 && !pushed.some((p) => p.kind === "session"); i += 1) await new Promise((r) => setTimeout(r, 20));
    const kinds = pushed.filter((p) => p.kind === "message").map((p) => p.event.kind);
    assert.deepEqual(kinds, ["error", "turn"]);
    assert.equal(pushed.find((p) => p.kind === "session").session.running, false);
    const reread = createSessionStore(join(dir, "sessions"));
    assert.equal(reread.get("s1").running, false);
    assert.equal(reread.messages("s1").at(-1).outcome, "error");
  } finally {
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("发送接口受理即回 202，忙时 409；会话推送转发会话进程的广播", async () => {
  let listener = null;
  const local = createLocalA2A({
    port: 0,
    targets: {},
    runtime: { launch() { return { ok: true }; }, cancel() {} },
    log: quiet,
    chat: {
      send(sessionId, text, onEvent, options) {
        if (text === "busy") return Promise.reject(Object.assign(new Error("上一轮还没结束"), { code: "busy" }));
        setTimeout(() => options.onAccepted(), 5);
        return new Promise(() => {}); // 这一轮一直在跑，接口也不能等它
      },
      subscribe(next) {
        listener = next;
        return () => { listener = null; };
      },
    },
  });
  await local.start();
  const port = local.server.address().port;
  const post = (text) => fetch(`http://127.0.0.1:${port}/api/sessions/s1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ text }),
  });
  const abort = new AbortController();
  try {
    const ok = await post("你好");
    assert.equal(ok.status, 202);
    const busy = await post("busy");
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).code, "busy");

    const events = await fetch(`http://127.0.0.1:${port}/api/sessions/events`, { signal: abort.signal });
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    assert.match(text, /: open/);
    assert.ok(listener, "连上推送时应订阅会话进程广播");
    listener({ kind: "message", sessionId: "s1", event: { kind: "assistant", text: "好", seq: 3 } });
    while (!text.includes("assistant")) text += decoder.decode((await reader.read()).value);
    assert.match(text, /"seq":3/);
  } finally {
    abort.abort();
    await local.close();
  }
});

test("界面记录按 seq 合并去重，是否在跑看最后一条 turn 行", () => {
  const a = { kind: "user", text: "hi", seq: 1 };
  const b = { kind: "turn", state: "running", seq: 2, at: "2026-11-19T00:00:00.000Z" };
  const c = { kind: "assistant", text: "好", seq: 3, at: "2026-11-19T00:00:05.000Z" };
  const live = mergeLog(mergeLog([], [c]), [a, b, c]);
  assert.deepEqual(live.map((row) => row.seq), [1, 2, 3], "推送先到、历史后到也不重复不乱序");
  assert.equal(turnRunning(live), true);
  assert.equal(turnRunning([], true), true, "没有 turn 行时看会话索引");
  const progress = turnProgress(live, true);
  assert.equal(progress.startedAt, b.at);
  assert.equal(progress.lastAt, c.at);
  const idle = mergeLog(live, [{ kind: "turn", state: "idle", outcome: "ok", seq: 4 }]);
  assert.equal(turnRunning(idle), false);
  assert.equal(turnProgress(idle, false), null);
});

test("气泡全部由记录推出：id 稳定，停止后问答、授权和工具收尾", () => {
  const rows = [
    { kind: "user", text: "查一下", seq: 1 },
    { kind: "turn", state: "running", seq: 2 },
    { kind: "tool", name: "Bash", toolUseId: "t1", input: { command: "ls" }, seq: 3 },
    { kind: "question", questionId: "q1", questions: [{ question: "哪个？", header: "选", options: [] }], seq: 4 },
    { kind: "approval", approvalId: "a1", tool: "Bash", seq: 5 },
  ];
  const live = buildBubbles(rows, true);
  assert.deepEqual(live.map((item) => item.id), ["user-1", "tools-3", "question-q1", "approval-a1"]);
  assert.equal(live[1].calls[0].status, "running");
  assert.equal(live[2].pending, true);
  assert.equal(live[3].decision, undefined);
  assert.deepEqual(buildBubbles(rows, true).map((item) => item.id), live.map((item) => item.id), "重算 id 不变");

  const stopped = buildBubbles([...rows, { kind: "turn", state: "idle", outcome: "interrupted", seq: 6 }], false);
  assert.notEqual(stopped[1].calls[0].status, "running");
  assert.equal(stopped[2].pending, false);
  assert.equal(stopped[3].decision, "cancel");
  assert.equal(stopped.at(-1).text, "这一轮已停止");

  const answered = buildBubbles([...rows, { kind: "answer", questionId: "q1", answers: { "哪个？": "本地" }, seq: 6 }], true);
  assert.equal(answered[2].pending, false);
  assert.equal(answered[2].answers["哪个？"], "本地");
});
