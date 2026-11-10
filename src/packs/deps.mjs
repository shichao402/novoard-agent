/**
 * 能力包依赖就绪（ADR-0019 §7）。
 * - python 包：<root>/.venv + pip install -r requirements.txt，完成后写 .venv/.deps-ok，内容为 requirements.txt 的 sha256；
 *   哈希不一致视为依赖未就绪。没有 requirements.txt 时按空内容计算哈希。
 * - node 包：必须提交打包好的 entry，没有安装步骤。
 * 运行时（invoke）只调 depsStatus 检查，安装只发生在 manager 里。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./exec.mjs";

export const DEPS_OK_FILE = ".deps-ok";

export function venvPython(root) {
  const win = join(root, ".venv", "Scripts", "python.exe");
  const nix = join(root, ".venv", "bin", "python");
  if (existsSync(win)) return win;
  if (existsSync(nix)) return nix;
  return null;
}

export function requirementsHash(root) {
  const file = join(root, "requirements.txt");
  const text = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  return createHash("sha256").update(text).digest("hex");
}

function depsOkPath(root) {
  return join(root, ".venv", DEPS_OK_FILE);
}

/** → { ready: true } | { ready: false, reason } */
export function depsStatus(root, manifest) {
  const runtime = manifest?.runtime ?? "python";
  const entry = join(root, manifest?.entry ?? (runtime === "node" ? "index.mjs" : "toolset.py"));
  if (!existsSync(entry)) return { ready: false, reason: `入口不存在：${entry}` };
  if (runtime === "node") return { ready: true };
  if (runtime !== "python") return { ready: false, reason: `runtime=${runtime} 不受支持` };
  if (!venvPython(root)) return { ready: false, reason: "缺少 .venv" };
  const okFile = depsOkPath(root);
  if (!existsSync(okFile)) return { ready: false, reason: "缺少 .deps-ok" };
  const recorded = readFileSync(okFile, "utf8").trim();
  if (recorded !== requirementsHash(root)) return { ready: false, reason: "requirements.txt 已变化，需要重新准备依赖" };
  return { ready: true };
}

/** 建 venv 用的基础解释器候选：Windows 为 py -3、python；其他平台为 python3。 */
export function basePythonCandidates(platform = process.platform) {
  return platform === "win32" ? [["py", ["-3"]], ["python", []]] : [["python3", []]];
}

/**
 * 准备依赖。→ { ok: true } | { ok: false, code, reason }
 * run 可注入（测试用），签名同 exec.mjs runCommand。
 */
export async function prepareDeps(root, manifest, { run = runCommand, platform = process.platform, env = process.env, onProgress } = {}) {
  const runtime = manifest?.runtime ?? "python";
  if (runtime === "node") {
    const status = depsStatus(root, manifest);
    return status.ready ? { ok: true } : { ok: false, code: "entry-missing", reason: status.reason };
  }
  if (runtime !== "python") return { ok: false, code: "runtime-unsupported", reason: `runtime=${runtime} 不受支持` };

  let python = venvPython(root);
  if (!python) {
    onProgress?.("创建 .venv…");
    let lastReason = "找不到 python";
    for (const [command, prefix] of basePythonCandidates(platform)) {
      const r = await run(command, [...prefix, "-m", "venv", ".venv"], { cwd: root, env });
      if (r.code === 0) {
        python = venvPython(root);
        break;
      }
      lastReason = r.spawnError ? `找不到 ${command}` : `${command} -m venv 失败：${tail(r.stderr || r.stdout)}`;
    }
    if (!python) return { ok: false, code: "runtime-missing", reason: lastReason };
  }
  if (existsSync(join(root, "requirements.txt"))) {
    onProgress?.("安装 Python 依赖…");
    const r = await run(python, ["-m", "pip", "install", "-r", "requirements.txt"], { cwd: root, env, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) return { ok: false, code: "deps-install-failed", reason: `pip install 失败：${tail(r.stderr || r.stdout)}` };
  }
  writeFileSync(depsOkPath(root), `${requirementsHash(root)}\n`);
  return { ok: true };
}

function tail(text) {
  return String(text ?? "").trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
}
