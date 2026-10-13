/**
 * lite-agent 执行协调层：task 生命周期（working → 终态）+ 并发控制（单并发，试点纪律）+ agent 侧本地审计。
 * hub 委派 → launch：查本地 targets（装载期已展开模板）→ runner.run → 终态回调上行。
 * requiresApproval: true → 不执行，回 input-required，等恢复指令（试点期 hub 侧未通恢复链，回执里说明）。
 * 插值失败（{{var}} 无来源）→ failed，不静默空串（契约 §1.2）。
 */
import { createRunner } from "./runner.mjs";

export function createAgentRuntime({ targets, log = console, concurrency = 1 } = {}) {
  /** taskId → { state, runner?, waitTimer? } */
  const running = new Map();
  let activeCount = 0;

  function launch({ taskId, skillId, vars, steps, onTerminal }) {
    const targetDef = targets?.[skillId];
    if (!targetDef) return { ok: false, reason: `unknown target: ${skillId}` };
    if (running.has(taskId)) return { ok: true, reason: "duplicate-taskId" };

    if (targetDef.requiresApproval === true) {
      running.set(taskId, { state: "input-required" });
      onTerminal?.("input-required", `target ${skillId} requiresApproval=true，等待审批（试点期语义）`);
      return { ok: true, reason: "input-required" };
    }

    if (activeCount >= concurrency) {
      // 排队：等并发位空出（单并发试点纪律）
      running.set(taskId, { state: "queued" });
      const waitTimer = setInterval(() => {
        if (activeCount < concurrency) {
          clearInterval(waitTimer);
          running.delete(taskId);
          launch({ taskId, skillId, vars, steps, onTerminal });
        }
      }, 500);
      running.set(taskId, { state: "queued", waitTimer });
      return { ok: true, reason: "queued" };
    }

    activeCount++;
    const runner = createRunner({ vars: targetDef.vars, steps, log, onProgress: (i, n, d) => log.info?.(`[${taskId}] ${d}`) });
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
    cancel,
    get runningTasks() {
      return [...running.entries()].map(([id, e]) => ({ id, state: e.state }));
    },
  };
}
