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
  let activeCount = 0;

  function launch({ taskId, skillId, vars, steps, onTerminal, onProgress }) {
    const targetDef = targets?.[skillId];
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
    if (activeCount >= concurrency) {
      // 排队：等并发位空出（单并发试点纪律）
      const waitTimer = setInterval(() => {
        if (activeCount < concurrency) {
          clearInterval(waitTimer);
          running.delete(taskId);
          startExecution({ taskId, skillId, vars, steps, onTerminal, onProgress });
        }
      }, 500);
      running.set(taskId, { state: "queued", waitTimer });
      return { ok: true, reason: "queued" };
    }

    activeCount++;
    const runner = createRunner({ vars: targetVarsOf(skillId), steps, log, onProgress: (i, n, d) => {
      log.info?.(`[${taskId}] ${d}`);
      onProgress?.(i, n, d);
    } });
    running.set(taskId, { state: "working", runner });
    runner
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
      });
    return { ok: true, reason: "working" };
  }

  function targetVarsOf(skillId) {
    return targets?.[skillId]?.vars ?? {};
  }

  /** 审批恢复（M4 F3）：input-required → working，继续执行（hub message/resume 到达后调）。 */
  function resume(taskId) {
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

  return {
    launch,
    resume,
    cancel,
    get runningTasks() {
      return [...running.entries()].map(([id, e]) => ({ id, state: e.state }));
    },
  };
}
