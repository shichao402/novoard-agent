import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { getTargetInputs, type InputDescription } from "@/lib/api";

/**
 * 磁贴运行时输入的选择框（ADR-0020 §2）。
 * 打开时向本机要 inputs 描述：静态候选直接给，动态候选由查询工具现场给（最长 15 秒）；
 * 查询失败时显示原因并退化为自由输入。默认值已由 agent 解析（default: last 回显上次的值）。
 * 需要确认的 target，在这里点「执行」即视为确认，不再弹第二次。
 */
export function InputsDialog({
  base,
  target,
  onClose,
  onSubmit,
}: {
  base: string;
  target: { id: string; title: string; requiresApproval?: boolean } | null;
  onClose: () => void;
  onSubmit: (vars: Record<string, string>) => void;
}) {
  const [inputs, setInputs] = useState<InputDescription[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setInputs(null);
    setLoadError("");
    getTargetInputs(base, target.id)
      .then((body) => {
        if (cancelled) return;
        setInputs(body.inputs);
        const next: Record<string, string> = {};
        const free: Record<string, boolean> = {};
        for (const input of body.inputs) {
          next[input.name] = input.default ?? "";
          const listed = input.choices.some((c) => c.value === input.default);
          free[input.name] = input.choices.length === 0 || (Boolean(input.default) && !listed && input.allowCustom);
        }
        setValues(next);
        setCustom(free);
      })
      .catch((caught) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : "读不到输入定义");
      });
    return () => {
      cancelled = true;
    };
  }, [base, target]);

  if (!target) return null;
  const missing = (inputs ?? []).filter((i) => i.required && !String(values[i.name] ?? "").trim());
  const ready = inputs !== null && missing.length === 0;

  return (
    <div className="fixed inset-0 z-30 grid place-items-center bg-black/55 p-6" role="presentation" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="inputs-title"
        className="w-full max-w-md rounded-2xl border border-line bg-panel p-5 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="inputs-title" className="text-sm font-medium">执行 {target.title}</h2>
        {target.requiresApproval ? <p className="mt-1 text-[11px] text-faint">这个 Target 需要确认，点「执行」即视为确认。</p> : null}
        {loadError ? <p className="mt-3 text-sm text-bad" role="alert">{loadError}</p> : null}
        {inputs === null && !loadError ? <p className="mt-4 text-sm text-muted">正在获取候选项…</p> : null}
        <form
          className="mt-4 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready || !inputs) return;
            const out: Record<string, string> = {};
            for (const input of inputs) {
              const value = String(values[input.name] ?? "").trim();
              if (value || !input.required) out[input.name] = value;
            }
            onSubmit(out);
          }}
        >
          {(inputs ?? []).map((input) => {
            const free = custom[input.name] || input.choices.length === 0;
            const label = `${input.label}${input.required ? "" : "（可空）"}`;
            const hint = input.error ? undefined : input.dynamic ? "候选由本机查询" : undefined;
            return (
              <Field key={input.name} label={label} hint={hint} error={input.error ? `${input.error}，可直接输入` : undefined}>
                {free ? (
                  <Input
                    value={values[input.name] ?? ""}
                    placeholder={input.name}
                    onChange={(event) => setValues((current) => ({ ...current, [input.name]: event.target.value }))}
                  />
                ) : (
                  <select
                    className="h-9 w-full rounded-lg border border-line-hi bg-surface px-2 text-[13px] text-ink outline-none focus:border-accent"
                    value={values[input.name] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "\u0000custom") {
                        setCustom((current) => ({ ...current, [input.name]: true }));
                        setValues((current) => ({ ...current, [input.name]: "" }));
                        return;
                      }
                      setValues((current) => ({ ...current, [input.name]: value }));
                    }}
                  >
                    {!input.required || !values[input.name] ? <option value="">{input.required ? "请选择" : "（不填）"}</option> : null}
                    {input.choices.map((choice) => (
                      <option key={choice.value} value={choice.value} title={choice.hint}>
                        {choice.label ? `${choice.label}（${choice.value}）` : choice.value}
                        {choice.hint ? ` · ${choice.hint}` : ""}
                      </option>
                    ))}
                    {input.allowCustom ? <option value={"\u0000custom"}>其他，手动输入…</option> : null}
                  </select>
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
