import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonlTail } from "./jsonl.mjs";

/**
 * 会话目录：index.json 是列表，sessions/<id>.jsonl 是给界面看的记录。
 * CodeBuddy 自己的 transcript 另存；这里保证重启后仍能列出、续上和删除。
 */
export function createSessionStore(dir) {
  mkdirSync(dir, { recursive: true });
  const indexFile = join(dir, "index.json");

  function readIndex() {
    if (!existsSync(indexFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(indexFile, "utf8"));
      return Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } catch {
      return [];
    }
  }

  function writeIndex(sessions) {
    const next = join(dir, `index.${process.pid}.tmp`);
    writeFileSync(next, JSON.stringify({ sessions }, null, 2));
    renameSync(next, indexFile);
  }

  return {
    list() {
      return readIndex().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    upsert(entry) {
      const sessions = readIndex().filter((item) => item.id !== entry.id);
      sessions.push(entry);
      writeIndex(sessions);
      return entry;
    },
    get(id) {
      return readIndex().find((item) => item.id === id) ?? null;
    },
    remove(id) {
      writeIndex(readIndex().filter((item) => item.id !== id));
      const file = join(dir, "sessions", `${safeId(id)}.jsonl`);
      if (existsSync(file)) unlinkSync(file);
    },
    append(id, event) {
      const folder = join(dir, "sessions");
      mkdirSync(folder, { recursive: true });
      const file = join(folder, `${safeId(id)}.jsonl`);
      writeFileSync(file, `${existsSync(file) ? readFileSync(file, "utf8") : ""}${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`);
    },
    messages(id, limit = 400) {
      return readJsonlTail(join(dir, "sessions", `${safeId(id)}.jsonl`), limit);
    },
  };
}

function safeId(id) {
  const clean = String(id ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!clean) throw new Error("会话 ID 为空");
  return clean;
}
