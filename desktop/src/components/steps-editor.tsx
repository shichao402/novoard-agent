import { ArrowDown, ArrowUp, FolderOpen, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { PackTools, ToolParam } from "@/lib/api";
import { pickDirectory } from "@/lib/pick-directory";
import {
  newStep,
  paramLabel,
  paramValue,
  retiredParams,
  STEP_KIND_LABELS,
  type DraftStep,
  type IndexedTool,
  type NewStepKind,
  type ParamValue,
} from "@/lib/target-draft.mjs";

const NEW_KINDS: NewStepKind[] = ["uses", "script", "openApp", "openPath"];
const PLATFORM_LABELS: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };

type UsesStep = Extract<DraftStep, { kind: "uses" }>;

function platformText(platforms: string[]) {
  return platforms.map((item) => PLATFORM_LABELS[item] ?? item).join("/");
}

function unsupported(tool: { platforms?: string[] }, platform: string) {
  return Array.isArray(tool.platforms) && tool.platforms.length > 0 && !tool.platforms.includes(platform);
}

/** 目录输入框 + 浏览按钮。 */
function PathInput({
  value,
  placeholder,
  fallbackDir,
  onChange,
  onError,
}: {
  value: string;
  placeholder?: string;
  fallbackDir?: string;
  onChange: (value: string) => void;
  onError: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  async function browse() {
    if (picking) return;
    setPicking(true);
    try {
      const path = await pickDirectory(value.trim() || fallbackDir?.trim() || undefined);
      if (path) onChange(path);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "无法打开目录选择器");
    } finally {
      setPicking(false);
    }
  }
  return (
    <div className="flex gap-2">
      <Input className="min-w-0 flex-1" value={value} placeholder={placeholder} spellCheck={false} onChange={(event) => onChange(event.target.value)} />
      <Button type="button" variant="outline" disabled={picking} onClick={() => void browse()}>
        <FolderOpen size={14} />
        浏览
      </Button>
    </div>
  );
}

function defaultText(spec: ToolParam) {
  if (spec.default === undefined) return "";
  if (typeof spec.default === "boolean") return spec.default ? "开" : "关";
  if (Array.isArray(spec.default)) return spec.default.join("、") || "空";
  return String(spec.default);
}

function ParamField({
  spec,
  withValues,
  cwd,
  onChange,
  onError,
}: {
  spec: ToolParam;
  withValues: UsesStep["with"];
  cwd: string;
  onChange: (value: ParamValue | undefined) => void;
  onError: (message: string) => void;
}) {
  const label = `${paramLabel(spec)}${spec.required && spec.default === undefined ? " *" : ""}`;
  const fallback = defaultText(spec);
  const hint = [spec.description, spec.label ? `参数名 ${spec.name}` : "", fallback ? `缺省 ${fallback}` : ""].filter(Boolean).join(" · ");
  const own = withValues[spec.name];

  if (spec.type === "boolean") {
    const checked = paramValue(spec, withValues) === true;
    return (
      <div className="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2.5 sm:col-span-2">
        <div>
          <div className="text-[13px]">{label}</div>
          {hint ? <div className="mt-0.5 text-[11px] leading-5 text-faint">{hint}</div> : null}
        </div>
        <Switch checked={checked} label={paramLabel(spec)} onChange={(next) => onChange(next)} />
      </div>
    );
  }

  if (spec.type === "enum") {
    const value = typeof own === "string" ? own : "";
    return (
      <Field label={label} hint={hint}>
        <Select value={value} onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">{fallback ? `缺省（${fallback}）` : "请选择"}</option>
          {(spec.enum ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
          {value && !(spec.enum ?? []).includes(value) ? <option value={value}>{value}（不在清单里）</option> : null}
        </Select>
      </Field>
    );
  }

  if (spec.type === "string[]") {
    const items = Array.isArray(own) ? own.map(String) : [];
    const set = (next: string[]) => onChange(next.length ? next : undefined);
    return (
      <div className="sm:col-span-2">
        <span className="mb-1.5 block text-xs text-muted">{label}</span>
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={index} className="flex gap-2">
              <div className="min-w-0 flex-1">
                {spec.format === "path" ? (
                  <PathInput value={item} fallbackDir={cwd} onError={onError} onChange={(next) => set(items.map((old, i) => (i === index ? next : old)))} />
                ) : (
                  <Input value={item} spellCheck={false} onChange={(event) => set(items.map((old, i) => (i === index ? event.target.value : old)))} />
                )}
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label="删除这一项" onClick={() => set(items.filter((_, i) => i !== index))}><X size={14} /></Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, ""])}><Plus size={14} />添加一项</Button>
        </div>
        {hint ? <span className="mt-1.5 block text-[11px] leading-5 text-faint">{hint}</span> : null}
      </div>
    );
  }

  if (spec.type === "number") {
    const value = typeof own === "number" ? String(own) : "";
    return (
      <Field label={label} hint={hint}>
        <Input
          type="number"
          value={value}
          placeholder={fallback}
          onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
        />
      </Field>
    );
  }

  const value = typeof own === "string" ? own : "";
  if (spec.format === "path") {
    return (
      <div className="sm:col-span-2">
        <Field label={label} hint={hint ? `${hint} · 相对路径按工程根解析` : "相对路径按工程根解析"}>
          <PathInput value={value} placeholder={fallback} fallbackDir={cwd} onError={onError} onChange={(next) => onChange(next || undefined)} />
        </Field>
      </div>
    );
  }
  if (spec.format === "time") {
    return (
      <Field label={label} hint={hint}>
        <div className="flex gap-2">
          <Input className="w-32" type="time" value={value} onChange={(event) => onChange(event.target.value || undefined)} />
          {value ? <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>清除</Button> : null}
        </div>
      </Field>
    );
  }
  return (
    <Field label={label} hint={spec.format === "duration" ? [hint, "例如 30s、10m、1h"].filter(Boolean).join(" · ") : hint}>
      <Input value={value} placeholder={fallback || (spec.format === "duration" ? "10m" : "")} spellCheck={false} onChange={(event) => onChange(event.target.value || undefined)} />
    </Field>
  );
}

function UsesStepForm({
  step,
  packs,
  tools,
  platform,
  onChange,
  onError,
}: {
  step: UsesStep;
  packs: PackTools["packs"];
  tools: Map<string, IndexedTool>;
  platform: string;
  onChange: (patch: Partial<UsesStep>) => void;
  onError: (message: string) => void;
}) {
  const [packPart, toolPart] = step.uses ? step.uses.split("/") : ["", ""];
  const [packChoice, setPackChoice] = useState(packPart ?? "");
  const packId = step.uses ? packPart : packChoice;
  const pack = packs.find((item) => item.id === packId);
  const tool = step.uses ? tools.get(step.uses) : undefined;
  const [advanced, setAdvanced] = useState(Boolean(step.cwd || step.retry || step.retryInterval));
  const missing = Boolean(step.uses) && !tool;
  const retired = retiredParams(step.with, tool);
  const setParam = (name: string, value: ParamValue | undefined) => {
    const next = { ...step.with };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onChange({ with: next });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="能力包">
          <Select
            value={packId ?? ""}
            onChange={(event) => {
              setPackChoice(event.target.value);
              onChange({ uses: "", with: {} });
            }}
          >
            <option value="">请选择</option>
            {packs.map((item) => <option key={item.id} value={item.id}>{item.displayName}{item.displayName !== item.id ? `（${item.id}）` : ""}</option>)}
            {packId && !pack ? <option value={packId}>{packId}（本机未装）</option> : null}
          </Select>
        </Field>
        <Field label="工具">
          <Select
            value={step.uses ? toolPart : ""}
            disabled={!packId}
            onChange={(event) => onChange({ uses: event.target.value ? `${packId}/${event.target.value}` : "", with: {} })}
          >
            <option value="">{packId ? "请选择" : "先选能力包"}</option>
            {(pack?.tools ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
                {item.remoteWrite ? " · 写远端" : ""}
                {unsupported(item, platform) ? ` · 仅 ${platformText(item.platforms ?? [])}` : ""}
              </option>
            ))}
            {missing ? <option value={toolPart}>{toolPart}（本机没有）</option> : null}
          </Select>
        </Field>
      </div>

      {tool?.description ? <p className="text-[12px] leading-5 text-muted">{tool.description}</p> : null}
      {tool && unsupported(tool, platform) ? (
        <p className="text-[12px] text-warn">这个工具只支持 {platformText(tool.platforms ?? [])}，在这台电脑上会跑失败。</p>
      ) : null}
      {tool?.remoteWrite ? <p className="text-[12px] text-warn">这个工具会写远端，保存时要求打开「执行前需要在 Hub 上确认」。</p> : null}
      {missing ? (
        <div className="space-y-1.5 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5 text-[12px] leading-5">
          <p className="text-warn">本机没装 {step.uses} 所在的能力包，看不到它的参数清单。已有参数会原样保存，装上包后可以在这里编辑。</p>
          {Object.keys(step.with).length ? <pre className="overflow-auto font-mono text-[11px] text-muted">{JSON.stringify(step.with, null, 2)}</pre> : null}
        </div>
      ) : null}

      {retired.length ? (
        <p className="text-[12px] text-warn">参数 {retired.join("、")} 已废弃，工具不再读取（工作目录由「工程根」决定），保存时会自动移除。</p>
      ) : null}
      {tool && tool.params.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {tool.params.map((spec) => (
            <ParamField key={spec.name} spec={spec} withValues={step.with} cwd={step.cwd} onError={onError} onChange={(value) => setParam(spec.name, value)} />
          ))}
        </div>
      ) : null}
      {tool && tool.params.length === 0 ? <p className="text-[12px] text-faint">这个工具没有参数。</p> : null}

      <button type="button" className="text-[12px] text-muted hover:text-ink" onClick={() => setAdvanced((value) => !value)}>
        {advanced ? "收起高级设置" : "高级设置：工程根、失败重试"}
      </button>
      {advanced ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <Field label="工程根" hint="工具在这个目录下运行，路径类参数也相对它解析；留空用 Agent 的数据目录">
              <PathInput value={step.cwd} onError={onError} onChange={(cwd) => onChange({ cwd })} />
            </Field>
          </div>
          <Field label="失败重试次数" hint="0 到 10，留空不重试">
            <Select value={step.retry} onChange={(event) => onChange({ retry: event.target.value })}>
              <option value="">不重试</option>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((count) => <option key={count} value={String(count)}>{count} 次</option>)}
              {step.retry && !/^([1-9]|10)$/.test(step.retry) ? <option value={step.retry}>{step.retry}</option> : null}
            </Select>
          </Field>
          {step.retry && step.retry !== "0" ? (
            <Field label="重试间隔" hint="例如 30s、5m">
              <Input value={step.retryInterval} placeholder="30s" spellCheck={false} onChange={(event) => onChange({ retryInterval: event.target.value.trim() })} />
            </Field>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function StepsEditor({
  steps,
  packs,
  tools,
  platform,
  onChange,
  onError,
}: {
  steps: DraftStep[];
  packs: PackTools["packs"];
  tools: Map<string, IndexedTool>;
  platform: string;
  onChange: (steps: DraftStep[]) => void;
  onError: (message: string) => void;
}) {
  const [addKind, setAddKind] = useState<NewStepKind>("uses");
  const patch = (index: number, value: Partial<DraftStep>) =>
    onChange(steps.map((step, i) => (i === index ? ({ ...step, ...value } as DraftStep) : step)));
  const move = (index: number, offset: number) => {
    const next = [...steps];
    const [item] = next.splice(index, 1);
    next.splice(index + offset, 0, item);
    onChange(next);
  };
  const changeKind = (index: number, kind: NewStepKind) => onChange(steps.map((step, i) => (i === index ? newStep(kind) : step)));

  return (
    <section className="space-y-3 rounded-xl border border-line p-4">
      <h3 className="text-[13px] font-medium">步骤</h3>
      <p className="text-[11px] leading-5 text-faint">按顺序执行，一步失败后面就不再跑。</p>
      {steps.map((step, index) => (
        <div key={step.key} className="space-y-3 rounded-lg border border-line-hi p-3">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-muted">第 {index + 1} 步</span>
            {step.kind === "template" ? (
              <span className="text-[13px]">模板 {step.template}</span>
            ) : (
              <Select className="h-8 w-40" value={step.kind} onChange={(event) => changeKind(index, event.target.value as NewStepKind)}>
                {NEW_KINDS.map((kind) => <option key={kind} value={kind}>{STEP_KIND_LABELS[kind]}</option>)}
              </Select>
            )}
            <div className="ml-auto flex">
              <Button type="button" variant="ghost" size="icon" aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp size={14} /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="下移" disabled={index === steps.length - 1} onClick={() => move(index, 1)}><ArrowDown size={14} /></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="删除这一步" onClick={() => onChange(steps.filter((_, i) => i !== index))}><Trash2 size={14} /></Button>
            </div>
          </div>

          {step.kind === "uses" ? (
            <UsesStepForm step={step} packs={packs} tools={tools} platform={platform} onError={onError} onChange={(value) => patch(index, value)} />
          ) : null}
          {step.kind === "script" ? (
            <>
              <Field label="命令" hint={step.env && Object.keys(step.env).length ? `另有环境变量 ${Object.keys(step.env).join("、")}，会原样保留` : "在这台电脑的 shell 里执行"}>
                <Textarea value={step.script} spellCheck={false} onChange={(event) => patch(index, { script: event.target.value })} />
              </Field>
              <Field label="工作目录" hint="可留空，表示使用 Agent 的数据目录">
                <PathInput value={step.cwd} onError={onError} onChange={(cwd) => patch(index, { cwd })} />
              </Field>
            </>
          ) : null}
          {step.kind === "openApp" ? (
            <Field label="应用" hint="应用名或可执行文件路径，例如 Unity Hub">
              <Input value={step.value} spellCheck={false} onChange={(event) => patch(index, { value: event.target.value })} />
            </Field>
          ) : null}
          {step.kind === "openPath" ? (
            <Field label="文件或目录" hint="用系统默认方式打开">
              <PathInput value={step.value} onError={onError} onChange={(value) => patch(index, { value })} />
            </Field>
          ) : null}
          {step.kind === "template" ? (
            <p className="text-[12px] leading-5 text-faint">模板步骤由 templates.yaml 定义，这里只能调整顺序或删除。</p>
          ) : null}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Select className="h-8 w-40" value={addKind} onChange={(event) => setAddKind(event.target.value as NewStepKind)}>
          {NEW_KINDS.map((kind) => <option key={kind} value={kind}>{STEP_KIND_LABELS[kind]}</option>)}
        </Select>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...steps, newStep(addKind)])}><Plus size={14} />添加步骤</Button>
      </div>
    </section>
  );
}
