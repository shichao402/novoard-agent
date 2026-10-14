/**
 * SEA 二进制入口（M6 F2）：仅由 scripts/build-agent.mjs 打包，不在 dev 下直接运行——
 * 依赖 build/embedded-schemas.gen.mjs（构建期由打包脚本生成，schema 内嵌进 bundle）。
 *
 * 与源码入口（main.mjs main()）的差异：
 *   1. schemas 内嵌：globalThis.__NOVOARD_EMBEDDED_SCHEMAS__ 在本模块顶部注入，
 *      frames.mjs 的 createFrameValidator 优先取内嵌（校验路径与 dev 完全同一条）；
 *   2. 路径锚定：agent.json / agents/<agentId>/ / .agent-state/ 一律 cwd 锚定
 *      （二进制形态 = "exe 旁边的目录即数据目录"，无需感知源码树）；
 *   3. setup 模式：agent.json 缺失不报错退出，起 127.0.0.1 配置向导并自动开浏览器；
 *      向导保存后 onReady 热启动（createLiteAgent 是工厂，免重启装配）。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EMBEDDED_SCHEMAS } from "../../build/embedded-schemas.gen.mjs";
import { loadAgentConfig } from "./config.mjs";
import { createLiteAgent } from "./main.mjs";
import { createSetupWizard } from "./setup-wizard.mjs";

globalThis.__NOVOARD_EMBEDDED_SCHEMAS__ = EMBEDDED_SCHEMAS;

const SETUP_PORT = Number(process.env.NOVOARD_SETUP_PORT ?? 39870);

let bootedAgent = null;

/** cwd 锚定装配（与 dev 唯一差异是 agentDir/stateDir 的锚点），重复调用幂等返回已启动实例。 */
async function bootAgent() {
  if (bootedAgent) return bootedAgent;
  const cwd = process.cwd();
  const probe = loadAgentConfig({ configPath: join(cwd, "agent.json") });
  if (!probe.ok) throw new Error(probe.reason);
  const agent = await createLiteAgent({
    configPath: probe.file,
    agentDir: join(cwd, "agents", probe.agentId),
    stateDir: join(cwd, ".agent-state"),
    log: { info() {}, error(...args) { console.error(...args); } },
  });
  bootedAgent = agent;
  const panelPort = agent.localA2A.server.address().port;
  console.log(`Novoard agent 已启动：${agent.config.agentId}`);
  console.log(`  hub: ${agent.config.hubUrl}`);
  console.log(`  面板: http://127.0.0.1:${panelPort} · 编辑器: http://127.0.0.1:${panelPort}/editor`);
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
  const cwd = process.cwd();
  if (!existsSync(join(cwd, "agent.json"))) {
    const wizard = createSetupWizard({ dir: cwd, port: SETUP_PORT, onReady: bootAgent, log: console });
    const addr = await wizard.start();
    console.log(`首次接入：未发现 agent.json，配置向导已就绪 http://127.0.0.1:${addr.port}/setup`);
    console.log(`（向导保存后自动启动 agent；数据目录：${cwd}）`);
    openBrowser(`http://127.0.0.1:${addr.port}/setup`);
    return;
  }
  await bootAgent();
}

main().catch((error) => {
  console.error(`novoard-agent 启动失败：${error?.message ?? error}`);
  process.exit(1);
});
