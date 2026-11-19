import { Check, ChevronDown, ChevronRight, Loader2, Plus, ShieldAlert, Square, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  agentDoctor,
  approveTool,
  createSession,
  deleteSession,
  answerQuestion,
  interruptSession,
  listSessions,
  sendMessage,
  sessionHistory,
  subscribeSessions,
  type ApprovalDecision,
  type AskQuestion,
  type ChatEvent,
  type ChatPermission,
  type ChatSession,
} from "@/lib/api";
import { groupTitle, type ToolCall } from "@/lib/chat-tools.mjs";
import {
  buildBubbles,
  mergeLog,
  turnProgress,
  turnRunning,
  type ApprovalBubble as LogApproval,
  type Bubble as LogBubble,
  type QuestionBubble,
  type TextBubble,
  type ToolGroupBubble as LogToolGroup,
} from "@/lib/chat-log.mjs";
import { prefixHeights, resolveWindow } from "@/lib/sliding-window.mjs";

const PERMISSION_LABELS: Record<ChatPermission, string> = { readonly: "只读", confirm: "逐次确认", full: "完全放行" };

/** 展开状态不在记录里，单独存；合进气泡后，变化时外层滚动容器才会重新量高度。 */
type ApprovalBubble = LogApproval & { open: boolean };
type ToolGroupBubble = LogToolGroup & { open: boolean; openCalls: string[] };
type Bubble = TextBubble | QuestionBubble | ToolGroupBubble | ApprovalBubble;
type Slice = { start: number; end: number };
type ToggleTool = (bubbleId: string, callKey?: string) => void;
type Approve = (approvalId: string, decision: ApprovalDecision) => Promise<void>;
/** 当前会话的记录。sessionId 用来丢掉切走之后才到的旧会话数据。 */
type SessionLog = { sessionId: string | null; rows: ChatEvent[] };

const PIN_SLOP_PX = 64;
const NO_ROWS: ChatEvent[] = [];

function message(caught: unknown, fallback: string) {
  return caught instanceof Error ? caught.message : fallback;
}

function seconds(from: string, now: number) {
  const at = Date.parse(from);
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : 0;
}

function withOpen(items: LogBubble[], open: Set<string>): Bubble[] {
  return items.map((item) => {
    if (item.role === "approval") return { ...item, open: open.has(item.id) };
    if (item.role === "tools") {
      const prefix = `${item.id}::`;
      const openCalls = [...open].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
      return { ...item, open: open.has(item.id), openCalls };
    }
    return item;
  });
}

/**
 * 聊天页只是后端会话记录的视图：
 * - 看到的气泡全部来自记录（历史接口 + 实时推送，按 seq 合并），发送时不在本地先画；
 * - 「是否在跑」看记录里最后一条 turn 行，没有时看会话索引上的 running；
 * - 发送只问后端受理没有，忙时后端直接拒绝；
 * - 推送连上（含重连）、切换会话、重新进入页面时都重读记录。
 * 所以切走再切回、断线重连、刷新页面，看到的都是同一个状态。
 */
export function ChatPage({ base }: { base: string }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [log, setLog] = useState<SessionLog>({ sessionId: null, rows: [] });
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [doctor, setDoctor] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const activeRef = useRef<string | null>(null);

  const select = useCallback((id: string | null) => {
    if (activeRef.current === id) return;
    activeRef.current = id;
    setActive(id);
    setLog({ sessionId: id, rows: [] });
    setOpen(new Set());
    setError("");
  }, []);

  const loadHistory = useCallback((id: string) => {
    void sessionHistory(base, id)
      .then((body) => {
        if (activeRef.current !== id) return;
        setLog((current) => (current.sessionId === id ? { sessionId: id, rows: mergeLog(current.rows, body.messages) } : current));
        if (body.session) {
          const session = body.session;
          setSessions((current) => current.map((item) => (item.id === id ? session : item)));
        }
      })
      .catch((caught: unknown) => setError(message(caught, "无法读取记录")));
  }, [base]);

  /** 重读会话列表；当前会话还在就留在它上面，否则选第一个。 */
  const loadSessions = useCallback((preferId?: string) => {
    return listSessions(base).then((body) => {
      const next = body.sessions ?? [];
      setSessions(next);
      const want = preferId ?? activeRef.current;
      const keep = want && next.some((item) => item.id === want) ? want : next[0]?.id ?? null;
      select(keep);
      if (keep) loadHistory(keep);
      return keep;
    });
  }, [base, loadHistory, select]);

  useEffect(() => {
    let cancelled = false;
    void agentDoctor(base)
      .then((result) => {
        if (cancelled) return;
        const status = result.ok ? (result.cli ? "模型运行时已就绪" : "正在使用 CodeBuddy 运行时") : (result.message || "模型运行时不可用");
        const permission = result.permission ? PERMISSION_LABELS[result.permission] : "";
        setDoctor(permission ? `${status} · 会话权限：${permission}` : status);
      })
      .catch((caught: unknown) => { if (!cancelled) setDoctor(message(caught, "模型运行时不可用")); });
    return () => { cancelled = true; };
  }, [base]);

  useEffect(() => {
    void loadSessions().catch((caught: unknown) => setError(message(caught, "无法读取会话")));
    return subscribeSessions(
      base,
      (push) => {
        if (push.kind === "session" && push.session) {
          const session = push.session;
          setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
          if (push.focus && activeRef.current !== session.id) {
            select(session.id);
            loadHistory(session.id);
          }
          return;
        }
        if (push.kind === "session_removed" && push.sessionId) {
          const removed = push.sessionId;
          setSessions((current) => {
            const next = current.filter((item) => item.id !== removed);
            if (activeRef.current === removed) {
              const fallback = next[0]?.id ?? null;
              select(fallback);
              if (fallback) loadHistory(fallback);
            }
            return next;
          });
          return;
        }
        if (push.kind === "message" && push.sessionId && push.event) {
          const sessionId = push.sessionId;
          const row = push.event;
          setLog((current) => (current.sessionId === sessionId ? { sessionId, rows: mergeLog(current.rows, [row]) } : current));
        }
      },
      // 每次连上都重读一遍，补上没连着的那段时间里漏掉的记录
      () => { void loadSessions().catch(() => {}); },
    );
  }, [base, loadHistory, loadSessions, select]);

  const activeSession = sessions.find((item) => item.id === active) ?? null;
  const rows = log.sessionId === active ? log.rows : NO_ROWS;
  const running = turnRunning(rows, activeSession?.running);
  const progress = turnProgress(rows, running, activeSession?.updatedAt);
  const bubbles = useMemo(() => withOpen(buildBubbles(rows, running), open), [rows, running, open]);

  useEffect(() => {
    if (!running) {
      setStopping(null);
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const toggleTool: ToggleTool = (bubbleId, callKey) => {
    const key = callKey === undefined ? bubbleId : `${bubbleId}::${callKey}`;
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 回答和授权只提交给后端；卡片什么时候收起，看记录里的 answer / approval_result 行
  async function submitAnswer(questionId: string, body: { skip?: boolean; answers?: Record<string, string> }) {
    if (!active) throw new Error("没有正在进行的会话");
    await answerQuestion(base, active, questionId, body);
  }

  async function submitApproval(approvalId: string, decision: ApprovalDecision) {
    if (!active) throw new Error("没有正在进行的会话");
    await approveTool(base, active, approvalId, decision);
  }

  async function start() {
    setError("");
    const created = await createSession(base);
    await loadSessions(created.session.id);
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending || running) return;
    setError("");
    setSending(true);
    try {
      let sessionId = active;
      if (!sessionId) {
        const created = await createSession(base);
        sessionId = await loadSessions(created.session.id);
        if (!sessionId) throw new Error("无法新建会话");
      }
      await sendMessage(base, sessionId, text);
      // 受理之后才清空输入框；被拒（例如上一轮还没结束）时草稿留着
      setDraft((current) => (current.trim() === text ? "" : current));
    } catch (caught) {
      setError(message(caught, "发送失败"));
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!active || stopping) return;
    const id = active;
    setStopping(id);
    try {
      await interruptSession(base, id);
    } catch (caught) {
      setStopping(null);
      setError(message(caught, "停止失败"));
    }
  }

  let progressText = "";
  if (progress) {
    const elapsed = seconds(progress.startedAt, now);
    const quiet = seconds(progress.lastAt, now);
    const doing = stopping === active
      ? "正在停止…"
      : progress.tool
        ? `正在执行：${progress.tool}`
        : quiet >= 10
          ? `模型思考中（${quiet} 秒没有新输出）`
          : "模型思考中";
    progressText = `已进行 ${elapsed} 秒 · ${doing}`;
  }

  return (
    <div className="mx-auto grid h-full max-h-full min-h-0 w-full min-w-0 max-w-6xl grid-cols-[240px_minmax(0,1fr)] gap-3 overflow-hidden">
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-xs text-muted">会话</span>
          <Button variant="ghost" size="icon" aria-label="新对话" onClick={() => void start().catch((caught: unknown) => setError(message(caught, "无法新建会话")))}>
            <Plus size={16} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {sessions.length === 0 ? <p className="px-2 py-6 text-center text-xs text-faint">还没有会话</p> : null}
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left ${session.id === active ? "bg-panel-hi" : "hover:bg-panel-hi/60"}`}
              onClick={() => {
                if (session.id === activeRef.current) return;
                select(session.id);
                loadHistory(session.id);
              }}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[13px]">{session.title || "新对话"}</span>
                {session.running ? <Loader2 size={12} className="shrink-0 animate-spin text-muted" aria-label="进行中" /> : null}
              </div>
              <div className="truncate text-[11px] text-faint">{session.preview || "尚无消息"}</div>
            </button>
          ))}
        </div>
      </aside>
      <section className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-4 py-2">
          <p className="truncate text-xs text-muted">{doctor || "正在检查模型运行时…"}</p>
          <Button variant="ghost" size="sm" disabled={!active} onClick={() => setPendingDelete(active)}>
            <Trash2 size={14} />删除
          </Button>
        </div>
        <MessageScroller messages={bubbles} resetKey={active} onAnswer={submitAnswer} onApprove={submitApproval} onToggle={toggleTool} />
        {progressText ? (
          <p className="flex items-center gap-1.5 px-4 pb-1 text-xs leading-5 text-muted" aria-live="polite">
            <Loader2 size={12} className="shrink-0 animate-spin" />
            <span className="truncate">{progressText}</span>
          </p>
        ) : null}
        {error ? <p className="px-4 pb-2 text-xs leading-5 text-bad" role="alert">{error}</p> : null}
        <form
          className="flex items-end gap-2 border-t border-line p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={running ? "这一轮结束后才能再发。可以先写好，或者点停止" : "给这台 Agent 发消息。Enter 发送，Shift+Enter 换行"}
            className="max-h-36 min-h-10 flex-1 resize-none rounded-lg border border-line-hi bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
          />
          {running ? (
            <Button type="button" variant="secondary" disabled={stopping === active} onClick={() => void stop()}>
              {stopping === active ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
              {stopping === active ? "正在停止…" : "停止"}
            </Button>
          ) : (
            <Button type="submit" variant="accent" disabled={!draft.trim() || sending}>
              {sending ? <Loader2 size={14} className="animate-spin" /> : null}发送
            </Button>
          )}
        </form>
      </section>
      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这个会话？"
        body="会话记录会从这台电脑移除。已经执行过的 Target 不受影响。"
        confirmLabel="删除"
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (!id) return;
          void deleteSession(base, id).then(() => loadSessions()).catch((caught: unknown) => setError(message(caught, "删除失败")));
        }}
      />
    </div>
  );
}

function MessageScroller({
  messages,
  resetKey,
  onAnswer,
  onApprove,
  onToggle,
}: {
  messages: Bubble[];
  resetKey: string | null;
  onAnswer: (questionId: string, body: { skip?: boolean; answers?: Record<string, string> }) => Promise<void>;
  onApprove: Approve;
  onToggle: ToggleTool;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const rowRefs = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const heightById = useRef(new Map<string, number>());
  const pinnedRef = useRef(true);
  const scrollTopRef = useRef(0);
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);
  const ignoreScroll = useRef(false);
  const seenKey = useRef(resetKey);
  const [viewport, setViewport] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [slice, setSlice] = useState<Slice>({ start: 0, end: 0 });

  if (seenKey.current !== resetKey) {
    seenKey.current = resetKey;
    pinnedRef.current = true;
    anchorRef.current = null;
    scrollTopRef.current = 0;
  }

  const prefix = useMemo(() => {
    const live = new Set(messages.map((item) => item.id));
    if (heightById.current.size > live.size) {
      for (const id of heightById.current.keys()) {
        if (!live.has(id)) heightById.current.delete(id);
      }
    }
    return prefixHeights(messages.map((item) => heightById.current.get(item.id) ?? 0));
  }, [messages, epoch]);

  const viewportPx = scrollerRef.current?.clientHeight || viewport || 640;
  const total = prefix[messages.length] ?? 0;
  const scrollTop = pinnedRef.current
    ? Math.max(0, total - viewportPx)
    : Math.min(scrollTopRef.current, Math.max(0, total - viewportPx));
  const view = resolveWindow(prefix, scrollTop, viewportPx, slice);
  if (view.start !== slice.start || view.end !== slice.end) setSlice(view);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const apply = () => {
      const next = node.clientHeight;
      setViewport((current) => (current === next ? current : next));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node || messages.length === 0 || node.clientHeight < 1) return;
    if (Math.abs(node.clientHeight - viewport) > 1) {
      setViewport(node.clientHeight);
      return;
    }

    const nodeTop = node.getBoundingClientRect().top;
    if (anchorRef.current) {
      const anchor = anchorRef.current;
      anchorRef.current = null;
      const el = rowEls.current.get(anchor.id);
      if (el) {
        const delta = anchor.offset - (nodeTop - el.getBoundingClientRect().top);
        if (Math.abs(delta) > 1) {
          ignoreScroll.current = true;
          node.scrollTop += delta;
          scrollTopRef.current = node.scrollTop;
        }
      } else {
        const index = messages.findIndex((item) => item.id === anchor.id);
        if (index >= 0) {
          ignoreScroll.current = true;
          node.scrollTop = prefix[index] + anchor.offset;
          scrollTopRef.current = node.scrollTop;
        }
      }
    }

    let changed = false;
    for (let index = view.start; index < view.end; index += 1) {
      const item = messages[index];
      const el = item ? rowEls.current.get(item.id) : undefined;
      if (!item || !el) continue;
      const height = el.offsetHeight;
      if (height < 1 || heightById.current.get(item.id) === height) continue;
      if (!changed && !pinnedRef.current) {
        const top = node.getBoundingClientRect().top;
        for (let cursor = view.start; cursor < view.end; cursor += 1) {
          const id = messages[cursor]?.id;
          const row = id ? rowEls.current.get(id) : undefined;
          if (!row || !id) continue;
          const rect = row.getBoundingClientRect();
          if (rect.bottom > top + 1) {
            anchorRef.current = { id, offset: top - rect.top };
            break;
          }
        }
      }
      heightById.current.set(item.id, height);
      changed = true;
    }
    if (changed) {
      setEpoch((value) => value + 1);
      return;
    }

    if (pinnedRef.current) {
      const target = Math.max(0, node.scrollHeight - node.clientHeight);
      if (Math.abs(node.scrollTop - target) > 1) {
        ignoreScroll.current = true;
        node.scrollTop = target;
        scrollTopRef.current = node.scrollTop;
      }
    }
  }, [messages, epoch, viewport, view.start, view.end, prefix, resetKey]);

  function rowRef(id: string) {
    let callback = rowRefs.current.get(id);
    if (!callback) {
      callback = (el) => {
        if (el) rowEls.current.set(id, el);
        else rowEls.current.delete(id);
      };
      rowRefs.current.set(id, callback);
    }
    return callback;
  }

  function onScroll() {
    const node = scrollerRef.current;
    if (!node) return;
    const ignored = ignoreScroll.current;
    ignoreScroll.current = false;
    const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (!ignored) {
      const movedUp = node.scrollTop < scrollTopRef.current - 1;
      if (gap < 2) pinnedRef.current = true;
      else if (gap >= PIN_SLOP_PX || movedUp) pinnedRef.current = false;
    }
    scrollTopRef.current = node.scrollTop;
    const top = pinnedRef.current ? Math.max(0, total - node.clientHeight) : node.scrollTop;
    const next = resolveWindow(prefix, top, node.clientHeight || viewportPx, slice);
    if (next.start !== slice.start || next.end !== slice.end) setSlice(next);
  }

  return (
    <div
      ref={scrollerRef}
      className="min-h-0 min-w-0 flex-1 overflow-auto"
      style={{ overflowAnchor: "none", scrollbarGutter: "stable" }}
      onScroll={onScroll}
      data-slide-start={view.start}
      data-slide-end={view.end}
      data-slide-count={messages.length}
    >
      {messages.length === 0 ? (
        <div className="grid h-full place-items-center px-4 text-center">
          <div>
            <p className="text-sm text-ink">这个 Agent 可以配置自己，并通过 A2A 执行 Target。</p>
            <p className="mt-2 text-xs text-faint">试试「列出这台电脑上的 Target」或「跑一次冒烟自检」。</p>
          </div>
        </div>
      ) : (
        <div className="relative w-full min-w-0" style={{ height: total }}>
          {messages.slice(view.start, view.end).map((item, offset) => (
            <div
              key={item.id}
              ref={rowRef(item.id)}
              className="absolute left-0 w-full min-w-0"
              style={{ top: prefix[view.start + offset] }}
            >
<MessageView item={item} onAnswer={onAnswer} onApprove={onApprove} onToggle={onToggle} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageView({
  item,
  onAnswer,
  onApprove,
  onToggle,
}: {
  item: Bubble;
  onAnswer: (questionId: string, body: { skip?: boolean; answers?: Record<string, string> }) => Promise<void>;
  onApprove: Approve;
  onToggle: ToggleTool;
}) {
  if (item.role === "question") return <QuestionCard item={item} onAnswer={onAnswer} />;
  if (item.role === "approval") return <ApprovalCard item={item} onApprove={onApprove} onToggle={onToggle} />;
  if (item.role === "tools") return <ToolGroupView item={item} onToggle={onToggle} />;
  const wrap = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
  if (item.role === "user") {
    return (
      <div className="flex w-full min-w-0 justify-end px-4 py-1">
        <span className={`max-w-[85%] rounded-2xl bg-accent px-3 py-1.5 text-sm leading-6 text-white ${wrap}`}>{item.text}</span>
      </div>
    );
  }
  if (item.role === "error") return <p className={`w-full min-w-0 px-4 py-1.5 text-sm leading-6 text-bad ${wrap}`}>{item.text}</p>;
  if (item.role === "status") return <p className={`w-full min-w-0 px-4 py-1.5 text-xs leading-5 text-faint ${wrap}`}>{item.text}</p>;
  return <div className={`w-full min-w-0 px-4 py-1.5 text-sm leading-6 text-ink ${wrap}`}>{item.text}</div>;
}

function ToolStatusIcon({ status }: { status: ToolCall["status"] }) {
  if (status === "running") return <Loader2 size={13} className="shrink-0 animate-spin text-muted" />;
  if (status === "ok") return <Check size={13} className="shrink-0 text-faint" />;
  if (status === "denied") return <ShieldAlert size={13} className="shrink-0 text-bad" />;
  return <X size={13} className="shrink-0 text-bad" />;
}

/**
 * 一组工具调用。只有一步时直接显示这一行；多步时显示「执行了 N 步」，默认收起，
 * 收起时仍露出正在执行的和失败、未授权的那几步。每一步点开看原始输出。
 */
function ToolGroupView({ item, onToggle }: { item: ToolGroupBubble; onToggle: ToggleTool }) {
  const single = item.calls.length === 1;
  const visible = single || item.open
    ? item.calls
    : item.calls.filter((call) => call.status !== "ok");
  return (
    <div className="mx-4 my-1 min-w-0 rounded-lg border border-line bg-surface/60 px-2 py-1">
      {single ? null : (
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-1 text-left text-xs text-muted hover:bg-panel-hi/60"
          aria-expanded={item.open}
          onClick={() => onToggle(item.id)}
        >
          {item.open ? <ChevronDown size={13} className="shrink-0" /> : <ChevronRight size={13} className="shrink-0" />}
          <span className="truncate">{groupTitle(item.calls)}</span>
        </button>
      )}
      {visible.map((call) => (
        <ToolCallRow key={call.key} call={call} open={item.openCalls.includes(call.key)} indent={!single} onToggle={() => onToggle(item.id, call.key)} />
      ))}
    </div>
  );
}

function ToolCallRow({ call, open, indent, onToggle }: { call: ToolCall; open: boolean; indent: boolean; onToggle: () => void }) {
  const bad = call.status === "error" || call.status === "denied";
  const canOpen = Boolean(call.detail);
  return (
    <div className={`min-w-0 ${indent ? "pl-4" : ""}`}>
      <button
        type="button"
        disabled={!canOpen}
        aria-expanded={canOpen ? open : undefined}
        className="flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-1 text-left text-xs enabled:hover:bg-panel-hi/60"
        onClick={onToggle}
      >
        <ToolStatusIcon status={call.status} />
        <span className="shrink-0 truncate text-ink" style={{ maxWidth: "55%" }} title={call.title}>{call.title}</span>
        {call.summary ? <span className={`min-w-0 truncate ${bad ? "text-bad" : "text-faint"}`} title={call.summary}>{call.summary}</span> : null}
      </button>
      {open && canOpen ? (
        <pre className="mx-1 mb-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-[11px] leading-5 text-muted [overflow-wrap:anywhere]">
          {call.detail}
        </pre>
      ) : null}
    </div>
  );
}

const APPROVAL_RESULT: Record<ApprovalDecision | "cancel", string> = {
  once: "已允许这一次",
  session: "本会话内已允许",
  deny: "已拒绝",
  cancel: "已取消",
};

/** 白名单外的工具调用，等用户放行。决定之后收成一行结果。 */
function ApprovalCard({ item, onApprove, onToggle }: { item: ApprovalBubble; onApprove: Approve; onToggle: ToggleTool }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const decided = item.decision ? APPROVAL_RESULT[item.decision] : note;

  async function decide(decision: ApprovalDecision) {
    if (submitting) return;
    setError("");
    setSubmitting(true);
    try {
      await onApprove(item.approvalId, decision);
      return; // 成功后不解除禁用，记录里的 approval_result 到了卡片自然收起
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "提交失败";
      if (message.includes("已经结束")) setNote("这次授权已经结束");
      else setError(message);
    }
    setSubmitting(false);
  }

  return (
    <div className={`mx-4 my-2 min-w-0 rounded-xl border bg-surface px-3 py-2 ${decided ? "border-line" : "border-accent/50"}`}>
      <div className="flex min-w-0 items-center gap-1.5 text-xs">
        <ShieldAlert size={13} className={`shrink-0 ${decided ? "text-faint" : "text-accent"}`} />
        <span className="shrink-0 text-ink">{decided ? item.tool : `要使用 ${item.tool}`}</span>
        {decided ? <span className={`min-w-0 truncate ${item.decision === "deny" ? "text-bad" : "text-faint"}`}>{decided}</span> : null}
      </div>
      {item.summary ? (
        <div className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-muted [overflow-wrap:anywhere]">{item.summary}</div>
      ) : null}
      {item.reason ? <div className="mt-1 text-xs leading-5 text-faint">理由：{item.reason}</div> : null}
      {item.detail ? (
        <button
          type="button"
          className="mt-1 flex items-center gap-1 rounded px-0.5 text-[11px] text-faint hover:text-muted"
          aria-expanded={item.open}
          onClick={() => onToggle(item.id)}
        >
          {item.open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}完整参数
        </button>
      ) : null}
      {item.open && item.detail ? (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-panel px-2 py-1.5 font-mono text-[11px] leading-5 text-muted [overflow-wrap:anywhere]">
          {item.detail}
        </pre>
      ) : null}
      {error ? <p className="mt-2 text-xs text-bad" role="alert">{error}</p> : null}
      {decided ? null : (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" variant="accent" size="sm" disabled={submitting} onClick={() => void decide("once")}>允许一次</Button>
          <Button type="button" variant="secondary" size="sm" disabled={submitting} onClick={() => void decide("session")}>本会话都允许 {item.tool}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => void decide("deny")}>拒绝</Button>
        </div>
      )}
    </div>
  );
}

function composeAnswers(questions: AskQuestion[], picked: Record<string, string[]>, other: Record<string, string>) {
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const labels = picked[question.question] ?? [];
    const custom = (other[question.question] ?? "").trim();
    if (question.multiSelect) {
      const parts = custom ? [...labels, custom] : labels;
      if (!parts.length) return "还有题目没选";
      answers[question.question] = parts.join(", ");
      continue;
    }
    if (custom) {
      answers[question.question] = custom;
      continue;
    }
    if (labels.length === 1) {
      answers[question.question] = labels[0];
      continue;
    }
    return "还有题目没选";
  }
  return answers;
}

function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionBubble;
  onAnswer: (questionId: string, body: { skip?: boolean; answers?: Record<string, string> }) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const closed = !item.pending || Boolean(note);

  async function submit(skip: boolean) {
    if (submitting) return;
    setError("");
    let answers: Record<string, string> | undefined;
    if (!skip) {
      const composed = composeAnswers(item.questions, picked, other);
      if (typeof composed === "string") {
        setError(composed);
        return;
      }
      answers = composed;
    }
    setSubmitting(true);
    try {
      await onAnswer(item.questionId, skip ? { skip: true } : { answers });
      return; // 成功后不解除禁用，记录里的 answer 到了卡片自然收起
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "提交失败";
      if (message.includes("已经结束")) setNote("这次提问已经结束");
      else setError(message);
    }
    setSubmitting(false);
  }

  if (closed) {
    return (
      <div className="mx-4 my-2 rounded-xl border border-line bg-surface px-3 py-2">
        {item.questions.map((question) => (
          <div key={question.question} className="py-1.5">
            <div className="text-[11px] text-faint">{question.header}</div>
            <div className="text-sm leading-6 text-ink">{question.question}</div>
            <div className="text-xs leading-5 text-muted">
              {note || (item.skipped ? "已跳过" : item.answers?.[question.question] || "未回答")}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mx-4 my-2 rounded-xl border border-accent/50 bg-surface px-3 py-3">
      {item.questions.map((question) => {
        const selected = picked[question.question] ?? [];
        return (
          <fieldset key={question.question} className="mb-3 min-w-0 border-0 p-0">
            <legend className="mb-1 text-[11px] text-faint">{question.header}{question.multiSelect ? " · 可多选" : ""}</legend>
            <div className="text-sm leading-6 text-ink">{question.question}</div>
            <div className="mt-2 flex flex-col gap-1.5">
              {question.options.map((option) => {
                const on = selected.includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={on}
                    disabled={submitting}
                    className={`rounded-lg border px-3 py-1.5 text-left ${on ? "border-accent bg-accent/15" : "border-line-hi hover:bg-panel-hi"}`}
                    onClick={() => {
                      setPicked((current) => {
                        const labels = current[question.question] ?? [];
                        const next = question.multiSelect
                          ? (labels.includes(option.label) ? labels.filter((label) => label !== option.label) : [...labels, option.label])
                          : (labels.length === 1 && labels[0] === option.label ? [] : [option.label]);
                        return { ...current, [question.question]: next };
                      });
                      if (!question.multiSelect) setOther((current) => ({ ...current, [question.question]: "" }));
                    }}
                  >
                    <div className="text-[13px] text-ink">{option.label}</div>
                    {option.description ? <div className="text-[11px] leading-5 text-faint">{option.description}</div> : null}
                  </button>
                );
              })}
              <input
                value={other[question.question] ?? ""}
                disabled={submitting}
                placeholder="其他"
                className="h-9 rounded-lg border border-line-hi bg-panel px-3 text-[13px] outline-none focus:border-accent"
                onChange={(event) => {
                  const value = event.target.value;
                  setOther((current) => ({ ...current, [question.question]: value }));
                  if (!question.multiSelect && value.trim()) setPicked((current) => ({ ...current, [question.question]: [] }));
                }}
              />
            </div>
          </fieldset>
        );
      })}
      {error ? <p className="mb-2 text-xs text-bad" role="alert">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" variant="accent" disabled={submitting} onClick={() => void submit(false)}>提交</Button>
        <Button type="button" variant="secondary" disabled={submitting} onClick={() => void submit(true)}>跳过</Button>
      </div>
    </div>
  );
}
