import { test } from "node:test";
import assert from "node:assert/strict";
import { applyToolEvent, classifyToolResult, groupTitle, settleCalls, toolResultText, toolTitle } from "../desktop/src/lib/chat-tools.mjs";

test("工具标题用中文并带关键参数", () => {
  assert.equal(toolTitle("Read", { file_path: "D:/workspace/GitHub/novoard-agent/VERSION.json" }), "读取 VERSION.json");
  assert.equal(toolTitle("PowerShell", { command: "Get-ChildItem D:/workspace -Name" }), "运行 Get-ChildItem D:/workspace -Name");
  assert.equal(toolTitle("Glob", { pattern: "**/*.mjs", path: "src" }), "查找 **/*.mjs（src）");
  assert.equal(toolTitle("mcp__novoard__novoard_run_target", { id: "smoke" }), "执行 Target smoke");
  assert.equal(toolTitle("mcp__novoard__novoard_set_schedule", { enabled: false }), "关闭定时");
  assert.equal(toolTitle("mcp__other__do_thing", {}), "do_thing（other）");
  assert.equal(toolTitle("Unknown", undefined), "Unknown");
  assert.ok(toolTitle("Bash", { command: "x".repeat(200) }).length <= 80);
});

test("旧记录里序列化的内容块和 MCP 套的两层都拆成纯文本", () => {
  assert.equal(toolResultText('[{"type":"text","text":"Task #1 created"}]'), "Task #1 created");
  const nested = JSON.stringify([{ type: "text", text: JSON.stringify([{ type: "text", text: '{"ok":true}' }]) }]);
  assert.equal(toolResultText(nested), '{"ok":true}');
  assert.equal(toolResultText("普通文本"), "普通文本");
  assert.equal(toolResultText("[{坏的 json"), "[{坏的 json");
});

test("结果分出成功、失败和未授权，并给一行摘要", () => {
  const denied = classifyToolResult("Bash", '[{"type":"text","text":"Error: Permission to use Bash has been denied because CodeBuddy is running in dontAsk mode."}]');
  assert.equal(denied.status, "denied");
  assert.match(denied.summary, /未授权/);
  assert.match(denied.detail, /dontAsk/);

  const listed = classifyToolResult("PowerShell", "Command: Get-ChildItem\nStdout: a\r\nb\r\nc\r\n\nStderr: (empty)\nExit Code: 0");
  assert.deepEqual([listed.status, listed.summary], ["ok", "输出 3 行"]);
  const one = classifyToolResult("Bash", "Command: git --version\nStdout: git version 2.49.0\n\nStderr: (empty)\nExit Code: 0");
  assert.deepEqual([one.status, one.summary], ["ok", "git version 2.49.0"]);
  const failed = classifyToolResult("Bash", "Command: git status\nStdout: (empty)\nStderr: fatal: not a git repository\nExit Code: 128");
  assert.equal(failed.status, "error");
  assert.match(failed.summary, /退出码 128：fatal: not a git repository/);

  assert.equal(classifyToolResult("Read", "     1→{\n     2→  \"v\": 1\n     3→}").summary, "3 行");
  const timeout = classifyToolResult("Glob", "Error: glob error: Search timeout after 30000ms");
  assert.deepEqual([timeout.status, timeout.summary], ["error", "glob error: Search timeout after 30000ms"]);
  assert.equal(classifyToolResult("Write", "anything", true).status, "error");
  assert.equal(classifyToolResult("mcp__novoard__novoard_upsert_target", '{"ok":false,"error":"id 重复"}').summary, "id 重复");
  assert.equal(classifyToolResult("mcp__novoard__novoard_status", '{"ok":true,"targets":[]}').summary, "完成");
});

test("调用和结果按 toolUseId 配对，旧记录按顺序配给还在运行的调用", () => {
  let calls = applyToolEvent([], { kind: "tool", name: "Read", input: { file_path: "a.txt" }, toolUseId: "t1" });
  calls = applyToolEvent(calls, { kind: "tool", name: "Bash", input: { command: "rm -rf x" }, toolUseId: "t2" });
  assert.deepEqual(calls.map((call) => call.status), ["running", "running"]);
  calls = applyToolEvent(calls, { kind: "tool_result", toolUseId: "t2", text: "Error: Permission to use Bash has been denied" });
  calls = applyToolEvent(calls, { kind: "tool_result", toolUseId: "t1", text: "     1→hi" });
  assert.deepEqual(calls.map((call) => call.status), ["ok", "denied"]);
  assert.equal(groupTitle(calls), "执行了 2 步 · 1 步未授权");

  let legacy = applyToolEvent([], { kind: "tool", name: "TaskCreate" });
  legacy = applyToolEvent(legacy, { kind: "tool", name: "TaskCreate" });
  legacy = applyToolEvent(legacy, { kind: "tool_result", text: '[{"type":"text","text":"Task #1 created"}]' });
  assert.deepEqual(legacy.map((call) => [call.status, call.summary]), [["ok", "Task #1 created"], ["running", ""]]);
  assert.equal(groupTitle(legacy), "正在执行第 2 步，共 2 步");

  const orphan = applyToolEvent([], { kind: "tool_result", text: "孤立结果" });
  assert.equal(orphan[0].title, "工具结果");
  assert.equal(applyToolEvent(legacy, { kind: "status", text: "x" }), legacy);
});

test("一轮结束后还没结果的调用标成未完成", () => {
  const calls = applyToolEvent([], { kind: "tool", name: "Bash", input: { command: "svn info" } });
  const settled = settleCalls(calls);
  assert.equal(settled[0].status, "error");
  assert.match(settled[0].summary, /未完成/);
  const done = settleCalls(settled);
  assert.equal(done, settled);
});
