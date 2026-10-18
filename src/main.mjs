/**
 * lite-agent 入口：装配 config → card → tunnel-client → runtime。
 * 目录约定：仓库根 agents/<agentId>/ 为该 agent 的定义目录（targets.yaml + templates/）。
 * 启动时序（纪律一）：装载 targets → schema 校验 → 展开 → 派生 card → 连隧道 → hello。
 * 本地审计：agent 侧一份 JSONL（契约 §6 落两侧各一份），与 hub 可对账。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadAgentConfig, pinEditionListenPort, pinPanelPort } from "./config.mjs";
import { loadTargets, expandSteps, deriveCard } from "./card.mjs";
import { loadProfile, saveProfile } from "./profile.mjs";
import { createPeerTalk } from "./peer-talk.mjs";
import { createAgentRuntime } from "./agent-runtime.mjs";
import { createTunnelClient } from "./tunnel-client.mjs";
import { resolveConsoleRoot } from "./console-ui.mjs";
import { createLocalA2A } from "./local-a2a.mjs";
import { createTargetsStore } from "./targets-store.mjs";
import { persistAgentConfig, testConnection } from "./setup-wizard.mjs";
import { createChatBridge } from "./chat-bridge.mjs";
import { publicCodebuddyConfig, readCodebuddyConfig, saveCodebuddyConfig } from "./codebuddy-config.mjs";

const HERE = moduleHere();

/** 模块定位（dev=src/；SEA/打包形态 import.meta 不可用时为 null，此时由 sea-entry 显式传 agentDir）。 */
function moduleHere() {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

export async function createLiteAgent({ configPath, agentDir, stateDir, log = console, env = process.env, onFatal } = {}) {
  const config = loadAgentConfig({ configPath, env });
  if (!config.ok) throw new Error(config.reason);

  const dir = agentDir ?? (HERE ? join(HERE, "..", "..", "agents", config.agentId) : null);
  if (!dir) throw new Error("SEA/打包形态必须显式传 agentDir（sea-entry 以 cwd 锚定传入）");
  const state = stateDir ?? join(process.cwd(), ".agent-state");
  mkdirSync(state, { recursive: true });
  const auditFile = join(state, "audit.jsonl");

  const localAudit = (event) => {
    const line = { ts: new Date().toISOString(), actor: `agent:${config.agentId}`, lane: event.lane ?? "a2a", target: event.target ?? "hub", taskId: event.taskId, outcome: event.outcome, detail: event.detail };
    appendFileSync(auditFile, JSON.stringify(line) + "\n");
  };

  const loaded = loadTargets({ agentDir: dir });
  if (!loaded.ok) throw new Error(loaded.reason);
  const expanded = expandSteps({ targets: loaded.targets, agentDir: dir });
  if (!expanded.ok) throw new Error(expanded.reason);
  const profileRef = { current: loadProfile(dir) };
  const card = deriveCard({ agentId: config.agentId, targets: loaded.targets, agentDir: dir, profile: profileRef.current });
  /** editor 保存后 card 热更新（tunnel 上报用新 card；hello 重连也带最新） */
  const cardRef = { current: card };

  const logDir = dirname(log.file || join(dirname(state), "logs", "agent.jsonl"));
  const bootId = randomUUID();
  const runtime = createAgentRuntime({
    targets: expanded.targets,
    log,
    bootId,
    shortcutLogDir: join(logDir, "shortcuts"),
    runTraceDir: join(logDir, "runs"),
  });

  // target 编辑器后端（M6）：保存 → 从盘重装载 → 热替换 runtime/localA2A 注册表 → card.update 上报 hub
  const store = createTargetsStore({ agentDir: dir, agentId: config.agentId, log });
  const onTargetsSaved = (saved) => {
    runtime.replaceTargets(saved.expanded);
    localA2A.refreshTargets(saved.expanded);
    cardRef.current = saved.card;
    peer?.replaceTargets(saved.expanded);
    tunnel.replaceTargets?.(saved.expanded);
    tunnel.replaceCard?.(saved.card);
    const up = tunnel.sendCardUpdate?.(saved.card);
    log.info?.(`[editor] 热生效：runtime/磁贴/委派查表已切新定义，card.update ${up?.ok ? "已上报 hub" : `未上报（${up?.reason ?? "hub 离线"}）`}`);
  };

  let peer = null;
  const tunnel = createTunnelClient({
    config,
    card: cardRef.current,
    targets: expanded.targets,
    runner: runtime,
    stateDir: state,
    runTraceDir: join(logDir, "runs"),
    bootId,
    log,
    onFatal,
    onAgentMessage: (message) => peer?.receive(message),
    onAgentNotice: (message) => peer?.note(message),
  });
  peer = createPeerTalk({
    agentId: config.agentId,
    profile: profileRef.current,
    targets: expanded.targets,
    tunnel,
    chat: null,
    stateDir: join(state, "peers"),
    log,
  });

  // 终态上行同时落 agent 侧审计（契约 §6 两侧对账）
  const origLaunch = runtime.launch;
  runtime.launch = (input) => {
    localAudit({ target: input.skillId, taskId: input.taskId, outcome: "working" });
    return origLaunch({
      ...input,
      onTerminal: (state, detail) => {
        localAudit({ target: input.skillId, taskId: input.taskId, outcome: state, detail });
        input.onTerminal?.(state, detail);
      },
    });
  };

  // 本地 A2A 端点（ADR-0008；PRD-1 触发路径统一：磁贴/热键/CLI → 本机端点）
  // hub 在线时终态经隧道上行（triggerHook）；离线时本地闭环（PRD-1 AC2）
  const codebuddyFile = join(dirname(state), "codebuddy.json");
  const chat = createChatBridge({ dataDir: state, codebuddyFile, log });
  const localA2A = createLocalA2A({
    port: Number(config.localPort ?? 0),
    host: config.uiHost,
    uiToken: config.uiToken,
    uiRoot: resolveConsoleRoot(),
    targets: expanded.targets,
    card: cardRef.current,
    runtime,
    audit: localAudit,
    log,
    store,
    onTargetsSaved,
    status: () => ({ hubConnected: tunnel.connected === true, hubRegistered: tunnel.registered === true }),
    settings: {
      read: () => ({
        agentId: config.agentId,
        hubUrl: config.hubUrl,
        localPort: config.localPort,
        hasToken: Boolean(config.agentToken),
        contractVersion: config.version,
      }),
      test: (input) => testConnection({ hubUrl: input?.hubUrl, agentToken: String(input?.agentToken ?? "").trim() || config.agentToken }),
      save: (input) => {
        const token = String(input.agentToken ?? "").trim() || config.agentToken;
        return persistAgentConfig({
          dir: dirname(config.file),
          hubUrl: input.hubUrl,
          agentId: input.agentId,
          agentToken: token,
          localPort: input.localPort ?? config.localPort,
          uiHost: "127.0.0.1",
          uiToken: "",
          log,
        });
      },
    },
    activityFile: auditFile,
    logFile: log.file || join(dirname(state), "logs", "agent.jsonl"),
    shortcutLogDir: join(dirname(log.file || join(dirname(state), "logs", "agent.jsonl")), "shortcuts"),
    codebuddy: {
      read: () => publicCodebuddyConfig(readCodebuddyConfig(codebuddyFile)),
      save: (input) => {
        const saved = saveCodebuddyConfig(codebuddyFile, input);
        log.info?.(`[codebuddy] 已保存类型 ${saved.environment}，模型 ${saved.model || "默认"}`);
        return { ok: true, public: publicCodebuddyConfig(saved) };
      },
    },
    chat,
    triggerHook: (state, skillId, taskId) => {
      if (TERMINAL_STATES_SET.has(state)) tunnel.uplinkTerminal?.(taskId, state, `tile-trigger ${skillId}`);
      if (TERMINAL_STATES_SET.has(state)) peer.reportRun(taskId, state, skillId);
    },
    peer,
    profile: {
      read: () => profileRef.current,
      save: (input) => {
        const saved = saveProfile(dir, input);
        if (!saved.ok) return saved;
        profileRef.current = { role: saved.role, introduction: saved.introduction };
        peer.replaceProfile(profileRef.current);
        const current = store.read();
        const next = deriveCard({ agentId: config.agentId, targets: current.ok ? current.targets : loaded.targets, agentDir: dir, profile: profileRef.current });
        cardRef.current = next;
        tunnel.replaceCard?.(next);
        const up = tunnel.sendCardUpdate?.(next);
        log.info?.(`[profile] 已更新自我介绍，card.update ${up?.ok ? "已上报 hub" : `未上报（${up?.reason ?? "hub 离线"}）`}`);
        return { ok: true, role: saved.role, introduction: saved.introduction };
      },
    },
  });
  const localAddr = await localA2A.start();
  const panelHost = config.uiHost.includes(":") ? `[${config.uiHost}]` : config.uiHost;
  peer.replaceChat(chat);
  chat.setOrigin(`http://${panelHost}:${localAddr.port}`);
  const uiHostForUrl = config.uiHost.includes(":") ? `[${config.uiHost}]` : config.uiHost;
  log.info?.(`[local-a2a] 控制台: http://${uiHostForUrl}:${localAddr.port}`);
  if (config.uiRemote) {
    log.error?.("[local-a2a] 警告：Web 控制台正在非回环地址监听，仅应用于受控测试网络；优先使用 SSH 端口转发。");
  }

  await tunnel.start();

  /** 统一停机：关隧道 + localhost 端点（测试与优雅退出共用）。 */
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    tunnel.close();
    chat.close();
    await runtime.shutdown();
    await localA2A.close();
  }

  return { config, card: cardRef.current, targets: expanded.targets, runtime, tunnel, localAudit, localA2A, store, peer, onTargetsSaved, stop, agentDir: dir };
}

const TERMINAL_STATES_SET = new Set(["completed", "failed", "canceled", "rejected"]);

export function main() {
  pinEditionListenPort();
  const probe = loadAgentConfig();
  if (probe.ok) pinPanelPort(probe.localPort);
  createLiteAgent()
    .then((agent) => {
      console.log(`Novoard lite-agent 已启动：${agent.config.agentId}`);
      console.log(`  skills: ${agent.card.skills.map((s) => s.id).join(", ") || "无"}`);
      console.log(`  hub: ${agent.config.hubUrl}  state: .agent-state/`);
      const host = agent.config.uiHost.includes(":") ? `[${agent.config.uiHost}]` : agent.config.uiHost;
      console.log(`  local: http://${host}:${agent.localA2A.server.address().port}`);
    })
    .catch((error) => {
      console.error(`lite-agent 启动失败：${error.message}`);
      process.exit(1);
    });
}

// SEA/CJS bundle 形态 import.meta.url 为空——恒不触发（sea-entry 显式装配）；dev 直接运行时正常判断
if (import.meta?.url && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
