/**
 * 工具参数校验与 argv 拼装（ADR-0019 §1–2），照搬 cronkit src/core/toolset/validate.ts。
 * 差异：去掉 rawArgs（契约 uses step 没有该字段）。
 */

export function validateToolParams(tool, raw) {
  const errors = [];
  const input = { ...(raw ?? {}) };
  const specs = tool.params ?? [];
  const known = new Set(specs.map((s) => s.name));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors.push(`未知参数: ${key}`);
  }
  const params = {};
  for (const spec of specs) {
    const has = Object.prototype.hasOwnProperty.call(input, spec.name);
    const value = has ? input[spec.name] : spec.default;
    if (value === undefined || value === null) {
      if (spec.required) errors.push(`缺少必填参数: ${spec.name}`);
      continue;
    }
    const coerced = coerceParam(spec, value);
    if (coerced.error) {
      errors.push(coerced.error);
      continue;
    }
    params[spec.name] = coerced.value;
  }
  return { params, errors };
}

function coerceParam(spec, value) {
  switch (spec.type) {
    case "string":
      if (typeof value !== "string") return { error: `${spec.name} 应为 string` };
      if (spec.enum && !spec.enum.includes(value)) return { error: `${spec.name} 必须是 ${spec.enum.join("|")}` };
      return { value };
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) return { error: `${spec.name} 应为 number` };
      return { value };
    case "boolean":
      if (typeof value !== "boolean") return { error: `${spec.name} 应为 boolean` };
      return { value };
    case "string[]":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return { error: `${spec.name} 应为 string[]` };
      return { value };
    case "enum":
      if (typeof value !== "string") return { error: `${spec.name} 应为枚举字符串` };
      if (spec.enum && !spec.enum.includes(value)) return { error: `${spec.name} 必须是 ${spec.enum.join("|")}` };
      return { value };
    default:
      return { error: `${spec.name} 未知类型` };
  }
}

/** { onConflict: "revert" } → ["--on-conflict", "revert"]；布尔 true 写 --flag，false 写 --flag=false；数组每项重复 flag。 */
export function paramsToArgv(params) {
  const args = [];
  for (const [key, value] of Object.entries(params)) {
    const flag = `--${camelToKebab(key)}`;
    if (typeof value === "boolean") {
      args.push(value ? flag : `${flag}=false`);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) args.push(flag, String(item));
      continue;
    }
    if (value === null || value === undefined) continue;
    args.push(flag, String(value));
  }
  return args;
}

function camelToKebab(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
