import { Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  agentDoctor,
  createSession,
  deleteSession,
  answerQuestion,
  interruptSession,
  listSessions,
  sendMessage,
  sessionHistory,
  subscribeSessions,
  type AskQuestion,
  type ChatEvent,
  type ChatSession,
} from "@/lib/api";
import { prefixHeights, resolveWindow } from "@/lib/sliding-window.mjs";

type TextBubble = { id: string; role: "user" | "assistant" | "tool" | "error" | "status"; text: string };
type QuestionBubble = {
  id: string;
  role: "question";
  questionId: string;
  questions: AskQuestion[];
  answers?: Record<string, string>;
  skipped?: boolean;
  pending: boolean;
  live: boolean;
};
type Bubble = TextBubble | QuestionBubble;
type Slice = { start: number; end: number };

const PIN_SLOP_PX = 64;

let bubbleSeq = 0;
function bubble(role: TextBubble["role"], text: string): TextBubble {
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
  const streamingRef = useRef(false);
  const activeRef = useRef<string | null>(null);

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
        setMessages(eventsToBubbles(body.messages));
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "无法读取记录"));
    return () => { cancelled = true; };
  }, [active, base]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    return subscribeSessions(base, (event) => {
      if (event.kind === "session" && event.session) {
        setSessions((current) => [event.session!, ...current.filter((item) => item.id !== event.session!.id)]);
        if (event.focus) {
          activeRef.current = event.session.id;
          setActive(event.session.id);
        }
        return;
      }
      if (event.kind === "message" && event.sessionId && event.sessionId === activeRef.current && event.event) {
        const next = toBubble(event.event);
        if (next) setMessages((current) => [...current, next]);
      }
    });
  }, [base]);

  useEffect(() => {
    if (streaming) return;
    setMessages((current) => {
      if (!current.some((item) => item.role === "question" && item.pending && item.live)) return current;
      return current.map((item) => (
        item.role === "question" && item.pending && item.live
          ? { ...item, pending: false, live: false, skipped: true }
          : item
      ));
    });
  }, [streaming]);

  async function submitAnswer(questionId: string, body: { skip?: boolean; answers?: Record<string, string> }) {
    if (!active) throw new Error("没有正在进行的会话");
    await answerQuestion(base, active, questionId, body);
    setMessages((current) => current.map((item) => (
      item.role === "question" && item.questionId === questionId
        ? { ...item, pending: false, live: false, skipped: Boolean(body.skip), answers: body.answers }
        : item
    )));
  }

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
            return current.map((item) => (item.id === assistantId && item.role === "assistant" ? { ...item, text: item.text + (event.text ?? "") } : item));
          });
          return;
        }
        if (event.kind === "assistant" && event.text) {
          setMessages((current) => {
            if (!assistantId) return [...current, bubble("assistant", event.text || "")];
            return current.map((item) => (item.id === assistantId && item.role === "assistant" ? { ...item, text: event.text || item.text } : item));
          });
          return;
        }
        if (event.kind === "question" && event.questionId) {
          setMessages((current) => {
            if (current.some((item) => item.role === "question" && item.questionId === event.questionId)) return current;
            return [...current, questionBubble(event, true)];
          });
          return;
        }
        if (event.kind === "answer" && event.questionId) {
          setMessages((current) => current.map((item) => (
            item.role === "question" && item.questionId === event.questionId
              ? { ...item, pending: false, live: false, answers: event.answers, skipped: Boolean(event.skipped) }
              : item
          )));
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
        <MessageScroller messages={messages} resetKey={active} onAnswer={submitAnswer} />
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

function MessageScroller({
  messages,
  resetKey,
  onAnswer,
}: {
  messages: Bubble[];
  resetKey: string | null;
  onAnswer: (questionId: string, body: { skip?: boolean; answers?: Record<string, string> }) => Promise<void>;
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
              <MessageView item={item} onAnswer={onAnswer} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function toBubble(event: ChatEvent): TextBubble | null {
  if (event.kind === "peer" && event.text) return bubble("user", event.from ? `${event.from}：${event.text}` : event.text);
  if (event.kind === "user" && event.text) return bubble("user", event.text);
  if (event.kind === "assistant" && event.text) return bubble("assistant", event.text);
  if (event.kind === "tool" && event.name === "AskUserQuestion") return null;
  if (event.kind === "tool") return bubble("tool", event.name || "工具");
  if (event.kind === "tool_result" && event.text) return bubble("tool", event.text);
  if (event.kind === "error" && event.text) return bubble("error", event.text);
  if (event.kind === "status" && event.text) return bubble("status", event.text);
  if (event.kind === "done" && event.ok === false && event.text) return bubble("error", event.text);
  return null;
}

function eventsToBubbles(events: ChatEvent[]): Bubble[] {
  const bubbles: Bubble[] = [];
  const byQuestion = new Map<string, QuestionBubble>();
  for (const event of events) {
    if (event.kind === "question" && event.questionId) {
      const item = questionBubble(event, false);
      byQuestion.set(event.questionId, item);
      bubbles.push(item);
      continue;
    }
    if (event.kind === "answer" && event.questionId) {
      const item = byQuestion.get(event.questionId);
      if (item) {
        item.pending = false;
        item.answers = event.answers;
        item.skipped = Boolean(event.skipped);
      }
      continue;
    }
    const next = toBubble(event);
    if (next) bubbles.push(next);
  }
  return bubbles;
}

function questionBubble(event: ChatEvent, live: boolean): QuestionBubble {
  return {
    id: `question-${event.questionId}`,
    role: "question",
    questionId: event.questionId || "",
    questions: event.questions ?? [],
    pending: true,
    live,
  };
}

function MessageView({ item, onAnswer }: { item: Bubble; onAnswer: (questionId: string, body: { skip?: boolean; answers?: Record<string, string> }) => Promise<void> }) {
  if (item.role === "question") return <QuestionCard item={item} onAnswer={onAnswer} />;
  const wrap = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
  if (item.role === "user") {
    return (
      <div className="flex w-full min-w-0 justify-end px-4 py-1">
        <span className={`max-w-[85%] rounded-2xl bg-accent px-3 py-1.5 text-sm leading-6 text-white ${wrap}`}>{item.text}</span>
      </div>
    );
  }
  if (item.role === "tool") {
    return <div className={`w-full min-w-0 px-4 py-1.5 font-mono text-[11px] leading-5 text-muted ${wrap}`}>{item.text}</div>;
  }
  if (item.role === "error") return <p className={`w-full min-w-0 px-4 py-1.5 text-sm leading-6 text-bad ${wrap}`}>{item.text}</p>;
  if (item.role === "status") return <p className={`w-full min-w-0 px-4 py-1.5 text-xs leading-5 text-faint ${wrap}`}>{item.text}</p>;
  return <div className={`w-full min-w-0 px-4 py-1.5 text-sm leading-6 text-ink ${wrap}`}>{item.text}</div>;
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
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "提交失败";
      if (message.includes("已经结束")) setNote("这次提问已经结束");
      else setError(message);
    } finally {
      setSubmitting(false);
    }
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
