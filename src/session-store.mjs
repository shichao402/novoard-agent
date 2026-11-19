import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 会话目录：index.json 是列表，sessions/<id>.jsonl 是给界面看的记录。
 * CodeBuddy 自己的 transcript 另存；这里保证重启后仍能列出、续上和删除。
 *
 * 记录是会话的唯一事实来源：每行带 seq（等于它在文件里的行号，只追加不改写，所以稳定），
 * 界面把历史和实时推送按 seq 合并去重，不自己画任何本地气泡。
 * 一轮的起止写成 { kind: "turn", state: "running" | "idle" }，同时在列表项上记 running，
 * 进程退出时据此收尾没结束的轮次。
 */
export function createSessionStore(dir) {
  mkdirSync(dir, { recursive: true });
  const indexFile = join(dir, "index.json");
  const counts = new Map();

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

  function fileFor(id) {
    return join(dir, "sessions", `${safeId(id)}.jsonl`);
  }

  function readLines(file) {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim());
  }

  /** 已有行数。按文件大小缓存，别的进程追加过（大小变了）就重数。 */
  function lineCount(file) {
    if (!existsSync(file)) return 0;
    const size = statSync(file).size;
    const cached = counts.get(file);
    if (cached && cached.size === size) return cached.count;
    const count = readLines(file).length;
    counts.set(file, { size, count });
    return count;
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
      const file = fileFor(id);
      counts.delete(file);
      if (existsSync(file)) unlinkSync(file);
    },
    /** 追加一条，返回带 seq 和 at 的那一行。 */
    append(id, event) {
      mkdirSync(join(dir, "sessions"), { recursive: true });
      const file = fileFor(id);
      const seq = lineCount(file) + 1;
      const { seq: _ignored, ...rest } = event ?? {};
      const row = { ...rest, seq, at: rest.at ?? new Date().toISOString() };
      appendFileSync(file, `${JSON.stringify(row)}\n`);
      counts.set(file, { size: statSync(file).size, count: seq });
      return row;
    },
    /** 尾部若干条。旧记录没有 seq 的按行号补上。 */
    messages(id, limit = 400) {
      const lines = readLines(fileFor(id));
      const start = Math.max(0, lines.length - Math.max(1, limit));
      const rows = [];
      for (let index = start; index < lines.length; index += 1) {
        let row;
        try {
          row = JSON.parse(lines[index]);
        } catch {
          row = { raw: lines[index] };
        }
        rows.push(row && typeof row === "object" && row.seq != null ? row : { ...row, seq: index + 1 });
      }
      return rows;
    },
  };
}

/**
 * 收尾所有还标着进行中的轮次：写一条错误和一条 turn idle，列表项 running 置回 false。
 * 会话进程退出（重启、崩溃、上次没正常关）后调用；返回写下的事件，调用方负责推给界面。
 */
export function closeOpenTurns(store, text) {
  const closed = [];
  for (const entry of store.list()) {
    if (!entry?.running) continue;
    const events = [
      store.append(entry.id, { kind: "error", text }),
      store.append(entry.id, { kind: "turn", state: "idle", outcome: "error" }),
    ];
    const session = store.upsert({ ...entry, running: false, updatedAt: new Date().toISOString() });
    closed.push({ sessionId: entry.id, events, session });
  }
  return closed;
}

function safeId(id) {
  const clean = String(id ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!clean) throw new Error("会话 ID 为空");
  return clean;
}
