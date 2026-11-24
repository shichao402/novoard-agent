import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Activity, LayoutDashboard, MessageSquare, Package, ScrollText, Settings, SquareTerminal, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { EditionMark } from "@/components/edition-mark";
import { edition } from "@/lib/edition";
import { apiBase, getRuntime, getTiles, type Endpoint, type Runtime, type ScheduleInfo, type Tile } from "@/lib/api";
import { href, navigate, sectionOf, useRoute, type Section } from "@/lib/router";
import { ChatPage } from "@/pages/chat-page";
import { HomePage } from "@/pages/home-page";
import { LogsPage } from "@/pages/logs-page";
import { PacksPage } from "@/pages/packs-page";
import { RunDetailPage } from "@/pages/run-detail-page";
import { RunsPage } from "@/pages/runs-page";
import { SettingsPage } from "@/pages/settings-page";
import { SetupPage } from "@/pages/setup-page";
import { ShortcutsPage } from "@/pages/shortcuts-page";
import { TargetDetailPage } from "@/pages/target-detail-page";
import { TargetEditPage } from "@/pages/target-edit-page";
import { TargetsListPage } from "@/pages/targets-list-page";

const NAV: Array<{ id: Section; label: string; icon: typeof LayoutDashboard }> = [
  { id: "home", label: "概览", icon: LayoutDashboard },
  { id: "shortcuts", label: "快捷", icon: Zap },
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "targets", label: "Target", icon: SquareTerminal },
  { id: "runs", label: "运行", icon: Activity },
  { id: "packs", label: "能力包", icon: Package },
  { id: "logs", label: "日志", icon: ScrollText },
  { id: "settings", label: "设置", icon: Settings },
];

/** 托盘菜单等旧入口的视图名 → 路由（PRD-8：actions 并入 targets）。 */
const LEGACY_VIEW: Record<string, string> = { actions: "targets" };

function initialEndpoint(): Endpoint | null {
  const panel = new URLSearchParams(window.location.search).get("panel");
  if (panel) return { view: "panel", panelUrl: panel, url: panel };
  if (window.location.pathname === "/setup") return { view: "setup", url: window.location.origin };
  if (import.meta.env.DEV || "__TAURI_INTERNALS__" in window) return null;
  return { view: "panel", panelUrl: window.location.origin, url: window.location.origin };
}

export function App() {
  const [endpoint, setEndpoint] = useState<Endpoint | null>(initialEndpoint);
  const [notice, setNotice] = useState("正在启动本机 Agent…");
  const [noticeError, setNoticeError] = useState(false);
  const [toast, setToast] = useState("");
  const route = useRoute();
  const section = sectionOf(route);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [schedule, setSchedule] = useState<ScheduleInfo | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick((n) => n + 1);
  const liveCount = tiles.reduce((sum, tile) => sum + (tile.live?.length ?? 0), 0);

  useEffect(() => {
    const unlisten: Array<() => void> = [];
    void listen<Endpoint>("agent-endpoint", (event) => {
      setEndpoint(event.payload);
      setNoticeError(false);
      setNotice("");
    }).then((stop) => unlisten.push(stop));
    void listen<{ message: string; error: boolean }>("agent-status", (event) => {
      setToast(event.payload.message);
      setNoticeError(event.payload.error);
    }).then((stop) => unlisten.push(stop));
    void listen<{ view: string }>("client-nav", (event) => {
      const view = LEGACY_VIEW[event.payload.view] ?? event.payload.view;
      if (NAV.some((item) => item.id === view)) navigate(view);
    }).then((stop) => unlisten.push(stop));
    // sidecar 就绪可能早于本组件挂载（事件已发完），监听注册后补取一次缓存。
    void invoke<Endpoint | null>("agent_endpoint")
      .then((cached) => {
        if (!cached) return;
        setEndpoint((current) => current ?? cached);
        setNoticeError(false);
        setNotice("");
      })
      .catch(() => {
        // 非 Tauri 环境（浏览器直开控制台）没有该命令，忽略。
      });
    return () => unlisten.forEach((stop) => stop());
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const base = apiBase(endpoint);
  const setup = endpoint?.view === "setup";

  useEffect(() => {
    if (!base || setup) return;
    let cancelled = false;
    let ticket = 0;
    let timer = 0;
    const load = () => {
      const mine = ++ticket;
      void getRuntime(base).then((value) => { if (!cancelled && mine === ticket) setRuntime(value); }).catch(() => { if (!cancelled && mine === ticket) setRuntime(null); });
      void getTiles(base)
        .then((value) => {
          if (cancelled || mine !== ticket) return;
          const next = value.tiles ?? [];
          setTiles(next);
          setSchedule(value.schedule ?? null);
          // 有在途时加快刷新，列表进度与角标跟得上
          timer = window.setTimeout(load, next.some((tile) => (tile.live?.length ?? 0) > 0) ? 1500 : 4000);
        })
        .catch(() => {
          if (cancelled || mine !== ticket) return;
          setTiles([]);
          timer = window.setTimeout(load, 4000);
        });
    };
    load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [base, setup, reloadTick]);

  if (!base) {
    return (
      <main className="grid h-full place-items-center">
        <p className={`text-sm ${noticeError ? "text-bad" : "text-muted"}`}>{notice}</p>
      </main>
    );
  }

  if (setup) return <SetupPage base={base} />;

  const online = runtime?.hubRegistered === true;
  const hubKnown = runtime !== null;
  const fill = route.page === "chat" || route.page === "logs";

  return (
    <div className="grid h-dvh max-h-dvh min-h-0 grid-cols-[220px_minmax(0,1fr)] overflow-hidden bg-canvas">
      <aside className="flex min-h-0 flex-col overflow-hidden border-r border-line bg-surface">
        <div className="flex items-center gap-3 px-4 py-5">
          <EditionMark className="size-9 text-sm" />
          <div>
            <div className="text-sm font-semibold">{edition.shortName}</div>
            <div className="text-[11px] text-faint">{edition.subtitle}</div>
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <a
                key={item.id}
                href={href(item.id)}
                className={`flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] ${active ? "bg-panel-hi text-ink" : "text-muted hover:bg-panel hover:text-ink"}`}
              >
                <Icon size={16} />
                {item.label}
                {item.id === "runs" && liveCount > 0 ? (
                  <span className="ml-auto min-w-5 rounded-full bg-accent/20 px-1.5 text-center text-[11px] leading-5 text-accent">{liveCount}</span>
                ) : null}
              </a>
            );
          })}
        </nav>
        {"__TAURI_INTERNALS__" in window ? (
          <div className="mt-auto px-4 py-4 text-[11px] leading-5 text-faint">关闭窗口后仍留在系统托盘，双击图标可再次打开。</div>
        ) : null}
      </aside>
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="flex h-12 items-center justify-between border-b border-line px-5">
          <div className="text-sm text-muted">{NAV.find((item) => item.id === section)?.label}</div>
          <div className="flex items-center gap-2 text-xs text-muted" aria-live="polite">
            <span className={`size-2 rounded-full ${online ? "bg-good" : hubKnown ? "bg-warn" : "bg-line-hi"}`} />
            {online ? `Hub 在线 · ${runtime?.agentId ?? ""}` : hubKnown ? `Hub 未注册 · ${runtime?.agentId ?? "本机"}` : "正在读取状态"}
          </div>
        </header>
        {hubKnown && !online ? (
          <div className="flex items-center justify-between gap-3 border-b border-line bg-warn/10 px-5 py-2 text-xs text-warn">
            <span>Hub 还没有接受这台成员。检查成员 ID 是否和签发令牌时一致。</span>
            <a className="text-ink underline-offset-2 hover:underline" href={href("settings")}>去设置</a>
          </div>
        ) : null}
        <div className={`min-h-0 flex-1 ${fill ? "overflow-hidden p-4" : "overflow-auto p-5"}`}>
          {route.page === "home" ? <HomePage base={base} runtime={runtime} tiles={tiles} onOpen={(next) => navigate(next)} /> : null}
          {route.page === "shortcuts" ? <ShortcutsPage base={base} tiles={tiles} onChanged={reload} /> : null}
          {route.page === "chat" ? <ChatPage base={base} /> : null}
          {route.page === "targets" ? <TargetsListPage base={base} tiles={tiles} schedule={schedule} onChanged={reload} /> : null}
          {route.page === "target-new" ? <TargetEditPage key="new" base={base} id={null} onSaved={reload} /> : null}
          {route.page === "target" ? <TargetDetailPage key={route.id} base={base} id={route.id} tab={route.tab} tile={tiles.find((tile) => tile.id === route.id)} onChanged={reload} /> : null}
          {route.page === "target-edit" ? <TargetEditPage key={route.id} base={base} id={route.id} onSaved={reload} /> : null}
          {route.page === "runs" ? <RunsPage base={base} onChanged={reload} /> : null}
          {route.page === "run" ? <RunDetailPage key={route.taskId} base={base} taskId={route.taskId} tiles={tiles} onChanged={reload} /> : null}
          {route.page === "packs" ? <PacksPage base={base} /> : null}
          {route.page === "logs" ? <LogsPage base={base} /> : null}
          {route.page === "settings" ? <SettingsPage base={base} onRestart={() => setToast("正在用新配置重新连接 Hub…")} /> : null}
        </div>
      </div>
      {toast ? (
        <div className={`fixed bottom-4 right-4 z-20 max-w-sm rounded-xl border border-line bg-panel px-4 py-3 text-sm shadow-xl ${noticeError ? "text-bad" : "text-ink"}`} role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
