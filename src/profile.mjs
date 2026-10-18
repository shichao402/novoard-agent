/**
 * 成员自我介绍，和 Target 分开存放。
 * 介绍写在 Card 的 description，角色写在 x-novoard-role。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const ROLE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function profilePath(agentDir) {
  return join(agentDir, "profile.yaml");
}

export function loadProfile(agentDir) {
  const file = profilePath(agentDir);
  if (!agentDir || !existsSync(file)) return { role: "", introduction: "" };
  try {
    const data = parse(readFileSync(file, "utf8")) ?? {};
    return normalizeProfile(data);
  } catch {
    return { role: "", introduction: "" };
  }
}

export function normalizeProfile(input = {}) {
  const role = String(input.role ?? "").trim();
  const introduction = String(input.introduction ?? "").trim().slice(0, 500);
  if (role && !ROLE_PATTERN.test(role)) {
    return { ok: false, reason: "角色标签只能是小写字母、数字和连字符" };
  }
  return { ok: true, role, introduction };
}

export function saveProfile(agentDir, input) {
  const normalized = normalizeProfile(input);
  if (!normalized.ok) return normalized;
  const file = profilePath(agentDir);
  const text = stringify({ role: normalized.role, introduction: normalized.introduction });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
  return { ok: true, role: normalized.role, introduction: normalized.introduction };
}
