/**
 * lite-agent 入口：装配 config → card → tunnel-client → runtime。
 * 目录约定：仓库根 agents/<agentId>/ 为该 agent 的定义目录（targets.yaml + templates/）。
 * 启动时序（纪律一）：装载 targets → schema 校验 → 展开 → 派生 card → 连隧道 → hello。
 * 本地审计：agent 侧一份 JSONL（契约 §6 落两侧各一份），与 hub 可对账。
 */
import { mkdirSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentConfig } from "./config.mjs";
import { loadTargets, expandSteps, deriveCard } from "./card.mjs";
import { createAgentRuntime } from "./agent-runtime.mjs";
import { createTunnelClient } from "./tunnel-client.mjs";
import { createLocalA2A } from "./local-a2a.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function createLiteAgent({ configPath, agentDir, stateDir, log = console, env = process.env } = {}) {
  const config = loadAgentConfig({ configPath, env });
  if (!config.ok) throw new Error(config.reason);

  const dir = agentDir ?? join(HERE, "..", "..", "agents", config.agentId);
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
  const card = deriveCard({ agentId: config.agentId, targets: loaded.targets });

  const runtime = createAgentRuntime({ targets: expanded.targets, log });

  const tunnel = createTunnelClient({
    config,
    card,
    targets: expanded.targets,
    runner: runtime,
    stateDir: state,
    log,
  });

  // 终态上行同时落 agent 侧审计（契约 §6 两侧对账）
  const origLaunch = runtime.launch;
  runtime.launch = ({ taskId, skillId, vars, steps, onTerminal }) => {
    localAudit({ target: skillId, taskId, outcome: "working" });
    return origLaunch({ taskId, skillId, vars, steps, onTerminal: (state, detail) => {
      localAudit({ target: skillId, taskId, outcome: state, detail });
      onTerminal?.(state, detail);
    } });
  };

  // 本地 A2A 端点 + 磁贴面板（ADR-0008；PRD-1 触发路径统一：磁贴/热键/CLI → localhost 端点）
  // hub 在线时终态经隧道上行（triggerHook）；离线时本地闭环（PRD-1 AC2）
  const localA2A = createLocalA2A({
    port: Number(config.localPort ?? 0),
    targets: expanded.targets,
    card,
    runtime,
    audit: localAudit,
    log,
    triggerHook: (state, skillId, taskId) => {
      if (TERMINAL_STATES_SET.has(state)) tunnel.uplinkTerminal?.(taskId, state, `tile-trigger ${skillId}`);
    },
  });
  const localAddr = await localA2A.start();
  log.info?.(`[local-a2a] localhost 端点: http://127.0.0.1:${localAddr.port} （磁贴面板 + 触发入口）`);

  await tunnel.start();

  /** 统一停机：关隧道 + localhost 端点（测试与优雅退出共用）。 */
  async function stop() {
    tunnel.close();
    await localA2A.close();
  }

  return { config, card, targets: expanded.targets, runtime, tunnel, localAudit, localA2A, stop, agentDir: dir };
}

const TERMINAL_STATES_SET = new Set(["completed", "failed", "canceled", "rejected"]);

export function main() {
  createLiteAgent()
    .then((agent) => {
      console.log(`Novoard lite-agent 已启动：${agent.config.agentId}`);
      console.log(`  skills: ${agent.card.skills.map((s) => s.id).join(", ") || "无"}`);
      console.log(`  hub: ${agent.config.hubUrl}  state: .agent-state/`);
      console.log(`  local: http://127.0.0.1:${agent.localA2A.server.address().port} （磁贴面板）`);
    })
    .catch((error) => {
      console.error(`lite-agent 启动失败：${error.message}`);
      process.exit(1);
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
