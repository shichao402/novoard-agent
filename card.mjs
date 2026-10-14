/**
 * Agent Card 派生（契约 §2）：每个 expose: a2a 的 target 生成一个 skill 条目；
 * skill id = target id；description = title + vars 参数说明。
 * targets YAML 与模板从 agents/<agentId>/ 同级目录装载，装载即用 target.json schema 校验（纪律一）。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse } from "yaml";
import { createFrameValidator } from "../frames.mjs";

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
  const res = validator.targets(data);
  if (!res.ok) {
    return { ok: false, reason: `targets 校验失败（纪律一）：${res.errors.join("; ")}`, errors: res.errors };
  }
  return { ok: true, targets: data.targets };
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

/** 从 targets 派生 Agent Card（契约 §2 生成规则；v1.1：offline 策略随 skill 透传）。 */
export function deriveCard({ agentId, targets, description, version = "1.0.0" }) {
  const skills = Object.entries(targets)
    .filter(([, t]) => t.expose === "a2a")
    .map(([id, t]) => {
      const skill = {
        id,
        name: t.title,
        description: `${t.title}；vars: ${Object.keys(t.vars ?? {}).join(", ") || "无"}`,
        tags: ["novoard"],
      };
      if (t.offline) {
        skill["x-novoard-offline"] = { policy: t.offline, ...(t.offlineTtl ? { ttl: t.offlineTtl } : {}) };
      }
      if (t.notify) {
        skill["x-novoard-notify"] = t.notify; // M3 F2：通知策略透传（always/on-failure/never），hub 查表过滤终态通知
      }
      return skill;
    });
  return {
    name: agentId,
    description: description ?? `${agentId} · lite-agent`,
    version,
    capabilities: { streaming: false, pushNotifications: true },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "file"],
    skills,
  };
}
