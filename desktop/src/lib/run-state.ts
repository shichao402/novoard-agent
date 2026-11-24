/** 运行状态只在展示层翻译（ADR-0005）；queued、interrupted 是展示态（ADR-0021）。 */
export type Tone = "good" | "bad" | "warn" | "accent" | "muted";

const STATE: Record<string, { label: string; tone: Tone }> = {
  submitted: { label: "已提交", tone: "accent" },
  working: { label: "运行中", tone: "accent" },
  running: { label: "运行中", tone: "accent" },
  queued: { label: "排队中", tone: "warn" },
  "input-required": { label: "等待审批", tone: "warn" },
  completed: { label: "完成", tone: "good" },
  failed: { label: "失败", tone: "bad" },
  canceled: { label: "已取消", tone: "muted" },
  rejected: { label: "被拒绝", tone: "bad" },
  interrupted: { label: "中断", tone: "bad" },
  open: { label: "运行中", tone: "accent" },
  pending: { label: "未开始", tone: "muted" },
  skipped: { label: "已跳过", tone: "muted" },
};

export function stateLabel(state?: string | null) {
  if (!state) return "未运行";
  return STATE[state]?.label ?? state;
}

export function stateTone(state?: string | null): Tone {
  if (!state) return "muted";
  return STATE[state]?.tone ?? "muted";
}

export const LIVE_STATES = new Set(["working", "queued", "input-required", "submitted", "running", "open"]);

export function isLive(state?: string | null) {
  return Boolean(state && LIVE_STATES.has(state));
}

export function isFailure(state?: string | null) {
  return state === "failed" || state === "interrupted" || state === "rejected";
}

export const TONE_TEXT: Record<Tone, string> = {
  good: "text-good",
  bad: "text-bad",
  warn: "text-warn",
  accent: "text-accent",
  muted: "text-muted",
};

export const TONE_BG: Record<Tone, string> = {
  good: "bg-good",
  bad: "bg-bad",
  warn: "bg-warn",
  accent: "bg-accent",
  muted: "bg-line-hi",
};

const TRIGGER: Record<string, string> = {
  schedule: "定时",
  "catch-up": "补跑",
  manual: "手动",
  hub: "Hub",
  peer: "成员委派",
};

export function triggerLabel(trigger?: string | null) {
  if (!trigger) return "";
  return TRIGGER[trigger] ?? trigger;
}

export function formatDuration(ms?: number | null) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}

export function durationBetween(start?: string | null, end?: string | null, now = Date.now()) {
  if (!start) return null;
  const from = Date.parse(start);
  if (Number.isNaN(from)) return null;
  const to = end ? Date.parse(end) : now;
  return Number.isNaN(to) ? null : Math.max(0, to - from);
}

export function formatRelative(value?: string | null, now = Date.now()) {
  if (!value) return "";
  const at = Date.parse(value);
  if (Number.isNaN(at)) return value;
  const diff = Math.max(0, now - at) / 1000;
  if (diff < 45) return "刚刚";
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(at);
}

/** 失败位置：「第 N 步 exit X」。 */
export function failureText(run: { failedStep?: { index: number; exit?: number | null } | null }) {
  const step = run.failedStep;
  if (!step) return "";
  return step.exit === null || step.exit === undefined ? `第 ${step.index} 步` : `第 ${step.index} 步 exit ${step.exit}`;
}

/** 单步状态：有 exit 按 exit 判；没结束时随整次运行（在途为 working，否则沿用终态）。 */
export function stepState(step: { exit?: number | null; endedAt?: string | null } | undefined, runState: string) {
  if (!step) return isLive(runState) ? "pending" : runState === "completed" ? "completed" : "pending";
  if (step.exit !== null && step.exit !== undefined) return step.exit === 0 ? "completed" : "failed";
  if (step.endedAt) return "completed";
  if (runState === "working" || runState === "open") return "working";
  return runState === "completed" ? "completed" : runState === "failed" ? "failed" : runState;
}

/** 跳过行（agent-runtime skipLine，ADR-0024）：「[step i] 已跳过 命令（when 为 "…"）」。跳过的步骤不进 trace，只靠这一行识别。 */
export function parseSkip(msg?: string) {
  const match = /^\[step (\d+)\] 已跳过 (.*?)（when 为 (.*)）$/.exec(msg ?? "");
  return match ? { step: Number(match[1]), command: match[2], value: match[3] } : null;
}

/** 进度日志行（agent-runtime：「进度 第 i 步：…」）。 */
export function parseProgress(msg?: string) {
  const match = /^进度 第 (\d+) 步：(.*)$/.exec(msg ?? "");
  return match ? { step: Number(match[1]), text: match[2] } : null;
}
