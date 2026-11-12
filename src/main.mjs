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
import { loadTargets, expandSteps, deriveCard, validateUsesSteps } from "./card.mjs";
import { createPackRegistry } from "./packs/registry.mjs";
import { createPackManager } from "./packs/manager.mjs";
import { createSourcesCache, packSourcesPath } from "./packs/sources-cache.mjs";
import { createGitAuth, gitCredentialsPath } from "./packs/git-auth.mjs";
import { createDiagnoser, createGitCheck, formatProblems } from "./packs/diagnose.mjs";
import { createScheduler, systemTimezone } from "./scheduler.mjs";
import { createScheduleState, scheduleStatePath } from "./schedule-state.mjs";
import { loadProfile, saveProfile } from "./profile.mjs";
import { createPeerTalk } from "./peer-talk.mjs";
import { createAgentRuntime } from "./agent-runtime.mjs";
import { resolveScriptEnv } from "./shell-env.mjs";
import { createTunnelClient } from "./tunnel-client.mjs";
import { resolveConsoleRoot } from "./console-ui.mjs";
import { createLocalA2A } from "./local-a2a.mjs";
import { createTargetsStore } from "./targets-store.mjs";
import { persistAgentConfig, testConnection } from "./setup-wizard.mjs";
import { createChatBridge } from "./chat-bridge.mjs";
import { acquireInstanceLock } from "./instance-lock.mjs";
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

export async function createLiteAgent(options = {}) {
  const { configPath, env = process.env, log = console } = options;
  const config = loadAgentConfig({ configPath, env });
  if (!config.ok) throw new Error(config.reason);
  const state = options.stateDir ?? join(process.cwd(), ".agent-state");
  mkdirSync(state, { recursive: true });
  // 同机同身份的第二个进程在这里被拦住：hub 侧也会拒，但那只能看到日志里的重试
  const lock = acquireInstanceLock({ stateDir: state, agentId: config.agentId, log });
  if (!lock.ok) throw new Error(lock.reason);
  try {
    const agent = await buildAgent({ ...options, config, state, log });
    const stopInner = agent.stop;
    agent.stop = async () => {
      try { await stopInner(); } finally { lock.release(); }
    };
    return agent;
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function buildAgent({ agentDir, log = console, onFatal, onActivity, config, state, env = process.env, now }) {
  const dir = agentDir ?? (HERE ? join(HERE, "..", "..", "agents", config.agentId) : null);
  if (!dir) throw new Error("SEA/打包形态必须显式传 agentDir（sea-entry 以 cwd 锚定传入）");
  const auditFile = join(state, "audit.jsonl");

  const localAudit = (event) => {
    const line = { ts: new Date().toISOString(), actor: `agent:${config.agentId}`, lane: event.lane ?? "a2a", target: event.target ?? "hub", taskId: event.taskId, outcome: event.outcome, detail: event.detail };
    appendFileSync(auditFile, JSON.stringify(line) + "\n");
  };

  const loaded = loadTargets({ agentDir: dir });
  if (!loaded.ok) throw new Error(loaded.reason);
  const expanded = expandSteps({ targets: loaded.targets, agentDir: dir });
  if (!expanded.ok) throw new Error(expanded.reason);
  // 能力包（ADR-0019）：<stateDir>/packs/<id>/；NOVOARD_PACKS_DIR 可覆盖（测试与本机调试用）
  const packs = createPackRegistry({ packsDir: env.NOVOARD_PACKS_DIR || join(state, "packs") });
  const packSources = createSourcesCache({ file: packSourcesPath(state), log });
  // 私有仓凭据只在本机（PRD-7 A8）：<stateDir>/git-credentials.json，按 URL 前缀匹配
  const gitAuth = createGitAuth({ file: gitCredentialsPath(state), log });
  // 包管理（PRD-7 A5）：安装/更新/删除结束（成功或失败）都重派生 Card 并发 card.update
  const packManager = createPackManager({
    registry: packs,
    sources: packSources,
    gitAuth,
    log,
    env,
    onChange: ({ id, result }) => refreshCard(`能力包 ${id} ${result.ok ? "已变更" : `操作失败：${result.reason}`}`),
  });
  // 已装包目录名与来源包名对齐（旧版人填的 id → toolset.json 的 id）；此时 Card 还没派生，不发通知
  packManager.reconcile({ notify: false });
  const usesErrors = validateUsesSteps(expanded.targets, packs);
  if (usesErrors.length > 0) throw new Error(`targets 校验失败：${usesErrors.join("; ")}`);
  // 诊断（PRD-7 A6）：现在跑会失败的 target 不进 Card；磁贴标红；定时前 60 分钟预检
  const diagnoser = createDiagnoser({ registry: packs, canProvide: (id) => packManager.canProvide(id), gitAvailable: createGitCheck({ env }) });
  const profileRef = { current: loadProfile(dir) };
  const card = deriveCard({ agentId: config.agentId, targets: loaded.targets, agentDir: dir, profile: profileRef.current, unavailable: diagnoser.unavailable(expanded.targets) });
  /** editor 保存后 card 热更新（tunnel 上报用新 card；hello 重连也带最新） */
  const cardRef = { current: card };

  const logDir = dirname(log.file || join(dirname(state), "logs", "agent.jsonl"));
  const bootId = randomUUID();
  const scriptEnv = resolveScriptEnv();
  log.info?.(`[env] target 脚本环境：${scriptEnv.source}（${scriptEnv.detail}），PATH=${scriptEnv.env.PATH ?? ""}`);
  const runtime = createAgentRuntime({
    targets: expanded.targets,
    log,
    bootId,
    scriptEnv: scriptEnv.env,
    packs,
    packInstaller: packManager,
    diagnose: (steps) => diagnoser.diagnoseSteps(steps),
    shortcutLogDir: join(logDir, "shortcuts"),
    runTraceDir: join(logDir, "runs"),
    onActivity,
  });

  // target 编辑器后端（M6）：保存 → 从盘重装载 → 热替换 runtime/localA2A 注册表 → card.update 上报 hub
  const store = createTargetsStore({ agentDir: dir, agentId: config.agentId, log, packs, diagnoser });
  let currentExpanded = expanded.targets;
  const onTargetsSaved = (saved) => {
    runtime.replaceTargets(saved.expanded);
    currentExpanded = saved.expanded;
    localA2A.refreshTargets(saved.expanded);
    cardRef.current = saved.card;
    peer?.replaceTargets(saved.expanded);
    tunnel.replaceTargets?.(saved.expanded);
    tunnel.replaceCard?.(saved.card);
    const up = tunnel.sendCardUpdate?.(saved.card);
    log.info?.(`[editor] 热生效：runtime/磁贴/委派查表已切新定义，card.update ${up?.ok ? "已上报 hub" : `未上报（${up?.reason ?? "hub 离线"}）`}`);
    // 用户在场时的自动补装（PRD-7 A5）：保存后缺包且来源已知就在后台装
    const steps = Object.values(saved.expanded ?? {}).flatMap((t) => t.expanded ?? []);
    if (packManager.needsInstall(steps)) {
      packManager.ensureFor(steps).then((r) => {
        if (!r.ok) log.warn?.(`[packs] 保存后自动补装失败：${r.reason}`);
      });
    }
  };

  /** 重派生 Card 并上报（profile 保存、包变更共用）。 */
  function refreshCard(why) {
    const current = store.read();
    const next = deriveCard({ agentId: config.agentId, targets: current.ok ? current.targets : loaded.targets, agentDir: dir, profile: profileRef.current, unavailable: diagnoser.unavailable(currentExpanded) });
    cardRef.current = next;
    tunnel?.replaceCard?.(next);
    const up = tunnel?.sendCardUpdate?.(next);
    log.info?.(`[card] ${why}，card.update ${up?.ok ? "已上报 hub" : `未上报（${up?.reason ?? "hub 离线"}）`}`);
    return next;
  }

  let peer = null;
  // 历史 agent.json 里可能写着旧版本号（升级只换二进制不重装的环境）：契约版本以代码常量为准，
  // 这里明确告知用户该值已被取代，避免有人以为改配置文件能对齐契约（需求 8.4）
  if (config.staleContractVersion) {
    log.info?.(
      `agent.json 中的 contractVersion=${config.staleContractVersion} 已被忽略：契约版本由代码常量提供（当前 ${config.contractVersion}），` +
        `该字段不再生效，也不会被回写`,
    );
  }
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
    onPackSources: (list) => {
      const r = packSources.replace(list);
      log.info?.(`[packs] 已缓存 hub 下发的能力包来源 ${r.count} 条`);
      packManager.reconcile();
    },
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
  /** 调度器在 localA2A 之后创建；控制台定时接口经此引用访问，启动完成前返回未就绪。 */
  const scheduleRef = { current: null };
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
        refreshCard("已更新自我介绍");
        return { ok: true, role: saved.role, introduction: saved.introduction };
      },
    },
    packManager,
    packRegistry: packs,
    gitAuth,
    diagnoseTarget: (target) => diagnoser.diagnoseTarget(target),
    schedule: {
      status: () => scheduleRef.current?.status() ?? null,
      setEnabled: (value) => {
        if (!scheduleRef.current) return { ok: false, reason: "定时调度还没启动" };
        scheduleRef.current.setEnabled(value);
        log.info?.(`[schedule] 定时已${value ? "开启" : "关闭"}（控制台）`);
        return { ok: true, enabled: scheduleRef.current.status().enabled };
      },
      catchUp: () => {
        if (!scheduleRef.current) return { ok: false, reason: "定时调度还没启动" };
        const fired = scheduleRef.current.catchUp();
        log.info?.(`[schedule] 控制台立即补跑，触发 ${fired.length} 项`);
        return { ok: true, fired: fired.map((f) => ({ id: f.id, trigger: f.trigger, slot: f.slot })) };
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

  // 定时调度（PRD-7 A2）：经本地触发入口执行，和磁贴手动触发同一条路（控制台可见、终态经 triggerHook 上行 hub）
  const scheduler = createScheduler({
    getTargets: () => currentExpanded,
    state: createScheduleState({ file: scheduleStatePath(state) }),
    timezone: resolveTimezone(config.schedule?.timezone, log),
    catchUpPreviousDays: config.schedule?.catchUpPreviousDays ?? 1,
    retryFailedOnCatchUp: config.schedule?.retryFailedOnCatchUp === true,
    ...(now ? { now } : {}),
    log,
    launch: ({ skillId, trigger, deadlineAt, deadlineLabel, onState }) => {
      const r = localA2A.trigger({ skillId, trigger, deadlineAt, deadlineLabel, onState });
      if (!r.ok) return { ok: false, reason: r.reason };
      const launched = r.launch ?? { ok: true };
      return { ok: launched.ok, retryable: launched.retryable === true, reason: launched.reason, taskId: r.task?.id };
    },
    // 预检（PRD-7 A6）：下次触发前 60 分钟内看一眼，现在跑会失败就提前告诉主人
    onPrecheck: ({ id, target, label }) => {
      const problems = diagnoser.diagnoseTarget(target).filter((p) => p.level === "error");
      if (!problems.length) return;
      const text = `【预检】${config.agentId} 的「${target.title ?? id}」将在 ${label} 运行，现在看会失败：\n${formatProblems(problems)}`;
      const sent = tunnel.notifyOwner?.(text) ?? { ok: false, reason: "no-tunnel" };
      log.warn?.(`[schedule] 预检 ${id} 有 ${problems.length} 个问题，通知${sent.ok ? "已发送" : `未发送（${sent.reason}）`}`);
    },
  });
  scheduleRef.current = scheduler;
  scheduler.start();
  log.info?.(`[schedule] 定时${scheduler.status().enabled ? "已开启" : "未开启"}，时区 ${scheduler.timezone}`);

  /** 统一停机：关隧道 + localhost 端点（测试与优雅退出共用）。 */
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    scheduler.stop();
    tunnel.close();
    chat.close();
    await runtime.shutdown();
    await localA2A.close();
  }

  return { config, card: cardRef.current, targets: expanded.targets, runtime, tunnel, localAudit, localA2A, store, peer, onTargetsSaved, scheduler, packs, packManager, packSources, gitAuth, diagnoser, stop, agentDir: dir };
}

function resolveTimezone(configured, log) {
  if (!configured) return systemTimezone();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: configured });
    return configured;
  } catch {
    log.warn?.(`[schedule] agent.json schedule.timezone=${configured} 无法识别，改用系统时区 ${systemTimezone()}`);
    return systemTimezone();
  }
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
