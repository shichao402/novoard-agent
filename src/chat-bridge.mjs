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
import { closeOpenTurns, createSessionStore } from "./session-store.mjs";
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
  const { apiKeySource = "", apiKey = "", environment = "", model = "", chatPermission = "" } = configured ?? {};
  return createHash("sha256").update(JSON.stringify([apiKeySource, apiKey, environment, model, chatPermission])).digest("hex");
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
  let restartPending = false;
  const pending = new Map();
  const listeners = new Set();

  function notify(payload) {
    for (const listener of listeners) {
      try { listener(payload); } catch (error) { log.warn?.(`[chat] 订阅回调失败：${error.message}`); }
    }
  }

  /** 有轮次在跑（发送请求还没结束）。 */
  function busy() {
    for (const item of pending.values()) if (item.op === "send") return true;
    return false;
  }

  /** 设置里改了配置但当时有轮次在跑：等手上的请求全部结束再重启（含停止等短请求，不能误伤）。 */
  function settle() {
    if (!restartPending || pending.size > 0) return;
    restartPending = false;
    log.info?.("[chat] 进行中的对话已结束，按新配置重启会话进程");
    restart();
  }

  /**
   * 会话进程没了，它手上没跑完的轮次由这里收尾：写进记录并推给界面，
   * 这样重新打开页面看到的也是「这一轮没有完成」，而不是一直转圈。
   */
  function closeTurnsAfterExit(reason) {
    try {
      const store = createSessionStore(sessionDir);
      for (const item of closeOpenTurns(store, `${reason}，这一轮没有完成。`)) {
        for (const event of item.events) notify({ kind: "message", sessionId: item.sessionId, event });
        notify({ kind: "session", session: item.session });
      }
    } catch (error) {
      log.warn?.(`[chat] 收尾未完成的对话失败：${error.message}`);
    }
  }

  function currentConfig() {
    const panel = readCodebuddyConfig(codebuddyFile);
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
      if (payload.broadcast) {
        notify(payload.broadcast);
        continue;
      }
      const item = pending.get(payload.id);
      if (!item) continue;
      if (payload.event) {
        try { item.onEvent?.(payload.event); } catch { /* 页面已离开，会话仍要继续 */ }
      }
      if (payload.accepted) {
        try { item.onAccepted?.(); } catch { /* 调用方已离开 */ }
      }
      if (payload.error) {
        pending.delete(payload.id);
        const error = new Error(payload.error);
        if (payload.code) error.code = payload.code;
        item.reject(error);
        settle();
      } else if (Object.prototype.hasOwnProperty.call(payload, "result")) {
        pending.delete(payload.id);
        item.resolve(payload.result);
        settle();
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
      log.info?.(`[chat] 启动 node=${node} worker=${script} type=${configured.environment} model=${configured.model || "默认"} key=${configured.apiKeySource || "无"} permission=${configured.chatPermission}`);
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
        const reason = proc.stopReason || (code ? `模型会话进程已退出（${code}）` : "模型会话进程已退出");
        if (child === proc) {
          child = null;
          failAll(new Error(reason));
        }
        // 新进程已经起来的话，它启动时已收尾过旧轮次，这里再收会误伤它正在跑的轮次
        if (!child && !starting) closeTurnsAfterExit(reason);
      });
      return proc;
    }).finally(() => {
      starting = null;
    });
    return starting;
  }

  function request(op, params = {}, onEvent, onAccepted) {
    const id = seq++;
    return ensure().then((proc) => new Promise((resolve, reject) => {
      pending.set(id, { op, resolve, reject, onEvent, onAccepted });
      proc.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    }));
  }

  function restart(reason = "模型会话进程已重启") {
    const current = child;
    child = null;
    if (current) {
      current.stopReason = reason;
      failAll(new Error(reason));
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
    if (busy()) {
      log.info?.(`[chat] 模型配置已变化（key=${configured.apiKeySource || "无"}），还有对话进行中，等它结束再重启`);
      restartPending = true;
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
    approve: (sessionId, payload = {}) => request("approve", {
      sessionId,
      approvalId: payload.approvalId,
      decision: payload.decision,
    }),
    doctor: () => request("doctor"),
    /**
     * 发起一轮。会话已有一轮在跑时被拒（error.code === "busy"），不排队。
     * onAccepted 在会话进程受理（用户消息已写进记录）时调用；返回的 promise 在这一轮结束时完成。
     */
    send: (sessionId, text, onEvent, options = {}) => request(
      "send",
      { sessionId, text, ...(options.peer ? { peer: true } : {}) },
      onEvent,
      options.onAccepted,
    ),
    /** 会话进程推来的记录变化：{ kind: "message", sessionId, event } / { kind: "session", session } / { kind: "session_removed", sessionId }。 */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 设置里保存了模型配置。有对话在跑时不打断，等它结束再重启。 */
    reload() {
      if (busy()) {
        restartPending = true;
        log.info?.("[chat] 模型配置已保存，有对话进行中，等它结束再重启会话进程");
        return { deferred: true };
      }
      restartPending = false;
      restart();
      return { deferred: false };
    },
    close() {
      restart("会话已关闭");
      failAll(new Error("会话已关闭"));
    },
  };
}
