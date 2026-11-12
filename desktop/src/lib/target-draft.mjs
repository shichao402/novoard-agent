/**
 * Target 表单草稿 ⇄ targets.yaml 定义（PRD-7 A9）。纯逻辑，由 test/target-form.test.mjs 直接测试。
 *
 * 保存的原则：表单只覆盖自己管的字段，其余字段（vars、script 的 env 等）原样沿用上次的定义，
 * 不能因为表单没有对应的控件就在保存时丢掉。
 */
import { isValidCron } from "./cron.mjs";

export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
export const DURATION_RE = /^\d+(s|m|h|d)$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const STEP_KIND_LABELS = {
  uses: "能力包工具",
  script: "命令",
  openApp: "打开应用",
  openPath: "打开文件或目录",
  template: "模板",
};

let seq = 0;
function stepKey() {
  seq += 1;
  return `s${seq}`;
}

export function newStep(kind) {
  switch (kind) {
    case "uses":
      return { key: stepKey(), kind, uses: "", with: {}, cwd: "", retry: "", retryInterval: "" };
    case "script":
      return { key: stepKey(), kind, script: "", cwd: "" };
    case "openApp":
    case "openPath":
      return { key: stepKey(), kind, value: "" };
    default:
      throw new Error(`不能新建 ${kind} 步骤`);
  }
}

function stepToDraft(step) {
  if ("uses" in step) {
    return {
      key: stepKey(),
      kind: "uses",
      uses: step.uses,
      with: { ...(step.with ?? {}) },
      cwd: step.cwd ?? "",
      retry: step.retry === undefined ? "" : String(step.retry),
      retryInterval: step.retryInterval ?? "",
    };
  }
  if ("script" in step) {
    return { key: stepKey(), kind: "script", script: step.script, cwd: step.cwd ?? "", ...(step.env ? { env: { ...step.env } } : {}) };
  }
  if ("openApp" in step) return { key: stepKey(), kind: "openApp", value: step.openApp };
  if ("openPath" in step) return { key: stepKey(), kind: "openPath", value: step.openPath };
  return { key: stepKey(), kind: "template", template: step.template };
}

export function toDraft(id, target) {
  return {
    id,
    title: target.title,
    expose: target.expose,
    audit: target.audit,
    notify: target.notify,
    requiresApproval: target.requiresApproval === true,
    offline: target.offline ?? "reject",
    offlineTtl: target.offlineTtl ?? "30m",
    concurrency: String(target.concurrency ?? 1),
    timeout: target.timeout ?? "10m",
    lostTtl: target.lostTtl ?? "10m",
    approvalTtl: target.approvalTtl ?? "10m",
    schedule: target.schedule ?? "",
    oncePerDay: target.oncePerDay !== false,
    deadline: target.deadline ?? "",
    template: target.template ?? "",
    steps: (target.steps ?? []).map(stepToDraft),
  };
}

export function newDraft(existingIds) {
  const ids = new Set(existingIds);
  let number = ids.size + 1;
  let id = `target-${number}`;
  while (ids.has(id)) {
    number += 1;
    id = `target-${number}`;
  }
  return {
    id,
    title: "新 Target",
    expose: "a2a",
    audit: "summary",
    notify: "on-failure",
    requiresApproval: false,
    offline: "reject",
    offlineTtl: "30m",
    concurrency: "1",
    timeout: "10m",
    lostTtl: "10m",
    approvalTtl: "10m",
    schedule: "",
    oncePerDay: true,
    deadline: "",
    template: "",
    steps: [newStep("uses")],
  };
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** 去掉没填的参数：空串、空数组、数组里的空项。没填的参数由工具按缺省值处理。 */
export function cleanWith(input) {
  const out = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    if (Array.isArray(value)) {
      const items = value.filter((item) => !isBlank(item));
      if (items.length) out[name] = items;
      continue;
    }
    if (typeof value === "number" && Number.isNaN(value)) continue;
    if (isBlank(value)) continue;
    out[name] = value;
  }
  return out;
}

/** 表单上显示的参数值：填了用填的，没填用清单缺省值。 */
export function paramValue(spec, withValues) {
  const own = withValues?.[spec.name];
  return own === undefined ? spec.default : own;
}

function clampConcurrency(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return 1;
  return Math.min(32, Math.max(1, number));
}

function stepToDef(step) {
  switch (step.kind) {
    case "uses": {
      const params = cleanWith(step.with);
      return {
        uses: step.uses,
        ...(Object.keys(params).length ? { with: params } : {}),
        ...(step.cwd.trim() ? { cwd: step.cwd.trim() } : {}),
        ...(String(step.retry).trim() !== "" ? { retry: Number(step.retry) } : {}),
        ...(step.retryInterval.trim() ? { retryInterval: step.retryInterval.trim() } : {}),
      };
    }
    case "script":
      return { script: step.script.trim(), ...(step.cwd.trim() ? { cwd: step.cwd.trim() } : {}), ...(step.env ? { env: step.env } : {}) };
    case "openApp":
      return { openApp: step.value.trim() };
    case "openPath":
      return { openPath: step.value.trim() };
    default:
      return { template: step.template };
  }
}

const OPTIONAL_KEYS = ["schedule", "oncePerDay", "deadline", "offlineTtl", "approvalTtl", "template", "steps"];

export function toDef(draft, previous) {
  const def = { ...(previous ?? {}) };
  for (const key of OPTIONAL_KEYS) delete def[key];
  Object.assign(def, {
    title: draft.title.trim(),
    expose: draft.expose,
    audit: draft.audit,
    requiresApproval: draft.requiresApproval,
    notify: draft.notify,
    offline: draft.offline,
    concurrency: clampConcurrency(draft.concurrency),
    timeout: draft.timeout.trim() || "10m",
    lostTtl: draft.lostTtl.trim() || "10m",
  });
  if (draft.requiresApproval) def.approvalTtl = draft.approvalTtl.trim() || "10m";
  if (draft.offline === "queue") def.offlineTtl = draft.offlineTtl.trim() || "30m";
  const schedule = draft.schedule.trim();
  if (schedule) {
    def.schedule = schedule;
    if (!draft.oncePerDay) def.oncePerDay = false;
    if (draft.deadline.trim()) def.deadline = draft.deadline.trim();
  }
  if (draft.steps.length === 0 && draft.template) def.template = draft.template;
  else def.steps = draft.steps.map(stepToDef);
  if (!def.vars) def.vars = {};
  return def;
}

/** "pack/tool" → 工具清单；tools 来自 GET /api/packs/tools。 */
export function indexTools(packs) {
  const map = new Map();
  for (const pack of packs ?? []) {
    for (const tool of pack.tools ?? []) map.set(`${pack.id}/${tool.id}`, { ...tool, packId: pack.id, packName: pack.displayName });
  }
  return map;
}

export function paramLabel(spec) {
  return spec.label || spec.name;
}

function checkParam(spec, value, where) {
  const label = `${where}「${paramLabel(spec)}」`;
  if (value === undefined || isBlank(value) || (Array.isArray(value) && value.every(isBlank))) {
    return spec.required && spec.default === undefined ? `${label}必填` : null;
  }
  if (spec.type === "number" && (typeof value !== "number" || Number.isNaN(value))) return `${label}需要是数字`;
  if (spec.format === "duration" && typeof value === "string" && !DURATION_RE.test(value.trim())) return `${label}要写成 30s、10m、1h 这种格式`;
  if (spec.format === "time" && typeof value === "string" && !TIME_RE.test(value.trim())) return `${label}要写成 HH:mm，例如 08:00`;
  return null;
}

/** 单个 target 的表单级错误；tools 为 indexTools 的结果。找不到的工具不在这里报，交给诊断（未装包仍可保存）。 */
export function validateDraft(draft, { tools = new Map(), timezone } = {}) {
  const errors = [];
  if (!ID_RE.test(draft.id)) errors.push(`ID 不合法：${draft.id || "(空)"}。使用小写字母、数字或连字符`);
  if (!draft.title.trim()) errors.push("缺少标题");
  if (draft.steps.length === 0 && !draft.template) errors.push("至少需要一个步骤");
  draft.steps.forEach((step, index) => {
    const where = `第 ${index + 1} 步`;
    if (step.kind === "script" && !step.script.trim()) errors.push(`${where}的命令为空`);
    if ((step.kind === "openApp" || step.kind === "openPath") && !step.value.trim()) errors.push(`${where}还没填要打开的内容`);
    if (step.kind !== "uses") return;
    if (!step.uses) {
      errors.push(`${where}还没选工具`);
      return;
    }
    if (String(step.retry).trim() !== "") {
      const retry = Number(step.retry);
      if (!Number.isInteger(retry) || retry < 0 || retry > 10) errors.push(`${where}的重试次数要在 0 到 10 之间`);
    }
    if (step.retryInterval.trim() && !DURATION_RE.test(step.retryInterval.trim())) errors.push(`${where}的重试间隔要写成 30s、10m、1h 这种格式`);
    const tool = tools.get(step.uses);
    if (!tool) return;
    for (const spec of tool.params ?? []) {
      const problem = checkParam(spec, step.with?.[spec.name], where);
      if (problem) errors.push(problem);
    }
    if (tool.remoteWrite && !draft.requiresApproval) errors.push(`${where}「${tool.displayName}」会写远端，需要打开「执行前需要在 Hub 上确认」`);
  });
  const durations = [
    ["运行超时", draft.timeout.trim() || "10m"],
    ["断线后判定丢失", draft.lostTtl.trim() || "10m"],
  ];
  if (draft.requiresApproval) durations.push(["审批等待", draft.approvalTtl.trim() || "10m"]);
  if (draft.offline === "queue") durations.push(["离线排队上限", draft.offlineTtl.trim() || "30m"]);
  for (const [label, value] of durations) {
    if (!DURATION_RE.test(value)) errors.push(`${label}要写成 30s、10m、1h 这种格式`);
  }
  const schedule = draft.schedule.trim();
  if (schedule && !isValidCron(schedule, timezone)) errors.push("定时表达式无效，需要 5 段（分 时 日 月 周）");
  if (schedule && draft.deadline.trim() && !TIME_RE.test(draft.deadline.trim())) errors.push("硬截止要写成 HH:mm，例如 08:00");
  return errors;
}

/** 全部 target：逐个校验并检查 ID 重复。返回 [{ index, id, errors }]，只含有错误的。 */
export function validateDrafts(drafts, context) {
  const seen = new Set();
  const out = [];
  drafts.forEach((draft, index) => {
    const errors = validateDraft(draft, context);
    if (seen.has(draft.id)) errors.unshift(`ID 重复：${draft.id}`);
    seen.add(draft.id);
    if (errors.length) out.push({ index, id: draft.id, errors });
  });
  return out;
}
