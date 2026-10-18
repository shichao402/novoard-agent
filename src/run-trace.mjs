/**
 * Target 运行记录（契约 §4.5）。
 * 每个 task 一份追加 JSONL，副作用发生前 fsync。
 * 只用来追溯停在哪一步，不从这里恢复执行。
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
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
