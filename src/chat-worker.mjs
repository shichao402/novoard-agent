/**
 * CodeBuddy 会话进程。由 sidecar 拉起，stdin/stdout 只走一行一个 JSON。
 * 不把 SDK 打进 SEA：CLI 在磁盘上的 node_modules 里，必须用系统 Node 跑这个文件。
 */
import { createInterface } from "node:readline";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const childProcess = require("node:child_process");
const spawnHidden = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args, options = {}) {
  return spawnHidden.call(this, command, args, { ...options, windowsHide: true });
};
import { closeOpenTurns, createSessionStore } from "./session-store.mjs";
import { explainAgentError, isMissingConversation, normalizeSdkMessage } from "./chat-events.mjs";
import { dispatchNovoardTool } from "./novoard-tools.mjs";
import { createAskGate, formatAnswers, normalizeQuestions } from "./ask-user.mjs";
import { cliPermissionMode, createApprovalGate, decideToolUse, describeToolCall, permissionPrompt } from "./chat-approval.mjs";
import { codebuddySessionFields } from "./codebuddy-config.mjs";
import { NOVOARD_SKILL, NOVOARD_SKILL_NAME, NOVOARD_SKILL_LEGACY_NAMES } from "./novoard-skill.mjs";
import { BUILTIN_ALLOWED_TOOLS, BUILTIN_DISALLOWED_TOOLS, NOVOARD_MCP_TOOLS } from "./chat-permissions.mjs";
import { edition } from "./edition.mjs";

const origin = process.env.NOVOARD_LOCAL_ORIGIN || "";
const sessionDir = process.env.NOVOARD_SESSION_DIR;
const agentHome = process.env.NOVOARD_AGENT_HOME;
if (!sessionDir || !agentHome) {
  process.stderr.write("缺少 NOVOARD_SESSION_DIR 或 NOVOARD_AGENT_HOME\n");
  process.exit(1);
}

const skillsDir = join(agentHome, ".codebuddy", "skills");
for (const legacy of NOVOARD_SKILL_LEGACY_NAMES) rmSync(join(skillsDir, legacy), { recursive: true, force: true });
mkdirSync(join(skillsDir, NOVOARD_SKILL_NAME), { recursive: true });
writeFileSync(join(skillsDir, NOVOARD_SKILL_NAME, "SKILL.md"), NOVOARD_SKILL);

const store = createSessionStore(sessionDir);
const live = new Map();
/** 每个会话同一时刻最多一轮：sessionId → { requestId, stopping }。没有排队，忙时新消息直接被拒。 */
const turns = new Map();
const holders = new Map();
const peerTurns = new Set();
const askGate = createAskGate();
const approvalGate = createApprovalGate();

for (const item of closeOpenTurns(store, "会话进程上次没有正常结束，这一轮没有完成。")) {
  for (const event of item.events) broadcast({ kind: "message", sessionId: item.sessionId, event });
  broadcast({ kind: "session", session: item.session });
}

function holderFor(id) {
  const existing = holders.get(id);
  if (existing) return existing;
  const holder = { id };
  holders.set(id, holder);
  return holder;
}

/** 落盘并推给所有订阅者；发起这一轮的请求另外收到一份（成员对话要从中取回复）。 */
function publish(sessionId, requestId, event) {
  if (!sessionId || !store.get(sessionId)) return null;
  const row = store.append(sessionId, event);
  broadcast({ kind: "message", sessionId, event: row });
  if (requestId != null) emit({ id: requestId, event: row });
  return row;
}

/** 改列表项并推送，界面侧栏和「是否在运行」跟着变。 */
function touch(sessionId, patch) {
  const current = store.get(sessionId);
  if (!current) return null;
  const session = store.upsert({ ...current, ...patch, updatedAt: new Date().toISOString() });
  broadcast({ kind: "session", session });
  return session;
}

function broadcast(payload) {
  emit({ broadcast: payload });
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
    permissionMode: cliPermissionMode(auth.permission),
    environment: auth.environment,
    ...(auth.model ? { model: auth.model } : {}),
    canUseTool: async (toolName, input, options) => {
      if (toolName !== "AskUserQuestion") return approveTool(holder.id, toolName, input, options, auth.permission);
      const sessionId = holder.id;
      const questions = normalizeQuestions(input);
      if (!questions.length) return { behavior: "deny", message: "问题格式不正确，没有可回答的题目。" };
      const questionId = String(options?.toolUseID || `ask-${Date.now()}`);
      const requestId = turns.get(sessionId)?.requestId;
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
    includePartialMessages: false,
    sessionId: holder.id || undefined,
    mcpServers: { novoard: server },
    allowedTools: [...NOVOARD_MCP_TOOLS, ...BUILTIN_ALLOWED_TOOLS],
    disallowedTools: BUILTIN_DISALLOWED_TOOLS,
    systemPrompt: {
      append: [
        `你是这台电脑上的 ${edition.productName}。配置、能力包、定时和执行遵循项目 skill ${NOVOARD_SKILL_NAME}。执行 Target 必须走 novoard_run_target，也就是本机 A2A。`,
        permissionPrompt(auth.permission),
      ].join("\n"),
    },
    env: sessionEnv(),
    stderr: (chunk) => process.stderr.write(String(chunk)),
  };
}

async function approveTool(sessionId, toolName, input, options, permission) {
  const allow = { behavior: "allow", updatedInput: input && typeof input === "object" ? input : {} };
  const decision = decideToolUse({
    permission,
    peer: peerTurns.has(sessionId),
    granted: approvalGate.isGranted(sessionId, toolName),
  });
  if (decision === "allow") return allow;
  if (decision === "deny-readonly") return { behavior: "deny", message: `会话权限是只读，${toolName} 不在白名单里。` };
  if (decision === "deny-peer") {
    return { behavior: "deny", message: `这一轮是其他成员发起的，没有本机用户确认，${toolName} 不能直接用。需要时写成 Target 经 novoard_run_target 执行。` };
  }
  const approvalId = String(options?.toolUseID || `approve-${Date.now()}`);
  const requestId = turns.get(sessionId)?.requestId;
  const call = describeToolCall(toolName, input);
  publish(sessionId, requestId, { kind: "approval", approvalId, ...call });
  let answer;
  try {
    answer = await approvalGate.wait(approvalId, sessionId, toolName, options?.signal);
  } catch {
    publish(sessionId, requestId, { kind: "approval_result", approvalId, decision: "cancel" });
    return { behavior: "deny", message: "授权已取消" };
  }
  publish(sessionId, requestId, { kind: "approval_result", approvalId, decision: answer });
  if (answer === "deny") {
    return { behavior: "deny", message: `用户拒绝了这次 ${toolName} 调用。不要换工具绕过，问他想怎么做。` };
  }
  return allow;
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
    ["novoard_target_inputs", "读取一个 Target 的运行时输入：每项的名字、是否必填、默认值和现场查询的候选项", {
      id: z.string().describe("Target id"),
    }],
    ["novoard_run_target", "通过本机 A2A message/send 执行一个 Target", {
      id: z.string().describe("Target id"),
      vars: z.record(z.string(), z.string()).optional().describe("运行时输入的取值，键为输入名；Target 声明了 inputs 时用"),
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
    ["novoard_list_packs", "列出本机已装能力包和 Hub 下发但还没装的来源（含版本、依赖、凭据状态）", {}],
    ["novoard_pack_tools", "读取已装能力包的工具清单和参数定义，写 uses 步骤前先查", {
      pack: z.string().optional().describe("只看这个包，省略则返回全部"),
    }],
    ["novoard_install_pack", "安装未装的来源或更新已装的包，完成后返回结果", {
      key: z.string().describe("novoard_list_packs 返回的 installKey：已装的是包名，未装来源是 src-…"),
      action: z.enum(["install", "update"]).optional().describe("默认 install"),
    }],
    ["novoard_get_schedule", "读取定时总开关、时区，以及每个定时 Target 的下次运行时间和上次结果", {}],
    ["novoard_set_schedule", "打开或关闭定时总开关，影响本机全部定时 Target，先征得用户同意", {
      enabled: z.boolean().describe("true 打开，false 关闭"),
    }],
    ["novoard_schedule_catch_up", "立即补跑今天错过的定时 Target", {}],
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

/** 读完这一轮的流。增量和成功的 done 不落盘也不推送：界面只显示完整消息，轮次结束由 turn 事件表示。 */
async function consume(session, sessionId, turn) {
  let missing = false;
  const state = { hidden: new Set() };
  for await (const message of session.stream()) {
    if (isMissingConversation(message)) {
      missing = true;
      continue;
    }
    for (const event of normalizeSdkMessage(message, state)) {
      if (event.kind === "delta" || (event.kind === "done" && event.ok)) continue;
      // 用户点了停止时 SDK 补一句英文，界面用 turn 的 interrupted 统一显示
      if (turn.stopping && event.kind === "assistant" && /^Interrupted by user$/i.test(event.text ?? "")) continue;
      publish(sessionId, turn.requestId, event);
      if (event.kind === "assistant" && event.text) touch(sessionId, { preview: event.text.slice(0, 80) });
    }
  }
  return { missing };
}

/** 丢掉恢复失败的会话，用同一个 id 新建，界面和本地记录不用换 id。 */
function recreateSession(sdk, id) {
  const stale = live.get(id);
  live.delete(id);
  try { stale?.close(); } catch { /* 已关闭 */ }
  return openSession(sdk, id, false);
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
    const turn = turns.get(request.sessionId);
    if (turn) turn.stopping = true;
    askGate.cancelSession(request.sessionId);
    approvalGate.forgetSession(request.sessionId);
    holders.delete(request.sessionId);
    const session = live.get(request.sessionId);
    live.delete(request.sessionId);
    // 先删记录：正在跑的那一轮收尾时发现会话没了就不再写
    store.remove(request.sessionId);
    try { session?.close(); } catch { /* 已关闭 */ }
    broadcast({ kind: "session_removed", sessionId: request.sessionId });
    emit({ id, result: { ok: true } });
    return;
  }
  if (request.op === "interrupt") {
    // 只有正在跑的这一轮可停；没有排队，所以停下就是真的停了
    const turn = turns.get(request.sessionId);
    if (!turn) {
      emit({ id, result: { ok: true, running: false } });
      return;
    }
    turn.stopping = true;
    askGate.cancelSession(request.sessionId);
    approvalGate.cancelSession(request.sessionId);
    await live.get(request.sessionId)?.interrupt();
    emit({ id, result: { ok: true, running: true } });
    return;
  }
  if (request.op === "approve") {
    emit({ id, result: approvalGate.decide(String(request.approvalId ?? ""), request.sessionId, request.decision) });
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
          permission: auth.permission,
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
    broadcast({ kind: "session", session: entry });
    emit({ id, result: { session: entry } });
    return;
  }
  if (request.op === "send") {
    const sessionId = request.sessionId;
    const text = String(request.text ?? "").trim();
    if (!text) return emit({ id, error: "消息是空的", code: "empty" });
    const entry = store.get(sessionId);
    if (!entry) return emit({ id, error: "会话不存在", code: "missing" });
    if (turns.has(sessionId)) return emit({ id, error: "上一轮还没结束。等它结束，或者先点停止。", code: "busy" });
    const turn = { requestId: id, stopping: false };
    turns.set(sessionId, turn);
    if (request.peer === true) peerTurns.add(sessionId);
    else peerTurns.delete(sessionId);
    publish(sessionId, id, { kind: "user", text });
    publish(sessionId, id, { kind: "turn", state: "running" });
    touch(sessionId, {
      running: true,
      title: entry.title && entry.title !== "新对话" ? entry.title : text.slice(0, 32),
      preview: text.slice(0, 80),
    });
    emit({ id, accepted: true });
    let failure = "";
    try {
      let session = live.get(sessionId) ?? await openSession(sdk, sessionId, true);
      if (!turn.stopping) {
        await session.send(text);
        let outcome = await consume(session, sessionId, turn);
        if (outcome.missing && !turn.stopping) {
          process.stderr.write(`[chat] 会话 ${request.sessionId} 在 CodeBuddy 侧不存在，用同一 id 重建后重发\n`);
          session = await recreateSession(sdk, request.sessionId);
          await session.send(text);
          outcome = await consume(session, sessionId, turn);
          if (outcome.missing) throw new Error("CodeBuddy 找不到这个会话，重建也没有成功。删除这个对话后新建一个再试。");
        }
      }
    } catch (error) {
      if (!turn.stopping) failure = explainAgentError(error);
    } finally {
      turns.delete(sessionId);
      peerTurns.delete(sessionId);
    }
    const outcome = turn.stopping ? "interrupted" : failure ? "error" : "ok";
    if (failure) publish(sessionId, id, { kind: "error", text: failure });
    publish(sessionId, id, { kind: "turn", state: "idle", outcome });
    const session = touch(sessionId, { running: false });
    if (failure) emit({ id, error: failure });
    else emit({ id, result: { ok: true, outcome, session } });
    return;
  }
  emit({ id, error: `未知操作：${request.op}` });
}
