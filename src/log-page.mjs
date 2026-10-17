import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";

export const LOG_PAGE_SIZE = 50;
export const LOG_PAGE_SIZE_MAX = 200;
export const LOG_MAX_PAGES = 20;
const TAIL_BYTES = 2 * 1024 * 1024;

/** 只读文件尾部。界面分页不能把整份历史载进内存。 */
export function readLogTail(file, maxBytes = TAIL_BYTES) {
  if (!file || !existsSync(file)) return "";
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline >= 0 ? text.slice(newline + 1) : "";
  } finally {
    closeSync(fd);
  }
}

export function parseLogLine(line) {
  const text = String(line ?? "").trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (value && (value.msg || value.message)) {
      return {
        ts: String(value.ts ?? value.time ?? ""),
        level: String(value.level ?? "info").toLowerCase(),
        msg: String(value.msg ?? value.message),
      };
    }
  } catch { /* 宿主日志不是 JSON */ }
  const matched = text.match(/^\[([^\]]+)\]\[([^\]]+)\]\[(info|warn|error|debug|trace)\]\s*(.*)$/i);
  if (matched) return { ts: `${matched[1]} ${matched[2]}`, level: matched[3].toLowerCase(), msg: matched[4] };
  return { ts: "", level: "info", msg: text };
}

/**
 * page 从 1 开始，第 1 页是最新的一页。
 * 先按条件过滤，再截断到最多 maxPages 页，避免请求把历史全部拉出来。
 */
export function pageLogs(chronological, { page = 1, pageSize = LOG_PAGE_SIZE, maxPages = LOG_MAX_PAGES, level = "all", query = "" } = {}) {
  const size = clampInt(pageSize, 1, LOG_PAGE_SIZE_MAX);
  const cap = clampInt(maxPages, 1, LOG_MAX_PAGES);
  const needle = String(query ?? "").trim().toLowerCase();
  const wanted = String(level ?? "all").toLowerCase();
  const filtered = chronological.filter((row) => {
    if (!row) return false;
    if (wanted !== "all" && row.level !== wanted) return false;
    if (needle && !String(row.msg).toLowerCase().includes(needle)) return false;
    return true;
  });
  const windowed = filtered.slice(-LOG_PAGE_SIZE * cap);
  const total = windowed.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, clampInt(page, 1, totalPages)), totalPages);
  const newestFirst = windowed.slice().reverse();
  const start = (safePage - 1) * size;
  return {
    page: safePage,
    pageSize: size,
    maxPages: Math.max(1, Math.ceil((LOG_PAGE_SIZE * cap) / size)),
    totalPages,
    total,
    lines: newestFirst.slice(start, start + size),
  };
}

export function pageLogFile(file, options) {
  const lines = readLogTail(file).split(/\r?\n/).map(parseLogLine).filter(Boolean);
  return pageLogs(lines, options);
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return min;
  return Math.min(max, Math.max(min, number));
}
