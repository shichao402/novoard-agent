import { AlertTriangle, ArrowDown, ArrowUp, Pencil, Plus, Square, Trash2, Zap } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { liveText, StateDot } from "@/components/run-bits";
import { RunError, useRunLauncher } from "@/components/run-launcher";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { isSwitchChoices } from "@/lib/switch-input";
import { getShortcuts, getTargets, saveShortcuts, type Shortcut, type TargetDef, type Tile } from "@/lib/api";
import { href } from "@/lib/router";
import { formatRelative, stateLabel } from "@/lib/run-state";
import { lastState } from "@/pages/targets-list-page";

/**
 * 快捷页（ADR-0023）：常用操作的预设按钮。
 * 每个快捷 = 一个 Target + 预填参数 + 点击时仍要问的输入；点一下就按预设触发，审批、并发、运行记录照旧。
 */
export function ShortcutsPage({ base, tiles, onChanged }: { base: string; tiles: Tile[]; onChanged: () => void }) {
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [problems, setProblems] = useState<Record<string, string[]>>({});
  const [defs, setDefs] = useState<Record<string, TargetDef>>({});
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<Shortcut | null>(null);
  const [removing, setRemoving] = useState<Shortcut | null>(null);
  const [saveError, setSaveError] = useState("");
  const launcher = useRunLauncher(base, { onChanged });
  const tileOf = useMemo(() => new Map(tiles.map((tile) => [tile.id, tile])), [tiles]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getShortcuts(base), getTargets(base).catch(() => ({ ok: false, targets: {} as Record<string, TargetDef> }))])
      .then(([body, targets]) => {
        if (cancelled) return;
        setShortcuts(body.shortcuts);
        setProblems(body.problems ?? {});
        setDefs(targets.targets ?? {});
        setLoaded(true);
      })
      .catch((caught) => {
        if (cancelled) return;
        setLoadError(caught instanceof Error ? caught.message : "读取快捷失败");
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [base]);

  async function persist(next: Shortcut[]) {
    setSaveError("");
    try {
      const body = await saveShortcuts(base, next);
      setShortcuts(body.shortcuts);
      setProblems(body.problems ?? {});
      return true;
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "保存失败");
      return false;
    }
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= shortcuts.length) return;
    const next = [...shortcuts];
    [next[index], next[to]] = [next[to], next[index]];
    void persist(next);
  }

  function labelOf(target: string, name: string) {
    return defs[target]?.inputs?.find((input) => input.name === name)?.label || name;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted">把常用的 Target 和参数存成按钮，点一下就执行。需要临时挑的参数会先弹框。</p>
        <Button className="ml-auto" variant="accent" size="sm" onClick={() => setEditing(blankShortcut())} disabled={tiles.length === 0}>
          <Plus size={14} />新建快捷
        </Button>
      </div>

      {loadError ? <p className="text-sm text-bad" role="alert">{loadError}</p> : null}
      <RunError message={launcher.error || saveError} />

      {loaded && !loadError && shortcuts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-hi px-6 py-16 text-center">
          <Zap size={22} className="mx-auto text-faint" />
          <p className="mt-3 text-sm text-muted">还没有快捷</p>
          {tiles.length === 0 ? (
            <a className="mt-3 inline-block text-[13px] text-accent hover:text-accent-hi" href={href("targets/new")}>先建一个 Target</a>
          ) : (
            <button className="mt-3 text-[13px] text-accent hover:text-accent-hi" onClick={() => setEditing(blankShortcut())}>新建快捷</button>
          )}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shortcuts.map((shortcut, index) => {
            const tile = tileOf.get(shortcut.target);
            const issues = problems[shortcut.id] ?? [];
            const live = tile?.live?.[0];
            const state = live?.state ?? (tile ? lastState(tile) : null);
            const presets = Object.entries(shortcut.vars).filter(([name]) => !shortcut.ask.includes(name));
            const disabled = !tile || launcher.pending === tile.id;
            return (
              <li key={shortcut.id} className={`group relative flex flex-col rounded-2xl border bg-panel ${issues.length ? "border-bad/40" : "border-line"}`}>
                <button
                  className="flex flex-1 flex-col items-start gap-2 rounded-2xl p-4 text-left hover:bg-panel-hi/50 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={disabled}
                  onClick={() => tile && launcher.launch(tile, { preset: shortcut.vars, ask: shortcut.ask })}
                  title={tile ? `执行 ${tile.title}` : "Target 不存在"}
                >
                  <div className="flex w-full items-center gap-2 pr-16">
                    <Zap size={15} className="shrink-0 text-accent" />
                    <span className="truncate text-sm font-medium text-ink">{shortcut.label}</span>
                  </div>
                  <div className="truncate text-[11px] text-faint">{tile?.title ?? shortcut.target}</div>
                  {presets.length || shortcut.ask.length ? (
                    <div className="flex flex-wrap gap-1">
                      {presets.map(([name, value]) => (
                        <span key={name} className="max-w-full truncate rounded-md bg-panel-hi px-1.5 py-px text-[11px] text-muted" title={`${name} = ${value}`}>
                          {labelOf(shortcut.target, name)}：{value}
                        </span>
                      ))}
                      {shortcut.ask.map((name) => (
                        <span key={name} className="rounded-md border border-dashed border-line-hi px-1.5 py-px text-[11px] text-muted">
                          选{labelOf(shortcut.target, name)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {shortcut.note ? <p className="line-clamp-2 text-[11px] leading-4 text-faint">{shortcut.note}</p> : null}
                </button>
                <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[11px] text-muted">
                  <StateDot state={state} />
                  {live ? (
                    <a className="min-w-0 flex-1 truncate text-accent hover:underline" href={href(`runs/${live.taskId}`)}>{liveText(live)}</a>
                  ) : tile?.lastRun ? (
                    <a className="min-w-0 flex-1 truncate hover:text-ink" href={href(`runs/${tile.lastRun.taskId}`)}>
                      {[stateLabel(tile.lastRun.state), formatRelative(tile.lastRun.endedAt ?? tile.lastRun.startedAt)].filter(Boolean).join(" · ")}
                    </a>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-faint">{tile ? "未运行" : "Target 不存在"}</span>
                  )}
                  {live && live.state !== "input-required" ? (
                    <button
                      className="grid size-6 place-items-center rounded-full hover:bg-panel-hi hover:text-bad disabled:opacity-50"
                      aria-label={`取消 ${shortcut.label}`}
                      disabled={launcher.canceling === live.taskId}
                      onClick={() => void launcher.cancel(live.taskId)}
                    >
                      <Square size={11} />
                    </button>
                  ) : null}
                </div>
                {issues.length ? (
                  <div className="space-y-1 px-4 pb-3 text-[11px] text-bad" role="alert">
                    {issues.map((issue) => (
                      <div key={issue} className="flex gap-1"><AlertTriangle size={11} className="mt-0.5 shrink-0" />{issue}</div>
                    ))}
                  </div>
                ) : null}
                <div className="absolute right-2 top-2 flex gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton label="前移" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></IconButton>
                  <IconButton label="后移" disabled={index === shortcuts.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></IconButton>
                  <IconButton label="编辑" onClick={() => setEditing(shortcut)}><Pencil size={13} /></IconButton>
                  <IconButton label="删除" danger onClick={() => setRemoving(shortcut)}><Trash2 size={13} /></IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing ? (
        <ShortcutEditor
          initial={editing}
          tiles={tiles}
          defs={defs}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            const exists = shortcuts.some((item) => item.id === draft.id);
            const next = exists ? shortcuts.map((item) => (item.id === draft.id ? draft : item)) : [...shortcuts, draft];
            if (await persist(next)) setEditing(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={`删除快捷「${removing?.label ?? ""}」`}
        body="只删除这个按钮，对应的 Target 和运行记录不受影响。"
        confirmLabel="删除"
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          setRemoving(null);
          if (target) void persist(shortcuts.filter((item) => item.id !== target.id));
        }}
      />
      {launcher.dialogs}
    </div>
  );
}

function IconButton({ label, danger, disabled, onClick, children }: { label: string; danger?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className={`grid size-7 place-items-center rounded-lg bg-panel text-muted hover:bg-panel-hi disabled:opacity-30 ${danger ? "hover:text-bad" : "hover:text-ink"}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function blankShortcut(): Shortcut {
  return { id: `sc-${Date.now().toString(36)}`, label: "", target: "", vars: {}, ask: [] };
}

type Mode = "default" | "preset" | "ask";

function describeDefault(value: string | undefined) {
  if (value === undefined || value === "") return "没有默认值";
  return value === "last" ? "上次选的值" : `默认 ${value}`;
}

/** 新建 / 编辑快捷：选 Target，逐个输入决定「用默认 / 预填 / 每次问」，可覆盖 Target 变量。 */
function ShortcutEditor({
  initial,
  tiles,
  defs,
  onClose,
  onSave,
}: {
  initial: Shortcut;
  tiles: Tile[];
  defs: Record<string, TargetDef>;
  onClose: () => void;
  onSave: (draft: Shortcut) => Promise<void>;
}) {
  const [label, setLabel] = useState(initial.label);
  const [note, setNote] = useState(initial.note ?? "");
  const [target, setTarget] = useState(initial.target);
  const [values, setValues] = useState<Record<string, string>>(initial.vars);
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [saving, setSaving] = useState(false);
  const def = defs[target];
  const inputs = def?.inputs ?? [];
  const varNames = Object.keys(def?.vars ?? {}).filter((name) => !inputs.some((input) => input.name === name));

  // 换 Target 时按快捷现有数据推导每个输入的模式；新建时缺省为「每次问」，与直接点 Target 的行为一致
  useEffect(() => {
    const next: Record<string, Mode> = {};
    for (const input of defs[target]?.inputs ?? []) {
      if (target === initial.target && initial.ask.includes(input.name)) next[input.name] = "ask";
      else if (target === initial.target && input.name in initial.vars) next[input.name] = "preset";
      else next[input.name] = target === initial.target && initial.label ? "default" : "ask";
    }
    setModes(next);
  }, [target, defs, initial]);

  const missingPreset = inputs.filter((input) => modes[input.name] === "preset" && !String(values[input.name] ?? "").trim());
  const ready = label.trim() !== "" && target !== "" && missingPreset.length === 0 && !saving;

  function build(): Shortcut {
    const vars: Record<string, string> = {};
    const ask: string[] = [];
    for (const input of inputs) {
      const mode = modes[input.name] ?? "ask";
      const value = String(values[input.name] ?? "").trim();
      if (mode === "ask") ask.push(input.name);
      if ((mode === "preset" || mode === "ask") && value) vars[input.name] = value;
    }
    for (const name of varNames) {
      const value = String(values[name] ?? "").trim();
      if (value) vars[name] = value;
    }
    const out: Shortcut = { id: initial.id, label: label.trim(), target, vars, ask };
    if (note.trim()) out.note = note.trim();
    return out;
  }

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/55 p-6" role="presentation" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-editor-title"
        className="flex max-h-full w-full max-w-lg flex-col rounded-2xl border border-line bg-panel shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="shortcut-editor-title" className="px-5 pt-5 text-sm font-medium">{initial.label ? `编辑快捷「${initial.label}」` : "新建快捷"}</h2>
        <form
          className="mt-4 flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) return;
            setSaving(true);
            void onSave(build()).finally(() => setSaving(false));
          }}
        >
          <div className="min-h-0 space-y-4 overflow-auto px-5">
            <Field label="按钮名">
              <Input value={label} placeholder="例如：s2 验 bug" onChange={(event) => setLabel(event.target.value)} autoFocus />
            </Field>
            <Field label="Target">
              <Select value={target} onChange={(event) => setTarget(event.target.value)}>
                <option value="">请选择</option>
                {tiles.map((tile) => <option key={tile.id} value={tile.id}>{tile.title}（{tile.id}）</option>)}
                {target && !tiles.some((tile) => tile.id === target) ? <option value={target}>{target}（不存在）</option> : null}
              </Select>
            </Field>

            {inputs.length ? (
              <div className="space-y-3">
                <div className="text-xs text-muted">输入</div>
                {inputs.map((input) => {
                  const mode = modes[input.name] ?? "ask";
                  const fixed = Array.isArray(input.choices) ? input.choices : [];
                  return (
                    <div key={input.name} className="grid grid-cols-[7rem_7.5rem_minmax(0,1fr)] items-center gap-2">
                      <span className="truncate text-[13px] text-ink" title={input.name}>{input.label || input.name}</span>
                      <Select value={mode} onChange={(event) => setModes((current) => ({ ...current, [input.name]: event.target.value as Mode }))}>
                        <option value="ask">每次问</option>
                        <option value="preset">预填</option>
                        <option value="default">用默认</option>
                      </Select>
                      {mode === "default" ? (
                        <span className="truncate text-[11px] text-faint">{describeDefault(input.default)}</span>
                      ) : isSwitchChoices(fixed) ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={values[input.name] === "true"}
                            label={input.label || input.name}
                            onChange={(next) => setValues((current) => ({ ...current, [input.name]: next ? "true" : "false" }))}
                          />
                          <span className="text-[11px] text-faint">{values[input.name] === "true" ? "开" : "关"}</span>
                        </div>
                      ) : fixed.length ? (
                        <Select
                          aria-label={input.label || input.name}
                          allowCustom
                          value={values[input.name] ?? ""}
                          onChange={(event) => setValues((current) => ({ ...current, [input.name]: event.target.value }))}
                        >
                          <option value="">{mode === "ask" ? "弹框初值（可空）" : "请选择"}</option>
                          {fixed.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                        </Select>
                      ) : (
                        <Input
                          value={values[input.name] ?? ""}
                          placeholder={mode === "ask" ? "弹框初值（可空）" : "必填"}
                          onChange={(event) => setValues((current) => ({ ...current, [input.name]: event.target.value }))}
                        />
                      )}
                    </div>
                  );
                })}
                {missingPreset.length ? <p className="text-[11px] text-bad">预填的 {missingPreset.map((input) => input.label || input.name).join("、")} 还没有值</p> : null}
              </div>
            ) : target ? (
              <p className="text-[11px] text-faint">这个 Target 没有运行时输入，点快捷就直接执行。</p>
            ) : null}

            {varNames.length ? (
              <div className="space-y-3">
                <div className="text-xs text-muted">覆盖 Target 变量（留空用 Target 里的值）</div>
                {varNames.map((name) => (
                  <div key={name} className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
                    <span className="truncate font-mono text-[12px] text-ink">{name}</span>
                    <Input
                      value={values[name] ?? ""}
                      placeholder={String(def?.vars?.[name] ?? "")}
                      onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            <Field label="备注（可空）">
              <Input value={note} placeholder="例如：验线上 bug，只开 Unity" onChange={(event) => setNote(event.target.value)} />
            </Field>
            {def?.requiresApproval ? <p className="text-[11px] text-faint">这个 Target 需要确认，点快捷后仍会先弹确认。</p> : null}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button type="button" variant="secondary" onClick={onClose}>取消</Button>
            <Button type="submit" variant="accent" disabled={!ready}>{saving ? "保存中…" : "保存"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
