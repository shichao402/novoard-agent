/**
 * 定时调度持久状态（PRD-7 A2，移植自 cronkit src/core/store.ts 的 schedulerEnabled 与 keyed）。
 * 文件：<dataDir>/schedule-state.json，tmp + rename 原子写。
 * - enabled：定时总开关，缺省关闭（与 cronkit 相同）。
 * - keyed：去重记录 key → { taskId, status, at }。key 由调度器决定（<targetId>|<本地日期> 或 <targetId>|<触发时刻 ISO>）。
 * 进程异常退出时残留的 queued/running 记录在装载时改记为 failed（cronkit markStaleRunning）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const KEEP_DAYS = 14;
const IN_FLIGHT = new Set(["queued", "running"]);

export function scheduleStatePath(dataDir) {
  return join(dataDir, "schedule-state.json");
}

export function createScheduleState({ file, now = () => Date.now() } = {}) {
  if (!file) throw new Error("schedule-state 需要 file");
  const data = read(file);
  let staleFixed = false;
  for (const record of Object.values(data.keyed)) {
    if (IN_FLIGHT.has(record.status)) {
      record.status = "failed";
      record.note = "进程异常退出";
      staleFixed = true;
    }
  }
  if (staleFixed) flush();

  function flush() {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, file);
  }

  function prune() {
    const cutoff = now() - KEEP_DAYS * 86_400_000;
    for (const [key, record] of Object.entries(data.keyed)) {
      if (!Number.isFinite(record.at) || record.at < cutoff) delete data.keyed[key];
    }
  }

  return {
    get enabled() {
      return data.enabled === true;
    },
    setEnabled(value) {
      data.enabled = value === true;
      flush();
      return data.enabled;
    },
    getKey(key) {
      return data.keyed[key] ?? null;
    },
    putKey(key, record) {
      data.keyed[key] = { ...record, at: now() };
      prune();
      flush();
    },
    deleteKey(key) {
      if (!(key in data.keyed)) return;
      delete data.keyed[key];
      flush();
    },
    /** 只更新状态，不刷新 at（去重记录按首次写入时间过期）。 */
    updateStatus(key, status) {
      const record = data.keyed[key];
      if (!record) return;
      record.status = status;
      flush();
    },
    /** 最近一次定时/补跑结果，控制台磁贴用（A7）。 */
    lastByTarget(targetId) {
      let best = null;
      for (const [key, record] of Object.entries(data.keyed)) {
        if (!key.startsWith(`${targetId}|`)) continue;
        if (!best || record.at > best.at) best = record;
      }
      return best;
    },
    snapshot() {
      return structuredClone(data);
    },
  };
}

function read(file) {
  const empty = { version: 1, enabled: false, keyed: {} };
  if (!existsSync(file)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version !== 1) return empty;
    return {
      version: 1,
      enabled: parsed.enabled === true,
      keyed: parsed.keyed && typeof parsed.keyed === "object" ? parsed.keyed : {},
    };
  } catch {
    return empty;
  }
}
