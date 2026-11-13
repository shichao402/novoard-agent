import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ScheduleEditor } from "@/components/schedule-editor";
import { StepsEditor } from "@/components/steps-editor";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getTargets, listPackTools, saveTargets, type PackTools, type TargetDef } from "@/lib/api";
import { indexTools, newDraft, toDef, toDraft, validateDrafts, type Draft } from "@/lib/target-draft.mjs";

const EMPTY_TOOLS: PackTools = {
  ok: true,
  platform: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  scheduleEnabled: false,
  packs: [],
};

export function TargetsPage({ base }: { base: string }) {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [original, setOriginal] = useState<Record<string, TargetDef>>({});
  const [packTools, setPackTools] = useState<PackTools>(EMPTY_TOOLS);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<Array<{ index: number; id: string; errors: string[] }>>([]);
  const [busy, setBusy] = useState(false);
  const [baseline, setBaseline] = useState("[]");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTargets(base)
      .then((body) => {
        if (cancelled) return;
        const targets = body.targets ?? {};
        setOriginal(targets);
        const next = Object.entries(targets).map(([id, target]) => toDraft(id, target));
        setDrafts(next);
        setBaseline(JSON.stringify(next));
        setSelected(0);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "读取失败"));
    // 工具清单读不到时表单仍可用，只是无法按清单生成参数
    listPackTools(base)
      .then((body) => {
        if (!cancelled) setPackTools(body);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [base]);

  const tools = useMemo(() => indexTools(packTools.packs), [packTools]);
  const context = { tools, timezone: packTools.timezone };
  const current = drafts[selected];
  const currentProblems = problems.find((item) => item.index === selected)?.errors ?? [];

  function update(patch: Partial<Draft>) {
    setStatus("");
    setDrafts((items) => items.map((item, index) => (index === selected ? { ...item, ...patch } : item)));
  }

  function add() {
    setDrafts((items) => [...items, newDraft(items.map((item) => item.id))]);
    setSelected(drafts.length);
  }

  function remove() {
    setDrafts((items) => items.filter((_, index) => index !== selected));
    setProblems([]);
    setSelected((index) => Math.max(0, index - 1));
    setConfirmDelete(false);
  }

  async function save() {
    const found = validateDrafts(drafts, context);
    setProblems(found);
    if (found.length) {
      setError(`有 ${found.length} 个 Target 还没填好：${found.map((item) => item.id).join("、")}`);
      if (!found.some((item) => item.index === selected)) setSelected(found[0].index);
      return;
    }
    const targets: Record<string, TargetDef> = {};
    for (const draft of drafts) targets[draft.id] = toDef(draft, original[draft.id], context);
    setBusy(true);
    setError("");
    try {
      const result = await saveTargets(base, targets);
      setOriginal(targets);
      setBaseline(JSON.stringify(drafts));
      const warned = new Set((result.warnings ?? []).map((w) => w.target));
      setStatus(
        warned.size
          ? `已保存 ${result.count} 个 Target。${[...warned].join("、")} 现在跑会失败，已从 Hub 隐藏，详情看快捷操作页的红色提示。`
          : `已保存 ${result.count} 个 Target，并已热生效。`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
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
              <div className={`truncate ${problems.some((item) => item.index === index) ? "text-bad" : ""}`}>{draft.title || "未命名"}</div>
              <div className="truncate font-mono text-[11px] text-faint">{draft.id}{draft.schedule ? " · 定时" : ""}</div>
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

            {currentProblems.length ? (
              <ul className="space-y-1 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2.5 text-[12px] leading-5 text-bad">
                {currentProblems.map((item) => <li key={item}>{item}</li>)}
              </ul>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="ID" hint="保存后 Hub 上的 skill id 就是这个值">
                <Input value={current.id} onChange={(event) => update({ id: event.target.value.trim() })} spellCheck={false} />
              </Field>
              <Field label="标题">
                <Input value={current.title} onChange={(event) => update({ title: event.target.value })} />
              </Field>
            </div>

            {current.template && current.steps.length === 0 ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-4 text-[13px]">
                <span>整个 Target 直接引用模板 <span className="font-mono">{current.template}</span>，步骤由 templates.yaml 决定。</span>
                <Button variant="outline" size="sm" onClick={() => update({ steps: [{ key: `tpl-${Date.now()}`, kind: "template", template: current.template }] })}>
                  改为自己的步骤
                </Button>
              </div>
            ) : (
              <StepsEditor
                steps={current.steps}
                packs={packTools.packs}
                tools={tools}
                platform={packTools.platform}
                onError={setError}
                onChange={(steps) => update({ steps })}
              />
            )}

            <ScheduleEditor
              key={`${selected}-${current.id}`}
              value={{ schedule: current.schedule, oncePerDay: current.oncePerDay, deadline: current.deadline }}
              timezone={packTools.timezone}
              scheduleEnabled={packTools.scheduleEnabled}
              onChange={update}
            />

            <section className="space-y-3 rounded-xl border border-line p-4">
              <h3 className="text-[13px] font-medium">运行方式</h3>
              <div className="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
                <div>
                  <div className="text-[13px]">执行前需要在 Hub 上确认</div>
                  <div className="mt-0.5 text-[11px] leading-5 text-faint">会写远端的工具必须打开</div>
                </div>
                <Switch checked={current.requiresApproval} label="执行前需要在 Hub 上确认" onChange={(requiresApproval) => update({ requiresApproval })} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
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
                  <Input type="number" min={1} max={32} value={current.concurrency} onChange={(event) => update({ concurrency: event.target.value })} />
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
            </section>

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
