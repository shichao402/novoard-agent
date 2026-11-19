import type { ToolCall } from "./chat-tools.mjs";

export type LogRow = {
  kind: string;
  seq?: number;
  at?: string;
  text?: string;
  from?: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  isError?: boolean;
  ok?: boolean;
  state?: string;
  outcome?: string;
  questionId?: string;
  questions?: Array<{ question: string; header: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }>;
  answers?: Record<string, string>;
  skipped?: boolean;
  approvalId?: string;
  tool?: string;
  summary?: string;
  detail?: string;
  reason?: string;
  decision?: "once" | "session" | "deny" | "cancel";
};

export type TextBubble = { id: string; role: "user" | "assistant" | "error" | "status"; text: string };
export type ApprovalBubble = {
  id: string;
  role: "approval";
  approvalId: string;
  tool: string;
  summary: string;
  detail: string;
  reason: string;
  decision?: "once" | "session" | "deny" | "cancel";
};
export type QuestionBubble = {
  id: string;
  role: "question";
  questionId: string;
  questions: NonNullable<LogRow["questions"]>;
  answers?: Record<string, string>;
  skipped?: boolean;
  pending: boolean;
};
export type ToolGroupBubble = { id: string; role: "tools"; calls: ToolCall[] };
export type Bubble = TextBubble | ApprovalBubble | QuestionBubble | ToolGroupBubble;

export type TurnProgress = { startedAt: string; lastAt: string; tool: string };

export function mergeLog<T extends LogRow>(log: T[], events: T[] | undefined | null): T[];

export function turnRunning(log: LogRow[], fallback?: boolean): boolean;

export function turnProgress(log: LogRow[], running: boolean, fallbackStartedAt?: string): TurnProgress | null;

export function buildBubbles(log: LogRow[], running?: boolean): Bubble[];
