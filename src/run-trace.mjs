/**
 * Target 运行记录（契约 §4.5）。
 * 每个 task 一份追加 JSONL，副作用发生前 fsync。
 * 只用来追溯停在哪一步，不从这里恢复执行。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const TASK_ID = /^task-[A-Za-z0-9-]+$/;

export function runTracePath(root, taskId) {
  if (!TASK_ID.test(taskId)) throw new Error(`非法 taskId：${taskId}`);
  return join(root, `${taskId}.jsonl`);
}

export function openRunTrace({ root, taskId }) {
  if (!root) return null;
  const file = runTracePath(root, taskId);
  mkdirSync(dirname(file), { recursive: true });
  let seq = countSeq(file);
  return {
    file,
    get seq() { return seq; },
    append(partial) {
      seq += 1;
      const event = {
        seq,
        ts: new Date().toISOString(),
        taskId,
        ...partial,
      };
      durableAppend(file, event);
      return event;
    },
  };
}

/** 没有 run/end 的记录。调用方只上报尾巴，不继续跑。 */
export function listOpenRuns(root) {
  if (!root || !existsSync(root)) return [];
  const open = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".jsonl")) continue;
    const taskId = name.slice(0, -".jsonl".length);
    if (!TASK_ID.test(taskId)) continue;
    const events = readEvents(join(root, name));
    if (events.some((event) => event.type === "run/end")) continue;
    const last = events[events.length - 1];
    if (!last) continue;
    open.push({ taskId, last });
  }
  return open;
}

/** 把未收尾的记录告诉 Hub。不启动 Target。 */
export function reportAbandonedRuns({ root, runningTaskIds = [], onTrace }) {
  const running = new Set(runningTaskIds);
  for (const item of listOpenRuns(root)) {
    if (running.has(item.taskId)) continue;
    onTrace?.(item.taskId, {
      seq: Number(item.last?.seq ?? 0) + 1,
      type: "run/truncated",
      ts: new Date().toISOString(),
      taskId: item.taskId,
      last: item.last,
    });
  }
}

function countSeq(file) {
  return readEvents(file).reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
}

/** 运行记录保留天数，与输出日志一致（ADR-0021）。 */
export const RUN_TRACE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 把一份运行记录收成摘要（ADR-0021）。没有 run/end 的记为 open，由调用方结合在途表判定是否中断。
 * 返回 null 表示记录里连 run/start 都没有。
 */
export function summarizeRun(events, taskId) {
  const start = events.find((event) => event.type === "run/start");
  if (!start) return null;
  const end = [...events].reverse().find((event) => event.type === "run/end");
  const steps = new Map();
  for (const event of events) {
    if (event.type === "step/start") {
      steps.set(event.index, { index: event.index, command: event.command ?? "", startedAt: event.ts, endedAt: null, exit: null });
    } else if (event.type === "step/end") {
      const step = steps.get(event.index) ?? { index: event.index, command: "", startedAt: null };
      steps.set(event.index, { ...step, endedAt: event.ts, exit: Number.isFinite(event.exit) ? event.exit : null });
    }
  }
  const list = [...steps.values()].sort((a, b) => a.index - b.index);
  const failed = list.find((step) => step.exit !== null && step.exit !== 0);
  return {
    taskId,
    target: start.target ?? "",
    trigger: start.trigger ?? "",
    timeout: start.timeout ?? "",
    bootId: start.bootId ?? "",
    startedAt: start.ts,
    endedAt: end?.ts ?? null,
    state: end ? end.state : "open",
    steps: list,
    failedStep: failed ? { index: failed.index, exit: failed.exit } : null,
  };
}

const summaryCache = new Map();

/** 读单次运行摘要；按文件 mtime 与大小缓存。 */
export function readRun(root, taskId) {
  if (!root || !TASK_ID.test(String(taskId ?? ""))) return null;
  const file = join(root, `${taskId}.jsonl`);
  let stat;
  try { stat = statSync(file); } catch { return null; }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = summaryCache.get(file);
  if (cached?.key === key) return cached.summary;
  const summary = summarizeRun(readEvents(file), taskId);
  summaryCache.set(file, { key, summary });
  return summary;
}

/** 列出运行摘要，按开始时间倒序。target 为空时列全部。 */
export function listRuns(root, { target = "", limit = 50 } = {}) {
  if (!root || !existsSync(root)) return [];
  const runs = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".jsonl")) continue;
    const summary = readRun(root, name.slice(0, -".jsonl".length));
    if (!summary) continue;
    if (target && summary.target !== target) continue;
    runs.push(summary);
  }
  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return Number.isInteger(limit) && limit > 0 ? runs.slice(0, limit) : runs;
}

/** 删除超过保留期的运行记录，返回删除数。正在写的文件 mtime 新，不会被删。 */
export function pruneRunTraces(root, now = Date.now(), retentionMs = RUN_TRACE_RETENTION_MS) {
  if (!root || !existsSync(root)) return 0;
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(root, name);
    try {
      if (now - statSync(file).mtimeMs <= retentionMs) continue;
      unlinkSync(file);
      summaryCache.delete(file);
      removed += 1;
    } catch {
      // 读写竞争时留到下一轮
    }
  }
  return removed;
}

function readEvents(file) {
  if (!existsSync(file)) return [];
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.seq) events.push(event);
    } catch {
      // 崩溃留下的半行丢掉，已 fsync 的前缀保留
    }
  }
  return events;
}

function durableAppend(file, event) {
  const fd = openSync(file, "a");
  try {
    writeSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
