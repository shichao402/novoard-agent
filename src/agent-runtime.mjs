/**
 * lite-agent 执行协调层：task 生命周期（working → 终态）+ 并发控制（单并发，试点纪律）+ agent 侧本地审计。
 * hub 委派 → launch：查本地 targets（装载期已展开模板）→ runner.run → 终态回调上行。
 * requiresApproval: true → 挂起（input-required，M4 审批门全链路），等 hub 恢复帧（message/resume）继续执行；
 *   拒绝走 tasks/cancel（挂起任务可取消，agent 侧直接出队）。
 * 插值失败（{{var}} 无来源）→ failed，不静默空串（契约 §1.2）。
 */
import { createRunner } from "./runner.mjs";

export function createAgentRuntime({ targets, log = console, concurrency = 1 } = {}) {
  /** taskId → { state, runner?, waitTimer?, pending? } */
  const running = new Map();
  /** 已启动的执行 Promise；停机时等待 runner 完成回收。 */
  const executions = new Set();
  let activeCount = 0;
  let stopping = false;
  /** 当前 targets 注册表（可热替换：editor 保存后 replaceTargets，在途任务不受影响） */
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
    if (activeCount >= concurrency) {
      // 排队：等并发位空出（单并发试点纪律）
      const waitTimer = setInterval(() => {
        if (stopping) {
          clearInterval(waitTimer);
          running.delete(taskId);
          return;
        }
        if (activeCount < concurrency) {
          clearInterval(waitTimer);
          running.delete(taskId);
          startExecution({ taskId, skillId, vars, steps, onTerminal, onProgress });
        }
      }, 500);
      waitTimer.unref?.();
      running.set(taskId, { state: "queued", waitTimer });
      return { ok: true, reason: "queued" };
    }

    activeCount++;
    const runner = createRunner({ vars: targetVarsOf(skillId), steps, log, onProgress: (i, n, d) => {
      log.info?.(`[${taskId}] ${d}`);
      onProgress?.(i, n, d);
    } });
    running.set(taskId, { state: "working", runner });
    const execution = runner
      .run(vars)
      .then((result) => {
        activeCount--;
        running.delete(taskId);
        const state = result.state ?? (result.ok ? "completed" : "failed");
        onTerminal?.(state, result.stderr ? `step ${result.step} 失败：${String(result.stderr).slice(0, 200)}` : "");
      })
      .catch((error) => {
        activeCount--;
        running.delete(taskId);
        onTerminal?.("failed", String(error?.message ?? error).slice(0, 200));
      })
      .finally(() => {
        executions.delete(execution);
      });
    executions.add(execution);
    return { ok: true, reason: "working" };
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
