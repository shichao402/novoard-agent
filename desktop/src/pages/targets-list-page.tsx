import { AlertTriangle, Clock, Laptop, Play, Plus, RotateCcw, Search, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { liveText, StateDot } from "@/components/run-bits";
import { RunError, useRunLauncher } from "@/components/run-launcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { catchUpNow, setScheduleEnabled, type ScheduleInfo, type Tile } from "@/lib/api";
import { href, navigate, useNow } from "@/lib/router";
import { durationBetween, formatDuration, formatRelative, isFailure, stateLabel, triggerLabel } from "@/lib/run-state";
import { formatTime } from "@/lib/utils";

type Filter = "all" | "running" | "failed" | "scheduled" | "local" | "problems";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "running", label: "运行中" },
  { id: "failed", label: "失败" },
  { id: "scheduled", label: "定时" },
  { id: "local", label: "仅本机" },
  { id: "problems", label: "有问题" },
];

export function lastState(tile: Tile) {
  return tile.lastRun?.state ?? tile.last?.state ?? null;
}

function matches(tile: Tile, filter: Filter) {
  switch (filter) {
    case "running":
      return (tile.live?.length ?? 0) > 0;
    case "failed":
      return isFailure(lastState(tile));
    case "scheduled":
      return Boolean(tile.schedule);
    case "local":
      return tile.expose === "local";
    case "problems":
      return (tile.problems?.length ?? 0) > 0;
    default:
      return true;
  }
}

export function TargetsListPage({
  base,
  tiles,
  schedule,
  onChanged,
}: {
  base: string;
  tiles: Tile[];
  schedule: ScheduleInfo | null;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleNote, setScheduleNote] = useState("");
  const launcher = useRunLauncher(base, { onChanged });
  const anyLive = tiles.some((tile) => (tile.live?.length ?? 0) > 0);
  const now = useNow(anyLive);

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((item) => [item.id, tiles.filter((tile) => matches(tile, item.id)).length])) as Record<Filter, number>, [tiles]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tiles.filter((tile) => matches(tile, filter) && (!needle || tile.id.toLowerCase().includes(needle) || tile.title.toLowerCase().includes(needle)));
  }, [tiles, filter, query]);

  async function toggleSchedule(enabled: boolean) {
    setScheduleBusy(true);
    launcher.setError("");
    try {
      await setScheduleEnabled(base, enabled);
      setScheduleNote("");
      onChanged();
    } catch (caught) {
      launcher.setError(caught instanceof Error ? caught.message : "切换失败");
    } finally {
      setScheduleBusy(false);
    }
  }

  async function catchUp() {
    setScheduleBusy(true);
    launcher.setError("");
    try {
      const result = await catchUpNow(base);
      setScheduleNote(result.fired.length ? `已补跑 ${result.fired.map((f) => f.id).join("、")}` : "没有需要补跑的");
      onChanged();
    } catch (caught) {
      launcher.setError(caught instanceof Error ? caught.message : "补跑失败");
    } finally {
      setScheduleBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      {schedule && counts.scheduled > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3">
          <Clock size={16} className="text-muted" />
          <span className="text-sm">定时</span>
          <Switch checked={schedule.enabled} label="定时总开关" onChange={(next) => { if (!scheduleBusy) void toggleSchedule(next); }} />
          <span className="text-xs text-muted">{schedule.enabled ? "已开启" : "已关闭"} · {schedule.timezone}</span>
          {scheduleNote ? <span className="text-xs text-faint">{scheduleNote}</span> : null}
          <button
            className="ml-auto flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-xs text-muted hover:bg-panel-hi hover:text-ink disabled:opacity-60"
            disabled={scheduleBusy}
            onClick={() => void catchUp()}
          >
            <RotateCcw size={13} />
            立即补跑
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input className="pl-8" placeholder="搜索 id 或标题" value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} />
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              className={`h-8 rounded-lg px-3 text-xs ${filter === item.id ? "bg-panel-hi text-ink" : "text-muted hover:bg-panel hover:text-ink"} ${item.id === "problems" && counts.problems > 0 && filter !== item.id ? "text-bad" : ""}`}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              {item.id !== "all" && counts[item.id] > 0 ? <span className="ml-1 text-faint">{counts[item.id]}</span> : null}
            </button>
          ))}
        </div>
        <Button className="ml-auto" variant="accent" size="sm" onClick={() => navigate("targets/new")}><Plus size={14} />新建</Button>
      </div>

      <RunError message={launcher.error} />

      {tiles.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-hi px-6 py-16 text-center">
          <p className="text-sm text-muted">还没有 Target</p>
          <a className="mt-3 inline-block text-[13px] text-accent hover:text-accent-hi" href={href("targets/new")}>新建</a>
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-hi px-6 py-10 text-center text-sm text-muted">没有匹配的 Target</div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
          {shown.map((tile) => {
            const live = tile.live ?? [];
            const current = live[0];
            const state = current?.state ?? lastState(tile);
            const problems = tile.problems ?? [];
            const open = expanded === tile.id;
            return (
              <li key={tile.id} className={problems.length ? "bg-bad/5" : ""}>
                <div
                  role="link"
                  tabIndex={0}
                  className="grid cursor-pointer grid-cols-[auto_minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 hover:bg-panel-hi/50"
                  onClick={() => navigate(`targets/${tile.id}`)}
                  onKeyDown={(event) => { if (event.key === "Enter") navigate(`targets/${tile.id}`); }}
                >
                  <StateDot state={state} />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className={`truncate text-sm ${problems.length ? "text-bad" : "text-ink"}`}>{tile.title}</span>
                      {tile.expose === "local" ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line-hi px-1.5 py-px text-[10px] leading-4 text-muted"
                          title="仅本机：Hub 上看不到，也不能从 Hub 触发"
                        >
                          <Laptop size={11} />
                          仅本机
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-[11px] text-faint">{tile.id}</div>
                  </div>
                  <div className="min-w-0 truncate text-xs text-muted">
                    {current ? (
                      <>
                        <span className="text-accent">{liveText(current)}</span>
                        {current.state === "working" ? ` · ${formatDuration(durationBetween(current.startedAt, null, now))}` : ""}
                        {live.length > 1 ? ` · 共 ${live.length} 个` : ""}
                      </>
                    ) : tile.lastRun ? (
                      [stateLabel(tile.lastRun.state), formatRelative(tile.lastRun.endedAt ?? tile.lastRun.startedAt), formatDuration(tile.lastRun.durationMs), triggerLabel(tile.lastRun.trigger)].filter(Boolean).join(" · ")
                    ) : tile.last ? (
                      [stateLabel(tile.last.state), formatRelative(tile.last.at)].filter(Boolean).join(" · ")
                    ) : (
                      <span className="text-faint">未运行</span>
                    )}
                  </div>
                  <div className="min-w-0 truncate text-[11px] text-faint">
                    {tile.schedule ? (
                      <span title={tile.schedule}>
                        <Clock size={11} className="mr-1 inline -translate-y-px" />
                        {tile.nextRun ? formatTime(tile.nextRun) : <span className="font-mono">{tile.schedule}</span>}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
                    {problems.length ? (
                      <button
                        className="grid size-8 place-items-center rounded-full text-bad hover:bg-bad/15"
                        aria-label="查看问题"
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? null : tile.id)}
                      >
                        <AlertTriangle size={14} />
                      </button>
                    ) : null}
                    {current && current.state !== "input-required" ? (
                      <button
                        className="grid size-8 place-items-center rounded-full text-muted hover:bg-panel-hi hover:text-bad disabled:opacity-50"
                        aria-label={`取消 ${tile.title}`}
                        disabled={launcher.canceling === current.taskId}
                        onClick={() => void launcher.cancel(current.taskId)}
                      >
                        <Square size={13} />
                      </button>
                    ) : null}
                    <button
                      className="grid size-8 place-items-center rounded-full bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50"
                      aria-label={`运行 ${tile.title}`}
                      disabled={launcher.pending === tile.id}
                      onClick={() => launcher.launch(tile)}
                    >
                      <Play size={14} />
                    </button>
                  </div>
                </div>
                {open && problems.length ? (
                  <div className="space-y-2 px-4 pb-3 pl-10 text-xs text-bad" role="alert">
                    {problems.map((p, i) => (
                      <div key={`${p.step}-${p.code}-${i}`}>
                        <div>第 {p.step} 步 {p.uses}：{p.message}</div>
                        <div className="text-muted">{p.action}</div>
                      </div>
                    ))}
                    {problems.some((p) => ["pack-missing", "deps-not-ready", "tool-missing"].includes(p.code)) ? (
                      <a className="inline-block text-accent hover:text-accent-hi" href={href("packs")}>去能力包页</a>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {launcher.dialogs}
    </div>
  );
}
