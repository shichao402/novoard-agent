import { ArrowLeft, ExternalLink, Pencil, Play, Square } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { liveText, runResultText, RunStrip, StateBadge, StateIcon } from "@/components/run-bits";
import { RunError, useRunLauncher } from "@/components/run-launcher";
import { Button } from "@/components/ui/button";
import { getRuns, getTargets, type LiveRun, type RunSummary, type TargetDef, type TargetStep, type Tile } from "@/lib/api";
import { href, navigate, useNow } from "@/lib/router";
import { durationBetween, failureText, formatDuration, formatRelative, stateLabel, stepState, triggerLabel } from "@/lib/run-state";
import { formatTime } from "@/lib/utils";

const EXPOSE: Record<string, string> = { a2a: "Hub 可触发", local: "仅本机", none: "隐藏" };
const NOTIFY: Record<string, string> = { always: "总是通知", "on-failure": "失败时通知", never: "不通知" };
const OFFLINE: Record<string, string> = { reject: "离线时拒绝", queue: "离线时排队" };
const AUDIT: Record<string, string> = { summary: "审计摘要", full: "完整审计", none: "不审计" };

export function describeStep(step: TargetStep) {
  if ("uses" in step) {
    const args = Object.entries(step.with ?? {}).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`);
    return { kind: step.uses, detail: [step.cwd ? `cwd=${step.cwd}` : "", ...args].filter(Boolean).join("  ") };
  }
  if ("script" in step) return { kind: "脚本", detail: step.script.split("\n").find((line) => line.trim()) ?? "" };
  if ("openApp" in step) return { kind: "打开应用", detail: step.openApp };
  if ("openPath" in step) return { kind: "打开路径", detail: step.openPath };
  return { kind: "模板", detail: step.template };
}

export function TargetDetailPage({
  base,
  id,
  tab,
  tile,
  onChanged,
}: {
  base: string;
  id: string;
  tab: "overview" | "runs";
  tile: Tile | undefined;
  onChanged: () => void;
}) {
  const [def, setDef] = useState<TargetDef | null | undefined>(undefined);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [live, setLive] = useState<LiveRun[]>([]);
  const [loadError, setLoadError] = useState("");
  const [tick, setTick] = useState(0);
  const launcher = useRunLauncher(base, { onChanged: () => { setTick((n) => n + 1); onChanged(); } });
  const now = useNow(live.length > 0);

  useEffect(() => {
    let cancelled = false;
    getTargets(base)
      .then((body) => { if (!cancelled) setDef(body.targets?.[id] ?? null); })
      .catch((caught: unknown) => { if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "读取失败"); });
    return () => { cancelled = true; };
  }, [base, id]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const load = () => {
      getRuns(base, { target: id, limit: 200 })
        .then((body) => {
          if (cancelled) return;
          setRuns(body.runs);
          setLive(body.live);
          setLoadError("");
          timer = window.setTimeout(load, body.live.length ? 1500 : 5000);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          setLoadError(caught instanceof Error ? caught.message : "读不到运行记录");
          timer = window.setTimeout(load, 5000);
        });
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [base, id, tick]);

  if (def === null) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <a className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink" href={href("targets")}><ArrowLeft size={13} />Target</a>
        <p className="mt-8 text-center text-sm text-muted">找不到 Target <span className="font-mono">{id}</span></p>
      </div>
    );
  }

  const title = def?.title ?? tile?.title ?? id;
  const launchable = { id, title, requiresApproval: def?.requiresApproval ?? tile?.requiresApproval, inputs: tile?.inputs };
  const steps = def?.steps ?? [];
  const runsById = new Map(runs.map((run) => [run.taskId, run]));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <a className="inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-ink" href={href("targets")}><ArrowLeft size={13} />Target</a>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
            <span className="font-mono">{id}</span>
            {def ? <span>{EXPOSE[def.expose] ?? def.expose}</span> : null}
            <span>超时 {def?.timeout ?? tile?.timeout ?? "10m"}</span>
            <span>并发 {def?.concurrency ?? tile?.concurrency ?? 1}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`targets/${id}/edit`)}><Pencil size={13} />编辑</Button>
          <Button variant="accent" size="sm" disabled={launcher.pending === id} onClick={() => launcher.launch(launchable)}><Play size={13} />运行</Button>
        </div>
      </header>

      <RunError message={launcher.error} />
      {loadError ? <p className="text-sm text-bad">{loadError}</p> : null}
      {tile?.problems?.length ? (
        <div className="space-y-2 rounded-xl border border-bad/40 bg-bad/5 px-4 py-3 text-xs text-bad" role="alert">
          {tile.problems.map((p, i) => (
            <div key={`${p.step}-${p.code}-${i}`}>
              <div>第 {p.step} 步 {p.uses}：{p.message}</div>
              <div className="text-muted">{p.action}</div>
            </div>
          ))}
          {tile.problems.some((p) => ["pack-missing", "deps-not-ready", "tool-missing"].includes(p.code)) ? (
            <a className="inline-block text-accent hover:text-accent-hi" href={href("packs")}>去能力包页</a>
          ) : null}
        </div>
      ) : null}

      <nav className="flex gap-1 border-b border-line">
        {([["overview", "概览", `targets/${id}`], ["runs", "运行记录", `targets/${id}/runs`]] as const).map(([key, label, path]) => (
          <a
            key={key}
            href={href(path)}
            className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${tab === key ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {label}
            {key === "runs" && runs.length ? <span className="ml-1 text-faint">{runs.length}</span> : null}
          </a>
        ))}
      </nav>

      {tab === "overview" ? (
        <div className="flex flex-col gap-4">
          {live.map((item) => {
            const summary = runsById.get(item.taskId);
            const total = Math.max(item.total ?? 0, summary?.steps.length ?? 0, steps.length);
            return (
              <section key={item.taskId} className="rounded-2xl border border-accent/40 bg-panel p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <StateBadge state={item.state} />
                  <span className="text-xs text-muted">{liveText(item)}</span>
                  <span className="text-xs text-faint">{triggerLabel(item.trigger)} · {formatDuration(durationBetween(item.startedAt, null, now))}</span>
                  <div className="ml-auto flex gap-2">
                    {item.state !== "input-required" ? (
                      <Button variant="destructive" size="sm" disabled={launcher.canceling === item.taskId} onClick={() => void launcher.cancel(item.taskId)}><Square size={12} />取消</Button>
                    ) : null}
                    <Button variant="secondary" size="sm" onClick={() => navigate(`runs/${item.taskId}`)}><ExternalLink size={13} />查看</Button>
                  </div>
                </div>
                {total > 0 ? (
                  <ol className="mt-3 space-y-1">
                    {Array.from({ length: total }, (_, index) => {
                      const no = index + 1;
                      const record = summary?.steps.find((step) => step.index === no);
                      const state = item.state === "working" ? stepState(record, "working") : "pending";
                      const current = item.state === "working" && item.step === no;
                      const label = record?.command ?? (steps[index] ? describeStep(steps[index]).kind : `第 ${no} 步`);
                      return (
                        <li key={no} className="flex items-center gap-2 text-xs">
                          <StateIcon state={current ? "working" : state} size={13} />
                          <span className="w-6 text-faint">{no}</span>
                          <span className={`min-w-0 flex-1 truncate font-mono ${current ? "text-ink" : "text-muted"}`}>{label}</span>
                          {current && item.message ? <span className="max-w-[40%] truncate text-accent">{item.message}</span> : null}
                          <span className="w-14 text-right text-faint">{record ? formatDuration(durationBetween(record.startedAt, record.endedAt, now)) : ""}</span>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
              </section>
            );
          })}

          <section className="rounded-2xl border border-line bg-panel p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[13px] font-medium">最近运行</h2>
              {runs[0] ? <a className="text-xs text-muted hover:text-ink" href={href(`runs/${runs[0].taskId}`)}>{runResultText(runs[0])} · {formatRelative(runs[0].endedAt ?? runs[0].startedAt)}</a> : <span className="text-xs text-faint">未运行</span>}
            </div>
            <div className="mt-3"><RunStrip runs={runs} /></div>
          </section>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <section className="rounded-2xl border border-line bg-panel p-4">
              <h2 className="text-[13px] font-medium">步骤</h2>
              {def?.template && steps.length === 0 ? (
                <p className="mt-3 text-xs text-muted">模板 <span className="font-mono">{def.template}</span></p>
              ) : (
                <ol className="mt-3 space-y-2">
                  {steps.map((step, index) => {
                    const { kind, detail } = describeStep(step);
                    return (
                      <li key={index} className="flex gap-3 text-xs">
                        <span className="w-5 shrink-0 text-faint">{index + 1}</span>
                        <div className="min-w-0">
                          <div className="font-mono text-ink">{kind}</div>
                          {detail ? <div className="truncate font-mono text-faint" title={detail}>{detail}</div> : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {def?.inputs?.length ? (
                <div className="mt-3 border-t border-line pt-3 text-xs text-muted">
                  输入 {def.inputs.map((input) => input.label || input.name).join("、")}
                </div>
              ) : null}
            </section>
            <div className="flex flex-col gap-4">
              <section className="rounded-2xl border border-line bg-panel p-4">
                <h2 className="text-[13px] font-medium">定时</h2>
                {def?.schedule ? (
                  <dl className="mt-3 space-y-1.5 text-xs">
                    <Row label="表达式"><span className="font-mono">{def.schedule}</span></Row>
                    <Row label="下次">{tile?.nextRun ? formatTime(tile.nextRun) : "—"}</Row>
                    <Row label="上次">
                      {tile?.lastScheduled
                        ? `${stateLabel(tile.lastScheduled.status)}${tile.lastScheduled.at ? ` · ${formatTime(new Date(tile.lastScheduled.at).toISOString())}` : ""}`
                        : "—"}
                    </Row>
                    {def.oncePerDay ? <Row label="每天">最多一次</Row> : null}
                    {def.deadline ? <Row label="截止">{def.deadline}</Row> : null}
                  </dl>
                ) : (
                  <p className="mt-3 text-xs text-faint">无</p>
                )}
              </section>
              <section className="rounded-2xl border border-line bg-panel p-4">
                <h2 className="text-[13px] font-medium">运行方式</h2>
                {def ? (
                  <dl className="mt-3 space-y-1.5 text-xs">
                    <Row label="审批">{def.requiresApproval ? `需要 · ${def.approvalTtl ?? ""}` : "不需要"}</Row>
                    <Row label="通知">{NOTIFY[def.notify] ?? def.notify}</Row>
                    <Row label="离线">{OFFLINE[def.offline ?? "reject"]}{def.offline === "queue" && def.offlineTtl ? ` · ${def.offlineTtl}` : ""}</Row>
                    <Row label="审计">{AUDIT[def.audit] ?? def.audit}</Row>
                    {def.lostTtl ? <Row label="断线判定">{def.lostTtl}</Row> : null}
                  </dl>
                ) : null}
              </section>
            </div>
          </div>
        </div>
      ) : (
        <RunTable runs={runs} now={now} />
      )}
      {launcher.dialogs}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-16 shrink-0 text-faint">{label}</dt>
      <dd className="min-w-0 text-muted">{children}</dd>
    </div>
  );
}

export function RunTable({ runs, now, showTarget = false }: { runs: RunSummary[]; now: number; showTarget?: boolean }) {
  if (runs.length === 0) return <div className="rounded-2xl border border-dashed border-line-hi px-6 py-10 text-center text-sm text-muted">没有运行记录</div>;
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel">
      <table className="w-full table-fixed text-left text-xs">
        <thead className="border-b border-line text-faint">
          <tr>
            <th className="w-28 px-4 py-2 font-normal">状态</th>
            {showTarget ? <th className="px-4 py-2 font-normal">Target</th> : null}
            <th className="w-36 px-4 py-2 font-normal">开始</th>
            <th className="w-20 px-4 py-2 font-normal">触发</th>
            <th className="w-20 px-4 py-2 font-normal">耗时</th>
            <th className="px-4 py-2 font-normal">结果</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map((run) => (
            <tr key={run.taskId} className="cursor-pointer hover:bg-panel-hi/50" onClick={() => navigate(`runs/${run.taskId}`)}>
              <td className="px-4 py-2"><StateBadge state={run.state} /></td>
              {showTarget ? <td className="truncate px-4 py-2 text-ink">{run.title ?? run.target}</td> : null}
              <td className="px-4 py-2 text-muted" title={run.startedAt}>{formatTime(run.startedAt)}</td>
              <td className="px-4 py-2 text-muted">{triggerLabel(run.trigger)}</td>
              <td className="px-4 py-2 text-muted">{formatDuration(run.durationMs ?? durationBetween(run.startedAt, run.endedAt, now))}</td>
              <td className="truncate px-4 py-2 text-muted">{run.live ? liveText(run.live) : failureText(run)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
