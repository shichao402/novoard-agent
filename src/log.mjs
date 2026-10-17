/**
 * Agent 文件日志：JSON Lines、按大小滚动、令牌脱敏。
 * 桌面宿主模式只写文件，不碰 stdout（stdout 是宿主协议）也不镜像 stderr（避免拉起控制台）。
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 5;

function redact(text) {
  return String(text)
    .replace(/nva_[A-Za-z0-9_-]+/g, "nva_[redacted]")
    .replace(/nvp_[A-Za-z0-9_-]+/g, "nvp_[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/(Bearer\s+)[^\s"]+/gi, "$1[redacted]")
    .replace(/("(?:agentToken|apiKey|api_key)"\s*:\s*")[^"]+/gi, '$1[redacted]')
    .replace(/(CODEBUDDY_API_KEY\s*[=:]\s*)\S+/gi, "$1[redacted]");
}

function rotate(file, maxBytes = MAX_BYTES, keep = KEEP) {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  const archives = Math.max(1, keep - 1);
  try { unlinkSync(`${file}.${archives}`); } catch { /* 最旧一份还不存在 */ }
  for (let i = archives - 1; i >= 1; i -= 1) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch { /* 上一代不存在 */ }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch { /* 正在被读时跳过这一轮 */ }
}

export function createFileLogger({ dir, name = "agent", mirrorStderr = false, maxBytes = MAX_BYTES, keep = KEEP } = {}) {
  if (!dir) throw new Error("createFileLogger 需要 dir");
  const folder = join(dir, "logs");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${name}.jsonl`);

  function write(level, args) {
    const msg = redact(args.map((part) => {
      if (typeof part === "string") return part;
      try { return JSON.stringify(part); } catch { return String(part); }
    }).join(" "));
    try {
      rotate(file, maxBytes, keep);
      appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), level, msg })}\n`);
    } catch { /* 日志失败不能拖垮 agent */ }
    if (mirrorStderr) {
      const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}\n`;
      process.stderr.write(line);
    }
  }

  return {
    debug: (...args) => write("debug", args),
    info: (...args) => write("info", args),
    warn: (...args) => write("warn", args),
    error: (...args) => write("error", args),
    file,
  };
}
