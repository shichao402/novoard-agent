import { Download, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { listPacks, packAction, type PackEntry } from "@/lib/api";

/**
 * 能力包页（PRD-7 A7）：每行一个来源，显示 id、版本、状态，带安装/更新/删除按钮。
 * 来源只读：在 Hub 管理台「能力包来源」页维护，这里没有任何手输字段。
 */
export function PacksPage({ base }: { base: string }) {
  const [packs, setPacks] = useState<PackEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [removing, setRemoving] = useState<PackEntry | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listPacks(base)
        .then((body) => {
          if (cancelled) return;
          setPacks(body.packs ?? []);
          setLoaded(true);
        })
        .catch((caught: unknown) => {
          if (!cancelled) setError(caught instanceof Error ? caught.message : "读不到能力包");
        });
    };
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, tick]);

  async function act(pack: PackEntry, action: "install" | "update" | "remove") {
    setBusy(pack.id);
    setError("");
    setNote(`${pack.id}：${action === "install" ? "安装" : action === "update" ? "更新" : "删除"}中…`);
    try {
      const result = await packAction(base, pack.id, action);
      if (!result.ok) throw new Error(result.reason || "操作失败");
      const extra = "patch" in result && result.patch ? `，本地改动已备份到 ${result.patch}` : "";
      setNote(`${pack.id}：${action === "remove" ? "已删除" : `完成${"version" in result && result.version ? ` ${result.version}` : ""}`}${extra}`);
    } catch (caught) {
      setNote("");
      setError(`${pack.id}：${caught instanceof Error ? caught.message : "操作失败"}`);
    } finally {
      setBusy(null);
      setTick((n) => n + 1);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <p className="text-xs leading-5 text-muted">来源由 Hub 管理台「能力包来源」页统一维护，连上 Hub 后自动同步到这台机器。这里只负责安装、更新和删除。</p>
      {error ? <p className="text-sm text-bad" role="alert">{error}</p> : null}
      {note ? <p className="text-xs text-muted" aria-live="polite">{note}</p> : null}
      {loaded && packs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-hi px-6 py-16 text-center text-sm text-muted">还没有能力包来源。先在 Hub 管理台添加，再回到这里安装。</div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-normal">能力包</th>
                <th className="px-4 py-2 font-normal">版本</th>
                <th className="px-4 py-2 font-normal">状态</th>
                <th className="px-4 py-2 font-normal">来源</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {packs.map((pack) => {
                const working = pack.busy || busy === pack.id;
                const status = statusOf(pack, working);
                return (
                  <tr key={pack.id}>
                    <td className="px-4 py-3">
                      <div className="font-mono text-[13px]">{pack.id}</div>
                      {pack.displayName && pack.displayName !== pack.id ? <div className="text-[11px] text-faint">{pack.displayName}</div> : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">{pack.version || "—"}</td>
                    <td className={`px-4 py-3 text-xs ${status.tone}`} title={status.detail}>{status.label}</td>
                    <td className="max-w-[260px] px-4 py-3 text-[11px] text-faint">
                      {pack.source ? (
                        <span className="break-all font-mono">{pack.source.git}#{pack.source.branch}{pack.source.subdir ? ` /${pack.source.subdir}` : ""}</span>
                      ) : (
                        "Hub 未登记"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {pack.installed ? (
                          <IconButton label={`更新 ${pack.id}`} disabled={working} onClick={() => void act(pack, "update")}>
                            <RefreshCw size={14} className={working ? "animate-spin" : ""} />更新
                          </IconButton>
                        ) : (
                          <IconButton label={`安装 ${pack.id}`} disabled={working || !pack.source} onClick={() => void act(pack, "install")}>
                            <Download size={14} />安装
                          </IconButton>
                        )}
                        {pack.installed || pack.problem ? (
                          <IconButton label={`删除 ${pack.id}`} disabled={working} onClick={() => setRemoving(pack)}>
                            <Trash2 size={14} />
                          </IconButton>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`删除能力包 ${removing?.id ?? ""}`}
        body="删除本机的克隆目录和来源快照。用到它的 Target 会在下次运行前提示缺包。"
        confirmLabel="删除"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const pack = removing;
          setRemoving(null);
          if (pack) void act(pack, "remove");
        }}
      />
    </div>
  );
}

function statusOf(pack: PackEntry, working: boolean): { label: string; tone: string; detail?: string } {
  if (working) return { label: "处理中…", tone: "text-accent" };
  if (pack.problem) return { label: "目录异常", tone: "text-bad", detail: pack.problem };
  if (!pack.installed) return pack.source ? { label: "未安装", tone: "text-warn" } : { label: "未安装，来源未知", tone: "text-bad" };
  if (pack.depsReady === false) return { label: "依赖未就绪", tone: "text-warn", detail: pack.depsReason };
  return { label: "就绪", tone: "text-good" };
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className="flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 text-xs text-muted hover:bg-panel-hi hover:text-ink disabled:opacity-50"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
