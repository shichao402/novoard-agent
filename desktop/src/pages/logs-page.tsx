import { invoke } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getLogs, type LogPage } from "@/lib/api";
import { formatTime } from "@/lib/utils";

type Row = { ts?: string; level: string; msg: string };

const EMPTY: LogPage = { page: 1, pageSize: 1, maxPages: 20, totalPages: 1, total: 0, lines: [] };
const ROW_PX = 32;

const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function fetchLogs(base: string, page: number, level: string, query: string, pageSize: number) {
  if (inDesktop) return invoke<LogPage>("read_logs", { page, pageSize, level, query });
  return getLogs(base, page, level, query, pageSize);
}

export function LogsPage({ base }: { base: string }) {
  const [page, setPage] = useState<LogPage>(EMPTY);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("all");
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const honorsSize = useRef<boolean | null>(null);

  const load = useCallback(async (nextPage: number, nextLevel: string, nextQuery: string, nextSize: number) => {
    try {
      const view = honorsSize.current === false
        ? await pageFixedWindow(base, nextPage, nextLevel, nextQuery, nextSize)
        : await fetchLogs(base, nextPage, nextLevel, nextQuery, nextSize);
      if (honorsSize.current !== false && view.pageSize !== nextSize) {
        honorsSize.current = false;
        setPage(await pageFixedWindow(base, nextPage, nextLevel, nextQuery, nextSize, view.pageSize));
      } else {
        if (honorsSize.current !== false) honorsSize.current = true;
        setPage(view);
      }
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "日志读取失败");
    }
  }, [base]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    let timer = 0;
    const measure = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = Math.max(1, Math.floor(node.clientHeight / ROW_PX));
        setPageSize((currentSize) => (currentSize === next ? currentSize : next));
      }, 80);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (pageSize < 1) return;
    void load(current, level, query, pageSize);
    if (current !== 1) return;
    const timer = window.setInterval(() => void load(1, level, query, pageSize), 4000);
    return () => window.clearInterval(timer);
  }, [load, current, level, query, pageSize]);

  function changeLevel(next: string) {
    setLevel(next);
    setCurrent(1);
  }

  const rows: Row[] = page.lines.map((line) => ({ ts: line.ts, level: line.level || "info", msg: line.msg || "" }));

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setCurrent(1);
          }}
          placeholder="搜索当前日志窗口"
          className="max-w-xs"
        />
        {["all", "info", "warn", "error"].map((item) => (
          <button
            key={item}
            className={`h-8 rounded-lg px-3 text-xs ${level === item ? "bg-panel-hi text-ink" : "text-muted hover:bg-panel"}`}
            onClick={() => changeLevel(item)}
          >
            {item === "all" ? "全部" : item}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => { if (pageSize > 0) void load(current, level, query, pageSize); }}><RefreshCw size={14} />刷新</Button>
          <Button variant="secondary" size="sm" onClick={() => void invoke("open_log_dir")}><FolderOpen size={14} />打开目录</Button>
        </div>
      </div>
      {error ? <p className="mb-2 text-sm text-bad">{error}</p> : null}
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto rounded-2xl border border-line bg-surface">
        {rows.length === 0 ? <p className="p-4 text-sm text-muted">没有匹配的日志。</p> : null}
        <ul className="w-max min-w-full font-mono text-[12px]">
          {rows.map((row, index) => (
            <li key={`${page.page}-${row.ts}-${index}`} className="box-border flex h-8 items-center gap-3 whitespace-nowrap border-b border-line/70 px-4">
              <span className="w-[148px] shrink-0 text-faint">{row.ts ? formatTime(row.ts) : ""}</span>
              <span className={`w-[52px] shrink-0 ${row.level === "error" ? "text-bad" : row.level === "warn" ? "text-warn" : "text-muted"}`}>{row.level}</span>
              <span className="text-ink">{row.msg}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted">
        <span>第 {page.page} / {page.totalPages} 页 · 最多 {page.maxPages} 页 · 每页 {page.pageSize} 条</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" disabled={page.page <= 1} onClick={() => setCurrent((value) => Math.max(1, value - 1))}>
            <ChevronLeft size={14} />较新
          </Button>
          <Button variant="secondary" size="sm" disabled={page.page >= page.totalPages} onClick={() => setCurrent((value) => value + 1)}>
            较旧<ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}

async function pageFixedWindow(base: string, uiPage: number, level: string, query: string, fit: number, serverSize = 50) {
  const size = Math.max(1, serverSize);
  const start = Math.max(0, uiPage - 1) * fit;
  const end = start + fit;
  const first = Math.floor(start / size) + 1;
  const last = Math.max(first, Math.floor(Math.max(end - 1, 0) / size) + 1);
  const chunks: LogPage["lines"][] = [];
  let meta: LogPage | null = null;
  for (let index = first; index <= last; index += 1) {
    const item = await fetchLogs(base, index, level, query, size);
    meta = item;
    if (item.page !== index) break;
    chunks.push(item.lines);
    if (index >= item.totalPages) break;
  }
  const head = meta ?? EMPTY;
  const kept = Math.max(0, head.total);
  const cap = Math.max(1, Math.ceil((size * Math.max(1, head.maxPages)) / fit));
  const totalPages = Math.min(cap, Math.max(1, Math.ceil(kept / fit)));
  const safePage = Math.min(Math.max(1, uiPage), totalPages);
  if (safePage !== uiPage) return pageFixedWindow(base, safePage, level, query, fit, size);
  const offset = start - (first - 1) * size;
  return {
    page: safePage,
    pageSize: fit,
    maxPages: cap,
    totalPages,
    total: kept,
    lines: chunks.flat().slice(offset, offset + fit),
  };
}
