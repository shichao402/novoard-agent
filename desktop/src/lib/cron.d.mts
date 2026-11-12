export type Schedule =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekdays: number[]; hour: number; minute: number }
  | { kind: "hourly"; minute: number }
  | { kind: "minutes"; every: number; fromHour: number; toHour: number };

export type ScheduleKind = Schedule["kind"] | "custom";

export const scheduleKindLabels: Record<ScheduleKind, string>;
export const SCHEDULE_KINDS: ScheduleKind[];
export const minuteIntervals: readonly number[];
export const WEEKDAY_ORDER: readonly number[];

export function weekdayLabel(day: number): string;
export function timeValue(hour: number, minute: number): string;
export function parseTimeValue(value: string): { hour: number; minute: number } | null;
export function parseSchedule(cron: string): Schedule | null;
export function buildCron(schedule: Schedule): string;
export function scheduleForKind(kind: Schedule["kind"], base: Schedule | null): Schedule;
export function withTime(schedule: Schedule, hour: number, minute: number): Schedule;
export function describeSchedule(schedule: Schedule): string;
export function describeCron(cron: string): string;
export function isValidCron(cron: string, timezone?: string): boolean;
export function nextRuns(cron: string, timezone: string, count?: number, from?: Date): string[];
export function scheduleOutlook(cron: string, timezone: string, count?: number, from?: Date): { next: string; later: string[] } | null;
