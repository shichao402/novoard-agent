import { useState } from "react";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  buildCron,
  describeCron,
  minuteIntervals,
  parseSchedule,
  parseTimeValue,
  SCHEDULE_KINDS,
  scheduleForKind,
  scheduleKindLabels,
  scheduleOutlook,
  timeValue,
  WEEKDAY_ORDER,
  weekdayLabel,
  withTime,
  type Schedule,
  type ScheduleKind,
} from "@/lib/cron.mjs";

type Value = { schedule: string; oncePerDay: boolean; deadline: string };

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_MARKS = Array.from({ length: 12 }, (_, i) => i * 5);
const DEFAULT_CRON = "10 2 * * *";

/** 手写 YAML 可能给出选项以外的值（如每 7 分钟），补进列表以免下拉显示空白。 */
function optionsWith(options: readonly number[], value: number) {
  return options.includes(value) ? [...options] : [...options, value].sort((a, b) => a - b);
}

export function ScheduleEditor({
  value,
  timezone,
  scheduleEnabled,
  onChange,
}: {
  value: Value;
  timezone: string;
  scheduleEnabled: boolean;
  onChange: (patch: Partial<Value>) => void;
}) {
  const cron = value.schedule.trim();
  const on = cron !== "";
  const parsed = on ? parseSchedule(cron) : null;
  // 表达式能被表单表示时也允许停在自定义模式，避免输入过程中被切走
  const [preferCustom, setPreferCustom] = useState(on && !parsed);
  const kind: ScheduleKind | "off" = !on ? "off" : parsed && !preferCustom ? parsed.kind : "custom";
  const outlook = on ? scheduleOutlook(cron, timezone) : null;
  const apply = (schedule: Schedule) => onChange({ schedule: buildCron(schedule) });

  return (
    <section className="space-y-3 rounded-xl border border-line p-4">
      <h3 className="text-[13px] font-medium">定时</h3>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="重复">
          <Select
            value={kind}
            onChange={(event) => {
              const next = event.target.value as ScheduleKind | "off";
              if (next === "off") {
                setPreferCustom(false);
                onChange({ schedule: "" });
                return;
              }
              if (next === "custom") {
                setPreferCustom(true);
                if (!on) onChange({ schedule: DEFAULT_CRON });
                return;
              }
              setPreferCustom(false);
              apply(scheduleForKind(next, parsed));
            }}
          >
            <option value="off">不定时（只手动或 Hub 触发）</option>
            {SCHEDULE_KINDS.map((item) => (
              <option key={item} value={item}>{scheduleKindLabels[item]}</option>
            ))}
          </Select>
        </Field>

        {(kind === "daily" || kind === "weekly") && parsed && "hour" in parsed ? (
          <Field label="时间">
            <Input
              type="time"
              value={timeValue(parsed.hour, parsed.minute)}
              onChange={(event) => {
                const time = parseTimeValue(event.target.value);
                if (time) apply(withTime(parsed, time.hour, time.minute));
              }}
            />
          </Field>
        ) : null}

        {kind === "hourly" && parsed?.kind === "hourly" ? (
          <Field label="每小时第">
            <Select value={parsed.minute} onChange={(event) => apply({ ...parsed, minute: Number(event.target.value) })}>
              {optionsWith(MINUTE_MARKS, parsed.minute).map((minute) => (
                <option key={minute} value={minute}>{minute} 分</option>
              ))}
            </Select>
          </Field>
        ) : null}

        {kind === "minutes" && parsed?.kind === "minutes" ? (
          <>
            <Field label="间隔">
              <Select value={parsed.every} onChange={(event) => apply({ ...parsed, every: Number(event.target.value) })}>
                {optionsWith(minuteIntervals, parsed.every).map((every) => (
                  <option key={every} value={every}>每 {every} 分钟</option>
                ))}
              </Select>
            </Field>
            <Field label="时段">
              <div className="flex items-center gap-2">
                <Select
                  value={parsed.fromHour}
                  onChange={(event) => {
                    const fromHour = Number(event.target.value);
                    apply({ ...parsed, fromHour, toHour: Math.max(fromHour, parsed.toHour) });
                  }}
                >
                  {HOURS.map((hour) => <option key={hour} value={hour}>{hour} 点</option>)}
                </Select>
                <span className="text-xs text-muted">至</span>
                <Select value={parsed.toHour} onChange={(event) => apply({ ...parsed, toHour: Number(event.target.value) })}>
                  {HOURS.filter((hour) => hour >= parsed.fromHour).map((hour) => <option key={hour} value={hour}>{hour} 点</option>)}
                </Select>
              </div>
            </Field>
          </>
        ) : null}

        {kind === "custom" ? (
          <div className="sm:col-span-2">
            <Field label="cron 表达式" hint="5 段：分 时 日 月 周">
              <Input value={value.schedule} spellCheck={false} placeholder="分 时 日 月 周" onChange={(event) => onChange({ schedule: event.target.value })} />
            </Field>
          </div>
        ) : null}
      </div>

      {kind === "weekly" && parsed?.kind === "weekly" ? (
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAY_ORDER.map((day) => {
            const active = parsed.weekdays.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={active}
                className={`h-8 w-9 rounded-lg border text-[13px] ${active ? "border-accent bg-accent/15 text-ink" : "border-line-hi text-muted hover:bg-panel-hi"}`}
                onClick={() => {
                  const weekdays = active ? parsed.weekdays.filter((item) => item !== day) : [...parsed.weekdays, day];
                  if (weekdays.length) apply({ ...parsed, weekdays });
                }}
              >
                {weekdayLabel(day)}
              </button>
            );
          })}
        </div>
      ) : null}

      {on ? (
        <>
          <p className="text-[12px] leading-5">
            {outlook ? (
              <>
                <span className="text-ink">{describeCron(cron)}</span>
                <span className="text-faint">
                  {" · "}下次 {outlook.next}
                  {outlook.later.length ? `，之后 ${outlook.later.join("、")}` : ""} · {timezone}
                </span>
              </>
            ) : (
              <span className="text-bad">{describeCron(cron)} · 无法推算运行时间</span>
            )}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
              <div>
                <div className="text-[13px]">每天只跑一次</div>
                <div className="mt-0.5 text-[11px] leading-5 text-faint">同一天成功过就不再触发；关掉则每个触发时刻都跑</div>
              </div>
              <Switch checked={value.oncePerDay} label="每天只跑一次" onChange={(checked) => onChange({ oncePerDay: checked })} />
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[13px]">硬截止</div>
                <div className="mt-0.5 text-[11px] leading-5 text-faint">到点还没跑完就停下，剩余步骤跳过；可以跨午夜</div>
                {value.deadline ? (
                  <Input className="mt-2 w-32" type="time" value={value.deadline} onChange={(event) => event.target.value && onChange({ deadline: event.target.value })} />
                ) : null}
              </div>
              <Switch checked={value.deadline !== ""} label="硬截止" onChange={(checked) => onChange({ deadline: checked ? "08:00" : "" })} />
            </div>
          </div>
          {!scheduleEnabled ? (
            <p className="text-[12px] text-warn">定时总开关现在是关着的，要到快捷操作页打开，定时才会真正触发。</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
