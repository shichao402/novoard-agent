import { CheckCircle2, CircleDashed, CircleSlash, Clock, Loader2, SkipForward, XCircle } from "lucide-react";
import type { LiveRun, RunSummary } from "@/lib/api";
import { href } from "@/lib/router";
import { failureText, formatDuration, stateLabel, stateTone, TONE_BG, TONE_TEXT, triggerLabel } from "@/lib/run-state";

export function StateDot({ state, className = "" }: { state?: string | null; className?: string }) {
  const tone = stateTone(state);
  const pulse = state === "working" || state === "submitted" || state === "open";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${TONE_BG[tone]} ${pulse ? "animate-pulse" : ""} ${className}`} aria-label={stateLabel(state)} />;
}

export function StateBadge({ state }: { state?: string | null }) {
  const tone = stateTone(state);
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${TONE_TEXT[tone]}`}>
      <StateDot state={state} />
      {stateLabel(state)}
    </span>
  );
}

export function StateIcon({ state, size = 15 }: { state?: string | null; size?: number }) {
  const cls = TONE_TEXT[stateTone(state)];
  if (state === "completed") return <CheckCircle2 size={size} className={cls} />;
  if (state === "failed" || state === "interrupted" || state === "rejected") return <XCircle size={size} className={cls} />;
  if (state === "canceled") return <CircleSlash size={size} className={cls} />;
  if (state === "skipped") return <SkipForward size={size} className="text-faint" />;
  if (state === "working" || state === "open") return <Loader2 size={size} className={`${cls} animate-spin`} />;
  if (state === "queued" || state === "input-required") return <Clock size={size} className={cls} />;
  return <CircleDashed size={size} className="text-faint" />;
}

/** 在途进度一行：第 i/n 步 · 文本；排队时显示占用者。 */
export function liveText(live: LiveRun) {
  if (live.state === "queued") return live.blockedBy ? `排队中 · 等 ${live.blockedBy}` : live.message || "排队中";
  if (live.state === "input-required") return "等待审批";
  const step = live.step && live.total ? `第 ${live.step}/${live.total} 步` : live.step ? `第 ${live.step} 步` : "";
  return [step, live.message].filter(Boolean).join(" · ") || "运行中";
}

/** 结束运行的一句话：状态 · 耗时 · 触发 · 失败位置。 */
export function runResultText(run: RunSummary) {
  return [stateLabel(run.state), formatDuration(run.durationMs), triggerLabel(run.trigger), failureText(run)].filter(Boolean).join(" · ");
}

/** 最近若干次的状态条，左旧右新，每格可点进运行详情。 */
export function RunStrip({ runs, slots = 20 }: { runs: RunSummary[]; slots?: number }) {
  const shown = runs.slice(0, slots).reverse();
  const empty = Math.max(0, slots - shown.length);
  return (
    <div className="flex items-end gap-1">
      {Array.from({ length: empty }, (_, index) => <span key={`empty-${index}`} className="h-6 w-2.5 rounded-sm bg-panel-hi" />)}
      {shown.map((run) => (
        <a
          key={run.taskId}
          href={href(`runs/${run.taskId}`)}
          title={`${runResultText(run)} · ${run.startedAt}`}
          className={`h-6 w-2.5 rounded-sm ${TONE_BG[stateTone(run.state)]} hover:opacity-70`}
        />
      ))}
    </div>
  );
}
