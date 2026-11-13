/**
 * uses step 的调用准备与结果解读（ADR-0019 §2–4）。
 * 进程的启动、取消、超时由 runner.mjs 统一负责，和 script step 共用同一套进程树回收。
 * 调用形状：<interpreter> <entry> <tool> --project-root <cwd> [--dry-run] [--result-json <file>] [--<param> <value> ...]
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { locateNode } from "../chat-bridge.mjs";
import { parseUses } from "./registry.mjs";
import { paramsToArgv, validateToolParams } from "./validate.mjs";
import { depsStatus, venvPython } from "./deps.mjs";

export const EXIT = { OK: 0, USAGE: 64, UNEXPECTED: 99, INTERRUPTED: 130 };

export const resolvePython = venvPython;

/** 当前平台是否被工具支持（platforms 缺省视为全平台）。 */
export function platformSupported(tool, platform = process.platform) {
  return !Array.isArray(tool?.platforms) || tool.platforms.length === 0 || tool.platforms.includes(platform);
}

/**
 * 解析 uses step 为一次进程调用。
 * → { ok: true, command, args, cwd, tool, pack, resultJson, label } | { ok: false, code, reason }
 */
export function prepareInvocation({ registry, uses, params, projectRoot, dryRun = false, platform = process.platform, env = process.env }) {
  const ref = parseUses(uses);
  if (!ref) return { ok: false, code: "bad-uses", reason: `uses 格式应为 <能力包>/<工具>：${uses}` };
  const pack = registry?.get(ref.packId) ?? { ok: false, code: "pack-missing", reason: `本机未安装能力包 ${ref.packId}` };
  if (!pack.ok) return { ok: false, code: pack.code, reason: pack.reason };
  const tool = pack.manifest.tools.find((t) => t.id === ref.toolId);
  if (!tool) {
    return { ok: false, code: "tool-missing", reason: `能力包 ${ref.packId} 中没有工具 ${ref.toolId}，可能版本过旧` };
  }
  if (!platformSupported(tool, platform)) {
    return { ok: false, code: "platform-unsupported", reason: `${uses} 不支持 ${platform}` };
  }
  const checked = validateToolParams(tool, params);
  if (checked.errors.length > 0) {
    return { ok: false, code: "bad-params", reason: `${uses} 参数错误：${checked.errors.join("; ")}` };
  }

  const runtime = pack.manifest.runtime ?? "python";
  let command;
  if (runtime === "node") {
    command = locateNode(env);
    if (!command) return { ok: false, code: "runtime-missing", reason: `找不到 Node，无法运行能力包 ${ref.packId}` };
  } else if (runtime === "python") {
    const deps = depsStatus(pack.root, pack.manifest);
    command = deps.ready ? venvPython(pack.root) : null;
    if (!command) return { ok: false, code: "deps-not-ready", reason: `能力包 ${ref.packId} 依赖未就绪（${deps.reason ?? "缺少 .venv"}）` };
  } else {
    return { ok: false, code: "runtime-unsupported", reason: `能力包 ${ref.packId} 的 runtime=${runtime} 不受支持` };
  }

  const entry = join(pack.root, pack.manifest.entry ?? "toolset.py");
  if (!existsSync(entry)) return { ok: false, code: "entry-missing", reason: `能力包 ${ref.packId} 入口不存在：${entry}` };

  const args = [entry, ref.toolId, "--project-root", projectRoot, ...paramsToArgv(checked.params)];
  let resultJson = null;
  if (tool.supportsResultJson !== false) {
    resultJson = join(tmpdir(), `novoard-pack-${randomUUID()}.result.json`);
    args.push("--result-json", resultJson);
  }
  if (dryRun && tool.supportsDryRun) args.push("--dry-run");
  return { ok: true, command, args, cwd: pack.root, tool, pack: ref.packId, resultJson, label: `uses ${uses}`, retired: checked.retired };
}

/** stdout 中 {"type":"progress",...} 的行视为进度（ADR-0019 §4），否则返回 null。 */
export function parseProgressLine(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text);
    if (value?.type !== "progress") return null;
    const message = typeof value.message === "string" ? value.message : "";
    const percent = Number.isFinite(value.percent) ? Math.max(0, Math.min(100, value.percent)) : null;
    return { message, percent };
  } catch {
    return null;
  }
}

/** 读 --result-json 并清理临时文件。step 结果描述依次取 summary、detail，再退回 stdout 末 12 行。 */
export function readResult({ resultJson, code, stdout = "", stderr = "", tool }) {
  let parsed = null;
  if (resultJson && existsSync(resultJson)) {
    try {
      parsed = JSON.parse(readFileSync(resultJson, "utf8"));
    } catch {
      parsed = null;
    }
    try { rmSync(resultJson, { force: true }); } catch {}
  }
  const name = tool?.displayName || tool?.id || "工具";
  const fromJson = parsed ? parsed.summary || parsed.detail || "" : "";
  if (code === EXIT.OK) {
    return { ok: true, detail: fromJson || tailLines(stdout) || `${name} 完成`, skipped: parsed?.skipped === true };
  }
  const prefix = code === EXIT.USAGE ? "参数错误：" : code === EXIT.UNEXPECTED ? "意外错误：" : "";
  return { ok: false, detail: `${prefix}${fromJson || tailLines(stderr || stdout) || `${name} 退出码 ${code}`}` };
}

function tailLines(text) {
  return String(text ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-12).join("\n");
}
