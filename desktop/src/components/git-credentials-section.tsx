import { Pencil, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input } from "@/components/ui/input";
import { listGitCredentials, removeGitCredential, saveGitCredential, type GitCredential } from "@/lib/api";

/** 与后端 git-auth.mjs defaultUsername 一致：GitHub 用 x-access-token，其余 oauth2。 */
export function defaultGitUsername(url: string) {
  try {
    return new URL(url.trim()).hostname.toLowerCase() === "github.com" ? "x-access-token" : "oauth2";
  } catch {
    return "oauth2";
  }
}

/**
 * 设置页「Git 凭据」（PRD-7 A8）：私有能力包仓库的访问令牌只存在这台机器，不经过 Hub。
 * 按地址前缀匹配，可以精确到组织或单个仓库；多条命中时取最长的那条。
 */
export function GitCredentialsSection({ base }: { base: string }) {
  const [items, setItems] = useState<GitCredential[]>([]);
  const [editing, setEditing] = useState<GitCredential | null>(null);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [removing, setRemoving] = useState<GitCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [tone, setTone] = useState<"info" | "ok" | "err">("info");

  async function reload() {
    try {
      const body = await listGitCredentials(base);
      setItems(body.credentials ?? []);
    } catch (caught) {
      setTone("err");
      setStatus(caught instanceof Error ? caught.message : "读不到 Git 凭据");
    }
  }

  useEffect(() => {
    void reload();
  }, [base]);

  function startEdit(item: GitCredential | null) {
    setEditing(item);
    setUrl(item?.url ?? "");
    setUsername(item?.username ?? "");
    setToken("");
    setStatus("");
  }

  async function save() {
    setBusy(true);
    setTone("info");
    setStatus("正在保存…");
    try {
      const saved = await saveGitCredential(base, {
        url,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(token ? { token } : {}),
        ...(editing ? { originalUrl: editing.url } : {}),
      });
      startEdit(null);
      setTone("ok");
      setStatus(`已保存 ${saved.credential.url}。之后安装、更新这个地址下的能力包会带上它。`);
      await reload();
    } catch (caught) {
      setTone("err");
      setStatus(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: GitCredential) {
    setBusy(true);
    try {
      await removeGitCredential(base, item.url);
      if (editing?.url === item.url) startEdit(null);
      setTone("ok");
      setStatus(`已删除 ${item.url} 的凭据。`);
      await reload();
    } catch (caught) {
      setTone("err");
      setStatus(caught instanceof Error ? caught.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-panel p-5">
      <div>
        <h2 className="text-sm font-medium">Git 凭据</h2>
        <p className="mt-1 text-xs leading-5 text-muted">
          能力包仓库默认按公开仓拉取。私有仓在这里配一个访问令牌，只存在这台机器上，不会传给 Hub。地址按前缀匹配，可以写到域名、组织或单个仓库。
        </p>
      </div>
      {items.length ? (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {items.map((item) => (
            <li key={item.url} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="break-all font-mono text-[12px]">{item.url}</div>
                <div className="text-[11px] text-faint">{item.username} · 令牌尾号 {item.tokenLastFour}</div>
              </div>
              <button className="rounded-lg p-1.5 text-muted hover:bg-panel-hi hover:text-ink" aria-label={`编辑 ${item.url}`} disabled={busy} onClick={() => startEdit(item)}>
                <Pencil size={14} />
              </button>
              <button className="rounded-lg p-1.5 text-muted hover:bg-panel-hi hover:text-bad" aria-label={`删除 ${item.url}`} disabled={busy} onClick={() => setRemoving(item)}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-faint">还没有凭据。</p>
      )}
      <div className="space-y-3 rounded-xl border border-dashed border-line-hi p-3">
        <div className="text-xs text-muted">{editing ? `编辑 ${editing.url}` : "添加凭据"}</div>
        <Field label="地址" hint="例如 https://git.woa.com/ 或 https://github.com/your-org/。只支持 https / http。">
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://git.woa.com/" spellCheck={false} />
        </Field>
        <Field label="用户名" hint={`留空则用 ${defaultGitUsername(url)}（GitHub 是 x-access-token，其他平台是 oauth2）。`}>
          <Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={defaultGitUsername(url)} spellCheck={false} />
        </Field>
        <Field label="访问令牌" hint={editing ? "留空表示沿用原令牌。" : "个人访问令牌（PAT），只需要读仓库权限。"}>
          <Input value={token} onChange={(event) => setToken(event.target.value)} type="password" placeholder={editing ? "留空则不修改" : "粘贴令牌"} spellCheck={false} />
        </Field>
        <div className="flex gap-2">
          <Button variant="accent" disabled={busy || !url.trim() || (!editing && !token)} onClick={() => void save()}>
            保存凭据
          </Button>
          {editing ? (
            <Button variant="secondary" disabled={busy} onClick={() => startEdit(null)}>
              取消编辑
            </Button>
          ) : null}
        </div>
      </div>
      {status ? <p className={`text-xs leading-5 ${tone === "ok" ? "text-good" : tone === "err" ? "text-bad" : "text-muted"}`}>{status}</p> : null}
      <ConfirmDialog
        open={removing !== null}
        title={`删除 ${removing?.url ?? ""} 的凭据`}
        body="之后这个地址下的私有能力包将无法安装或更新，已装的包不受影响。"
        confirmLabel="删除"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const item = removing;
          setRemoving(null);
          if (item) void remove(item);
        }}
      />
    </section>
  );
}
