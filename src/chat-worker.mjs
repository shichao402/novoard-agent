/**
 * CodeBuddy 会话进程。由 sidecar 拉起，stdin/stdout 只走一行一个 JSON。
 * 不把 SDK 打进 SEA：CLI 在磁盘上的 node_modules 里，必须用系统 Node 跑这个文件。
 */
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const spawnHidden = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args, options = {}) {
  return spawnHidden.call(this, command, args, { ...options, windowsHide: true });
};
import { createSessionStore } from "./session-store.mjs";
import { explainAgentError, normalizeSdkMessage } from "./chat-events.mjs";
import { dispatchNovoardTool } from "./novoard-tools.mjs";
import { createAskGate, formatAnswers, normalizeQuestions } from "./ask-user.mjs";
import { codebuddySessionFields } from "./codebuddy-config.mjs";
import { NOVOARD_SKILL } from "./novoard-skill.mjs";
import { edition } from "./edition.mjs";

const origin = process.env.NOVOARD_LOCAL_ORIGIN || "";
const sessionDir = process.env.NOVOARD_SESSION_DIR;
const agentHome = process.env.NOVOARD_AGENT_HOME;
if (!sessionDir || !agentHome) {
  process.stderr.write("缺少 NOVOARD_SESSION_DIR 或 NOVOARD_AGENT_HOME\n");
  process.exit(1);
}

mkdirSync(join(agentHome, ".codebuddy", "skills", "novoard-agent"), { recursive: true });
writeFileSync(join(agentHome, ".codebuddy", "skills", "novoard-agent", "SKILL.md"), NOVOARD_SKILL);

const store = createSessionStore(sessionDir);
const live = new Map();
const queues = new Map();
const holders = new Map();
const inflight = new Map();
const askGate = createAskGate();

function holderFor(id) {
  const existing = holders.get(id);
  if (existing) return existing;
  const holder = { id };
  holders.set(id, holder);
  return holder;
}

function publish(sessionId, requestId, event) {
  if (sessionId) store.append(sessionId, event);
  if (requestId != null) emit({ id: requestId, event });
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sessionOptions(sdk, holder) {
  const server = sdk.createSdkMcpServer({
    name: "novoard",
    version: "1.0.0",
    tools: toolDefs(sdk),
  });
  const auth = codebuddySessionFields(process.env);
  return {
    cwd: agentHome,
    settingSources: ["project"],
    permissionMode: "dontAsk",
    environment: auth.environment,
    ...(auth.model ? { model: auth.model } : {}),
    canUseTool: async (toolName, input, options) => {
      if (toolName !== "AskUserQuestion") return { behavior: "allow" };
      const sessionId = holder.id;
      const questions = normalizeQuestions(input);
      if (!questions.length) return { behavior: "deny", message: "问题格式不正确，没有可回答的题目。" };
      const questionId = String(options?.toolUseID || `ask-${Date.now()}`);
      const requestId = inflight.get(sessionId);
      publish(sessionId, requestId, { kind: "question", questionId, questions });
      let payload;
      try {
        payload = await askGate.wait(questionId, sessionId, questions, options?.signal);
      } catch {
        return { behavior: "deny", message: "提问已取消" };
      }
      const baseInput = input && typeof input === "object" ? input : {};
      if (payload?.skip) {
        publish(sessionId, requestId, { kind: "answer", questionId, skipped: true });
        return { behavior: "allow", updatedInput: { ...baseInput, answers: { _action: "skip_question" } } };
      }
      let answers;
      try {
        answers = formatAnswers(questions, payload?.answers);
      } catch (error) {
        return { behavior: "deny", message: error instanceof Error ? error.message : "回答格式不正确" };
      }
      publish(sessionId, requestId, { kind: "answer", questionId, answers });
      return { behavior: "allow", updatedInput: { ...baseInput, answers } };
    },
    persistSession: true,
    includePartialMessages: true,
    sessionId: holder.id || undefined,
    mcpServers: { novoard: server },
    allowedTools: [
      "mcp__novoard__novoard_status",
      "mcp__novoard__novoard_list_targets",
      "mcp__novoard__novoard_get_settings",
      "mcp__novoard__novoard_save_settings",
      "mcp__novoard__novoard_upsert_target",
      "mcp__novoard__novoard_delete_target",
      "mcp__novoard__novoard_run_target",
      "mcp__novoard__novoard_ask_member",
      "mcp__novoard__novoard_request_detail",
      "mcp__novoard__novoard_report_result",
      "mcp__novoard__novoard_signal_presence",
      "mcp__novoard__novoard_notify_owner",
      "mcp__novoard__novoard_recent_activity",
      "mcp__novoard__novoard_tail_logs",
    ],
    systemPrompt: {
      append: `你是这台电脑上的 ${edition.productName}。配置和执行遵循项目 skill novoard-agent。执行 Target 必须走 novoard_run_target，也就是本机 A2A。`,
    },
    env: sessionEnv(),
    stderr: (chunk) => process.stderr.write(String(chunk)),
  };
}

function sessionEnv() {
  return { ...process.env };
}

function toolDefs(sdk) {
  const { z } = sdk.zod;
  const spec = [
    ["novoard_status", "查看本机成员、Hub 注册状态和 Target 列表", {}],
    ["novoard_list_targets", "读取全部 Target 定义", {}],
    ["novoard_get_settings", "读取 Hub 地址和成员 ID，不返回令牌", {}],
    ["novoard_save_settings", "写入 Hub 地址、成员 ID，以及可选的新令牌", {
      hubUrl: z.string().describe("Hub 域名或地址"),
      agentId: z.string().describe("成员 ID"),
      agentToken: z.string().optional().describe("新的 Agent Token，留空则不更换"),
    }],
    ["novoard_upsert_target", "新增或覆盖一个 Target", {
      id: z.string().describe("Target id"),
      target: z.record(z.string(), z.any()).describe("Target 定义"),
    }],
    ["novoard_delete_target", "删除一个 Target", {
      id: z.string().describe("Target id"),
    }],
    ["novoard_run_target", "通过本机 A2A message/send 执行一个 Target", {
      id: z.string().describe("Target id"),
      forPeer: z.boolean().optional().describe("这次是替其他成员做的，完成后要向对方报告"),
    }],
    ["novoard_ask_member", "向另一个成员发自然语言，不指定 Target", {
      to: z.string().describe("对方成员 id"),
      text: z.string().describe("要问的话"),
    }],
    ["novoard_request_detail", "还缺关键信息。这条回复停在 input-required，等对方下一条消息，不要走脚本审批恢复", {}],
    ["novoard_report_result", "把完成结果发回当前正在对话的成员", {
      text: z.string().describe("结果说明"),
    }],
    ["novoard_signal_presence", "告诉当前成员主人已在这台电脑上", {
      text: z.string().optional().describe("在场说明，可省略"),
    }],
    ["novoard_notify_owner", "请 Hub 把一句话发给主人", {
      text: z.string().describe("要发给主人的话"),
    }],
    ["novoard_recent_activity", "读取最近的本机执行审计", {}],
    ["novoard_tail_logs", "读取最近的本机日志", {}],
  ];
  return spec.map(([name, description, shape]) => sdk.tool(name, description, shape, async (args) => {
    try {
      const text = await dispatchNovoardTool(name, args, { origin });
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return { content: [{ type: "text", text: explainAgentError(error) }], isError: true };
    }
  }));
}

async function loadSdk() {
  const sdk = await import("@tencent-ai/agent-sdk");
  const zod = await import("zod");
  return {
    createSession: sdk.unstable_v2_createSession,
    resumeSession: sdk.unstable_v2_resumeSession,
    createSdkMcpServer: sdk.createSdkMcpServer,
    tool: sdk.tool,
    tryCLIPath: sdk.tryCLIPath ?? null,
    zod,
  };
}

function enqueue(sessionId, job) {
  const previous = queues.get(sessionId) ?? Promise.resolve();
  const run = previous.then(job, job);
  queues.set(sessionId, run.catch(() => {}));
  return run;
}

async function openSession(sdk, id, resume) {
  if (live.has(id)) return live.get(id);
  const holder = holderFor(id);
  const session = resume ? sdk.resumeSession(id, sessionOptions(sdk, holder)) : sdk.createSession(sessionOptions(sdk, holder));
  const sessionId = session.sessionId || id;
  holder.id = sessionId;
  holders.set(sessionId, holder);
  live.set(sessionId, session);
  return session;
}

async function consume(session, requestId) {
  for await (const message of session.stream()) {
    for (const event of normalizeSdkMessage(message)) {
      if (event.kind !== "delta" && !(event.kind === "done" && event.ok)) store.append(session.sessionId, event);
      emit({ id: requestId, event });
      if (event.kind === "assistant" && event.text) {
        const current = store.get(session.sessionId);
        if (current) store.upsert({ ...current, preview: event.text.slice(0, 80), updatedAt: new Date().toISOString() });
      }
    }
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let request;
  try {
    request = JSON.parse(text);
  } catch {
    emit({ id: null, error: "请求不是 JSON" });
    return;
  }
  handle(request).catch((error) => emit({ id: request.id ?? null, error: explainAgentError(error) }));
});

async function handle(request) {
  const id = request.id;
  if (request.op === "list") {
    emit({ id, result: { sessions: store.list() } });
    return;
  }
  if (request.op === "history") {
    emit({ id, result: { session: store.get(request.sessionId), messages: store.messages(request.sessionId) } });
    return;
  }
  if (request.op === "delete") {
    askGate.cancelSession(request.sessionId);
    holders.delete(request.sessionId);
    const session = live.get(request.sessionId);
    live.delete(request.sessionId);
    try { session?.close(); } catch { /* 已关闭 */ }
    store.remove(request.sessionId);
    emit({ id, result: { ok: true } });
    return;
  }
  if (request.op === "interrupt") {
    askGate.cancelSession(request.sessionId);
    await live.get(request.sessionId)?.interrupt();
    emit({ id, result: { ok: true } });
    return;
  }
  if (request.op === "answer") {
    const result = askGate.answer(String(request.questionId ?? ""), request.sessionId, {
      skip: request.skip === true,
      answers: request.answers,
    });
    emit({ id, result });
    return;
  }
  if (request.op === "doctor") {
    try {
      const sdk = await loadSdk();
      let cli = null;
      let message = "";
      try {
        const main = require.resolve("@tencent-ai/agent-sdk");
        const utils = await import(pathToFileURL(join(dirname(main), "utils", "cli-resolver.js")).href);
        cli = utils.tryCLIPath?.() ?? null;
        if (!cli) message = "没有找到 CodeBuddy 运行时。";
      } catch (error) {
        message = explainAgentError(error);
      }
      const auth = codebuddySessionFields(process.env);
      emit({
        id,
        result: {
          ok: Boolean(cli),
          cli: Boolean(cli),
          cliPath: cli,
          message,
          model: auth.model ?? "",
          environment: auth.environment,
          hasApiKey: Boolean(process.env.CODEBUDDY_API_KEY),
        },
      });
    } catch (error) {
      emit({ id, result: { ok: false, cli: false, message: explainAgentError(error) } });
    }
    return;
  }

  const sdk = await loadSdk();
  if (request.op === "create") {
    const holder = { id: "" };
    const session = sdk.createSession(sessionOptions(sdk, holder));
    const sessionId = session.sessionId;
    holder.id = sessionId;
    holders.set(sessionId, holder);
    live.set(sessionId, session);
    const now = new Date().toISOString();
    const entry = { id: sessionId, title: String(request.title || "新对话").slice(0, 80), createdAt: now, updatedAt: now, preview: "" };
    store.upsert(entry);
    emit({ id, result: { session: entry } });
    return;
  }
  if (request.op === "send") {
    await enqueue(request.sessionId, async () => {
      let session = live.get(request.sessionId);
      if (!session) {
        if (!store.get(request.sessionId)) throw new Error("会话不存在");
        session = await openSession(sdk, request.sessionId, true);
      }
      const text = String(request.text ?? "").trim();
      if (!text) throw new Error("消息是空的");
      store.append(request.sessionId, { kind: "user", text });
      const current = store.get(request.sessionId);
      store.upsert({
        ...current,
        title: current?.title && current.title !== "新对话" ? current.title : text.slice(0, 32),
        preview: text.slice(0, 80),
        updatedAt: new Date().toISOString(),
      });
      inflight.set(request.sessionId, id);
      try {
        await session.send(text);
        await consume(session, id);
        emit({ id, result: { ok: true, session: store.get(request.sessionId) } });
      } finally {
        inflight.delete(request.sessionId);
      }
    });
    return;
  }
  emit({ id, error: `未知操作：${request.op}` });
}
