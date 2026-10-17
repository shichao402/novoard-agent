import { listen } from "@tauri-apps/api/event";
import { LayoutDashboard, MessageSquare, ScrollText, Settings, SquareTerminal, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { EditionMark } from "@/components/edition-mark";
import { edition } from "@/lib/edition";
import { apiBase, getRuntime, getTiles, type Endpoint, type Runtime, type Tile } from "@/lib/api";
import { ActionsPage } from "@/pages/actions-page";
import { ChatPage } from "@/pages/chat-page";
import { HomePage } from "@/pages/home-page";
import { LogsPage } from "@/pages/logs-page";
import { SettingsPage } from "@/pages/settings-page";
import { SetupPage } from "@/pages/setup-page";
import { TargetsPage } from "@/pages/targets-page";

type View = "home" | "chat" | "actions" | "targets" | "logs" | "settings";

const NAV: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: "home", label: "概览", icon: LayoutDashboard },
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "actions", label: "快捷操作", icon: Zap },
  { id: "targets", label: "Target", icon: SquareTerminal },
  { id: "logs", label: "日志", icon: ScrollText },
  { id: "settings", label: "设置", icon: Settings },
];

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
  const [view, setView] = useState<View>("home");
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);

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
    void listen<{ view: View }>("client-nav", (event) => {
      if (NAV.some((item) => item.id === event.payload.view)) setView(event.payload.view);
    }).then((stop) => unlisten.push(stop));
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
    const load = () => {
      const mine = ++ticket;
      void getRuntime(base).then((value) => { if (!cancelled && mine === ticket) setRuntime(value); }).catch(() => { if (!cancelled && mine === ticket) setRuntime(null); });
      void getTiles(base).then((value) => { if (!cancelled && mine === ticket) setTiles(value.tiles ?? []); }).catch(() => { if (!cancelled && mine === ticket) setTiles([]); });
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, setup]);

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
            const active = view === item.id;
            return (
              <button
                key={item.id}
                className={`flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] ${active ? "bg-panel-hi text-ink" : "text-muted hover:bg-panel hover:text-ink"}`}
                onClick={() => setView(item.id)}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>
        {"__TAURI_INTERNALS__" in window ? (
          <div className="mt-auto px-4 py-4 text-[11px] leading-5 text-faint">关闭窗口后仍留在系统托盘，双击图标可再次打开。</div>
        ) : null}
      </aside>
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="flex h-12 items-center justify-between border-b border-line px-5">
          <div className="text-sm text-muted">{NAV.find((item) => item.id === view)?.label}</div>
          <div className="flex items-center gap-2 text-xs text-muted" aria-live="polite">
            <span className={`size-2 rounded-full ${online ? "bg-good" : hubKnown ? "bg-warn" : "bg-line-hi"}`} />
            {online ? `Hub 在线 · ${runtime?.agentId ?? ""}` : hubKnown ? `Hub 未注册 · ${runtime?.agentId ?? "本机"}` : "正在读取状态"}
          </div>
        </header>
        {hubKnown && !online ? (
          <div className="flex items-center justify-between gap-3 border-b border-line bg-warn/10 px-5 py-2 text-xs text-warn">
            <span>Hub 还没有接受这台成员。检查成员 ID 是否和签发令牌时一致。</span>
            <button className="text-ink underline-offset-2 hover:underline" onClick={() => setView("settings")}>去设置</button>
          </div>
        ) : null}
        <div className={`min-h-0 flex-1 ${view === "chat" || view === "logs" ? "overflow-hidden p-4" : "overflow-auto p-5"}`}>
          {view === "home" ? <HomePage base={base} runtime={runtime} tiles={tiles} onOpen={(next) => setView(next)} /> : null}
          {view === "chat" ? <ChatPage base={base} /> : null}
          {view === "actions" ? <ActionsPage base={base} tiles={tiles} onOpenTargets={() => setView("targets")} /> : null}
          {view === "targets" ? <TargetsPage base={base} /> : null}
          {view === "logs" ? <LogsPage base={base} /> : null}
          {view === "settings" ? <SettingsPage base={base} onRestart={() => setToast("正在用新配置重新连接 Hub…")} /> : null}
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
