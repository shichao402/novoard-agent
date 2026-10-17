/**
 * 快捷方式自己的输出。
 * 目录：logs/shortcuts/<targetId>/<taskId>.jsonl
 * 主日志只记触发和结束，并用相对路径指到这里。默认保留 30 天。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const SHORTCUT_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TARGET_ID = /^[a-z0-9][a-z0-9-]*$/;
const TASK_ID = /^task-[A-Za-z0-9-]+$/;

export function shortcutLogPath(root, targetId, taskId) {
  const target = safeTarget(targetId);
  const task = safeTask(taskId);
  return {
    dir: join(root, target),
    file: join(root, target, `${task}.jsonl`),
    relative: `shortcuts/${target}/${task}.jsonl`,
  };
}

export function createShortcutRun({ root, targetId, taskId, now = Date.now() }) {
  if (!root) return null;
  const path = shortcutLogPath(root, targetId, taskId);
  pruneShortcutLogs(root, now);
  mkdirSync(path.dir, { recursive: true });
  function write(level, msg) {
    appendFileSync(path.file, `${JSON.stringify({ ts: new Date().toISOString(), level, msg: String(msg) })}\n`);
  }
  return {
    file: path.file,
    relative: path.relative,
    info(msg) { write("info", msg); },
    error(msg) { write("error", msg); },
    output(stream, text) {
      const level = stream === "stderr" ? "error" : "info";
      for (const line of String(text).split(/\r?\n/)) {
        if (line) write(level, line);
      }
    },
  };
}

export function listShortcutRuns(root, targetId) {
  if (!root) return [];
  const target = safeTarget(targetId);
  const dir = join(root, target);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const taskId = name.slice(0, -".jsonl".length);
      const file = join(dir, name);
      const stat = statSync(file);
      return { taskId, bytes: stat.size, mtime: stat.mtime.toISOString(), log: `shortcuts/${target}/${name}` };
    })
    .sort((left, right) => right.mtime.localeCompare(left.mtime));
}

export function shortcutRunFile(root, targetId, taskId) {
  if (!root || !TARGET_ID.test(targetId) || !TASK_ID.test(taskId)) return null;
  const file = shortcutLogPath(root, targetId, taskId).file;
  return existsSync(file) ? file : null;
}

export function pruneShortcutLogs(root, now = Date.now(), retentionMs = SHORTCUT_LOG_RETENTION_MS) {
  if (!root || !existsSync(root)) return 0;
  let removed = 0;
  for (const target of readdirSync(root)) {
    const dir = join(root, target);
    let stat;
    try { stat = statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      let fileStat;
      try { fileStat = statSync(file); } catch { continue; }
      if (!fileStat.isFile()) continue;
      if (now - fileStat.mtimeMs > retentionMs) {
        try { unlinkSync(file); removed += 1; } catch { /* 正在写时留到下一轮 */ }
      }
    }
    try { rmdirSync(dir); } catch { /* 目录里还有记录 */ }
  }
  return removed;
}

function safeTarget(targetId) {
  const value = String(targetId ?? "");
  if (!TARGET_ID.test(value)) throw new Error(`快捷方式 id 不合法：${value}`);
  return value;
}

function safeTask(taskId) {
  const value = String(taskId ?? "");
  if (!TASK_ID.test(value)) throw new Error(`任务 id 不合法：${value}`);
  return value;
}
