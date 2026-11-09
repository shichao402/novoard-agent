/**
 * Agent Card 派生（契约 §2）：每个 expose: a2a 的 target 生成一个 skill 条目；
 * skill id = target id；description = title + vars 参数说明。
 * targets YAML 与模板从 agents/<agentId>/ 同级目录装载，装载即用 target.json schema 校验（纪律一）。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse } from "yaml";
import { createFrameValidator } from "./contract/frames.mjs";
import { loadProfile } from "./profile.mjs";
import { validateToolParams } from "./packs/validate.mjs";

/** 保留技能：表示这台机器能用自然语言和别的成员对话。不能被 Target 占用。 */
export const CONVERSE_SKILL_ID = "converse";

export function loadTargets({ agentDir, validate }) {
  const targetsPath = join(agentDir, "targets.yaml");
  if (!existsSync(targetsPath)) {
    return { ok: false, reason: `targets.yaml 不存在：${targetsPath}` };
  }
  let data;
  try {
    data = parse(readFileSync(targetsPath, "utf8"));
  } catch (error) {
    return { ok: false, reason: `targets.yaml 解析失败：${error.message}` };
  }
  return validateTargetsData(data, validate);
}

/** 校验已解析的 targets 定义（装载期与 editor 保存共用同一条路，纪律一：不合法定义不上盘）。 */
export function validateTargetsData(data, validate) {
  const validator = validate ?? createFrameValidator();
  if (!data || typeof data !== "object" || !data.targets) {
    return { ok: false, reason: "定义缺少顶层 targets 键", errors: ["缺少顶层 targets 键（targets: {...}）"] };
  }
  if (Object.prototype.hasOwnProperty.call(data.targets, CONVERSE_SKILL_ID)) {
    return { ok: false, reason: "target id 不能占用 converse", errors: ["converse 是成员对话技能的保留 id"] };
  }
  const res = validator.targets(data);
  if (!res.ok) {
    return { ok: false, reason: `targets 校验失败（纪律一）：${res.errors.join("; ")}`, errors: res.errors };
  }
  return { ok: true, targets: data.targets };
}

/**
 * uses step 的装载期检查（PRD-7 A4，依据 ADR-0019 §6）。入参是展开后的 targets（含模板展开的 steps）。
 * 定义错误（拒绝保存、启动失败）：with 不通过工具 params 校验；remoteWrite 工具所在 target 没有 requiresApproval: true。
 * 不算定义错误、交给诊断（A6）：包没装、manifest 读不了、包里没有这个工具（多半是包版本旧）、平台不支持。
 * with 中含 {{var}} 的值要到触发时才知道，装载期跳过它的类型检查，运行时再校验。
 */
export function validateUsesSteps(expandedTargets, packs) {
  if (!packs) return [];
  const errors = [];
  for (const [id, t] of Object.entries(expandedTargets ?? {})) {
    const steps = t.expanded ?? t.steps;
    if (!Array.isArray(steps)) continue;
    steps.forEach((step, i) => {
      if (typeof step?.uses !== "string") return;
      const slash = step.uses.indexOf("/");
      if (slash <= 0) return;
      const tool = packs.lookupTool(step.uses.slice(0, slash), step.uses.slice(slash + 1));
      if (!tool) return;
      const where = `targets.${id}.steps[${i}]`;
      if (tool.remoteWrite === true && t.requiresApproval !== true) {
        errors.push(`${where}: ${step.uses} 会写远端，所在 target 必须设 requiresApproval: true`);
      }
      const input = {};
      const deferred = new Set();
      for (const [k, v] of Object.entries(step.with ?? {})) {
        const templated = typeof v === "string" ? v.includes("{{") : Array.isArray(v) && v.some((x) => typeof x === "string" && x.includes("{{"));
        if (templated) deferred.add(k);
        else input[k] = v;
      }
      const checked = validateToolParams(tool, input);
      const real = checked.errors.filter((e) => ![...deferred].some((k) => e === `缺少必填参数: ${k}`));
      for (const e of real) errors.push(`${where}: ${step.uses} 参数错误：${e}`);
    });
  }
  return errors;
}

/** 展开模板引用：target.template → templates/<name>.yaml 的 steps + vars 默认值（契约 §1.3）。 */
export function expandSteps({ targets, agentDir }) {
  const out = {};
  for (const [id, t] of Object.entries(targets)) {
    if (t.steps) {
      out[id] = { ...t, expanded: t.steps };
      continue;
    }
    const tplPath = join(agentDir, "templates", `${t.template}.yaml`);
    if (!existsSync(tplPath)) {
      return { ok: false, reason: `target ${id} 引用的模板不存在：${tplPath}` };
    }
    const tpl = parse(readFileSync(tplPath, "utf8"));
    out[id] = {
      ...t,
      vars: { ...(tpl.vars ?? {}), ...(t.vars ?? {}) }, // target vars 覆盖模板默认值
      expanded: tpl.steps,
    };
  }
  return { ok: expandedAll(out), targets: out };
}

function expandedAll(out) {
  return Object.values(out).every((t) => Array.isArray(t.expanded) && t.expanded.length >= 1);
}

/** 从自我介绍和 targets 派生 Agent Card。介绍给其他成员看；Target 只是其中的技能。 */
export function deriveCard({ agentId, targets, agentDir, profile, description, version = "1.0.0" }) {
  const intro = profile ?? (agentDir ? loadProfile(agentDir) : { role: "", introduction: "" });
  const introduction = String(intro.introduction || description || `${agentId} 上的 Novoard agent`).trim();
  const role = String(intro.role ?? "").trim();
  const converseTags = ["novoard", "kind:agent"];
  if (role) converseTags.push(`role:${role}`);
  const skills = [
    {
      id: CONVERSE_SKILL_ID,
      name: "对话",
      description: introduction,
      tags: converseTags,
      "x-novoard-kind": "agent",
    },
    ...Object.entries(targets)
    .filter(([, t]) => t.expose === "a2a")
    .map(([id, t]) => {
      const skill = {
        id,
        name: t.title,
        description: capabilityText(t),
        tags: ["novoard"],
      };
      if (t.offline) {
        skill["x-novoard-offline"] = {
          policy: t.offline,
          ...(t.offline === "queue" || t.offlineTtl ? { ttl: t.offlineTtl || "30m" } : {}),
        };
      }
      if (t.notify) {
        skill["x-novoard-notify"] = t.notify; // M3 F2：通知策略透传（always/on-failure/never），hub 查表过滤终态通知
      }
      skill["x-novoard-timeout"] = t.timeout || "10m";
      skill["x-novoard-lost"] = { ttl: t.lostTtl || "10m" };
      if (t.requiresApproval) skill["x-novoard-approval"] = { ttl: t.approvalTtl || "10m" };
      return skill;
    }),
  ];
  const card = {
    name: agentId,
    description: introduction,
    version,
    capabilities: { streaming: false, pushNotifications: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "file"],
    skills,
  };
  if (role) card["x-novoard-role"] = role;
  return card;
}

function capabilityText(target) {
  const title = String(target.title ?? "").trim();
  const schedule = target.schedule ? `安排：${target.schedule}` : "";
  const vars = Object.keys(target.vars ?? {});
  const params = vars.length ? `参数：${vars.join("、")}` : "";
  return [title, schedule, params].filter(Boolean).join("。");
}
