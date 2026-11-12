import { Download, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { listPacks, packAction, type PackEntry } from "@/lib/api";

/**
 * 能力包页（PRD-7 A7/A8）：每行一个来源或一个已装包，显示包名、版本、状态、来源与凭据命中。
 * 来源在 Hub 管理台「能力包来源」页维护；包名默认从仓库的 toolset.json 自动发现。
 * 私有仓的令牌在「设置 → Git 凭据」配，这里只展示命中了哪一条。
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
    const ref = refOf(pack, action);
    if (!ref) return;
    const label = labelOf(pack);
    setBusy(rowKey(pack));
    setError("");
    setNote(`${label}：${action === "install" ? "安装" : action === "update" ? "更新" : "删除"}中…`);
    try {
      const result = await packAction(base, ref, action);
      if (!result.ok) throw new Error(result.reason || "操作失败");
      const extra = "patch" in result && result.patch ? `，本地改动已备份到 ${result.patch}` : "";
      const name = "id" in result && typeof result.id === "string" ? result.id : label;
      setNote(`${name}：${action === "remove" ? "已删除" : `完成${"version" in result && result.version ? ` ${result.version}` : ""}`}${extra}`);
    } catch (caught) {
      setNote("");
      setError(`${label}：${caught instanceof Error ? caught.message : "操作失败"}`);
    } finally {
      setBusy(null);
      setTick((n) => n + 1);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <p className="text-xs leading-5 text-muted">
        来源由 Hub 管理台「能力包来源」页统一维护，连上 Hub 后自动同步到这台机器；包名从仓库里的 toolset.json 自动读取。私有仓请先在「设置 → Git 凭据」配置访问令牌。
      </p>
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
                const key = rowKey(pack);
                const working = pack.busy || busy === key;
                const status = statusOf(pack, working);
                const label = labelOf(pack);
                return (
                  <tr key={key}>
                    <td className="px-4 py-3">
                      {pack.id ? <div className="font-mono text-[13px]">{pack.id}</div> : <div className="text-[13px] text-muted">自动</div>}
                      {pack.id && pack.source?.id ? <div className="text-[11px] text-faint">Hub 指定包名</div> : null}
                      {!pack.id ? <div className="text-[11px] text-faint">安装后从 toolset.json 读取包名</div> : null}
                      {pack.displayName && pack.displayName !== pack.id ? <div className="text-[11px] text-faint">{pack.displayName}</div> : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">{pack.version || "—"}</td>
                    <td className={`max-w-[220px] px-4 py-3 text-xs ${status.tone}`} title={status.detail}>
                      {status.label}
                      {status.detail && status.inline ? <div className="mt-0.5 break-words text-[11px] leading-4 text-faint">{status.detail}</div> : null}
                    </td>
                    <td className="max-w-[280px] px-4 py-3 text-[11px] text-faint">
                      {pack.source ? (
                        <span className="break-all font-mono">{pack.source.git}#{pack.source.branch}{pack.source.subdir ? ` /${pack.source.subdir}` : ""}</span>
                      ) : (
                        "Hub 未登记"
                      )}
                      {pack.credential ? (
                        <div className="mt-1 flex items-center gap-1 text-faint" title={`用户名 ${pack.credential.username}，令牌尾号 ${pack.credential.tokenLastFour}`}>
                          <KeyRound size={11} />凭据 {pack.credential.url}
                        </div>
                      ) : pack.source ? (
                        <div className="mt-1 text-faint">按公开仓访问</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        {pack.installed ? (
                          <IconButton label={`更新 ${label}`} disabled={working} onClick={() => void act(pack, "update")}>
                            <RefreshCw size={14} className={working ? "animate-spin" : ""} />更新
                          </IconButton>
                        ) : (
                          <IconButton label={`安装 ${label}`} disabled={working || !refOf(pack, "install")} onClick={() => void act(pack, "install")}>
                            <Download size={14} />安装
                          </IconButton>
                        )}
                        {onDisk(pack) && pack.id ? (
                          <IconButton label={`删除 ${label}`} disabled={working} onClick={() => setRemoving(pack)}>
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
        title={`删除能力包 ${removing ? labelOf(removing) : ""}`}
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

function rowKey(pack: PackEntry) {
  return pack.installed || onDisk(pack) ? `pack:${pack.id}` : `src:${pack.sourceKey ?? pack.id}`;
}

function labelOf(pack: PackEntry) {
  if (pack.id) return pack.id;
  const s = pack.source;
  if (!s) return "未知来源";
  const repo = s.git.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || s.git;
  return s.subdir ? `${repo}/${s.subdir}` : repo;
}

/** 本机已有克隆目录（已装或目录异常）；来源装失败的问题带 problemCode，不在磁盘上。 */
function onDisk(pack: PackEntry) {
  return pack.installed || Boolean(pack.problem && !pack.problemCode && pack.id);
}

/** 已装的包按包名操作；未装的来源按来源 key 安装，这样包名可以交给 toolset.json 决定。 */
function refOf(pack: PackEntry, action: "install" | "update" | "remove") {
  if (action !== "install" || onDisk(pack)) return pack.id;
  return pack.sourceKey ?? pack.id;
}

function statusOf(pack: PackEntry, working: boolean): { label: string; tone: string; detail?: string; inline?: boolean } {
  if (working) return { label: "处理中…", tone: "text-accent" };
  if (pack.problemCode) {
    const label =
      pack.problemCode === "pack-name-conflict"
        ? "包名冲突"
        : pack.problemCode === "manifest-missing" || pack.problemCode === "manifest-invalid"
          ? "toolset.json 有问题"
          : pack.problemCode === "git-missing"
            ? "本机没有 git"
            : "安装失败";
    return { label, tone: "text-bad", inline: true, ...(pack.problem ? { detail: pack.problem } : {}) };
  }
  if (pack.problem) return { label: "目录异常", tone: "text-bad", detail: pack.problem };
  if (!pack.installed) return pack.source ? { label: "未安装", tone: "text-warn" } : { label: "未安装，来源未知", tone: "text-bad" };
  if (pack.orphan) return { label: "就绪（Hub 已删除来源）", tone: "text-warn", detail: "Hub 不再下发这个来源，仍可使用；不需要时可以删除。" };
  if (pack.depsReady === false) return { label: "依赖未就绪", tone: "text-warn", ...(pack.depsReason ? { detail: pack.depsReason } : {}) };
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
