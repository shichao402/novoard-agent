import { Square } from "lucide-react";
import { useEffect, useState } from "react";
import { liveText, StateBadge } from "@/components/run-bits";
import { RunError, useRunLauncher } from "@/components/run-launcher";
import { getRuns, type LiveRun, type RunSummary } from "@/lib/api";
import { href, navigate, useNow } from "@/lib/router";
import { durationBetween, formatDuration, isLive, triggerLabel } from "@/lib/run-state";
import { RunTable } from "@/pages/target-detail-page";

/** 全局运行页（PRD-8 R2）：运行中、排队与等待审批、最近 50 次。 */
export function RunsPage({ base, onChanged }: { base: string; onChanged: () => void }) {
  const [live, setLive] = useState<LiveRun[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const launcher = useRunLauncher(base, { onChanged: () => { setTick((n) => n + 1); onChanged(); } });
  const now = useNow(live.length > 0);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = () => {
      getRuns(base, { limit: 50 })
        .then((body) => {
          if (cancelled) return;
          setLive(body.live);
          setRuns(body.runs);
          setError("");
          timer = window.setTimeout(load, body.live.length ? 1500 : 4000);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setError(caught instanceof Error ? caught.message : "读不到运行记录");
          timer = window.setTimeout(load, 4000);
        });
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [base, tick]);

  const running = live.filter((item) => item.state === "working");
  const waiting = live.filter((item) => item.state !== "working");
  const finished = runs.filter((run) => !isLive(run.state));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <RunError message={launcher.error} />
      {error ? <p className="text-sm text-bad">{error}</p> : null}
      <LiveSection title="运行中" items={running} now={now} launcher={launcher} />
      <LiveSection title="排队与等待审批" items={waiting} now={now} launcher={launcher} />
      <section className="flex flex-col gap-2">
        <h2 className="text-[13px] font-medium">最近完成</h2>
        <RunTable runs={finished} now={now} showTarget />
      </section>
    </div>
  );
}

function LiveSection({ title, items, now, launcher }: { title: string; items: LiveRun[]; now: number; launcher: ReturnType<typeof useRunLauncher> }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[13px] font-medium">{title}{items.length ? <span className="ml-1 text-faint">{items.length}</span> : null}</h2>
      {items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-hi px-4 py-4 text-center text-xs text-faint">无</div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel">
          {items.map((item) => (
            <li
              key={item.taskId}
              className="grid cursor-pointer grid-cols-[7rem_minmax(0,1fr)_minmax(0,1.6fr)_5rem_5rem_auto] items-center gap-3 px-4 py-2.5 text-xs hover:bg-panel-hi/50"
              onClick={() => navigate(`runs/${item.taskId}`)}
            >
              <StateBadge state={item.state} />
              <a className="truncate text-ink hover:underline" href={href(`targets/${item.target}`)} onClick={(event) => event.stopPropagation()}>{item.title ?? item.target}</a>
              <span className="truncate text-muted">{liveText(item)}</span>
              <span className="text-muted">{triggerLabel(item.trigger)}</span>
              <span className="text-muted">{formatDuration(durationBetween(item.startedAt, null, now))}</span>
              <span className="flex justify-end" onClick={(event) => event.stopPropagation()}>
                {item.state !== "input-required" ? (
                  <button
                    className="grid size-7 place-items-center rounded-full text-muted hover:bg-panel-hi hover:text-bad disabled:opacity-50"
                    aria-label="取消"
                    disabled={launcher.canceling === item.taskId}
                    onClick={() => void launcher.cancel(item.taskId)}
                  >
                    <Square size={12} />
                  </button>
                ) : <span className="size-7" />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
