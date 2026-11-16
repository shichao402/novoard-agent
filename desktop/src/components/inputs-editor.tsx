import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { PackTools } from "@/lib/api";
import { INPUT_SOURCE_LABELS, newInput, type DraftInput, type InputSource } from "@/lib/target-draft.mjs";

/**
 * 运行时输入编辑（ADR-0020 §1）：点磁贴时先选这些值，再执行。
 * 步骤里用 {{名字}} 引用。查询工具的 with 参数没有控件，保存时原样沿用。
 */
export function InputsEditor({
  inputs,
  packs,
  scheduled,
  onChange,
}: {
  inputs: DraftInput[];
  packs: PackTools["packs"];
  scheduled: boolean;
  onChange: (inputs: DraftInput[]) => void;
}) {
  const queryTools = packs.flatMap((pack) => pack.tools.filter((tool) => tool.kind === "query").map((tool) => ({ uses: `${pack.id}/${tool.id}`, label: `${pack.displayName} · ${tool.displayName}` })));

  function patch(index: number, next: Partial<DraftInput>) {
    onChange(inputs.map((item, i) => (i === index ? { ...item, ...next } : item)));
  }

  return (
    <section className="space-y-3 rounded-xl border border-line p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-medium">运行时输入</h3>
          <p className="mt-0.5 text-[11px] leading-5 text-faint">
            点磁贴时先选这些值再执行，步骤里用 {"{{名字}}"} 引用。默认值写 last 表示沿用上次选的值{scheduled ? "；定时运行的必填项需要固定默认值" : ""}。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => onChange([...inputs, newInput(inputs.map((i) => i.name))])}>
          <Plus size={14} />添加
        </Button>
      </div>
      {inputs.map((input, index) => (
        <div key={input.key} className="space-y-3 rounded-lg border border-line px-3 py-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="名字">
              <Input value={input.name} spellCheck={false} onChange={(event) => patch(index, { name: event.target.value.trim() })} />
            </Field>
            <Field label="显示名">
              <Input value={input.label} placeholder={input.name} onChange={(event) => patch(index, { label: event.target.value })} />
            </Field>
            <Field label="候选来源">
              <Select value={input.source} onChange={(event) => patch(index, { source: event.target.value as InputSource })}>
                {(Object.keys(INPUT_SOURCE_LABELS) as InputSource[]).map((key) => <option key={key} value={key}>{INPUT_SOURCE_LABELS[key]}</option>)}
              </Select>
            </Field>
          </div>
          {input.source === "list" ? (
            <Field label="候选项" hint="一行一个">
              <textarea
                className="min-h-20 w-full rounded-lg border border-line-hi bg-surface px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-accent"
                value={input.list}
                onChange={(event) => patch(index, { list: event.target.value })}
              />
            </Field>
          ) : null}
          {input.source === "query" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="查询工具" hint={input.with ? `参数沿用：${Object.keys(input.with).join("、")}` : "点磁贴时现场查询，最多等 15 秒"}>
                <Select value={input.uses} onChange={(event) => patch(index, { uses: event.target.value })}>
                  <option value="">请选择</option>
                  {queryTools.map((tool) => <option key={tool.uses} value={tool.uses}>{tool.label}</option>)}
                  {input.uses && !queryTools.some((tool) => tool.uses === input.uses) ? <option value={input.uses}>{input.uses}（本机没有）</option> : null}
                </Select>
              </Field>
              <Field label="查询目录" hint="可用 {{变量}}，留空为 agent 工作目录">
                <Input value={input.cwd} spellCheck={false} onChange={(event) => patch(index, { cwd: event.target.value })} />
              </Field>
            </div>
          ) : null}
          <div className="grid items-end gap-3 sm:grid-cols-3">
            <Field label="默认值">
              <Input value={input.default} spellCheck={false} placeholder="不填或 last" onChange={(event) => patch(index, { default: event.target.value })} />
            </Field>
            <label className="flex h-9 items-center justify-between gap-2 rounded-lg border border-line px-3 text-[12px]">
              必填
              <Switch checked={input.required} label="必填" onChange={(required) => patch(index, { required })} />
            </label>
            <div className="flex items-center gap-2">
              {input.source !== "free" ? (
                <label className="flex h-9 flex-1 items-center justify-between gap-2 rounded-lg border border-line px-3 text-[12px]">
                  允许手动输入
                  <Switch checked={input.allowCustom} label="允许手动输入" onChange={(allowCustom) => patch(index, { allowCustom })} />
                </label>
              ) : <div className="flex-1" />}
              <Button variant="ghost" size="icon" aria-label={`删除输入 ${input.name}`} onClick={() => onChange(inputs.filter((_, i) => i !== index))}>
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
