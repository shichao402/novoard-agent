export type Endpoint = {
  view?: string | null;
  url?: string | null;
  panelUrl?: string | null;
  agentId?: string | null;
};

export type Runtime = {
  ok: boolean;
  phase: string;
  agentId: string | null;
  hubConnected: boolean;
  hubRegistered: boolean;
};

export type Settings = {
  ok: boolean;
  agentId: string;
  hubUrl: string;
  localPort: number;
  hasToken: boolean;
  contractVersion: string;
};

export type TileProblem = { step: number; uses: string; code: string; level: "error" | "warning"; message: string; action: string };

export type Tile = {
  id: string;
  title: string;
  requiresApproval: boolean;
  concurrency?: number;
  timeout?: string;
  last: { state: string; message?: string; at?: string; log?: string | null } | null;
  problems?: TileProblem[];
  schedule?: string;
  nextRun?: string | null;
  lastScheduled?: { status: string; trigger?: string; slot?: string; at?: number; taskId?: string | null } | null;
};

export type ScheduleInfo = { enabled: boolean; timezone: string };

export type TargetStep =
  | { script: string; cwd?: string; env?: Record<string, string> }
  | { openApp: string }
  | { openPath: string }
  | { template: string }
  | { uses: string; with?: Record<string, string | number | boolean | string[]>; cwd?: string; retry?: number; retryInterval?: string };

export type TargetDef = {
  title: string;
  schedule?: string;
  oncePerDay?: boolean;
  deadline?: string;
  steps?: TargetStep[];
  template?: string;
  vars?: Record<string, string | number | boolean>;
  expose: "a2a" | "local";
  audit: "none" | "summary" | "full";
  requiresApproval: boolean;
  notify: "always" | "on-failure" | "never";
  offline?: "reject" | "queue";
  offlineTtl?: string;
  concurrency?: number;
  timeout?: string;
  lostTtl?: string;
  approvalTtl?: string;
};

export function apiBase(endpoint: Endpoint | null) {
  const raw = endpoint?.view === "setup" ? endpoint.url : endpoint?.panelUrl || endpoint?.url;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => null)) as (T & { errors?: string[]; reason?: string; message?: string }) | null;
  if (!response.ok) {
    throw new Error(body?.errors?.[0] || body?.reason || body?.message || `请求失败（HTTP ${response.status}）`);
  }
  return body as T;
}

export function getRuntime(base: string) {
  return request<Runtime>(base, "/api/runtime");
}

export function getSettings(base: string) {
  return request<Settings>(base, "/api/settings");
}

export function saveSettings(base: string, input: { hubUrl: string; agentId: string; agentToken?: string }) {
  return request<{ ok: boolean; restartRequired: boolean; agentId: string }>(base, "/api/settings", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function testHub(base: string, hubUrl: string, agentToken: string) {
  return request<{ ok: boolean; reason?: string }>(base, "/api/setup/test", {
    method: "POST",
    body: JSON.stringify({ hubUrl, agentToken }),
  });
}

export function saveSetup(base: string, input: { hubUrl: string; agentId: string; agentToken: string }) {
  return request<{ ok: boolean; agentId: string; panelUrl?: string | null }>(base, "/api/setup/save", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getTiles(base: string) {
  return request<{ tiles: Tile[]; tasks: Array<{ id: string; target: string; state: string; updatedAt?: string }>; schedule?: ScheduleInfo | null }>(base, "/api/tiles");
}

export function setScheduleEnabled(base: string, enabled: boolean) {
  return request<{ ok: boolean; enabled: boolean }>(base, "/api/schedule", { method: "PUT", body: JSON.stringify({ enabled }) });
}

export function catchUpNow(base: string) {
  return request<{ ok: boolean; fired: Array<{ id: string; trigger: string; slot: string }> }>(base, "/api/schedule/catch-up", { method: "POST", body: "{}" });
}

export type GitCredential = { url: string; username: string; tokenLastFour: string };

export type PackEntry = {
  /** 包名；来源还没装过且没有覆盖名时为 null（装上后从 toolset.json 得到）。 */
  id: string | null;
  /** 来源 key（src-…），未装的来源用它安装。 */
  sourceKey: string | null;
  installed: boolean;
  busy: boolean;
  /** source.id 是 Hub 上填的「包名覆盖」，不填表示自动发现。 */
  source: { key?: string; id?: string; git: string; branch: string; subdir?: string } | null;
  version?: string | null;
  displayName?: string;
  depsReady?: boolean;
  depsReason?: string;
  problem?: string;
  problemCode?: string;
  /** 已装、但 Hub 已不再下发其来源。 */
  orphan?: boolean;
  /** 本机会给这个仓库用哪条 Git 凭据；null 表示按公开仓访问。 */
  credential?: GitCredential | null;
};

export function listPacks(base: string) {
  return request<{ ok: boolean; packs: PackEntry[] }>(base, "/api/packs");
}

/** 能力包工具参数（ADR-0019 §1）。label/description/format 为表单展示用，可缺省。 */
export type ToolParam = {
  name: string;
  type: "string" | "number" | "boolean" | "string[]" | "enum";
  required?: boolean;
  default?: string | number | boolean | string[];
  enum?: string[];
  label?: string;
  description?: string;
  format?: "path" | "duration" | "time";
};

export type PackTool = {
  id: string;
  displayName: string;
  description?: string;
  remoteWrite: boolean;
  platforms?: string[];
  params: ToolParam[];
};

export type PackTools = {
  ok: boolean;
  platform: string;
  timezone: string;
  scheduleEnabled: boolean;
  packs: Array<{ id: string; displayName: string; tools: PackTool[] }>;
};

export function listPackTools(base: string) {
  return request<PackTools>(base, "/api/packs/tools");
}

export function listGitCredentials(base: string) {
  return request<{ ok: boolean; credentials: GitCredential[] }>(base, "/api/git-credentials");
}

export function saveGitCredential(base: string, input: { url: string; username?: string; token?: string; originalUrl?: string }) {
  return request<{ ok: boolean; credential: GitCredential }>(base, "/api/git-credentials", { method: "PUT", body: JSON.stringify(input) });
}

export function removeGitCredential(base: string, url: string) {
  return request<{ ok: boolean; removed: boolean }>(base, `/api/git-credentials?url=${encodeURIComponent(url)}`, { method: "DELETE" });
}

export function packAction(base: string, id: string, action: "install" | "update" | "remove") {
  return action === "remove"
    ? request<{ ok: boolean; reason?: string }>(base, `/api/packs/${encodeURIComponent(id)}`, { method: "DELETE" })
    : request<{ ok: boolean; reason?: string; version?: string | null; patch?: string }>(base, `/api/packs/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
}

export function runTarget(base: string, id: string) {
  return request<{ result?: { id: string; status?: { state?: string } }; error?: { message?: string } }>(base, "/a2a", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: { message: { parts: [{ kind: "text", text: id }] } },
    }),
  });
}

export type ActivityEvent = {
  ts?: string;
  target?: string;
  outcome?: string;
  taskId?: string;
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
};

export type AskOption = { label: string; description?: string };

export type AskQuestion = {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
};

export type ChatEvent = {
  kind: string;
  text?: string;
  name?: string;
  from?: string;
  input?: unknown;
  ok?: boolean;
  at?: string;
  questionId?: string;
  questions?: AskQuestion[];
  answers?: Record<string, string>;
  skipped?: boolean;
};

export type AgentProfile = {
  ok: boolean;
  role: string;
  introduction: string;
};

export function getProfile(base: string) {
  return request<AgentProfile>(base, "/api/profile");
}

export function saveProfile(base: string, input: { role: string; introduction: string }) {
  return request<AgentProfile>(base, "/api/profile", { method: "PUT", body: JSON.stringify(input) });
}

export function getActivity(base: string) {
  return request<{ ok: boolean; events: ActivityEvent[] }>(base, "/api/activity?limit=30");
}

export function agentDoctor(base: string) {
  return request<{ ok: boolean; cli?: boolean; message?: string }>(base, "/api/agent/doctor");
}

export function listSessions(base: string) {
  return request<{ sessions: ChatSession[] }>(base, "/api/sessions");
}

export function createSession(base: string) {
  return request<{ session: ChatSession }>(base, "/api/sessions", { method: "POST", body: JSON.stringify({ title: "新对话" }) });
}

export function deleteSession(base: string, id: string) {
  return request<{ ok: boolean }>(base, `/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function sessionHistory(base: string, id: string) {
  return request<{ session: ChatSession | null; messages: ChatEvent[] }>(base, `/api/sessions/${encodeURIComponent(id)}`);
}

export async function sendMessage(base: string, id: string, text: string, onEvent: (event: ChatEvent) => void) {
  const response = await fetch(`${base}/api/sessions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || `发送失败（HTTP ${response.status}）`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const chunks = pending.split("\n\n");
    pending = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) continue;
      onEvent(JSON.parse(data) as ChatEvent);
    }
  }
}

export function subscribeSessions(base: string, onEvent: (event: { kind: string; session?: ChatSession; sessionId?: string; focus?: boolean; event?: ChatEvent }) => void) {
  const source = new EventSource(`${base}/api/sessions/events`);
  source.onmessage = (message) => {
    onEvent(JSON.parse(message.data));
  };
  return () => source.close();
}

export function interruptSession(base: string, id: string) {
  return request<{ ok: boolean }>(base, `/api/sessions/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: "{}" });
}

export function answerQuestion(
  base: string,
  id: string,
  questionId: string,
  body: { skip?: boolean; answers?: Record<string, string> },
) {
  return request<{ ok: boolean }>(base, `/api/sessions/${encodeURIComponent(id)}/answer`, {
    method: "POST",
    body: JSON.stringify({ questionId, ...body }),
  });
}

export type LogPage = {
  page: number;
  pageSize: number;
  maxPages: number;
  totalPages: number;
  total: number;
  lines: Array<{ ts?: string; level?: string; msg?: string }>;
};

export type CodebuddySettings = {
  ok: boolean;
  model: string;
  environment: "internal" | "external" | "ioa" | "cloudhosted";
  hasApiKey: boolean;
};

export function getCodebuddy(base: string) {
  return request<CodebuddySettings>(base, "/api/codebuddy");
}

export function saveCodebuddy(
  base: string,
  input: { model: string; environment: CodebuddySettings["environment"]; apiKey?: string },
) {
  return request<CodebuddySettings>(base, "/api/codebuddy", { method: "PUT", body: JSON.stringify(input) });
}

export function getLogs(base: string, page: number, level: string, query: string, pageSize?: number) {
  const params = new URLSearchParams({ page: String(page), level, q: query });
  if (pageSize) params.set("pageSize", String(pageSize));
  return request<LogPage & { ok: boolean }>(base, `/api/logs?${params}`);
}

export type ShortcutRun = {
  taskId: string;
  bytes: number;
  mtime: string;
  log: string;
};

export function getShortcutRuns(base: string, id: string) {
  return request<{ ok: boolean; retentionDays: number; runs: ShortcutRun[] }>(base, `/api/shortcuts/${encodeURIComponent(id)}/runs`);
}

export function getShortcutLog(base: string, id: string, taskId: string, page = 1) {
  return request<LogPage & { ok: boolean; log: string }>(base, `/api/shortcuts/${encodeURIComponent(id)}/runs/${encodeURIComponent(taskId)}?page=${page}`);
}

export type UpdatePhase =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "applying"
  | "fallback"
  | "error";

/** 桌面壳 updater.rs 的 UpdateView（Tauri 命令 update_* 与事件 update-status）。 */
export type UpdateView = {
  enabled: boolean;
  channel: string;
  currentVersion: string;
  currentCode: number;
  phase: UpdatePhase;
  message: string | null;
  available: {
    planId: string;
    version: string;
    code: number;
    mandatory: boolean;
    releaseNotes: string;
    releaseNotesUrl: string;
  } | null;
  progress: { received: number; total: number; bytesPerSecond: number } | null;
  manualUrl: string | null;
  /** 用户已点安装、但还有在途任务：结束后自动安装（ADR-0018）。 */
  waitingForTasks?: { running: number; pendingApproval: number } | null;
  checkedAt: number | null;
};

export const UPDATE_EVENT = "update-status";

export function getTargets(base: string) {
  return request<{ ok: boolean; targets: Record<string, TargetDef> }>(base, "/api/targets");
}

export function saveTargets(base: string, targets: Record<string, TargetDef>) {
  return request<{ ok: boolean; count: number; warnings?: Array<TileProblem & { target: string }> }>(base, "/api/targets", {
    method: "PUT",
    body: JSON.stringify({ targets }),
  });
}
