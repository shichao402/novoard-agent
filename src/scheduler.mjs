/**
 * 定时调度器（PRD-7 A2）。语义以 cronkit 为准：
 * - 时间计算移植自 cronkit src/core/plan.ts（previousFire / nextRunIso / deadlineAtFromCron / wallClockIn）；
 * - tick 与补跑移植自 cronkit orchestrator.ts tick / catchUpNow；
 * - 去重判定移植自 cronkit orchestrator.ts runTarget。
 * 调度器只决定「何时触发哪个 target」，执行、排队、路径锁归 agent-runtime。
 */
import { CronExpressionParser } from "cron-parser";

export const TICK_MS = 20_000;
export const ON_TIME_WINDOW_MS = 3 * 60_000;
export const STARTUP_CATCH_UP_MS = 60_000;

const IN_FLIGHT = new Set(["queued", "running", "working", "input-required"]);
const RETRYABLE_FAIL = new Set(["failed", "canceled", "rejected"]);

export function systemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function nextRunIso(cron, timezone, at = new Date()) {
  try {
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: at }).next().toISOString();
  } catch {
    return null;
  }
}

export function previousFire(cron, timezone, at = new Date()) {
  try {
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: at }).prev().toDate();
  } catch {
    return null;
  }
}

/**
 * deadline（HH:mm，配置时区）映射为具体时刻：触发时刻的 wall-clock 早于 deadline → 当天截止；
 * 否则视为跨午夜窗口 → 次日截止。wall-clock → epoch 用两次偏移迭代，兼容 DST 切换。
 */
export function deadlineAtFromCron(deadline, timezone, triggerTime) {
  if (!deadline) return undefined;
  const match = /^(\d{2}):(\d{2})$/.exec(deadline);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const at = triggerTime instanceof Date ? triggerTime.getTime() : new Date(triggerTime).getTime();
  const triggerWall = wallClockIn(timezone, at);
  const nextDay = triggerWall.hour * 60 + triggerWall.minute >= hour * 60 + minute;
  const deadlineWall = Date.UTC(triggerWall.year, triggerWall.month - 1, triggerWall.day + (nextDay ? 1 : 0), hour, minute);
  const firstGuess = deadlineWall - zoneOffsetMs(timezone, deadlineWall);
  return deadlineWall - zoneOffsetMs(timezone, firstGuess);
}

export function wallClockIn(timezone, epoch) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epoch));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // en-CA 在午夜可能给出 24，归一到 0
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

function zoneOffsetMs(timezone, epoch) {
  const wall = wallClockIn(timezone, epoch);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - epoch;
}

/** 配置时区下的本地日期 YYYY-MM-DD。 */
export function localDate(timezone, at = Date.now()) {
  const w = wallClockIn(timezone, at instanceof Date ? at.getTime() : at);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

export function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function hhmm(timezone, epoch) {
  const w = wallClockIn(timezone, epoch);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * @param getTargets () => 当前（已展开）targets 表
 * @param launch ({ skillId, trigger, deadlineAt, deadlineLabel, onState }) => { ok, reason, retryable?, taskId? }
 * @param state createScheduleState 实例
 */
export function createScheduler({
  getTargets,
  launch,
  state,
  timezone = systemTimezone(),
  catchUpPreviousDays = 1,
  retryFailedOnCatchUp = false,
  now = () => Date.now(),
  log = console,
  tickMs = TICK_MS,
  startupCatchUpMs = STARTUP_CATCH_UP_MS,
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
} = {}) {
  let interval = null;
  let startupTimer = null;

  function scheduledTargets() {
    return Object.entries(getTargets?.() ?? {}).filter(([, t]) => typeof t?.schedule === "string" && t.schedule.trim());
  }

  function dedupKey(id, target, today, prev) {
    return target.oncePerDay === false ? `${id}|${prev.toISOString()}` : `${id}|${today}`;
  }

  function blocked(existing) {
    if (!existing) return false;
    if (IN_FLIGHT.has(existing.status)) return true;
    if (existing.status === "completed") return true;
    return RETRYABLE_FAIL.has(existing.status) && !retryFailedOnCatchUp;
  }

  /** 一次巡检。force=true 为补跑：总开关关闭也执行，且触发超过准点窗口的错过项。返回本次触发列表。 */
  function tick(force = false) {
    if (!force && !state.enabled) return [];
    const at = now();
    const today = localDate(timezone, at);
    const oldest = addDays(today, -catchUpPreviousDays);
    const fired = [];
    for (const [id, target] of scheduledTargets()) {
      const prev = previousFire(target.schedule, timezone, new Date(at));
      if (!prev) continue;
      if (prev.getTime() > at) continue;
      const fireDate = localDate(timezone, prev);
      if (fireDate < oldest || fireDate > today) continue;
      const age = at - prev.getTime();
      if (!force && age > ON_TIME_WINDOW_MS) continue;
      const trigger = age < ON_TIME_WINDOW_MS ? "schedule" : "catch-up";
      const key = dedupKey(id, target, today, prev);
      if (blocked(state.getKey(key))) continue;

      const deadlineAt = deadlineAtFromCron(target.deadline, timezone, trigger === "schedule" ? at : prev);
      const deadlineLabel = deadlineAt === undefined ? undefined : hhmm(timezone, deadlineAt);
      // 先占位再触发：launch 可能同步回调终态（审批挂起、立即失败）
      state.putKey(key, { taskId: null, status: "queued", trigger, slot: prev.toISOString() });
      let result;
      try {
        result = launch({
          skillId: id,
          trigger,
          deadlineAt,
          deadlineLabel,
          onState: (next) => state.updateStatus(key, next),
        });
      } catch (error) {
        result = { ok: false, reason: error?.message ?? String(error) };
      }
      if (!result?.ok && result?.retryable) {
        // 并发已满等可重试拒绝：不留去重记录，下个 tick 重试（PRD-7 A2）
        state.deleteKey(key);
        log.info?.(`[schedule] ${id} 暂不能运行（${result.reason}），下个 tick 重试`);
        continue;
      }
      if (!result?.ok) {
        state.updateStatus(key, "failed");
        log.warn?.(`[schedule] ${id} 触发失败：${result?.reason ?? "未知原因"}`);
        continue;
      }
      const record = state.getKey(key);
      if (record && !record.taskId) state.putKey(key, { ...record, taskId: result.taskId ?? null });
      log.info?.(`[schedule] 触发 ${id} trigger=${trigger} slot=${prev.toISOString()}${deadlineLabel ? ` deadline=${deadlineLabel}` : ""}`);
      fired.push({ id, trigger, key, slot: prev.toISOString(), deadlineAt });
    }
    return fired;
  }

  function catchUp() {
    return tick(true);
  }

  function start() {
    if (interval) return;
    interval = timers.setInterval(() => {
      try { tick(false); } catch (error) { log.error?.(`[schedule] tick 失败：${error?.message ?? error}`); }
    }, tickMs);
    interval?.unref?.();
    // 新增行为（cronkit 没有）：启动后自动补跑一次，补上关机/睡眠期间错过的触发。总开关关闭时不补。
    startupTimer = timers.setTimeout(() => {
      startupTimer = null;
      if (!state.enabled) return;
      try {
        const fired = tick(true);
        if (fired.length) log.info?.(`[schedule] 启动补跑 ${fired.length} 项`);
      } catch (error) {
        log.error?.(`[schedule] 启动补跑失败：${error?.message ?? error}`);
      }
    }, startupCatchUpMs);
    startupTimer?.unref?.();
  }

  function stop() {
    if (interval) timers.clearInterval(interval);
    if (startupTimer) timers.clearTimeout(startupTimer);
    interval = null;
    startupTimer = null;
  }

  function status() {
    const at = new Date(now());
    return {
      enabled: state.enabled,
      timezone,
      targets: scheduledTargets().map(([id, t]) => ({
        id,
        schedule: t.schedule,
        nextRun: nextRunIso(t.schedule, timezone, at),
        last: state.lastByTarget(id),
      })),
    };
  }

  return {
    start,
    stop,
    tick,
    catchUp,
    status,
    setEnabled: (value) => state.setEnabled(value),
    get timezone() {
      return timezone;
    },
  };
}
