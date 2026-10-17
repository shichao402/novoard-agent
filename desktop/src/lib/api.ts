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

export type Tile = {
  id: string;
  title: string;
  requiresApproval: boolean;
  concurrency?: number;
  timeout?: string;
  last: { state: string; message?: string; at?: string; log?: string | null } | null;
};

export type TargetStep =
  | { script: string; cwd?: string; env?: Record<string, string> }
  | { openApp: string }
  | { openPath: string };

export type TargetDef = {
  title: string;
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
  return request<{ tiles: Tile[]; tasks: Array<{ id: string; target: string; state: string; updatedAt?: string }> }>(base, "/api/tiles");
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

export type ChatEvent = {
  kind: string;
  text?: string;
  name?: string;
  input?: unknown;
  ok?: boolean;
  at?: string;
};

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

export function interruptSession(base: string, id: string) {
  return request<{ ok: boolean }>(base, `/api/sessions/${encodeURIComponent(id)}/interrupt`, { method: "POST", body: "{}" });
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

export function getTargets(base: string) {
  return request<{ ok: boolean; targets: Record<string, TargetDef> }>(base, "/api/targets");
}

export function saveTargets(base: string, targets: Record<string, TargetDef>) {
  return request<{ ok: boolean; count: number }>(base, "/api/targets", {
    method: "PUT",
    body: JSON.stringify({ targets }),
  });
}
