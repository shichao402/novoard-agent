import assert from "node:assert/strict";
import test from "node:test";
import {
  cliPermissionMode,
  createApprovalGate,
  decideToolUse,
  describeToolCall,
  normalizeChatPermission,
  permissionPrompt,
} from "../src/chat-approval.mjs";

test("未知或缺省的权限按逐次确认处理", () => {
  assert.equal(normalizeChatPermission(undefined), "confirm");
  assert.equal(normalizeChatPermission("bogus"), "confirm");
  assert.equal(normalizeChatPermission("full"), "full");
});

test("只读走 dontAsk，其余走 default", () => {
  assert.equal(cliPermissionMode("readonly"), "dontAsk");
  assert.equal(cliPermissionMode("confirm"), "default");
  assert.equal(cliPermissionMode("full"), "default");
});

test("decideToolUse 按模式、授权和来源判断", () => {
  assert.equal(decideToolUse({ permission: "full", peer: true }), "allow");
  assert.equal(decideToolUse({ permission: "readonly", granted: true }), "deny-readonly");
  assert.equal(decideToolUse({ permission: "confirm" }), "ask");
  assert.equal(decideToolUse({ permission: "confirm", peer: true }), "deny-peer");
  assert.equal(decideToolUse({ permission: "confirm", granted: true }), "allow");
});

test("describeToolCall 取命令做摘要、description 做理由", () => {
  const call = describeToolCall("PowerShell", { command: "Remove-Item  a.txt", description: "清理临时文件" });
  assert.equal(call.tool, "PowerShell");
  assert.equal(call.summary, "Remove-Item a.txt");
  assert.equal(call.reason, "清理临时文件");
  assert.match(call.detail, /Remove-Item/);
});

test("允许一次不记授权，本会话允许按工具名记住", async () => {
  const gate = createApprovalGate();
  const first = gate.wait("a1", "s1", "PowerShell");
  assert.deepEqual(gate.decide("a1", "s1", "once"), { ok: true });
  assert.equal(await first, "once");
  assert.equal(gate.isGranted("s1", "PowerShell"), false);

  const second = gate.wait("a2", "s1", "PowerShell");
  assert.deepEqual(gate.decide("a2", "s1", "session"), { ok: true });
  assert.equal(await second, "session");
  assert.equal(gate.isGranted("s1", "PowerShell"), true);
  assert.equal(gate.isGranted("s2", "PowerShell"), false);

  gate.forgetSession("s1");
  assert.equal(gate.isGranted("s1", "PowerShell"), false);
});

test("已结束、会话不符或选项非法时 decide 不生效", async () => {
  const gate = createApprovalGate();
  assert.equal(gate.decide("none", "s1", "once").gone, true);
  const waiting = gate.wait("a1", "s1", "Write");
  assert.equal(gate.decide("a1", "s2", "once").gone, true);
  assert.equal(gate.decide("a1", "s1", "maybe").ok, false);
  assert.deepEqual(gate.decide("a1", "s1", "deny"), { ok: true });
  assert.equal(await waiting, "deny");
});

test("中断会话或 signal 取消会让等待失败", async () => {
  const gate = createApprovalGate();
  const waiting = gate.wait("a1", "s1", "Write");
  gate.cancelSession("s1");
  await assert.rejects(waiting, /授权已取消/);

  const controller = new AbortController();
  const aborted = gate.wait("a2", "s1", "Write", controller.signal);
  controller.abort();
  await assert.rejects(aborted, /授权已取消/);
  assert.equal(gate.decide("a2", "s1", "once").gone, true);
});

test("系统提示按模式写", () => {
  assert.match(permissionPrompt("confirm"), /逐次确认/);
  assert.match(permissionPrompt("readonly"), /只读/);
  assert.match(permissionPrompt("full"), /完全放行/);
});
