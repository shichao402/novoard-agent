/**
 * 定时表达式与表单之间的互转（PRD-7 A9），移植自 cronkit `src/renderer/config-editor/cron.ts`。
 * 纯逻辑，供 Target 表单使用，也由 test/target-form.test.mjs 直接测试。
 */
import { CronExpressionParser } from "cron-parser";

export const scheduleKindLabels = {
  daily: "每天",
  weekly: "每周",
  hourly: "每小时",
  minutes: "按分钟间隔",
  custom: "自定义 cron",
};

export const SCHEDULE_KINDS = ["daily", "weekly", "hourly", "minutes", "custom"];
export const minuteIntervals = [5, 10, 15, 20, 30];
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function weekdayLabel(day) {
  return WEEKDAYS[day] ?? String(day);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function fixed(field, max) {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value <= max ? value : null;
}

export function timeValue(hour, minute) {
  return `${pad(hour)}:${pad(minute)}`;
}

export function parseTimeValue(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** 能用表单表示的 cron → Schedule；其余返回 null（界面落到「自定义 cron」）。 */
export function parseSchedule(cron) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minField, hourField, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*") return null;
  const minute = fixed(minField, 59);

  if (dow !== "*") {
    const hour = fixed(hourField, 23);
    if (minute == null || hour == null || !/^[0-6](,[0-6])*$/.test(dow)) return null;
    const weekdays = [...new Set(dow.split(",").map(Number))].sort((a, b) => a - b);
    return { kind: "weekly", weekdays, hour, minute };
  }

  if (minute != null) {
    if (hourField === "*") return { kind: "hourly", minute };
    const hour = fixed(hourField, 23);
    return hour != null ? { kind: "daily", hour, minute } : null;
  }

  const step = /^\*\/(\d{1,2})$/.exec(minField);
  if (!step) return null;
  const every = Number(step[1]);
  if (every < 1 || every > 59) return null;
  if (hourField === "*") return { kind: "minutes", every, fromHour: 0, toHour: 23 };
  const range = /^(\d{1,2})-(\d{1,2})$/.exec(hourField);
  if (range) {
    const fromHour = Number(range[1]);
    const toHour = Number(range[2]);
    if (fromHour <= toHour && toHour <= 23) return { kind: "minutes", every, fromHour, toHour };
  }
  return null;
}

export function buildCron(schedule) {
  switch (schedule.kind) {
    case "daily":
      return `${schedule.minute} ${schedule.hour} * * *`;
    case "weekly": {
      const days = schedule.weekdays.length ? [...schedule.weekdays].sort((a, b) => a - b).join(",") : "*";
      return `${schedule.minute} ${schedule.hour} * * ${days}`;
    }
    case "hourly":
      return `${schedule.minute} * * * *`;
    case "minutes": {
      const allDay = schedule.fromHour === 0 && schedule.toHour === 23;
      return `*/${schedule.every} ${allDay ? "*" : `${schedule.fromHour}-${schedule.toHour}`} * * *`;
    }
    default:
      throw new Error(`未知的定时类型：${schedule.kind}`);
  }
}

/** 切换重复方式时尽量沿用当前时间，避免用户重新填一遍。 */
export function scheduleForKind(kind, base) {
  const hour = base?.kind === "daily" || base?.kind === "weekly" ? base.hour : 2;
  const minute = base && base.kind !== "minutes" ? base.minute : 0;
  switch (kind) {
    case "daily":
      return { kind: "daily", hour, minute };
    case "weekly":
      return { kind: "weekly", weekdays: base?.kind === "weekly" ? base.weekdays : [1], hour, minute };
    case "hourly":
      return { kind: "hourly", minute };
    case "minutes":
      return {
        kind: "minutes",
        every: base?.kind === "minutes" ? base.every : 15,
        fromHour: base?.kind === "minutes" ? base.fromHour : 0,
        toHour: base?.kind === "minutes" ? base.toHour : 23,
      };
    default:
      throw new Error(`未知的定时类型：${kind}`);
  }
}

export function withTime(schedule, hour, minute) {
  return schedule.kind === "daily" || schedule.kind === "weekly" ? { ...schedule, hour, minute } : schedule;
}

export function describeSchedule(schedule) {
  switch (schedule.kind) {
    case "daily":
      return `每天 ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "weekly":
      return `每周${schedule.weekdays.map(weekdayLabel).join("、") || "—"} ${pad(schedule.hour)}:${pad(schedule.minute)}`;
    case "hourly":
      return `每小时第 ${schedule.minute} 分`;
    case "minutes":
      return schedule.fromHour === 0 && schedule.toHour === 23
        ? `每 ${schedule.every} 分钟`
        : `${schedule.fromHour}–${schedule.toHour} 点每 ${schedule.every} 分钟`;
    default:
      return "";
  }
}

export function describeCron(cron) {
  const trimmed = String(cron ?? "").trim();
  if (!trimmed) return "未设置时间";
  const schedule = parseSchedule(trimmed);
  if (schedule) return describeSchedule(schedule);
  if (trimmed.split(/\s+/).length !== 5) return "cron 需要 5 段（分 时 日 月 周）";
  return trimmed;
}

/** cron 能否被调度器解析；与 agent scheduler 用同一个库。 */
export function isValidCron(cron, timezone) {
  const trimmed = String(cron ?? "").trim();
  if (trimmed.split(/\s+/).length !== 5) return false;
  try {
    CronExpressionParser.parse(trimmed, timezone ? { tz: timezone } : {});
    return true;
  } catch {
    return false;
  }
}

export function nextRuns(cron, timezone, count = 3, from = new Date()) {
  try {
    const expr = CronExpressionParser.parse(String(cron).trim(), { tz: timezone, currentDate: from });
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const iso = expr.next().toISOString();
      if (iso) out.push(iso);
    }
    return out;
  } catch {
    return [];
  }
}

function splitLocal(iso, timezone) {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(iso));
    const pick = (type) => parts.find((p) => p.type === type)?.value ?? "";
    const [month, day, hour, minute] = [pick("month"), pick("day"), pick("hour"), pick("minute")];
    if (!month || !day || !hour || !minute) return null;
    return { date: `${month}/${day}`, time: `${hour === "24" ? "00" : hour}:${minute}` };
  } catch {
    return null;
  }
}

/** 紧凑展示接下来的几次触发：首次给完整日期，后续同日只给时间。 */
export function scheduleOutlook(cron, timezone, count = 3, from = new Date()) {
  const runs = nextRuns(cron, timezone, count, from)
    .map((iso) => splitLocal(iso, timezone))
    .filter((item) => item !== null);
  const [first, ...rest] = runs;
  if (!first) return null;
  return {
    next: `${first.date} ${first.time}`,
    later: rest.map((item) => (item.date === first.date ? item.time : `${item.date} ${item.time}`)),
  };
}
