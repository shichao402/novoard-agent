import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunner, openCommand, shellInvocation } from "../src/runner.mjs";

test("Windows 的 script step 按 cmd /d /s /c \"...\" 原样传参", () => {
  const inv = shellInvocation('start "" "C:\\Program Files\\x.exe"', "win32", "C:\\Windows\\system32\\cmd.exe");
  assert.equal(inv.file, "C:\\Windows\\system32\\cmd.exe");
  assert.deepEqual(inv.args, ["/d", "/s", "/c", '"start "" "C:\\Program Files\\x.exe""']);
  assert.equal(inv.verbatim, true);
});

test("非 Windows 仍用 /bin/sh -c，且不关参数转义", () => {
  assert.deepEqual(shellInvocation("echo hi", "darwin"), { file: "/bin/sh", args: ["-c", "echo hi"], verbatim: false });
});

test("Windows 的 openApp 不把反斜杠加倍", () => {
  assert.equal(
    openCommand("C:\\Users\\me\\AppData\\Local\\Novoard Agent Dev\\novoard-agent-desktop.exe", "win32"),
    'start "" "C:\\Users\\me\\AppData\\Local\\Novoard Agent Dev\\novoard-agent-desktop.exe"',
  );
  assert.equal(openCommand("/Applications/A B.app", "darwin"), 'open "/Applications/A B.app"');
  assert.equal(openCommand("http://x", "linux"), 'xdg-open "http://x"');
});

test("Windows 上带引号和空格路径的 script step 能跑完", { skip: process.platform !== "win32" }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "novoard-quote-")), "with space");
  mkdirSync(dir);
  const bat = join(dir, "hello.cmd");
  writeFileSync(bat, "@echo hello-from-space\r\n");
  let out = "";
  const result = await createRunner({
    steps: [{ script: `"${bat}" && echo "done"` }],
    timeoutMs: 15_000,
    onOutput: (kind, text) => { if (kind === "stdout") out += text; },
  }).run();
  assert.equal(result.ok, true, result.stderr);
  assert.match(out, /hello-from-space/);
  assert.match(out, /"done"/);
});
