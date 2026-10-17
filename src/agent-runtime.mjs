/**
 * lite-agent 执行协调层：task 生命周期（working → 终态）。
 * 并发按每个快捷方式自己的 concurrency 限制，默认 1，不能重叠。
 * 单次运行按 timeout 到点停止，缺省 10 分钟。
 * 主日志只记开始、结束和拒绝，并带上快捷方式内部日志的相对路径。
 */
import { createRunner } from "./runner.mjs";
import { parseDuration } from "./duration.mjs";
import { createShortcutRun } from "./shortcut-log.mjs";

const DEFAULT_TIMEOUT = "10m";
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;

export function createAgentRuntime({ targets, log = console, shortcutLogDir, concurrency = MAX_CONCURRENCY } = {}) {
  /** taskId → { state, runner?, waitTimer?, pending? } */
  const running = new Map();
  const executions = new Set();
  const activeByTarget = new Map();
  let activeCount = 0;
  let stopping = false;
  let currentTargets = targets;

  /** 热替换 targets（editor 保存路径）：新触发立即用新定义；在途/审批挂起任务沿用旧定义继续跑。 */
  function replaceTargets(next) {
    currentTargets = next;
    return Object.keys(currentTargets ?? {});
  }

  function launch({ taskId, skillId, vars, steps, onTerminal, onProgress }) {
    if (stopping) return { ok: false, reason: "agent-stopping" };
    const targetDef = currentTargets?.[skillId];
    if (!targetDef) return { ok: false, reason: `unknown target: ${skillId}` };
    if (running.has(taskId)) return { ok: true, reason: "duplicate-taskId" };

    if (targetDef.requiresApproval === true) {
      // M4 F3：挂起而非终态——hub 侧 task 停在 input-required，恢复帧到达后 startExecution
      running.set(taskId, { state: "input-required", pending: { skillId, vars, steps, onTerminal, onProgress } });
      onTerminal?.("input-required", `target ${skillId} requiresApproval=true，等待审批（hub 审批门）`);
      return { ok: true, reason: "input-required" };
    }

    return startExecution({ taskId, skillId, vars, steps, onTerminal, onProgress });
  }

  function startExecution({ taskId, skillId, vars, steps, onTerminal, onProgress }) {
    if (stopping) return { ok: false, reason: "agent-stopping" };
    const targetDef = currentTargets?.[skillId];
    const limit = targetLimit(targetDef);
    const active = activeByTarget.get(skillId) ?? 0;
    if (active >= limit) {
      log.info?.(`[shortcut] 拒绝 target=${skillId} task=${taskId} 并发已满（${active}/${limit}）`);
      return { ok: false, reason: `并发已满（${active}/${limit}）` };
    }
    if (activeCount >= concurrency) {
      log.info?.(`[shortcut] 拒绝 target=${skillId} task=${taskId} 本机同时运行已达 ${concurrency}`);
      return { ok: false, reason: `本机同时运行的快捷方式已达 ${concurrency}` };
    }

    activeByTarget.set(skillId, active + 1);
    activeCount += 1;
    const startedAt = Date.now();
    const runLog = openRunLog(skillId, taskId);
    const timeoutMs = parseDuration(targetDef?.timeout, parseDuration(DEFAULT_TIMEOUT, 600_000));
    log.info?.(`[shortcut] 开始 target=${skillId} task=${taskId}${runLog ? ` log=${runLog.relative}` : ""}`);
    runLog?.info(`开始 ${skillId}，超时 ${targetDef?.timeout || DEFAULT_TIMEOUT}，并发上限 ${limit}`);
    let runner;
    try {
      runner = createRunner({
        vars: targetVarsOf(skillId),
        steps,
        timeoutMs,
        onOutput: (stream, text) => runLog?.output(stream, text),
        onProgress: (i, n) => onProgress?.(i, n, `第 ${i}/${n} 步`),
      });
    } catch (error) {
      finish(skillId, taskId, startedAt, runLog, "failed", error?.message ?? error, onTerminal);
      return { ok: false, reason: error?.message ?? String(error) };
    }
    running.set(taskId, { state: "working", runner, skillId });
    const execution = runner
      .run(vars)
      .then((result) => finish(skillId, taskId, startedAt, runLog, result.state ?? (result.ok ? "completed" : "failed"), result.stderr, onTerminal))
      .catch((error) => finish(skillId, taskId, startedAt, runLog, "failed", error?.message ?? error, onTerminal))
      .finally(() => executions.delete(execution));
    executions.add(execution);
    return { ok: true, reason: "working", log: runLog?.relative ?? null };
  }

  const finished = new Set();
  function finish(skillId, taskId, startedAt, runLog, state, detail, onTerminal) {
    if (finished.has(taskId)) return;
    finished.add(taskId);
    activeByTarget.set(skillId, Math.max(0, (activeByTarget.get(skillId) ?? 1) - 1));
    activeCount = Math.max(0, activeCount - 1);
    running.delete(taskId);
    const elapsed = Date.now() - startedAt;
    if (detail && state === "failed" && String(detail).includes("运行超时")) runLog?.error("运行超时");
    runLog?.info(`结束 state=${state} elapsed=${elapsed}ms`);
    log.info?.(`[shortcut] 结束 target=${skillId} task=${taskId} state=${state} elapsed=${elapsed}ms${runLog ? ` log=${runLog.relative}` : ""}`);
    const summary = state === "failed" && String(detail ?? "").includes("运行超时") ? "运行超时" : state === "failed" ? "失败" : "";
    try { onTerminal?.(state, summary); } catch { /* 状态回调不能把并发计数弄乱 */ }
  }

  function openRunLog(skillId, taskId) {
    try {
      return createShortcutRun({ root: shortcutLogDir, targetId: skillId, taskId });
    } catch (error) {
      log.warn?.(`[shortcut] 无法写内部日志 target=${skillId} task=${taskId} ${error.message}`);
      return null;
    }
  }

  function targetLimit(targetDef) {
    const value = Number(targetDef?.concurrency);
    if (!Number.isInteger(value) || value < 1) return DEFAULT_CONCURRENCY;
    return Math.min(value, MAX_CONCURRENCY);
  }

  function targetVarsOf(skillId) {
    return currentTargets?.[skillId]?.vars ?? {};
  }

  /** 审批恢复（M4 F3）：input-required → working，继续执行（hub message/resume 到达后调）。 */
  function resume(taskId) {
    if (stopping) return { ok: false, reason: "agent-stopping" };
    const entry = running.get(taskId);
    if (!entry || entry.state !== "input-required" || !entry.pending) return { ok: false, reason: "not-suspended" };
    running.delete(taskId);
    startExecution(entry.pending);
    return { ok: true, reason: "resumed" };
  }

  /** 取消：杀 runner 子进程；排队/审批中的直接出队，终态由 hub 侧判（canceled）。 */
  function cancel(taskId) {
    const entry = running.get(taskId);
    if (!entry) return { ok: false, reason: "not-running" };
    if (entry.waitTimer) clearInterval(entry.waitTimer);
    if (entry.state === "working") {
      entry.runner.cancel();
      running.delete(taskId);
      return { ok: true, reason: "cancel-signal-sent" };
    }
    running.delete(taskId);
    return { ok: true, reason: "dequeued" };
  }

  /**
   * 统一停机：拒绝新任务，清掉排队/审批任务，取消运行中子进程并等待回收。
   * timeout 只是 sidecar 内部上限；桌面壳仍会在协议超时后做进程级强杀兜底。
   */
  async function shutdown({ timeoutMs = 4_000 } = {}) {
    if (stopping && executions.size === 0) return { ok: true, remaining: 0 };
    stopping = true;
    for (const [taskId, entry] of running) {
      if (entry.waitTimer) {
        clearInterval(entry.waitTimer);
        running.delete(taskId);
        continue;
      }
      if (entry.state === "working") {
        entry.runner?.cancel();
        continue;
      }
      running.delete(taskId);
    }

    if (executions.size > 0) {
      let timer;
      await Promise.race([
        Promise.allSettled([...executions]),
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
      clearTimeout(timer);
    }
    return { ok: executions.size === 0, remaining: executions.size };
  }

  return {
    launch,
    resume,
    cancel,
    shutdown,
    replaceTargets,
    get stopping() {
      return stopping;
    },
    get runningTasks() {
      return [...running.entries()].map(([id, e]) => ({ id, state: e.state }));
    },
  };
}
