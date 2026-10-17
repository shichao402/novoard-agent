import { existsSync, readFileSync } from "node:fs";

/** 读取 JSONL 尾部。坏行跳过，不把半截记录当成成功。 */
export function readJsonlTail(file, limit = 40) {
  if (!file || !existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const sliced = lines.slice(-Math.max(1, limit));
  const rows = [];
  for (const line of sliced) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      rows.push({ raw: line });
    }
  }
  return rows;
}
