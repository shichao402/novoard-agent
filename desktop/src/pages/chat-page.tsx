import { Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  agentDoctor,
  createSession,
  deleteSession,
  interruptSession,
  listSessions,
  sendMessage,
  sessionHistory,
  type ChatEvent,
  type ChatSession,
} from "@/lib/api";

type Bubble = { id: string; role: "user" | "assistant" | "tool" | "error" | "status"; text: string };

const ROW_PX = 32;

let bubbleSeq = 0;
function bubble(role: Bubble["role"], text: string): Bubble {
  bubbleSeq += 1;
  return { id: `${role}-${bubbleSeq}`, role, text };
}

export function ChatPage({ base }: { base: string }) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Bubble[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [doctor, setDoctor] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const streamingRef = useRef(false);
  const [page, setPage] = useState(1);
  const [fit, setFit] = useState(0);

  async function refresh(selectId?: string) {
    const body = await listSessions(base);
    const sessionsNext = body.sessions ?? [];
    setSessions(sessionsNext);
    const next = selectId && sessionsNext.some((item) => item.id === selectId)
      ? selectId
      : sessionsNext.some((item) => item.id === active) && !selectId
        ? active
        : sessionsNext[0]?.id ?? null;
    setActive(next);
    return next;
  }

  useEffect(() => {
    let cancelled = false;
    void listSessions(base)
      .then((body) => {
        if (cancelled) return;
        setSessions(body.sessions ?? []);
        setActive(body.sessions?.[0]?.id ?? null);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "无法读取会话"));
    void agentDoctor(base)
      .then((result) => { if (!cancelled) setDoctor(result.ok ? (result.cli ? "模型运行时已就绪" : "正在使用 CodeBuddy 运行时") : (result.message || "模型运行时不可用")); })
      .catch((caught: unknown) => { if (!cancelled) setDoctor(caught instanceof Error ? caught.message : "模型运行时不可用"); });
    return () => { cancelled = true; };
  }, [base]);

  useEffect(() => {
    if (!active) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void sessionHistory(base, active)
      .then((body) => {
        if (cancelled || streamingRef.current) return;
        setMessages(body.messages.map((event) => toBubble(event)).filter((item): item is Bubble => Boolean(item)));
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "无法读取记录"));
    return () => { cancelled = true; };
  }, [active, base]);

  useEffect(() => {
    setPage(1);
  }, [active]);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    let timer = 0;
    const measure = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = Math.max(1, Math.floor(node.clientHeight / ROW_PX));
        setFit((current) => (current === next ? current : next));
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

  const totalPages = Math.max(1, Math.ceil(messages.length / Math.max(fit, 1)));
  const safePage = Math.min(page, totalPages);
  const end = messages.length - (safePage - 1) * Math.max(fit, 1);
  const visible = fit < 1 ? [] : messages.slice(Math.max(0, end - fit), end);

  async function start() {
    setError("");
    const created = await createSession(base);
    await refresh(created.session.id);
    setMessages([]);
  }

  async function send() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setError("");
    setStreaming(true);
    streamingRef.current = true;
    setMessages((current) => [...current, bubble("user", text)]);
    let sessionId = active;
    if (!sessionId) {
      const created = await createSession(base);
      sessionId = created.session.id;
      await refresh(sessionId);
    }
    let assistantId = "";
    try {
      await sendMessage(base, sessionId, text, (event) => {
        if (event.kind === "delta" && event.text) {
          setMessages((current) => {
            if (!assistantId) {
              const next = bubble("assistant", event.text || "");
              assistantId = next.id;
              return [...current, next];
            }
            return current.map((item) => (item.id === assistantId ? { ...item, text: item.text + (event.text ?? "") } : item));
          });
          return;
        }
        if (event.kind === "assistant" && event.text) {
          setMessages((current) => {
            if (!assistantId) return [...current, bubble("assistant", event.text || "")];
            return current.map((item) => (item.id === assistantId ? { ...item, text: event.text || item.text } : item));
          });
          return;
        }
        const next = toBubble(event);
        if (next) setMessages((current) => [...current, next]);
        if (event.kind === "error" && event.text) setError(event.text);
      });
      const body = await listSessions(base);
      setSessions(body.sessions ?? []);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "发送失败";
      setError(message);
      setMessages((current) => [...current, bubble("error", message)]);
    } finally {
      streamingRef.current = false;
      setStreaming(false);
    }
  }

  return (
    <div className="mx-auto grid h-full max-h-full min-h-0 w-full min-w-0 max-w-6xl grid-cols-[240px_minmax(0,1fr)] gap-3 overflow-hidden">
      <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="text-xs text-muted">会话</span>
          <Button variant="ghost" size="icon" aria-label="新对话" onClick={() => void start().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "无法新建会话"))}>
            <Plus size={16} />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {sessions.length === 0 ? <p className="px-2 py-6 text-center text-xs text-faint">还没有会话</p> : null}
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`mb-1 w-full rounded-lg px-3 py-2 text-left ${session.id === active ? "bg-panel-hi" : "hover:bg-panel-hi/60"}`}
              onClick={() => setActive(session.id)}
            >
              <div className="truncate text-[13px]">{session.title || "新对话"}</div>
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
        <div ref={scroller} className="min-h-0 min-w-0 flex-1 overflow-auto">
          {messages.length === 0 ? (
            <div className="grid h-full place-items-center px-4 text-center">
              <div>
                <p className="text-sm text-ink">这个 Agent 可以配置自己，并通过 A2A 执行 Target。</p>
                <p className="mt-2 text-xs text-faint">试试「列出这台电脑上的 Target」或「跑一次冒烟自检」。</p>
              </div>
            </div>
          ) : (
            <div className="w-max min-w-full">
              {visible.map((item) => (
                <MessageView key={item.id} item={item} />
              ))}
            </div>
          )}
        </div>
        {messages.length > 0 ? (
          <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-muted">
            <span>第 {safePage} / {totalPages} 页 · 每页 {fit || 1} 条</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>较新</Button>
              <Button variant="secondary" size="sm" disabled={safePage >= totalPages} onClick={() => setPage((value) => value + 1)}>较旧</Button>
            </div>
          </div>
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
            placeholder="给这台 Agent 发消息。Enter 发送，Shift+Enter 换行"
            className="max-h-36 min-h-10 flex-1 resize-none rounded-lg border border-line-hi bg-surface px-3 py-2 text-[13px] outline-none focus:border-accent"
          />
          {streaming ? (
            <Button type="button" variant="secondary" onClick={() => active && void interruptSession(base, active)}><Square size={14} />停止</Button>
          ) : (
            <Button type="submit" variant="accent" disabled={!draft.trim()}>发送</Button>
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
          void deleteSession(base, id).then(() => refresh()).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "删除失败"));
        }}
      />
    </div>
  );
}

function toBubble(event: ChatEvent): Bubble | null {
  if (event.kind === "user" && event.text) return bubble("user", event.text);
  if (event.kind === "assistant" && event.text) return bubble("assistant", event.text);
  if (event.kind === "tool") return bubble("tool", event.name || "工具");
  if (event.kind === "tool_result" && event.text) return bubble("tool", event.text);
  if (event.kind === "error" && event.text) return bubble("error", event.text);
  if (event.kind === "status" && event.text) return bubble("status", event.text);
  if (event.kind === "done" && event.ok === false && event.text) return bubble("error", event.text);
  return null;
}

function MessageView({ item }: { item: Bubble }) {
  if (item.role === "user") {
    return (
      <div className="box-border flex h-8 w-max min-w-full items-center whitespace-nowrap px-4">
        <span className="ml-auto rounded-2xl bg-accent px-3 text-sm leading-8 text-white">{item.text}</span>
      </div>
    );
  }
  if (item.role === "tool") {
    return <div className="box-border flex h-8 w-max min-w-full items-center whitespace-nowrap px-4 font-mono text-[11px] text-muted">{item.text}</div>;
  }
  if (item.role === "error") return <p className="box-border flex h-8 w-max min-w-full items-center whitespace-nowrap px-4 text-sm text-bad">{item.text}</p>;
  if (item.role === "status") return <p className="box-border flex h-8 w-max min-w-full items-center whitespace-nowrap px-4 text-xs text-faint">{item.text}</p>;
  return <div className="box-border flex h-8 w-max min-w-full items-center whitespace-nowrap px-4 text-sm text-ink">{item.text}</div>;
}
