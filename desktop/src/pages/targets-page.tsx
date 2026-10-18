import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { getTargets, saveTargets, type TargetDef, type TargetStep } from "@/lib/api";

type Draft = {
  id: string;
  title: string;
  expose: "a2a" | "local";
  audit: "none" | "summary" | "full";
  notify: "always" | "on-failure" | "never";
  requiresApproval: boolean;
  offline: "reject" | "queue";
  offlineTtl: string;
  concurrency: string;
  timeout: string;
  lostTtl: string;
  approvalTtl: string;
  template: string;
  script: string;
  cwd: string;
};

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function clampConcurrency(value: string) {
  const number = Number(value);
  if (!Number.isInteger(number)) return 1;
  return Math.min(32, Math.max(1, number));
}

async function pickDirectory(defaultPath?: string) {
  const options = { directory: true as const, multiple: false as const, title: "选择工作目录" };
  try {
    return await open(defaultPath ? { ...options, defaultPath } : options);
  } catch (error) {
    if (!defaultPath) throw error;
    return await open(options);
  }
}

function toDraft(id: string, target: TargetDef): Draft {
  const step = target.steps?.find((item): item is { script: string; cwd?: string } => "script" in item);
  return {
    id,
    title: target.title,
    expose: target.expose,
    audit: target.audit,
    notify: target.notify,
    requiresApproval: target.requiresApproval,
    offline: target.offline ?? "reject",
    offlineTtl: target.offlineTtl ?? "30m",
    concurrency: String(target.concurrency ?? 1),
    timeout: target.timeout ?? "10m",
    lostTtl: target.lostTtl ?? "10m",
    approvalTtl: target.approvalTtl ?? "10m",
    template: target.template ?? "",
    script: step?.script ?? "",
    cwd: step?.cwd ?? "",
  };
}

function toDef(draft: Draft, previous?: TargetDef): TargetDef {
  const base: TargetDef = {
    title: draft.title.trim(),
    expose: draft.expose,
    audit: draft.audit,
    requiresApproval: draft.requiresApproval,
    notify: draft.notify,
    offline: draft.offline,
    concurrency: clampConcurrency(draft.concurrency),
    timeout: draft.timeout.trim() || "10m",
    lostTtl: draft.lostTtl.trim() || "10m",
    ...(draft.requiresApproval ? { approvalTtl: draft.approvalTtl.trim() || "10m" } : {}),
    ...(draft.offline === "queue" ? { offlineTtl: draft.offlineTtl.trim() || "30m" } : {}),
    vars: previous?.vars ?? {},
  };
  if (draft.template && !draft.script.trim()) {
    return { ...base, template: draft.template };
  }
  const steps: TargetStep[] = [{ script: draft.script.trim(), ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}) }];
  const extra = (previous?.steps ?? []).filter((step) => !("script" in step));
  return { ...base, steps: [...steps, ...extra] };
}

export function TargetsPage({ base }: { base: string }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [original, setOriginal] = useState<Record<string, TargetDef>>({});
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState("[]");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTargets(base)
      .then((body) => {
        if (cancelled) return;
        const entries = Object.entries(body.targets ?? {});
        setOriginal(body.targets ?? {});
        const next = entries.map(([id, target]) => toDraft(id, target));
        setDrafts(next);
        setBaseline(JSON.stringify(next));
        setSelected(0);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "读取失败"));
    return () => {
      cancelled = true;
    };
  }, [base]);

  const current = drafts[selected];

  function update(patch: Partial<Draft>) {
    setDrafts((items) => items.map((item, index) => (index === selected ? { ...item, ...patch } : item)));
  }

  function add() {
    setDrafts((items) => {
      const ids = new Set(items.map((item) => item.id));
      let number = items.length + 1;
      let id = `target-${number}`;
      while (ids.has(id)) {
        number += 1;
        id = `target-${number}`;
      }
      return [
      ...items,
      {
        id,
        title: "新 Target",
        expose: "a2a",
        audit: "summary",
        notify: "on-failure",
        requiresApproval: false,
        offline: "reject",
        offlineTtl: "30m",
        concurrency: "1",
        timeout: "10m",
        lostTtl: "10m",
        approvalTtl: "10m",
        template: "",
        script: "echo hello",
        cwd: "",
      },
    ];
    });
    setSelected(drafts.length);
  }

  function remove() {
    setDrafts((items) => items.filter((_, index) => index !== selected));
    setSelected((index) => Math.max(0, index - 1));
    setConfirmDelete(false);
  }

  async function save() {
    const targets: Record<string, TargetDef> = {};
    for (const draft of drafts) {
      if (!ID_RE.test(draft.id)) {
        setError(`成员内 ID 不合法：${draft.id || "(空)"}。使用小写字母、数字或连字符。`);
        return;
      }
      if (targets[draft.id]) {
        setError(`ID 重复：${draft.id}`);
        return;
      }
      if (!draft.title.trim()) {
        setError(`${draft.id} 缺少标题`);
        return;
      }
      if (!draft.template && !draft.script.trim()) {
        setError(`${draft.id} 需要一条命令`);
        return;
      }
      const durations: Array<[string, string]> = [
        ["运行超时", draft.timeout.trim() || "10m"],
        ["断线后判定丢失", draft.lostTtl.trim() || "10m"],
      ];
      if (draft.requiresApproval) durations.push(["审批等待", draft.approvalTtl.trim() || "10m"]);
      if (draft.offline === "queue") durations.push(["离线排队上限", draft.offlineTtl.trim() || "30m"]);
      const badDuration = durations.find(([, value]) => !/^\d+(s|m|h|d)$/.test(value));
      if (badDuration) {
        setError(`${draft.id} 的${badDuration[0]}需要写成 30s、10m、1h 这种格式`);
        return;
      }
      targets[draft.id] = toDef(draft, original[draft.id]);
    }
    setBusy(true);
    setError("");
    try {
      const result = await saveTargets(base, targets);
      setOriginal(targets);
      setBaseline(JSON.stringify(drafts));
      setStatus(`已保存 ${result.count} 个 Target，并已热生效。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function pickCwd() {
    if (!current || picking) return;
    setPicking(true);
    setError("");
    try {
      const selected = await pickDirectory(current.cwd.trim() || undefined);
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (typeof path === "string" && path) update({ cwd: path });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法打开目录选择器");
    } finally {
      setPicking(false);
    }
  }

  const dirty = JSON.stringify(drafts) !== baseline;

  return (
    <div className="mx-auto grid h-full min-h-0 w-full max-w-6xl gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col rounded-2xl border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-xs text-muted">全部 Target</span>
          <Button variant="ghost" size="icon" onClick={add} aria-label="新建 Target"><Plus size={16} /></Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {drafts.map((draft, index) => (
            <button
              key={`${draft.id}-${index}`}
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-[13px] ${index === selected ? "bg-panel-hi text-ink" : "text-muted hover:bg-panel-hi/60"}`}
              onClick={() => setSelected(index)}
            >
              <div className="truncate">{draft.title || "未命名"}</div>
              <div className="truncate font-mono text-[11px] text-faint">{draft.id}</div>
            </button>
          ))}
        </div>
      </aside>
      <section className="min-h-0 overflow-auto rounded-2xl border border-line bg-panel p-5">
        {current ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium">{dirty ? "编辑 Target · 未保存" : "编辑 Target"}</h2>
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除</Button>
                <Button variant="accent" size="sm" disabled={busy || !dirty} onClick={() => void save()}>保存</Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="ID" hint="保存后 Hub 上的 skill id 就是这个值">
                <Input value={current.id} onChange={(event) => update({ id: event.target.value.trim() })} spellCheck={false} />
              </Field>
              <Field label="标题">
                <Input value={current.title} onChange={(event) => update({ title: event.target.value })} />
              </Field>
              <Field label="暴露范围">
                <Select value={current.expose} onChange={(event) => update({ expose: event.target.value as Draft["expose"] })}>
                  <option value="a2a">Hub 可触发</option>
                  <option value="local">仅本机</option>
                </Select>
              </Field>
              <Field label="失败通知">
                <Select value={current.notify} onChange={(event) => update({ notify: event.target.value as Draft["notify"] })}>
                  <option value="on-failure">仅失败</option>
                  <option value="always">总是</option>
                  <option value="never">不通知</option>
                </Select>
              </Field>
              <Field label="成员离线时">
                <Select value={current.offline} onChange={(event) => update({ offline: event.target.value as Draft["offline"] })}>
                  <option value="reject">拒绝</option>
                  <option value="queue">排队等待上线</option>
                </Select>
              </Field>
              <Field label="审计">
                <Select value={current.audit} onChange={(event) => update({ audit: event.target.value as Draft["audit"] })}>
                  <option value="summary">摘要</option>
                  <option value="full">完整</option>
                  <option value="none">不记录</option>
                </Select>
              </Field>
              <Field label="同时运行" hint="1 表示不能重叠。只有隔离、可重复或本来就要并发的任务才调高">
                <Input
                  type="number"
                  min={1}
                  max={32}
                  value={current.concurrency}
                  onChange={(event) => update({ concurrency: event.target.value })}
                />
              </Field>
              <Field label="运行超时" hint="到点会停掉这一次，例如 30s、10m、1h">
                <Input value={current.timeout} onChange={(event) => update({ timeout: event.target.value.trim() })} spellCheck={false} />
              </Field>
              <Field label="断线后判定丢失" hint="成员断开超过这个时间，还没带着任务重连，就记为失败">
                <Input value={current.lostTtl} onChange={(event) => update({ lostTtl: event.target.value.trim() })} spellCheck={false} />
              </Field>
              {current.offline === "queue" ? (
                <Field label="离线排队上限" hint="成员离线时排队等它上线，超过这个时间就失败">
                  <Input value={current.offlineTtl} onChange={(event) => update({ offlineTtl: event.target.value.trim() })} spellCheck={false} />
                </Field>
              ) : null}
              {current.requiresApproval ? (
                <Field label="审批等待" hint="等确认超过这个时间，这次任务会取消">
                  <Input value={current.approvalTtl} onChange={(event) => update({ approvalTtl: event.target.value.trim() })} spellCheck={false} />
                </Field>
              ) : null}
            </div>
            <label className="flex items-center gap-2 text-[13px] text-muted">
              <input type="checkbox" checked={current.requiresApproval} onChange={(event) => update({ requiresApproval: event.target.checked })} />
              执行前需要在 Hub 上确认
            </label>
            <Field label="命令" hint={current.template ? `当前还引用模板 ${current.template}。填写命令后，保存会改成直接执行这条命令。` : "在这台电脑上执行"}>
              <Textarea value={current.script} onChange={(event) => update({ script: event.target.value })} />
            </Field>
            <Field label="工作目录" hint="可留空，表示使用 Agent 的数据目录">
              <div className="flex gap-2">
                <Input className="min-w-0 flex-1" value={current.cwd} onChange={(event) => update({ cwd: event.target.value })} spellCheck={false} />
                <Button type="button" variant="outline" disabled={picking} onClick={() => void pickCwd()}>
                  <FolderOpen size={14} />
                  浏览
                </Button>
              </div>
            </Field>
            {error ? <p className="text-sm text-bad">{error}</p> : null}
            {status ? <p className="text-sm text-good">{status}</p> : null}
          </div>
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted">还没有 Target。点左侧加号新建。</div>
        )}
      </section>
      <ConfirmDialog
        open={confirmDelete}
        title={`删除 ${current?.title ?? "这个 Target"}？`}
        body="删除会在你保存后生效。还没保存之前可以继续编辑其他项，离开页面前记得保存。"
        confirmLabel="从列表移除"
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
      />
    </div>
  );
}
