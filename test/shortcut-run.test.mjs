import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentRuntime } from "../src/agent-runtime.mjs";
import { parseDuration } from "../src/duration.mjs";
import { createRunner } from "../src/runner.mjs";
import { createShortcutRun, pruneShortcutLogs } from "../src/shortcut-log.mjs";

/** 平台无关的等待命令：先立刻输出标记再用平台自带的计时手段阻塞。
 *  不能用 ping -n，macOS/BSD 的 ping 里 -n 是 "不解析域名"，参数会直接报错退出。 */
const MARKER = "pause-marker";
const PAUSE = process.platform === "win32"
  ? `echo ${MARKER} && ping -n 2 127.0.0.1 >nul`
  : `echo ${MARKER} && sleep 1`;
const PAUSE_LONG = process.platform === "win32"
  ? `echo ${MARKER} && ping -n 20 127.0.0.1 >nul`
  : `echo ${MARKER} && sleep 20`;

test("时长按秒分时天换算，不合法时用默认", () => {
  assert.equal(parseDuration("30s", 0), 30_000);
  assert.equal(parseDuration("10m", 0), 600_000);
  assert.equal(parseDuration("1h", 0), 3_600_000);
  assert.equal(parseDuration("2d", 0), 172_800_000);
  assert.equal(parseDuration("soon", 1234), 1234);
});

test("快捷方式日志超过 30 天会被清掉，新的留下", () => {
  const root = mkdtempSync(join(tmpdir(), "novoard-shortcut-"));
  const oldDir = join(root, "old-target");
  mkdirSync(oldDir, { recursive: true });
  const oldFile = join(oldDir, "task-old.jsonl");
  writeFileSync(oldFile, "{\"msg\":\"old\"}\n");
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(oldFile, old, old);

  const keepDir = join(root, "keep");
  mkdirSync(keepDir, { recursive: true });
  const keepFile = join(keepDir, "task-keep.jsonl");
  writeFileSync(keepFile, "{\"msg\":\"keep\"}\n");
  const recent = new Date(Date.now() - 24 * 60 * 60 * 1000);
  utimesSync(keepFile, recent, recent);

  const run = createShortcutRun({ root, targetId: "echo", taskId: "task-new" });
  run.info("hello");
  assert.equal(existsSync(oldFile), false);
  assert.equal(existsSync(keepFile), true);
  assert.match(readFileSync(run.file, "utf8"), /hello/);
  assert.equal(pruneShortcutLogs(root, Date.now(), 0) >= 1, true);
});

test("同一个快捷方式默认不能重叠，主日志只留路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "novoard-runtime-"));
  const lines = [];
  const runtime = createAgentRuntime({
    shortcutLogDir: root,
    log: { info(message) { lines.push(String(message)); } },
    targets: {
      echo: {
        title: "echo",
        expose: "local",
        audit: "none",
        requiresApproval: false,
        notify: "never",
        steps: [{ script: PAUSE }],
      },
    },
  });
  const first = runtime.launch({ taskId: "task-one", skillId: "echo", vars: {}, steps: [{ script: PAUSE }] });
  const second = runtime.launch({ taskId: "task-two", skillId: "echo", vars: {}, steps: [{ script: PAUSE }] });
  assert.equal(first.ok, true);
  assert.match(first.log, /^shortcuts\/echo\/task-one\.jsonl$/);
  assert.equal(second.ok, false);
  assert.match(second.reason, /并发已满/);
  const joined = lines.join("\n");
  assert.match(joined, /\[shortcut\] 开始 target=echo task=task-one log=shortcuts\/echo\/task-one\.jsonl/);
  assert.match(joined, /\[shortcut\] 拒绝 target=echo task=task-two 并发已满（1\/1）/);
  assert.equal(joined.includes(MARKER), false);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.match(lines.join("\n"), /\[shortcut\] 结束 target=echo task=task-one state=completed/);
  const internal = readFileSync(join(root, "echo", "task-one.jsonl"), "utf8");
  assert.match(internal, new RegExp(MARKER));
  assert.equal(existsSync(join(root, "echo", "task-two.jsonl")), false);
});

test("并发设为 2 时同一次快捷方式可以重叠", async () => {
  const runtime = createAgentRuntime({
    log: { info() {} },
    targets: {
      echo: {
        title: "echo",
        concurrency: 2,
        expose: "local",
        audit: "none",
        requiresApproval: false,
        notify: "never",
        steps: [{ script: PAUSE }],
      },
    },
  });
  const steps = [{ script: PAUSE }];
  const first = runtime.launch({ taskId: "task-a", skillId: "echo", vars: {}, steps });
  const second = runtime.launch({ taskId: "task-b", skillId: "echo", vars: {}, steps });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 2500));
});

test("运行超时会停掉快捷方式，超时细节不进主日志", async () => {
  const lines = [];
  const outputs = [];
  const result = await createRunner({
    steps: [{ script: PAUSE_LONG }],
    timeoutMs: 400,
    onOutput(stream, text) { outputs.push(`${stream}:${text}`); },
  }).run();
  assert.equal(result.ok, false);
  assert.equal(result.stderr, "运行超时");
  assert.equal(outputs.some((line) => line.includes(MARKER)), true);

  const root = mkdtempSync(join(tmpdir(), "novoard-timeout-"));
  const runtime = createAgentRuntime({
    shortcutLogDir: root,
    log: { info(message) { lines.push(String(message)); } },
    targets: {
      hang: {
        title: "hang",
        timeout: "1s",
        expose: "local",
        audit: "none",
        requiresApproval: false,
        notify: "never",
        steps: [{ script: PAUSE_LONG }],
      },
    },
  });
  const launched = runtime.launch({
    taskId: "task-hang",
    skillId: "hang",
    vars: {},
    steps: [{ script: PAUSE_LONG }],
  });
  assert.equal(launched.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const joined = lines.join("\n");
  assert.match(joined, /state=failed/);
  assert.equal(joined.includes(MARKER), false);
  assert.match(readFileSync(join(root, "hang", "task-hang.jsonl"), "utf8"), /运行超时/);
});
