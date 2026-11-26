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
  /** a2a：Hub 可见可触发；local：仅本机，Hub 看不到。 */
  expose?: "a2a" | "local";
  requiresApproval: boolean;
  concurrency?: number;
  timeout?: string;
  last: { state: string; message?: string; at?: string; log?: string | null } | null;
  problems?: TileProblem[];
  schedule?: string;
  nextRun?: string | null;
  lastScheduled?: { status: string; trigger?: string; slot?: string; at?: number; taskId?: string | null } | null;
  /** 带运行时输入（ADR-0020）：点击先弹选择框。 */
  inputs?: boolean;
  /** 运行记录里最近一次（ADR-0021），含 Hub、定时触发。 */
  lastRun?: RunSummary | null;
  /** 该 target 的在途运行。 */
  live?: LiveRun[];
};

/** 在途运行快照（ADR-0021）。state 为展示态：working、queued、input-required。 */
export type LiveRun = {
  taskId: string;
  target: string;
  title?: string;
  state: string;
  trigger?: string;
  startedAt: string;
  step?: number;
  total?: number;
  message?: string;
  blockedBy?: string | null;
};

export type RunStep = { index: number; command?: string; startedAt?: string; endedAt?: string | null; exit?: number | null };

/** 运行记录摘要。state 额外可能是 interrupted（无 run/end 且不在途）。 */
export type RunSummary = {
  taskId: string;
  target: string;
  title?: string;
  trigger?: string;
  timeout?: string;
  startedAt: string;
  endedAt?: string | null;
  state: string;
  steps: RunStep[];
  failedStep?: { index: number; exit?: number | null } | null;
  durationMs?: number | null;
  log?: string | null;
  live?: LiveRun;
};

export type RunLine = { ts?: string; level?: string; msg?: string; step?: number };

/** target 的运行时输入定义（ADR-0020 §1）。choices 为静态列表或查询工具。 */
export type TargetInput = {
  name: string;
  label?: string;
  choices?: string[] | { uses: string; with?: Record<string, string | number | boolean | string[]>; cwd?: string };
  default?: string;
  allowCustom?: boolean;
  required?: boolean;
};

export type InputChoice = { value: string; label?: string; hint?: string; usage?: { count: number; lastUsedAt: number } };

/** 选择框用的单个输入：候选项已现场查好并按使用历史加权，default 已解析（last 回显上次值）。 */
export type InputDescription = {
  name: string;
  label: string;
  required: boolean;
  allowCustom: boolean;
  dynamic: boolean;
  default: string;
  choices: InputChoice[];
  /** 查询失败原因；此时 choices 为空且允许自由输入。 */
  error?: string;
};

export type ScheduleInfo = { enabled: boolean; timezone: string };

export type TargetStep =
  | { script: string; cwd?: string; env?: Record<string, string>; when?: string }
  | { openApp: string; when?: string }
  | { openPath: string; when?: string }
  | { template: string }
  | { uses: string; with?: Record<string, string | number | boolean | string[]>; cwd?: string; retry?: number; retryInterval?: string; when?: string };

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
  inputs?: TargetInput[];
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

export function getRuns(base: string, options: { target?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (options.target) params.set("target", options.target);
  if (options.limit) params.set("limit", String(options.limit));
  return request<{ ok: boolean; retentionDays: number; live: LiveRun[]; runs: RunSummary[] }>(base, `/api/runs?${params}`);
}

export function getRun(base: string, taskId: string) {
  return request<{ ok: boolean; run: RunSummary; lines: RunLine[]; truncated: boolean }>(base, `/api/runs/${encodeURIComponent(taskId)}`);
}

export function cancelRun(base: string, taskId: string) {
  return request<{ ok: boolean; reason?: string }>(base, `/api/runs/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: "{}" });
}

export type GitCredential = { url: string; username: string; tokenLastFour: string };

export type PackEntry = {
  /** 包名；来源还没装过且没有覆盖名时为 null（装上后从 toolset.json 得到）。 */
  id: string | null;
  /** 来源 key（src-…），未装的来源用它安装。 */
  sourceKey: string | null;
  installed: boolean;
  busy: boolean;
  /** source.id 是 Hub 上填的「包名覆盖」，不填表示自动发现；repo/found 表示由整仓扫描得到。 */
  source: { key?: string; id?: string; git: string; branch: string; subdir?: string; repo?: string; found?: string } | null;
  version?: string | null;
  displayName?: string;
  depsReady?: boolean;
  depsReason?: string;
  problem?: string;
  problemCode?: string;
  /** 已装、但 Hub 已不再下发其来源。 */
  orphan?: boolean;
  /** 本机会给这个仓库用哪条 Git 凭据；null 表示不带令牌：HTTPS 按公开仓拉，SSH 地址用本机 SSH 密钥。 */
  credential?: GitCredential | null;
};

/** Hub 登记的整仓来源（契约 v2.7）：agent 扫描仓库里所有 toolset.json。 */
export type PackRepo = {
  key: string;
  git: string;
  branch: string;
  autoAdd: boolean;
  scanning: boolean;
  scannedAt: string | null;
  commit: string | null;
  packs: Array<{ id: string; subdir?: string; displayName?: string; problem?: string }>;
  error?: string;
};

export function listPacks(base: string) {
  return request<{ ok: boolean; packs: PackEntry[]; repos?: PackRepo[] }>(base, "/api/packs");
}

export function scanPackRepo(base: string, key: string) {
  return request<{ ok: boolean; reason?: string; added?: string[] }>(base, `/api/pack-repos/${encodeURIComponent(key)}/scan`, { method: "POST", body: "{}" });
}

export function setPackRepoAutoAdd(base: string, key: string, autoAdd: boolean) {
  return request<{ ok: boolean; reason?: string; autoAdd?: boolean }>(base, `/api/pack-repos/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ autoAdd }) });
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
  /** query 只能当 inputs 的候选来源，不能作步骤（ADR-0020 §3）。 */
  kind?: "action" | "query";
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

/** vars：快捷预设的变量覆盖，候选查询按覆盖后的值插值（ADR-0023）。 */
export function getTargetInputs(base: string, id: string, vars?: Record<string, string>) {
  const query = vars && Object.keys(vars).length > 0 ? `?vars=${encodeURIComponent(JSON.stringify(vars))}` : "";
  return request<{ ok: boolean; id: string; title: string; inputs: InputDescription[] }>(base, `/api/targets/${encodeURIComponent(id)}/inputs${query}`);
}

/** 快捷预设（ADR-0023）：target + 预填参数 + 点击时仍要询问的输入。只存本机。 */
export type Shortcut = {
  id: string;
  label: string;
  target: string;
  vars: Record<string, string>;
  ask: string[];
  note?: string;
};

export type ShortcutsBody = { ok: boolean; shortcuts: Shortcut[]; problems: Record<string, string[]> };

export function getShortcuts(base: string) {
  return request<ShortcutsBody>(base, "/api/shortcuts");
}

export function saveShortcuts(base: string, shortcuts: Shortcut[]) {
  return request<ShortcutsBody>(base, "/api/shortcuts", { method: "PUT", body: JSON.stringify({ shortcuts }) });
}

/** vars 为运行时输入的取值，作为 data part 传给本机 A2A。 */
export function runTarget(base: string, id: string, vars?: Record<string, string>) {
  const parts: Array<Record<string, unknown>> = [{ kind: "text", text: id }];
  if (vars && Object.keys(vars).length > 0) parts.push({ kind: "data", data: vars });
  return request<{ result?: { id: string; status?: { state?: string; message?: string } }; error?: { message?: string } }>(base, "/a2a", {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: { message: { parts } },
    }),
  });
}

export type ChatSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  /** 后端会话索引上的「有一轮在跑」。 */
  running?: boolean;
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
  /** 记录里的行号，界面按它合并去重。 */
  seq?: number;
  /** kind 为 turn 时：running / idle。 */
  state?: string;
  /** kind 为 turn、state 为 idle 时：ok / interrupted / error。 */
  outcome?: string;
  text?: string;
  name?: string;
  from?: string;
  input?: unknown;
  toolUseId?: string;
  isError?: boolean;
  ok?: boolean;
  at?: string;
  questionId?: string;
  questions?: AskQuestion[];
  answers?: Record<string, string>;
  skipped?: boolean;
  approvalId?: string;
  tool?: string;
  summary?: string;
  detail?: string;
  reason?: string;
  decision?: "once" | "session" | "deny" | "cancel";
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

export function agentDoctor(base: string) {
  return request<{ ok: boolean; cli?: boolean; message?: string; permission?: ChatPermission }>(base, "/api/agent/doctor");
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

/**
 * 发起一轮。只回「受理了没有」：202 表示用户消息已写进记录，之后的内容都从 subscribeSessions 推来。
 * 会话已有一轮在跑时后端拒绝（HTTP 409），不排队。
 */
export function sendMessage(base: string, id: string, text: string) {
  return request<{ ok: boolean }>(base, `/api/sessions/${encodeURIComponent(id)}/messages`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export type SessionPush = { kind: string; session?: ChatSession; sessionId?: string; focus?: boolean; event?: ChatEvent };

/** onOpen 在每次连上（含断线重连）时调用：调用方应重读列表和当前会话，补上断开期间漏掉的记录。 */
export function subscribeSessions(base: string, onEvent: (event: SessionPush) => void, onOpen?: () => void) {
  const source = new EventSource(`${base}/api/sessions/events`);
  source.onopen = () => onOpen?.();
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as SessionPush);
    } catch {
      /* 忽略无法解析的推送 */
    }
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

export type ApprovalDecision = "once" | "session" | "deny";

export function approveTool(base: string, id: string, approvalId: string, decision: ApprovalDecision) {
  return request<{ ok: boolean }>(base, `/api/sessions/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify({ approvalId, decision }),
  });
}

export type ChatPermission = "readonly" | "confirm" | "full";

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
  apiKeySource?: "" | "panel" | "env" | "dec";
  effectiveEnvironment?: "internal" | "external" | "ioa" | "cloudhosted";
  chatPermission?: ChatPermission;
};

export function getCodebuddy(base: string) {
  return request<CodebuddySettings>(base, "/api/codebuddy");
}

export function saveCodebuddy(
  base: string,
  input: { model: string; environment: CodebuddySettings["environment"]; chatPermission?: ChatPermission; apiKey?: string; clearApiKey?: boolean },
) {
  return request<CodebuddySettings & { restartDeferred?: boolean }>(base, "/api/codebuddy", { method: "PUT", body: JSON.stringify(input) });
}

export function getLogs(base: string, page: number, level: string, query: string, pageSize?: number) {
  const params = new URLSearchParams({ page: String(page), level, q: query });
  if (pageSize) params.set("pageSize", String(pageSize));
  return request<LogPage & { ok: boolean }>(base, `/api/logs?${params}`);
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
  /** 已下载、但还有在途任务或对话：结束后自动安装（ADR-0018 / ADR-0022）。 */
  waitingForTasks?: { running: number; pendingApproval: number; chatTurns: number } | null;
  /** 自动跟随：空闲时自动检查、下载并安装（ADR-0022）；NOVOARD_AUTO_UPDATE=0 关闭。 */
  auto?: boolean;
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
