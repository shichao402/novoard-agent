import { AlertTriangle, Clock, Play, RotateCcw, ScrollText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import type { ScheduleInfo, Tile } from "@/lib/api";
import { catchUpNow, getShortcutLog, getShortcutRuns, runTarget, setScheduleEnabled, type ShortcutRun } from "@/lib/api";
import { formatTime } from "@/lib/utils";

const STATE_LABEL: Record<string, string> = { completed: "完成", failed: "失败", canceled: "已取消", rejected: "被拒绝", queued: "排队中", running: "运行中", working: "运行中", "input-required": "等待确认" };

export function ActionsPage({
  base,
  tiles,
  schedule,
  onChanged,
  onOpenTargets,
  onOpenPacks,
}: {
  base: string;
  tiles: Tile[];
  schedule: ScheduleInfo | null;
  onChanged: () => void;
  onOpenTargets: () => void;
  onOpenPacks: () => void;
}) {
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleNote, setScheduleNote] = useState("");
  const hasScheduled = tiles.some((tile) => tile.schedule);

  async function toggleSchedule(enabled: boolean) {
    setScheduleBusy(true);
    setError("");
    try {
      await setScheduleEnabled(base, enabled);
      setScheduleNote(enabled ? "定时已开启" : "定时已关闭，到点不会自动运行");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "切换失败");
    } finally {
      setScheduleBusy(false);
    }
  }

  async function catchUp() {
    setScheduleBusy(true);
    setError("");
    try {
      const result = await catchUpNow(base);
      setScheduleNote(result.fired.length ? `已补跑 ${result.fired.map((f) => f.id).join("、")}` : "没有需要补跑的");
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "补跑失败");
    } finally {
      setScheduleBusy(false);
    }
  }

  const [pending, setPending] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Tile | null>(null);
  const [watch, setWatch] = useState<Tile | null>(null);
  const [runs, setRuns] = useState<ShortcutRun[]>([]);
  const [taskId, setTaskId] = useState("");
  const [logPath, setLogPath] = useState("");
  const [lines, setLines] = useState<Array<{ ts?: string; level?: string; msg?: string }>>([]);
  const [logError, setLogError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);

  async function run(tile: Tile) {
    setPending(tile.id);
    setError("");
    setLive((current) => ({ ...current, [tile.id]: "已提交" }));
    try {
      const result = await runTarget(base, tile.id);
      if (result.error?.message) throw new Error(result.error.message);
      const nextTaskId = result.result?.id;
      if (!nextTaskId) return;
      if (watch?.id === tile.id) setTaskId(nextTaskId);
      const source = new EventSource(`${base}/api/stream/${nextTaskId}`);
      source.onmessage = (event) => {
        const frame = JSON.parse(event.data) as { status?: { state?: string; message?: string }; final?: boolean };
        const state = frame.status?.state || "working";
        const label = state === "working" ? "运行中" : state === "completed" ? "完成" : state === "canceled" ? "已取消" : frame.status?.message || "失败";
        setLive((current) => ({ ...current, [tile.id]: label }));
        if (frame.final) source.close();
      };
      source.onerror = () => source.close();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "执行失败");
      setLive((current) => ({ ...current, [tile.id]: "失败" }));
    } finally {
      setPending(null);
    }
  }

  useEffect(() => {
    if (!watch) return;
    let cancelled = false;
    const current = watch;
    async function loadRuns() {
      try {
        const body = await getShortcutRuns(base, current.id);
        if (cancelled) return;
        setRuns(body.runs);
        setTaskId((selected) => selected || body.runs[0]?.taskId || "");
        setLogError("");
      } catch (caught) {
        if (!cancelled) setLogError(caught instanceof Error ? caught.message : "读不到运行记录");
      }
    }
    void loadRuns();
    const timer = window.setInterval(() => void loadRuns(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, watch]);

  useEffect(() => {
    if (!watch || !taskId) {
      setLines([]);
      setLogPath("");
      return;
    }
    let cancelled = false;
    const current = watch;
    const selected = taskId;
    async function loadLog() {
      try {
        const body = await getShortcutLog(base, current.id, selected);
        if (cancelled) return;
        setLines(body.lines);
        setLogPath(body.log);
        setLogError("");
      } catch (caught) {
        if (!cancelled) setLogError(caught instanceof Error ? caught.message : "读不到这次输出");
      }
    }
    void loadLog();
    const timer = window.setInterval(() => void loadLog(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, watch, taskId]);

  const ordered = [...lines].reverse();
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [ordered.length, taskId]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      {schedule && hasScheduled ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-panel px-4 py-3">
          <Clock size={16} className="text-muted" />
          <span className="text-sm">定时</span>
          <Switch checked={schedule.enabled} label="定时总开关" onChange={(next) => { if (!scheduleBusy) void toggleSchedule(next); }} />
          <span className="text-xs text-muted">{schedule.enabled ? "到点自动运行" : "已关闭"} · 时区 {schedule.timezone}</span>
          <button
            className="ml-auto flex h-8 items-center gap-1 rounded-lg border border-line px-3 text-xs text-muted hover:bg-panel-hi hover:text-ink disabled:opacity-60"
            disabled={scheduleBusy}
            onClick={() => void catchUp()}
          >
            <RotateCcw size={13} />
            立即补跑
          </button>
          {scheduleNote ? <span className="w-full text-[11px] text-faint">{scheduleNote}</span> : null}
        </div>
      ) : null}
      {error ? <p className="mb-3 text-sm text-bad" role="alert">{error}</p> : null}
      {tiles.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-hi px-6 py-16 text-center">
          <p className="text-sm text-muted">还没有可执行的 Target。</p>
          <button className="mt-3 text-[13px] text-accent hover:text-accent-hi" onClick={onOpenTargets}>去添加</button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {tiles.map((tile) => (
            <div key={tile.id} className={`rounded-2xl border bg-panel p-4 ${tile.problems?.length ? "border-bad/60" : "border-line"}`}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{tile.title}</div>
                  <div className="mt-1 font-mono text-[11px] text-faint">{tile.id}</div>
                </div>
                <div className="flex gap-1">
                  <button
                    className="grid size-8 place-items-center rounded-full text-muted hover:bg-panel-hi hover:text-ink"
                    aria-label={`查看 ${tile.title} 的输出`}
                    onClick={() => {
                      setWatch(tile);
                      setTaskId("");
                      setLines([]);
                    }}
                  >
                    <ScrollText size={14} />
                  </button>
                  <button
                    className="grid size-8 place-items-center rounded-full bg-accent/15 text-accent disabled:opacity-60"
                    aria-label={`执行 ${tile.title}`}
                    disabled={pending === tile.id}
                    onClick={() => (tile.requiresApproval ? setConfirm(tile) : void run(tile))}
                  >
                    <Play size={14} />
                  </button>
                </div>
              </div>
              <div className="mt-4 text-xs text-muted">
                {live[tile.id] || (tile.last ? `${tile.last.state === "completed" ? "完成" : tile.last.state === "failed" ? "失败" : tile.last.state} · ${formatTime(tile.last.at)}` : "尚未运行")}
                {tile.requiresApproval ? " · 执行前会再确认" : ""}
              </div>
              <div className="mt-1 text-[11px] text-faint">同时 {tile.concurrency ?? 1} 个 · 超时 {tile.timeout ?? "10m"}</div>
              {tile.schedule ? (
                <div className="mt-1 text-[11px] text-faint">
                  定时 <span className="font-mono">{tile.schedule}</span>
                  {" · 下次 "}{tile.nextRun ? formatTime(tile.nextRun) : "—"}
                  {tile.lastScheduled ? ` · 上次定时 ${STATE_LABEL[tile.lastScheduled.status] ?? tile.lastScheduled.status}${tile.lastScheduled.at ? ` ${formatTime(new Date(tile.lastScheduled.at).toISOString())}` : ""}` : ""}
                </div>
              ) : null}
              {tile.problems?.length ? (
                <div className="mt-3 space-y-2 rounded-xl bg-bad/10 px-3 py-2 text-xs text-bad" role="alert">
                  {tile.problems.map((p, i) => (
                    <div key={`${p.step}-${p.code}-${i}`}>
                      <div className="flex items-start gap-1"><AlertTriangle size={12} className="mt-0.5 shrink-0" />第 {p.step} 步 {p.uses}：{p.message}</div>
                      <div className="ml-4 text-muted">{p.action}</div>
                    </div>
                  ))}
                  {tile.problems.some((p) => ["pack-missing", "deps-not-ready", "tool-missing"].includes(p.code)) ? (
                    <button className="ml-4 text-accent hover:text-accent-hi" onClick={onOpenPacks}>去能力包页</button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {watch ? (
        <section className="mt-4 flex min-h-0 flex-1 flex-col rounded-2xl border border-line bg-panel">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <div className="text-sm font-medium">{watch.title} 的输出</div>
            <select
              className="rounded-lg border border-line bg-canvas px-2 py-1 text-xs"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
            >
              {runs.length === 0 ? <option value="">还没有运行记录</option> : null}
              {runs.map((run) => (
                <option key={run.taskId} value={run.taskId}>{formatTime(run.mtime)} · {run.taskId}</option>
              ))}
            </select>
            <span className="font-mono text-[11px] text-faint">{logPath ? `logs/${logPath}` : ""}</span>
            <button className="ml-auto text-xs text-muted hover:text-ink" onClick={() => setWatch(null)}>关闭</button>
          </div>
          <p className="px-4 pt-2 text-[11px] text-faint">这里只记这个快捷方式自己的输出，默认保留 30 天。主日志里的同一次触发会带上上面这条路径。</p>
          {logError ? <p className="px-4 pt-2 text-sm text-bad">{logError}</p> : null}
          <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[12px] leading-6">
            {ordered.length === 0 ? <p className="text-muted">这次运行还没有输出。</p> : ordered.map((line, index) => (
              <div key={`${line.ts}-${index}`} className={line.level === "error" ? "text-bad" : "text-ink"}>
                <span className="mr-2 text-faint">{line.ts ? formatTime(line.ts) : ""}</span>
                {line.msg}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        title={`执行 ${confirm?.title ?? ""}`}
        body="这个 Target 被标记为需要确认。确认后会通过本机 A2A 立即执行。"
        confirmLabel="执行"
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const tile = confirm;
          setConfirm(null);
          if (tile) void run(tile);
        }}
      />
    </div>
  );
}
