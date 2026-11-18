/**
 * sidecar 与 CodeBuddy 会话进程之间的桥。
 * SEA 里没有 SDK 的 CLI 目录，所以会话交给系统 Node 跑 src/chat-worker.mjs。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readCodebuddyConfig, resolveCodebuddyConfig, codebuddyProcessEnv } from "./codebuddy-config.mjs";
import { edition } from "./edition.mjs";

function moduleDir() {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

export function locateChatWorker() {
  const fromEnv = process.env.NOVOARD_CHAT_WORKER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const here = moduleDir();
  if (here) {
    const local = join(here, "chat-worker.mjs");
    if (existsSync(local)) return local;
  }
  const beside = join(dirname(process.execPath), "agent-runtime", "chat-worker.mjs");
  if (existsSync(beside)) return beside;
  return null;
}

function plainWindowsPath(value) {
  const text = String(value);
  if (text.startsWith("\\\\?\\UNC\\")) return `\\\\${text.slice(8)}`;
  if (text.startsWith("\\\\?\\")) return text.slice(4);
  return text;
}

export function locateNode(env = process.env, options = {}) {
  const executable = options.executable || process.execPath;
  const fromEnv = env.NOVOARD_NODE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const base = basename(executable).toLowerCase();
  if (base === "node" || base === "node.exe") return executable;
  const pathValue = env.PATH || env.Path || "";
  const names = process.platform === "win32" ? ["node.exe"] : ["node"];
  for (const dir of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!dir || /windowsapps/i.test(dir)) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 会话进程启动时用的模型配置指纹。key 只参与哈希，不写日志。
 * 面板保存会主动重启会话进程；Dec 轮换 key、环境变量变化没有通知，靠新建会话前比对指纹发现。
 */
export function codebuddyFingerprint(configured) {
  const { apiKeySource = "", apiKey = "", environment = "", model = "" } = configured ?? {};
  return createHash("sha256").update(JSON.stringify([apiKeySource, apiKey, environment, model])).digest("hex");
}

/**
 * env 是会话进程的基础环境。GUI 拉起时进程 PATH 只有系统目录，找不到 Homebrew 等装的 Node，
 * 所以宿主应传入与 target 脚本相同的登录 shell 环境（resolveScriptEnv）；不传时沿用进程环境。
 */
export function createChatBridge({ dataDir, codebuddyFile, decEnvFile, workerPath, nodePath, env = process.env, log = console } = {}) {
  if (!dataDir) throw new Error("createChatBridge 需要 dataDir");
  const sessionDir = join(dataDir, "sessions");
  const agentHome = join(dataDir, "agent-home");
  let origin = "";
  let child = null;
  let buffer = "";
  let seq = 1;
  let starting = null;
  let spawnedFingerprint = "";
  const pending = new Map();

  function currentConfig() {
    const panel = codebuddyFile ? readCodebuddyConfig(codebuddyFile) : { model: "", apiKey: "", environment: "internal" };
    return resolveCodebuddyConfig(panel, { env, ...(decEnvFile ? { decFile: decEnvFile } : {}) });
  }

  function setOrigin(next) {
    origin = next;
    if (child) restart();
  }

  function failAll(error) {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }

  function onData(chunk) {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        log.warn?.(`[chat] 忽略无法解析的会话输出：${line.slice(0, 180)}`);
        continue;
      }
      const item = pending.get(payload.id);
      if (!item) continue;
      if (payload.event) {
        try { item.onEvent?.(payload.event); } catch { /* 页面已离开，会话仍要继续 */ }
      }
      if (payload.error) {
        pending.delete(payload.id);
        item.reject(new Error(payload.error));
      } else if (Object.prototype.hasOwnProperty.call(payload, "result")) {
        pending.delete(payload.id);
        item.resolve(payload.result);
      }
    }
  }

  function ensure() {
    if (child) return Promise.resolve(child);
    if (starting) return starting;
    starting = Promise.resolve().then(() => {
      const node = nodePath || locateNode(env);
      const worker = workerPath || locateChatWorker();
      if (!node) throw new Error("没有找到系统 Node，无法启动模型会话。安装 Node.js 22 或更新版本后再试。");
      if (!worker) throw new Error(`没有找到会话程序。重新安装 ${edition.productName} 后再试。`);
      if (!origin) throw new Error("本机 Agent 还没准备好。");
      const script = plainWindowsPath(worker);
      const configured = currentConfig();
      log.info?.(`[chat] 启动 node=${node} worker=${script} type=${configured.environment} model=${configured.model || "默认"} key=${configured.apiKeySource || "无"}`);
      const proc = spawn(node, [script], {
        stdio: ["pipe", "pipe", "pipe"],
        env: codebuddyProcessEnv(configured, {
          ...env,
          NOVOARD_LOCAL_ORIGIN: origin,
          NOVOARD_SESSION_DIR: sessionDir,
          NOVOARD_AGENT_HOME: agentHome,
        }),
        windowsHide: true,
      });
      child = proc;
      spawnedFingerprint = codebuddyFingerprint(configured);
      proc.stdout.on("data", onData);
      proc.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8").trim();
        if (text) log.info?.(`[chat] ${text}`);
      });
      proc.on("exit", (code) => {
        // 主动重启时 child 已指向新进程（或为空），旧进程的请求在 restart() 里已经处理，这里不能误伤新进程上的请求
        if (child !== proc) return;
        child = null;
        failAll(new Error(code ? `模型会话进程已退出（${code}）` : "模型会话进程已退出"));
      });
      return proc;
    }).finally(() => {
      starting = null;
    });
    return starting;
  }

  function request(op, params = {}, onEvent) {
    const id = seq++;
    return ensure().then((proc) => new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onEvent });
      proc.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    }));
  }

  function restart() {
    const current = child;
    child = null;
    if (current) {
      failAll(new Error("模型会话进程已重启"));
      current.kill();
    }
  }

  /**
   * 新建会话前调用：key 来源或内容、类型、模型和会话进程启动时不同，就重启会话进程。
   * 其他会话还在回复时不重启（进程退出会让它们的请求失败），留到下次新建会话再比对。
   */
  function refreshIfChanged() {
    if (!child) return;
    let configured;
    try {
      configured = currentConfig();
    } catch {
      return;
    }
    if (codebuddyFingerprint(configured) === spawnedFingerprint) return;
    if (pending.size > 0) {
      log.info?.(`[chat] 模型配置已变化（key=${configured.apiKeySource || "无"}），还有 ${pending.size} 个请求进行中，下次新建会话时再重启`);
      return;
    }
    log.info?.(`[chat] 模型配置已变化（key=${configured.apiKeySource || "无"} type=${configured.environment}），重启会话进程`);
    restart();
  }

  return {
    setOrigin,
    list: () => request("list"),
    history: (sessionId) => request("history", { sessionId }),
    create: (title) => {
      refreshIfChanged();
      return request("create", { title });
    },
    remove: (sessionId) => request("delete", { sessionId }),
    interrupt: (sessionId) => request("interrupt", { sessionId }),
    answer: (sessionId, payload = {}) => request("answer", {
      sessionId,
      questionId: payload.questionId,
      answers: payload.answers,
      skip: payload.skip === true,
    }),
    doctor: () => request("doctor"),
    send: (sessionId, text, onEvent) => request("send", { sessionId, text }, onEvent),
    reload() {
      restart();
    },
    close() {
      restart();
      failAll(new Error("会话已关闭"));
    },
  };
}
