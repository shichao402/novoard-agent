import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getTargetInputs, type InputDescription } from "@/lib/api";
import { isSwitchChoices } from "@/lib/switch-input";

/**
 * 运行时参数选择（ADR-0020）：候选已按最近与常用加权，可文本筛选或输入自定义值。
 * 查询失败退化为自由输入；default: last 仍回显上次受理的值。
 * 快捷预设（ADR-0023）：only 只显示这些输入，preset 作为初值；提交只返回显示项。
 */
export function InputsDialog({
  base, target, only, preset, onClose, onSubmit,
}: {
  base: string;
  target: { id: string; title: string; requiresApproval?: boolean } | null;
  only?: string[];
  preset?: Record<string, string>;
  onClose: () => void;
  onSubmit: (vars: Record<string, string>) => void;
}) {
  const [inputs, setInputs] = useState<InputDescription[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setInputs(null);
    setLoadError("");
    getTargetInputs(base, target.id, preset)
      .then((body) => {
        if (cancelled) return;
        const shown = only ? body.inputs.filter((input) => only.includes(input.name)) : body.inputs;
        setInputs(shown);
        const next: Record<string, string> = {};
        for (const input of shown) {
          const raw = preset?.[input.name] ?? input.default ?? "";
          const listed = input.choices.some((choice) => choice.value === raw);
          next[input.name] = isSwitchChoices(input.choices) && raw !== "true" ? "false"
            : input.choices.length && !input.allowCustom && !listed ? "" : raw;
        }
        setValues(next);
      })
      .catch((caught) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "读不到输入定义");
      });
    return () => { cancelled = true; };
    // only / preset 随 target 一起换，按 target 触发即可
  }, [base, target]);

  if (!target) return null;
  const missing = (inputs ?? []).filter((input) => input.required && !String(values[input.name] ?? "").trim());
  const ready = inputs !== null && missing.length === 0;

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/55 p-6" role="presentation" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="inputs-title" className="w-full max-w-md rounded-2xl border border-line bg-panel p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="inputs-title" className="text-sm font-medium">执行 {target.title}</h2>
        {target.requiresApproval ? <p className="mt-1 text-[11px] text-faint">这个 Target 需要确认，点「执行」即视为确认。</p> : null}
        {loadError ? <p className="mt-3 text-sm text-bad" role="alert">{loadError}</p> : null}
        {inputs === null && !loadError ? <p className="mt-4 text-sm text-muted">正在获取候选项…</p> : null}
        <form className="mt-4 space-y-4" onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !inputs) return;
          const out: Record<string, string> = {};
          for (const input of inputs) {
            const value = String(values[input.name] ?? "").trim();
            if (value || !input.required) out[input.name] = value;
          }
          onSubmit(out);
        }}>
          {(inputs ?? []).map((input) => {
            const label = `${input.label}${input.required ? "" : "（可空）"}`;
            const hint = input.error ? undefined : [input.choices.some((choice) => choice.usage) ? "最近与常用优先" : "", input.dynamic ? "候选由本机查询" : ""].filter(Boolean).join(" · ");
            if (isSwitchChoices(input.choices)) {
              return (
                <div key={input.name} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
                  <span className="text-[13px]">{input.label}</span>
                  <Switch checked={values[input.name] === "true"} label={input.label} onChange={(next) => setValues((current) => ({ ...current, [input.name]: next ? "true" : "false" }))} />
                </div>
              );
            }
            return (
              <Field key={input.name} label={label} hint={hint} error={input.error ? `${input.error}，可直接输入` : undefined}>
                {input.choices.length === 0 ? (
                  <Input value={values[input.name] ?? ""} placeholder={input.name} onChange={(event) => setValues((current) => ({ ...current, [input.name]: event.target.value }))} />
                ) : (
                  <Select value={values[input.name] ?? ""} allowCustom={input.allowCustom} onChange={(event) => setValues((current) => ({ ...current, [input.name]: event.target.value }))}>
                    <option value="">{input.required ? "请选择" : "（不填）"}</option>
                    {input.choices.map((choice) => (
                      <option key={choice.value} value={choice.value} data-hint={choice.hint} data-search={choice.value} data-usage-count={choice.usage?.count}>
                        {choice.label ? `${choice.label}（${choice.value}）` : choice.value}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            );
          })}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={!ready}>执行</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
