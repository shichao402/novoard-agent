import { useEffect, useState } from "react";
import { getActivity, type ActivityEvent, type Runtime, type Tile } from "@/lib/api";
import { formatTime } from "@/lib/utils";

export function HomePage({
  base,
  runtime,
  tiles,
  onOpen,
}: {
  base: string;
  runtime: Runtime | null;
  tiles: Tile[];
  onOpen: (view: "actions" | "chat") => void;
}) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void getActivity(base).then((body) => { if (!cancelled) setEvents(body.events ?? []); }).catch(() => { if (!cancelled) setEvents([]); });
    };
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base]);

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
          <button className="text-[13px] text-accent hover:text-accent-hi" onClick={() => onOpen("actions")}>快捷操作</button>
        </div>
        {events.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-line-hi px-4 py-8 text-center">
            <p className="text-sm text-muted">这台电脑还没有执行记录。重启之后这里仍会保留。</p>
            <button className="mt-3 text-[13px] text-accent hover:text-accent-hi" onClick={() => onOpen("chat")}>让 Agent 帮你配置或执行</button>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-line">
            {events.slice(0, 8).map((event, index) => (
              <li key={`${event.taskId ?? event.ts}-${index}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="truncate text-ink">{event.target || "hub"}</span>
                <span className="shrink-0 text-muted">{event.outcome || ""}</span>
                <span className="shrink-0 text-xs text-faint">{formatTime(event.ts)}</span>
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
