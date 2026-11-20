import { ArrowLeft, ChevronDown, ChevronRight, Copy, RotateCw, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { liveText, StateBadge, StateIcon } from "@/components/run-bits";
import { RunError, useRunLauncher } from "@/components/run-launcher";
import { Button } from "@/components/ui/button";
import { getRun, type RunLine, type RunSummary, type Tile } from "@/lib/api";
import { href, navigate, useNow } from "@/lib/router";
import { durationBetween, formatDuration, isLive, parseProgress, stepState, triggerLabel } from "@/lib/run-state";
import { formatTime } from "@/lib/utils";

type Group = { key: string; label: string; index: number | null; lines: RunLine[] };

/** 日志按步归属（ADR-0021）：有 step 字段按字段，老日志按步骤起止时间切；进度行单独抽出。 */
function groupLines(run: RunSummary, lines: RunLine[]) {
  const progress = new Map<number, string>();
  const output: RunLine[] = [];
  for (const line of lines) {
    const hit = parseProgress(line.msg);
    if (hit) progress.set(hit.step, hit.text);
    else output.push(line);
  }
  const tagged = output.some((line) => typeof line.step === "number");
  const steps = new Map<number, RunLine[]>();
  const head: RunLine[] = [];
  const tail: RunLine[] = [];
  const firstStart = run.steps[0]?.startedAt ? Date.parse(run.steps[0].startedAt) : null;
  for (const line of output) {
    let index: number | null = null;
    if (tagged) index = typeof line.step === "number" && line.step > 0 ? line.step : null;
    else if (line.ts) {
      const at = Date.parse(line.ts);
      const found = run.steps.find((step) => step.startedAt && at >= Date.parse(step.startedAt) && (!step.endedAt || at <= Date.parse(step.endedAt)));
      index = found?.index ?? null;
    }
    if (index !== null) steps.set(index, [...(steps.get(index) ?? []), line]);
    else if (firstStart === null || !line.ts || Date.parse(line.ts) < firstStart) head.push(line);
    else tail.push(line);
  }
  return { progress, steps, head, tail };
}

export function RunDetailPage({ base, taskId, tiles, onChanged }: { base: string; taskId: string; tiles: Tile[]; onChanged: () => void }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [lines, setLines] = useState<RunLine[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState(false);
  const launcher = useRunLauncher(base, {
    onStarted: (next) => navigate(`runs/${next}`),
    onChanged: () => { setTick((n) => n + 1); onChanged(); },
  });
  const live = run ? isLive(run.state) : false;
  const now = useNow(live);
  const followRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    setToggled({});
    const load = () => {
      getRun(base, taskId)
        .then((body) => {
          if (cancelled) return;
          setRun(body.run);
          setLines(body.lines);
          setTruncated(body.truncated);
          setError("");
          if (isLive(body.run.state)) timer = window.setTimeout(load, 1000);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setError(caught instanceof Error ? caught.message : "读取失败");
        });
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [base, taskId, tick]);

  const grouped = useMemo(() => (run ? groupLines(run, lines) : null), [run, lines]);

  useEffect(() => {
    const node = followRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines.length]);

  if (!run || !grouped) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <a className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink" href={href("runs")}><ArrowLeft size={13} />运行</a>
        {error ? <p className="mt-8 text-center text-sm text-muted">{error}</p> : null}
      </div>
    );
  }

  const tile = tiles.find((item) => item.id === run.target);
  const current = run.live?.state === "working" ? run.live.step ?? null : null;
  const total = Math.max(run.live?.total ?? 0, run.steps.length, ...run.steps.map((step) => step.index));
  const groups: Group[] = [];
  if (grouped.head.length) groups.push({ key: "head", label: "开始", index: null, lines: grouped.head });
  for (let index = 1; index <= total; index += 1) {
    const step = run.steps.find((item) => item.index === index);
    groups.push({ key: `s${index}`, label: step?.command ?? `第 ${index} 步`, index, lines: grouped.steps.get(index) ?? [] });
  }
  for (const [index, stepLines] of grouped.steps) {
    if (index > total) groups.push({ key: `s${index}`, label: `第 ${index} 步`, index, lines: stepLines });
  }
  if (grouped.tail.length) groups.push({ key: "tail", label: "结束", index: null, lines: grouped.tail });

  function isOpen(group: Group) {
    if (group.key in toggled) return toggled[group.key];
    if (group.index === null) return false;
    if (group.index === current) return true;
    return run?.failedStep?.index === group.index;
  }

  const duration = run.endedAt ? run.durationMs : durationBetween(run.startedAt, null, now);
  const logPath = run.log ? `logs/${run.log}` : "";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <nav className="flex min-w-0 items-center gap-1 text-xs text-muted">
        <a className="hover:text-ink" href={href("runs")}>运行</a>
        <span className="text-faint">/</span>
        <a className="truncate hover:text-ink" href={href(`targets/${run.target}`)}>{run.title ?? run.target}</a>
        <span className="text-faint">/</span>
        <span className="truncate font-mono text-faint">{run.taskId}</span>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-line bg-panel p-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <StateBadge state={run.state} />
            <span className="text-sm text-ink">{run.title ?? run.target}</span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>{formatTime(run.startedAt)}</span>
            {duration !== null && duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
            {run.trigger ? <span>{triggerLabel(run.trigger)}</span> : null}
            {run.live ? <span className="text-accent">{liveText(run.live)}</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {logPath ? (
            <Button
              variant="ghost"
              size="sm"
              title={logPath}
              onClick={() => {
                void navigator.clipboard?.writeText(logPath).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Copy size={13} />{copied ? "已复制" : "原始日志"}
            </Button>
          ) : null}
          {run.live && run.live.state !== "input-required" ? (
            <Button variant="destructive" size="sm" disabled={launcher.canceling === run.taskId} onClick={() => void launcher.cancel(run.taskId)}><Square size={12} />取消</Button>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={launcher.pending === run.target}
            onClick={() => launcher.launch({ id: run.target, title: run.title ?? run.target, requiresApproval: tile?.requiresApproval, inputs: tile?.inputs })}
          >
            <RotateCw size={13} />再次运行
          </Button>
        </div>
      </header>

      <RunError message={launcher.error} />
      {error ? <p className="text-sm text-bad">{error}</p> : null}

      <section className="overflow-hidden rounded-2xl border border-line bg-panel">
        {truncated ? <div className="border-b border-line px-4 py-1.5 text-[11px] text-faint">已截断</div> : null}
        {groups.length === 0 ? <p className="px-4 py-6 text-sm text-muted">没有输出</p> : null}
        <ul className="divide-y divide-line">
          {groups.map((group) => {
            const step = group.index ? run.steps.find((item) => item.index === group.index) : undefined;
            const state = group.index === null ? null : group.index === current ? "working" : stepState(step, run.state);
            const open = isOpen(group);
            const progress = group.index ? grouped.progress.get(group.index) : undefined;
            const following = group.index !== null && group.index === current;
            return (
              <li key={group.key}>
                <button
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-panel-hi/50"
                  aria-expanded={open}
                  onClick={() => setToggled((value) => ({ ...value, [group.key]: !open }))}
                >
                  {open ? <ChevronDown size={14} className="text-faint" /> : <ChevronRight size={14} className="text-faint" />}
                  {state ? <StateIcon state={state} size={14} /> : <span className="w-3.5" />}
                  <span className="w-6 text-xs text-faint">{group.index ?? ""}</span>
                  <span className={`min-w-0 flex-1 truncate font-mono text-xs ${group.index === null ? "text-muted" : "text-ink"}`}>{group.label}</span>
                  {progress && (state === "working" || open) ? <span className="max-w-[35%] truncate text-xs text-accent">{progress}</span> : null}
                  {step?.exit ? <span className="text-xs text-bad">exit {step.exit}</span> : null}
                  <span className="w-16 text-right text-xs text-faint">{step ? formatDuration(durationBetween(step.startedAt, step.endedAt, now)) : ""}</span>
                </button>
                {open ? (
                  <div
                    ref={following ? followRef : undefined}
                    className="max-h-[28rem] overflow-auto border-t border-line bg-canvas px-4 py-2 font-mono text-[12px] leading-6"
                  >
                    {group.lines.length === 0 ? <p className="text-faint">没有输出</p> : group.lines.map((line, index) => (
                      <div key={`${line.ts}-${index}`} className={`whitespace-pre-wrap break-all ${line.level === "error" ? "text-bad" : line.level === "warn" ? "text-warn" : "text-ink"}`}>
                        <span className="mr-2 select-none text-faint">{line.ts ? formatTime(line.ts).slice(-8) : ""}</span>
                        {line.msg}
                      </div>
                    ))}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      {launcher.dialogs}
    </div>
  );
}
