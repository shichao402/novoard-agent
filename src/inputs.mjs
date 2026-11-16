/**
 * 磁贴运行时输入（ADR-0020）：点击时选参数，候选项可以由能力包的查询工具现场给出。
 *
 * - resolveInputs：触发受理前统一取值（§4）。传入值优先，其次 default（last 取上次选定值），
 *   必填仍缺值即失败；静态 choices 且不允许自定义时，值必须在列表内。动态候选在这里不复核，交给执行工具。
 * - createInputMemory：last 的存取，文件 <dataDir>/input-memory.json，键 <targetId>.<name>。
 *   只在任务受理成功后写入，失败或取消不覆盖。
 * - createInputService：给控制台和内置会话用的 describe / queryChoices。
 *   查询工具进程外调用，固定 15 秒超时，不加路径锁、不受 concurrency 约束、不降优先级；
 *   超时、失败、格式非法一律退化为空列表 + 错误原因 + 临时允许自由输入（§3）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { prepareInvocation, EXIT } from "./packs/invoke.mjs";
import { parseUses, toolKind } from "./packs/registry.mjs";
import { runCommand } from "./packs/exec.mjs";

export const QUERY_TIMEOUT_MS = 15_000;
export const LAST = "last";
const VAR_RE = /\{\{(\w+)\}\}/g;

export function inputsOf(target) {
  return Array.isArray(target?.inputs) ? target.inputs : [];
}

export function hasInputs(target) {
  return inputsOf(target).length > 0;
}

function labelOf(input) {
  return String(input?.label || input?.name || "");
}

function isRequired(input) {
  return input?.required !== false;
}

function staticChoices(input) {
  return Array.isArray(input?.choices) ? input.choices.map(String) : null;
}

/** 允许输入列表外的值：无 choices 时恒为 true。 */
function allowsCustom(input) {
  if (input?.choices === undefined || input?.choices === null) return true;
  return input?.allowCustom === true;
}

function present(value) {
  return value !== undefined && value !== null;
}

/** last 的存取。文件读坏了按空处理，不影响触发。 */
export function createInputMemory({ file } = {}) {
  function load() {
    if (!file || !existsSync(file)) return {};
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  function get(targetId, name) {
    const value = load()[`${targetId}.${name}`];
    return typeof value === "string" ? value : undefined;
  }

  /** 受理成功后调用：把本次 inputs 的取值记下来。 */
  function remember(targetId, target, vars) {
    const list = inputsOf(target);
    if (!file || list.length === 0) return;
    const data = load();
    let changed = false;
    for (const input of list) {
      const value = vars?.[input.name];
      if (!present(value)) continue;
      const key = `${targetId}.${input.name}`;
      if (data[key] === String(value)) continue;
      data[key] = String(value);
      changed = true;
    }
    if (!changed) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      renameSync(tmp, file);
    } catch {
      try { rmSync(`${file}.tmp`, { force: true }); } catch {}
    }
  }

  return { get, remember, file };
}

/** default 的解析值：last 无记录时为 undefined。 */
export function defaultValue({ targetId, input, memory }) {
  if (!present(input?.default)) return undefined;
  if (input.default === LAST) return memory?.get?.(targetId, input.name);
  return String(input.default);
}

/**
 * 触发时取值（§4）。
 * → { ok: true, vars }：vars = 传入 vars + 各 input 的取值
 * → { ok: false, reason, missing: [{ name, label }] }
 */
export function resolveInputs({ targetId, target, vars = {}, memory = null } = {}) {
  const list = inputsOf(target);
  const out = { ...(vars ?? {}) };
  if (list.length === 0) return { ok: true, vars: out };
  const missing = [];
  const invalid = [];
  for (const input of list) {
    let value = out[input.name];
    if (!present(value) || (isRequired(input) && value === "")) {
      value = defaultValue({ targetId, input, memory });
    }
    if (!present(value) || (isRequired(input) && value === "")) {
      if (isRequired(input)) {
        missing.push({ name: input.name, label: labelOf(input) });
        continue;
      }
      value = "";
    }
    const fixed = staticChoices(input);
    if (fixed && !allowsCustom(input) && !(value === "" && !isRequired(input)) && !fixed.includes(String(value))) {
      invalid.push(`${labelOf(input)}（${input.name}）的值 ${value} 不在候选项 ${fixed.join("、")} 里`);
      continue;
    }
    out[input.name] = value;
  }
  if (missing.length > 0 || invalid.length > 0) {
    const parts = [];
    if (missing.length > 0) parts.push(`缺少输入：${missing.map((m) => (m.label === m.name ? m.name : `${m.label}（${m.name}）`)).join("、")}`);
    parts.push(...invalid);
    return { ok: false, reason: parts.join("；"), missing };
  }
  return { ok: true, vars: out };
}

function interpolate(text, vars) {
  return String(text).replace(VAR_RE, (_, key) => {
    if (!(key in vars)) throw new Error(`插值 {{${key}}} 无来源`);
    return String(vars[key]);
  });
}

function mapWith(withParams, vars) {
  const out = {};
  for (const [k, v] of Object.entries(withParams ?? {})) {
    if (typeof v === "string") out[k] = interpolate(v, vars);
    else if (Array.isArray(v)) out[k] = v.map((item) => (typeof item === "string" ? interpolate(item, vars) : item));
    else out[k] = v;
  }
  return out;
}

/** 查询工具返回的 choices 归一：字符串或 { value, label?, hint? }。非法时返回 null。 */
export function normalizeChoices(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ value: item });
      continue;
    }
    if (!item || typeof item !== "object" || typeof item.value !== "string") return null;
    const choice = { value: item.value };
    if (typeof item.label === "string" && item.label) choice.label = item.label;
    if (typeof item.hint === "string" && item.hint) choice.hint = item.hint;
    out.push(choice);
  }
  return out;
}

export function createInputService({ packs = null, memory = null, env = process.env, cwd = process.cwd(), timeoutMs = QUERY_TIMEOUT_MS, run = runCommand, log = console } = {}) {
  /** → { choices: [{ value, label?, hint? }], error?: string } */
  async function query({ target, input }) {
    const spec = input?.choices;
    const ref = parseUses(spec?.uses);
    if (!ref) return { choices: [], error: `候选项来源格式不对：${spec?.uses ?? ""}` };
    if (!packs) return { choices: [], error: "本机没有配置能力包目录" };
    const tool = packs.lookupTool?.(ref.packId, ref.toolId);
    if (tool && toolKind(tool) !== "query") return { choices: [], error: `${spec.uses} 不是查询工具` };
    let params;
    let projectRoot;
    try {
      const vars = target?.vars ?? {};
      params = mapWith(spec.with, vars);
      projectRoot = spec.cwd ? interpolate(spec.cwd, vars) : cwd;
    } catch (error) {
      return { choices: [], error: `${spec.uses}：${error.message}` };
    }
    const inv = prepareInvocation({ registry: packs, uses: spec.uses, params, projectRoot, env });
    if (!inv.ok) return { choices: [], error: inv.reason };
    if (!inv.resultJson) return { choices: [], error: `${spec.uses} 不支持 --result-json，拿不到候选项` };
    const r = await run(inv.command, inv.args, { cwd: inv.cwd, env, timeoutMs });
    let parsed = null;
    try {
      if (existsSync(inv.resultJson)) parsed = JSON.parse(readFileSync(inv.resultJson, "utf8"));
    } catch {
      parsed = undefined;
    } finally {
      try { rmSync(inv.resultJson, { force: true }); } catch {}
    }
    if (r.spawnError) return { choices: [], error: `${spec.uses} 启动失败：${r.spawnError}` };
    if (r.code !== EXIT.OK) {
      const timedOut = /超时（\d+ 秒）/.test(r.stderr ?? "") && r.code === -1;
      const why = timedOut
        ? `查询超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`
        : (parsed?.detail || tail(r.stderr || r.stdout) || `退出码 ${r.code}`);
      return { choices: [], error: `${spec.uses}：${why}` };
    }
    const choices = normalizeChoices(parsed?.choices);
    if (!choices) return { choices: [], error: `${spec.uses} 返回的候选项格式不对` };
    return { choices };
  }

  /** 单个 input 的完整描述（选择框用）。 */
  async function describeInput({ targetId, target, input }) {
    const base = {
      name: input.name,
      label: labelOf(input),
      required: isRequired(input),
      allowCustom: allowsCustom(input),
      dynamic: Boolean(input.choices && !Array.isArray(input.choices)),
      default: defaultValue({ targetId, input, memory }) ?? "",
      choices: [],
    };
    if (Array.isArray(input.choices)) {
      base.choices = input.choices.map((value) => ({ value: String(value) }));
      return base;
    }
    if (!input.choices) return base;
    let res;
    try {
      res = await query({ target, input });
    } catch (error) {
      res = { choices: [], error: error?.message ?? String(error) };
    }
    if (res.error) {
      log.warn?.(`[inputs] ${targetId}.${input.name} 候选项查询失败：${res.error}`);
      return { ...base, choices: [], error: res.error, allowCustom: true };
    }
    return { ...base, choices: res.choices };
  }

  /** → { id, title, inputs: [...] }；多个 input 的查询并行。 */
  async function describe(targetId, target) {
    const inputs = await Promise.all(inputsOf(target).map((input) => describeInput({ targetId, target, input })));
    return { id: targetId, title: target?.title ?? targetId, inputs };
  }

  async function queryChoices(targetId, target, name) {
    const input = inputsOf(target).find((i) => i.name === name);
    if (!input) return { choices: [], error: `没有输入 ${name}`, allowCustom: true };
    const d = await describeInput({ targetId, target, input });
    return { choices: d.choices, ...(d.error ? { error: d.error } : {}), allowCustom: d.allowCustom };
  }

  return { describe, queryChoices, query };
}

function tail(text) {
  return String(text ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
}
