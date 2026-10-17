/**
 * SEA 二进制入口（M6 F2）：仅由 scripts/build-agent.mjs 打包，不在 dev 下直接运行——
 * 依赖 build/embedded-schemas.gen.mjs（构建期由打包脚本生成，schema 内嵌进 bundle）。
 *
 * 与源码入口（main.mjs main()）的差异：
 *   1. schemas 内嵌：globalThis.__NOVOARD_EMBEDDED_SCHEMAS__ 在本模块顶部注入，
 *      frames.mjs 的 createFrameValidator 优先取内嵌（校验路径与 dev 完全同一条）；
 *   2. 路径锚定：agent.json / agents/<agentId>/ / .agent-state/ 锚定 NOVOARD_DATA_DIR，
 *      未设置时回退 cwd（Linux 直接运行形态无需感知源码树）；
 *   3. setup 模式：agent.json 缺失不报错退出，起 127.0.0.1 配置向导并自动开浏览器；
 *      向导保存后 onReady 热启动（createLiteAgent 是工厂，免重启装配）。
 */
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { EMBEDDED_SCHEMAS } from "../build/embedded-schemas.gen.mjs";
import { loadAgentConfig } from "./config.mjs";
import { createLiteAgent } from "./main.mjs";
import { resolveConsoleRoot } from "./console-ui.mjs";
import { createSetupWizard } from "./setup-wizard.mjs";
import { createHostProtocol } from "./host-protocol.mjs";
import { createFileLogger } from "./log.mjs";

globalThis.__NOVOARD_EMBEDDED_SCHEMAS__ = EMBEDDED_SCHEMAS;

const HOST_MODE = process.env.NOVOARD_HOST_PROTOCOL === "ndjson";
const DATA_DIR = resolve(process.env.NOVOARD_DATA_DIR || process.cwd());
const SETUP_PORT = Number(process.env.NOVOARD_SETUP_PORT ?? (HOST_MODE ? 0 : 39870));
const UI_HOST = HOST_MODE ? "127.0.0.1" : String(process.env.NOVOARD_UI_HOST ?? "127.0.0.1");
const UI_TOKEN = HOST_MODE ? "" : String(process.env.NOVOARD_UI_TOKEN ?? "");

mkdirSync(DATA_DIR, { recursive: true });
process.chdir(DATA_DIR);
if (HOST_MODE) {
  // 桌面 WebView 永远走回环；即使 agent.json 曾用于 Linux 远程测试也不能继承外放配置。
  process.env.NOVOARD_UI_HOST = "127.0.0.1";
  process.env.NOVOARD_UI_TOKEN = "";
}

let bootedAgent = null;
let setupWizard = null;
let shuttingDown = null;
let hostProtocol = null;

/** 宿主模式 stdout 只留协议。日志进数据目录 logs/agent.jsonl，不镜像到控制台。 */
const serviceLog = createFileLogger({ dir: DATA_DIR, mirrorStderr: !HOST_MODE });

function emit(type, detail) {
  hostProtocol?.emit(type, detail);
}

/**
 * SEA 统一停机路径。宿主命令、stdin 断开、SIGINT/SIGTERM 与 fatal 都走这里，
 * 保证隧道、HTTP 和 runner 子进程按同一顺序回收。
 */
async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    emit("stopping", { reason });
    if (setupWizard?.server?.listening) {
      try { await setupWizard.close(); } catch {}
    }
    if (bootedAgent) {
      try { await bootedAgent.stop(); } catch (error) {
        serviceLog.error(`agent 停机失败：${error?.message ?? error}`);
        exitCode = 1;
      }
    }
    emit("stopped", { reason, exitCode });
    hostProtocol?.close();
    process.exitCode = exitCode;
  })();
  return shuttingDown;
}

if (HOST_MODE) {
  hostProtocol = createHostProtocol({
    onCommand: async (command) => {
      if (command.type === "shutdown") {
        await shutdown("host-command");
        return;
      }
      emit("protocol-error", { code: "unknown-command", message: `未知宿主命令：${command.type}` });
    },
    onDisconnect: async () => {
      await shutdown("host-disconnected");
    },
  });
}

/** cwd 锚定装配（与 dev 唯一差异是 agentDir/stateDir 的锚点），重复调用幂等返回已启动实例。 */
async function bootAgent() {
  if (bootedAgent) return bootedAgent;
  const probe = loadAgentConfig({ configPath: join(DATA_DIR, "agent.json") });
  if (!probe.ok) throw new Error(probe.reason);
  const agent = await createLiteAgent({
    configPath: probe.file,
    agentDir: join(DATA_DIR, "agents", probe.agentId),
    stateDir: join(DATA_DIR, ".agent-state"),
    log: serviceLog,
    onFatal: async (fatal) => {
      emit("fatal", fatal);
      await shutdown("agent-fatal", 1);
    },
  });
  bootedAgent = agent;
  const panelPort = agent.localA2A.server.address().port;
  const panelHost = agent.config.uiHost.includes(":") ? `[${agent.config.uiHost}]` : agent.config.uiHost;
  const panelUrl = `http://${panelHost}:${panelPort}`;
  serviceLog.info(`Novoard agent 已启动：${agent.config.agentId}`);
  serviceLog.info(`  hub: ${agent.config.hubUrl}`);
  serviceLog.info(`  控制台: ${panelUrl}`);
  emit("ui-ready", {
    view: "panel",
    url: panelUrl,
    panelUrl,
    agentId: agent.config.agentId,
  });
  return agent;
}

/** 跨平台开浏览器（无 GUI/失败静默忽略；NOVOARD_SETUP_OPEN=0 可关）。 */
function openBrowser(url) {
  if (process.env.NOVOARD_SETUP_OPEN === "0") return;
  try {
    const cmd = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch { /* 无桌面环境时忽略 */ }
}

async function main() {
  if (!existsSync(join(DATA_DIR, "agent.json"))) {
    setupWizard = createSetupWizard({
      dir: DATA_DIR,
      port: SETUP_PORT,
      host: UI_HOST,
      uiToken: UI_TOKEN,
      uiRoot: resolveConsoleRoot(),
      onReady: bootAgent,
      log: serviceLog,
    });
    const addr = await setupWizard.start();
    const setupHost = UI_HOST.includes(":") ? `[${UI_HOST}]` : UI_HOST;
    const setupUrl = `http://${setupHost}:${addr.port}/setup`;
    serviceLog.info(`首次接入：未发现 agent.json，配置向导已就绪 ${setupUrl}`);
    serviceLog.info(`（向导保存后自动启动 agent；数据目录：${DATA_DIR}）`);
    emit("ui-ready", { view: "setup", url: setupUrl, setupUrl });
    if (!HOST_MODE) openBrowser(setupUrl);
    return;
  }
  await bootAgent();
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });

main().catch(async (error) => {
  const message = `novoard-agent 启动失败：${error?.message ?? error}`;
  serviceLog.error(message);
  emit("fatal", { code: "startup-failed", message });
  await shutdown("startup-failed", 1);
});
