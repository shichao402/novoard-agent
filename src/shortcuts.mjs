/**
 * 快捷预设（ADR-0023）：一个 target + 一组预填参数 + 一个按钮名。
 *
 * - 不是新的执行单元：运行时就是带 vars 触发 target，审批、并发、日志、运行记录全部沿用。
 * - 只属于本机界面：存 <stateDir>/shortcuts.json，不进 targets.yaml、不进契约、不上 Hub。
 * - vars：预填值，作为触发 vars 传入；同名的 target vars 会被覆盖（runner 既有优先级）。
 * - ask：点击时仍要询问的 input 名单；同时出现在 vars 里时，预填值作为选择框的初值。
 *   ask 为空即一键执行；没预填也不询问的 input 按 target 的 default/last 取值（ADR-0020 §4）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { inputsOf } from "./inputs.mjs";

export const SHORTCUTS_VERSION = 1;
export const MAX_SHORTCUTS = 200;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 结构校验，挡住存不得的数据。
 * → { ok: true, shortcuts }（已归一：vars 值转字符串、ask 去重、缺省字段补齐）
 * → { ok: false, errors: string[] }
 */
export function validateShortcuts(raw) {
  if (!Array.isArray(raw)) return { ok: false, errors: ["shortcuts 必须是数组"] };
  if (raw.length > MAX_SHORTCUTS) return { ok: false, errors: [`快捷最多 ${MAX_SHORTCUTS} 个`] };
  const errors = [];
  const seen = new Set();
  const out = [];
  raw.forEach((item, i) => {
    const at = `shortcuts[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${at} 必须是对象`);
      return;
    }
    const id = String(item.id ?? "");
    if (!ID_RE.test(id)) errors.push(`${at}.id 只能用小写字母、数字和 -，且不能以 - 开头：${id || "（空）"}`);
    else if (seen.has(id)) errors.push(`${at}.id 重复：${id}`);
    seen.add(id);
    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (!label) errors.push(`${at}.label 不能为空`);
    const target = String(item.target ?? "");
    if (!ID_RE.test(target)) errors.push(`${at}.target 不是合法的 target id：${target || "（空）"}`);
    const vars = {};
    if (item.vars !== undefined && item.vars !== null) {
      if (typeof item.vars !== "object" || Array.isArray(item.vars)) {
        errors.push(`${at}.vars 必须是键值对象`);
      } else {
        for (const [key, value] of Object.entries(item.vars)) {
          if (!NAME_RE.test(key)) errors.push(`${at}.vars 的键名不合法：${key}`);
          else if (["string", "number", "boolean"].includes(typeof value)) vars[key] = String(value);
          else errors.push(`${at}.vars.${key} 只能是字符串、数字或布尔`);
        }
      }
    }
    const ask = [];
    if (item.ask !== undefined && item.ask !== null) {
      if (!Array.isArray(item.ask)) {
        errors.push(`${at}.ask 必须是数组`);
      } else {
        for (const name of item.ask) {
          if (typeof name !== "string" || !NAME_RE.test(name)) errors.push(`${at}.ask 里的名字不合法：${String(name)}`);
          else if (!ask.includes(name)) ask.push(name);
        }
      }
    }
    const shortcut = { id, label, target, vars, ask };
    if (typeof item.note === "string" && item.note.trim()) shortcut.note = item.note.trim();
    out.push(shortcut);
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, shortcuts: out };
}

/**
 * 和当前 targets 对照的问题，只提示、不挡保存（target 可能稍后才建或被删）。
 * → string[]
 */
export function shortcutProblems(shortcut, targets = {}) {
  const def = targets[shortcut.target];
  if (!def) return [`Target ${shortcut.target} 不存在`];
  const problems = [];
  const inputNames = new Set(inputsOf(def).map((input) => input.name));
  const varNames = new Set(Object.keys(def.vars ?? {}));
  for (const name of shortcut.ask ?? []) {
    if (!inputNames.has(name)) problems.push(`要询问的 ${name} 不是这个 Target 的输入`);
  }
  for (const name of Object.keys(shortcut.vars ?? {})) {
    if (!inputNames.has(name) && !varNames.has(name)) problems.push(`预填的 ${name} 不是这个 Target 的输入或变量`);
  }
  return problems;
}

export function createShortcutStore({ file } = {}) {
  function list() {
    if (!file || !existsSync(file)) return [];
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      const checked = validateShortcuts(data?.shortcuts ?? []);
      return checked.ok ? checked.shortcuts : [];
    } catch {
      return [];
    }
  }

  /** 整体替换。→ { ok: true, shortcuts } | { ok: false, errors } */
  function save(raw) {
    const checked = validateShortcuts(raw);
    if (!checked.ok) return checked;
    if (!file) return { ok: false, errors: ["快捷存储未配置文件路径"] };
    const tmp = `${file}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify({ version: SHORTCUTS_VERSION, shortcuts: checked.shortcuts }, null, 2)}\n`, "utf8");
      renameSync(tmp, file);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch {}
      return { ok: false, errors: [`写入失败：${error.message}`] };
    }
    return { ok: true, shortcuts: checked.shortcuts };
  }

  return { list, save, file };
}
