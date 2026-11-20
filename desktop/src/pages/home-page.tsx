import { useEffect, useState } from "react";
import { liveText, StateBadge } from "@/components/run-bits";
import { getRuns, type LiveRun, type RunSummary, type Runtime, type Tile } from "@/lib/api";
import { navigate, useNow } from "@/lib/router";
import { durationBetween, failureText, formatDuration, formatRelative, triggerLabel } from "@/lib/run-state";

const RECENT_LIMIT = 8;

export function HomePage({
  base,
  runtime,
  tiles,
  onOpen,
}: {
  base: string;
  runtime: Runtime | null;
  tiles: Tile[];
  onOpen: (view: "targets" | "runs" | "chat") => void;
}) {
  const [live, setLive] = useState<LiveRun[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const now = useNow(live.length > 0);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = () => {
      getRuns(base, { limit: RECENT_LIMIT })
        .then((body) => {
          if (cancelled) return;
          setLive(body.live);
          setRuns(body.runs);
          setLoaded(true);
          timer = window.setTimeout(load, body.live.length ? 1500 : 5000);
        })
        .catch(() => {
          if (cancelled) return;
          setLoaded(true);
          timer = window.setTimeout(load, 5000);
        });
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [base]);

  const liveIds = new Set(live.map((item) => item.taskId));
  const finished = runs.filter((run) => !liveIds.has(run.taskId));
  const rows: Array<{ kind: "live"; item: LiveRun } | { kind: "run"; item: RunSummary }> = [
    ...live.map((item) => ({ kind: "live" as const, item })),
    ...finished.map((item) => ({ kind: "run" as const, item })),
  ].slice(0, RECENT_LIMIT);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="成员" value={runtime?.agentId || "未接入"} />
        <Stat label="Hub" value={runtime?.hubRegistered ? "在线" : runtime ? "未注册" : "连接中"} tone={runtime?.hubRegistered ? "good" : "warn"} />
        <Stat label="Target" value={String(tiles.length)} />
      </section>
      <section className="rounded-2xl border border-line bg-panel p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">最近执行</h2>
          <button className="text-[13px] text-accent hover:text-accent-hi" onClick={() => onOpen("runs")}>全部运行</button>
        </div>
        {loaded && rows.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-line-hi px-4 py-8 text-center">
            <p className="text-sm text-muted">还没有执行记录</p>
            <button className="mt-3 text-[13px] text-accent hover:text-accent-hi" onClick={() => onOpen("chat")}>让 Agent 帮你配置或执行</button>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {rows.map((row) => (
              <li
                key={row.item.taskId}
                className="-mx-2 grid cursor-pointer grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1.4fr)_4rem_5rem] items-center gap-3 rounded-lg px-2 py-2 text-xs hover:bg-panel-hi/50"
                onClick={() => navigate(`runs/${row.item.taskId}`)}
              >
                <StateBadge state={row.item.state} />
                <span className="truncate text-sm text-ink">{row.item.title ?? row.item.target}</span>
                <span className="truncate text-muted">
                  {row.kind === "live"
                    ? `${liveText(row.item)} · ${formatDuration(durationBetween(row.item.startedAt, null, now))}`
                    : [formatDuration(row.item.durationMs), failureText(row.item)].filter(Boolean).join(" · ")}
                </span>
                <span className="text-muted">{triggerLabel(row.item.trigger)}</span>
                <span className="text-right text-faint">{formatRelative(row.item.startedAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) {
  return (
    <div className="rounded-2xl border border-line bg-panel px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : "text-ink"}`}>{value}</div>
    </div>
  );
}
