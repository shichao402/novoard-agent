import { ArrowLeft, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { InputsEditor } from "@/components/inputs-editor";
import { ScheduleEditor } from "@/components/schedule-editor";
import { StepsEditor } from "@/components/steps-editor";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getTargets, listPackTools, saveTargets, type PackTools, type TargetDef } from "@/lib/api";
import { href, navigate } from "@/lib/router";
import { indexTools, newDraft, toDef, toDraft, validateDraft, type Draft } from "@/lib/target-draft.mjs";

const EMPTY_TOOLS: PackTools = {
  ok: true,
  platform: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  scheduleEnabled: false,
  packs: [],
};

/** 编辑单个 Target（PRD-8 T3）。保存整表 PUT，只替换当前这一项；id 为 null 时新建。 */
export function TargetEditPage({ base, id, onSaved }: { base: string; id: string | null; onSaved: () => void }) {
  const [original, setOriginal] = useState<Record<string, TargetDef> | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [packTools, setPackTools] = useState<PackTools>(EMPTY_TOOLS);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getTargets(base)
      .then((body) => {
        if (cancelled) return;
        const targets = body.targets ?? {};
        setOriginal(targets);
        if (id && !targets[id]) {
          setMissing(true);
          return;
        }
        const next = id ? toDraft(id, targets[id]) : newDraft(Object.keys(targets));
        setDraft(next);
        setBaseline(id ? JSON.stringify(next) : "");
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "读取失败"));
    // 工具清单读不到时表单仍可用，只是无法按清单生成参数
    listPackTools(base)
      .then((body) => { if (!cancelled) setPackTools(body); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [base, id]);

  const tools = useMemo(() => indexTools(packTools.packs), [packTools]);
  const context = { tools, timezone: packTools.timezone };
  const backPath = id ? `targets/${id}` : "targets";

  function update(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  async function persist(targets: Record<string, TargetDef>) {
    setBusy(true);
    setError("");
    try {
      await saveTargets(base, targets);
      onSaved();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft || !original) return;
    const found = validateDraft(draft, context);
    if (draft.id !== id && original[draft.id]) found.unshift(`ID 重复：${draft.id}`);
    setProblems(found);
    if (found.length) return;
    const def = toDef(draft, id ? original[id] : undefined, context);
    const targets: Record<string, TargetDef> = {};
    for (const [key, value] of Object.entries(original)) {
      if (key === id) targets[draft.id] = def;
      else targets[key] = value;
    }
    if (!id) targets[draft.id] = def;
    if (await persist(targets)) navigate(`targets/${draft.id}`, true);
  }

  async function remove() {
    setConfirmDelete(false);
    if (!id || !original) return;
    const targets = Object.fromEntries(Object.entries(original).filter(([key]) => key !== id));
    if (await persist(targets)) navigate("targets", true);
  }

  if (missing) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <a className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink" href={href("targets")}><ArrowLeft size={13} />Target</a>
        <p className="mt-8 text-center text-sm text-muted">找不到 Target <span className="font-mono">{id}</span></p>
      </div>
    );
  }

  const dirty = draft ? JSON.stringify(draft) !== baseline : false;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <a className="inline-flex w-fit items-center gap-1 text-xs text-muted hover:text-ink" href={href(backPath)}>
        <ArrowLeft size={13} />{id ? (original?.[id]?.title ?? id) : "Target"}
      </a>
      {draft ? (
        <section className="space-y-4 rounded-2xl border border-line bg-panel p-5">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-sm font-medium">{id ? "编辑 Target" : "新建 Target"}{id && dirty ? " · 未保存" : ""}</h1>
            <div className="flex gap-2">
              {id ? <Button variant="destructive" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除</Button> : null}
              <Button variant="secondary" size="sm" onClick={() => navigate(backPath)}>取消</Button>
              <Button variant="accent" size="sm" disabled={busy || !dirty} onClick={() => void save()}>保存</Button>
            </div>
          </div>

          {problems.length ? (
            <ul className="space-y-1 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2.5 text-[12px] leading-5 text-bad">
              {problems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="ID" hint="Hub 上的 skill id">
              <Input value={draft.id} onChange={(event) => update({ id: event.target.value.trim() })} spellCheck={false} />
            </Field>
            <Field label="标题">
              <Input value={draft.title} onChange={(event) => update({ title: event.target.value })} />
            </Field>
          </div>

          {draft.template && draft.steps.length === 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-line p-4 text-[13px]">
              <span>模板 <span className="font-mono">{draft.template}</span></span>
              <Button variant="outline" size="sm" onClick={() => update({ steps: [{ key: `tpl-${Date.now()}`, kind: "template", template: draft.template }] })}>
                改为自己的步骤
              </Button>
            </div>
          ) : (
            <StepsEditor
              steps={draft.steps}
              packs={packTools.packs}
              tools={tools}
              platform={packTools.platform}
              onError={setError}
              onChange={(steps) => update({ steps })}
            />
          )}

          <InputsEditor
            inputs={draft.inputs}
            packs={packTools.packs}
            scheduled={Boolean(draft.schedule.trim())}
            onChange={(inputs) => update({ inputs })}
          />

          <ScheduleEditor
            key={id ?? "new"}
            value={{ schedule: draft.schedule, oncePerDay: draft.oncePerDay, deadline: draft.deadline }}
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
              <Switch checked={draft.requiresApproval} label="执行前需要在 Hub 上确认" onChange={(requiresApproval) => update({ requiresApproval })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="暴露范围">
                <Select value={draft.expose} onChange={(event) => update({ expose: event.target.value as Draft["expose"] })}>
                  <option value="a2a">Hub 可触发</option>
                  <option value="local">仅本机</option>
                </Select>
              </Field>
              <Field label="失败通知">
                <Select value={draft.notify} onChange={(event) => update({ notify: event.target.value as Draft["notify"] })}>
                  <option value="on-failure">仅失败</option>
                  <option value="always">总是</option>
                  <option value="never">不通知</option>
                </Select>
              </Field>
              <Field label="成员离线时">
                <Select value={draft.offline} onChange={(event) => update({ offline: event.target.value as Draft["offline"] })}>
                  <option value="reject">拒绝</option>
                  <option value="queue">排队等待上线</option>
                </Select>
              </Field>
              <Field label="审计">
                <Select value={draft.audit} onChange={(event) => update({ audit: event.target.value as Draft["audit"] })}>
                  <option value="summary">摘要</option>
                  <option value="full">完整</option>
                  <option value="none">不记录</option>
                </Select>
              </Field>
              <Field label="同时运行" hint="1 表示不能重叠。只有隔离、可重复或本来就要并发的任务才调高">
                <Input type="number" min={1} max={32} value={draft.concurrency} onChange={(event) => update({ concurrency: event.target.value })} />
              </Field>
              <Field label="运行超时" hint="例如 30s、10m、1h">
                <Input value={draft.timeout} onChange={(event) => update({ timeout: event.target.value.trim() })} spellCheck={false} />
              </Field>
              <Field label="断线后判定丢失" hint="成员断开超过这个时间，还没带着任务重连，就记为失败">
                <Input value={draft.lostTtl} onChange={(event) => update({ lostTtl: event.target.value.trim() })} spellCheck={false} />
              </Field>
              {draft.offline === "queue" ? (
                <Field label="离线排队上限" hint="超过这个时间就失败">
                  <Input value={draft.offlineTtl} onChange={(event) => update({ offlineTtl: event.target.value.trim() })} spellCheck={false} />
                </Field>
              ) : null}
              {draft.requiresApproval ? (
                <Field label="审批等待" hint="等确认超过这个时间，这次任务会取消">
                  <Input value={draft.approvalTtl} onChange={(event) => update({ approvalTtl: event.target.value.trim() })} spellCheck={false} />
                </Field>
              ) : null}
            </div>
          </section>

          {error ? <p className="text-sm text-bad">{error}</p> : null}
        </section>
      ) : error ? (
        <p className="text-sm text-bad">{error}</p>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        title={`删除 ${draft?.title || id || ""}？`}
        body="删除后立即生效，Hub 上也不再可见。"
        confirmLabel="删除"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
