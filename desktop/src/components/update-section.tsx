import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { UPDATE_EVENT, type UpdateView } from "@/lib/api";

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function phaseText(view: UpdateView) {
  switch (view.phase) {
    case "disabled":
      return view.message || "此构建未接入自动更新。";
    case "checking":
      return "正在检查更新…";
    case "up-to-date":
      return "已是最新版本。";
    case "available":
      return `发现新版本 ${view.available?.version ?? ""}。`;
    case "downloading": {
      const progress = view.progress;
      if (!progress) return "正在下载更新…";
      const percent = progress.total > 0 ? ` ${Math.floor((progress.received / progress.total) * 100)}%` : "";
      return `正在下载更新${percent}（${formatBytes(progress.received)}${progress.total > 0 ? ` / ${formatBytes(progress.total)}` : ""}）`;
    }
    case "downloaded":
      if (view.waitingForTasks) return view.message || "还有任务在执行，结束后自动安装。";
      return `新版本 ${view.available?.version ?? ""} 已下载，安装时会退出并自动重启。`;
    case "applying":
      return "正在安装更新，应用即将退出并重启…";
    case "fallback":
      return view.message || "这台机器需要手动安装新版本。";
    case "error":
      return view.message || "更新失败。";
    default:
      return view.message || "";
  }
}

export function UpdateSection() {
  const [view, setView] = useState<UpdateView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    invoke<UpdateView>("update_status").then((value) => !cancelled && setView(value)).catch(() => setView(null));
    void listen<UpdateView>(UPDATE_EVENT, (event) => setView(event.payload)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  async function act(command: "update_check" | "update_download" | "update_apply", args?: { force: boolean }) {
    setError("");
    try {
      setView(await invoke<UpdateView>(command, args));
    } catch (caught) {
      setError(typeof caught === "string" ? caught : caught instanceof Error ? caught.message : "操作失败");
    }
  }

  /** 等待任务时给一个逃生口：审批可能挂很久。会中断在途任务，所以先确认。 */
  async function applyNow() {
    const ok = await ask("立即安装会中断正在执行的任务，等待审批的任务也会丢失。确定继续吗？", { title: "立即安装更新", kind: "warning" });
    if (!ok) return;
    void act("update_apply", { force: true });
  }

  if (!view) return null;
  const busy = view.phase === "checking" || view.phase === "downloading" || view.phase === "applying";
  const tone = view.phase === "error" ? "text-bad" : view.phase === "available" || view.phase === "downloaded" ? "text-good" : "text-muted";
  const notes = view.available?.releaseNotes?.trim();

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-panel p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">软件更新</h2>
          <p className="mt-1 text-xs text-muted">
            当前版本 {view.currentVersion}
            {view.enabled ? `（${view.channel === "dev" ? "开发" : "正式"}渠道）` : ""}
          </p>
        </div>
        {view.enabled ? (
          <div className="flex shrink-0 gap-2">
            {view.phase === "available" ? (
              <Button variant="accent" disabled={busy} onClick={() => void act("update_download")}>下载更新</Button>
            ) : view.phase === "downloaded" && view.waitingForTasks ? (
              <Button variant="secondary" disabled={busy} onClick={() => void applyNow()}>立即安装</Button>
            ) : view.phase === "downloaded" ? (
              <Button variant="accent" disabled={busy} onClick={() => void act("update_apply")}>安装并重启</Button>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => void act("update_check")}>检查更新</Button>
            )}
          </div>
        ) : null}
      </div>
      <p className={`text-xs leading-5 ${tone}`}>{phaseText(view)}</p>
      {view.available?.mandatory ? <p className="text-xs leading-5 text-bad">这是一次必须安装的更新。</p> : null}
      {notes && (view.phase === "available" || view.phase === "downloading" || view.phase === "downloaded") ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface px-3 py-2 text-xs leading-5 text-muted">{notes}</pre>
      ) : null}
      {view.available?.releaseNotesUrl ? (
        <p className="select-all break-all text-xs text-muted">发布说明：{view.available.releaseNotesUrl}</p>
      ) : null}
      {view.manualUrl ? <p className="select-all break-all text-xs text-muted">手动下载：{view.manualUrl}</p> : null}
      {error ? <p className="text-xs leading-5 text-bad">{error}</p> : null}
    </section>
  );
}
