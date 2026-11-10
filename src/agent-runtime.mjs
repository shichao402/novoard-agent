/**
 * lite-agent 执行协调层：task 生命周期（working → 终态）。
 * 并发按每个快捷方式自己的 concurrency 限制，默认 1，不能重叠。
 * 单次运行按 timeout 到点停止，缺省 10 分钟。
 * 路径锁（PRD-7 A3）：工具标了 requiresExclusiveWorkspace 的 uses step 按 cwd 加锁，拿不到就排队，四种触发来源共用一个队列。
 * 硬截止（契约 v2.4 deadline）：定时触发带 deadlineAt，到点等同取消，终态 failed。
 * 主日志只记开始、结束和拒绝，并带上快捷方式内部日志的相对路径。
 */
import { createRunner } from "./runner.mjs";
import { parseDuration } from "./duration.mjs";
import { createShortcutRun } from "./shortcut-log.mjs";
import { openRunTrace } from "./run-trace.mjs";
import { createPathLocks, normalizePathKey } from "./path-locks.mjs";

const DEFAULT_TIMEOUT = "10m";
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;
const VAR_RE = /\{\{(\w+)\}\}/g;

export function createAgentRuntime({ targets, log = console, shortcutLogDir, runTraceDir, bootId = "", concurrency = MAX_CONCURRENCY, onActivity, scriptEnv = null, packs = null, packInstaller = null, pathLocks = createPathLocks(), now = () => Date.now() } = {}) {
  /** taskId → { state, runner?, queued?, ctx?, pending? } */
  const running = new Map();
  const executions = new Set();
  const activeByTarget = new Map();
  let activeCount = 0;
  let stopping = false;
  let currentTargets = targets;
  let lastActivityKey = "0/0";

  /** 在途统计：working（含排队）计 running，审批挂起计 pendingApproval。桌面壳据此决定能否重启安装更新。 */
  function activity() {
    let runningCount = 0;
    let pendingApproval = 0;
    for (const entry of running.values()) {
      if (entry.state === "input-required") pendingApproval += 1;
      else runningCount += 1;
    }
    return { running: runningCount, pendingApproval };
  }

  /** running 表每次变化后调用；只在计数变化时回调，避免刷屏。 */
  function notifyActivity() {
    if (typeof onActivity !== "function") return;
    const current = activity();
    const key = `${current.running}/${current.pendingApproval}`;
    if (key === lastActivityKey) return;
    lastActivityKey = key;
    try { onActivity(current); } catch { /* 上报失败不影响任务执行 */ }
  }

  /** 热替换 targets（editor 保存路径）：新触发立即用新定义；在途/审批挂起任务沿用旧定义继续跑。 */
  function replaceTargets(next) {
    currentTargets = next;
    return Object.keys(currentTargets ?? {});
  }

  /**
   * input：{ taskId, skillId, vars, steps, onTerminal, onProgress, onTrace,
   *          trigger?: schedule|catch-up|manual|hub|peer, deadlineAt?: epoch ms, deadlineLabel?: "HH:mm" }
   */
  function launch(input) {
    const { taskId, skillId, onTerminal } = input;
    if (stopping) return { ok: false, retryable: true, reason: "agent-stopping" };
    const targetDef = currentTargets?.[skillId];
    if (!targetDef) return { ok: false, reason: `unknown target: ${skillId}` };
    if (running.has(taskId)) return { ok: true, reason: "duplicate-taskId" };

    if (targetDef.requiresApproval === true) {
      // M4 F3：挂起而非终态——hub 侧 task 停在 input-required，恢复帧到达后 startExecution
      running.set(taskId, { state: "input-required", pending: input });
      notifyActivity();
      onTerminal?.("input-required", `target ${skillId} requiresApproval=true，等待审批（hub 审批门）`);
      return { ok: true, reason: "input-required" };
    }

    return startExecution(input);
  }

  function startExecution(input) {
    const { taskId, skillId, vars, steps, onTerminal, onProgress, onTrace, trigger = "manual", deadlineAt, deadlineLabel } = input;
    if (stopping) return { ok: false, retryable: true, reason: "agent-stopping" };
    const targetDef = currentTargets?.[skillId];
    const limit = targetLimit(targetDef);
    const active = activeByTarget.get(skillId) ?? 0;
    if (active >= limit) {
      log.info?.(`[shortcut] 拒绝 target=${skillId} task=${taskId} 并发已满（${active}/${limit}）`);
      return { ok: false, retryable: true, reason: `并发已满（${active}/${limit}）` };
    }
    if (activeCount >= concurrency) {
      log.info?.(`[shortcut] 拒绝 target=${skillId} task=${taskId} 本机同时运行已达 ${concurrency}`);
      return { ok: false, retryable: true, reason: `本机同时运行的快捷方式已达 ${concurrency}` };
    }

    activeByTarget.set(skillId, active + 1);
    activeCount += 1;
    const ctx = {
      skillId,
      taskId,
      startedAt: now(),
      runLog: openRunLog(skillId, taskId),
      trace: openTrace(taskId),
      onTrace,
      onTerminal,
      lock: null,
      deadlineTimer: null,
      runner: null,
    };
    const timeoutMs = parseDuration(targetDef?.timeout, parseDuration(DEFAULT_TIMEOUT, 600_000));
    log.info?.(`[shortcut] 开始 target=${skillId} task=${taskId}${ctx.runLog ? ` log=${ctx.runLog.relative}` : ""} trigger=${trigger}`);
    ctx.runLog?.info(`开始 ${skillId}，触发来源 ${trigger}，超时 ${targetDef?.timeout || DEFAULT_TIMEOUT}，并发上限 ${limit}`);
    if (ctx.trace && ctx.trace.seq === 0) {
      emitTrace(ctx, {
        type: "run/start",
        target: skillId,
        bootId,
        trigger,
        timeout: targetDef?.timeout || DEFAULT_TIMEOUT,
      });
    }

    const total = Array.isArray(steps) ? steps.length : 0;
    if (Number.isFinite(deadlineAt)) {
      const reason = `已到运行窗口硬截止 ${deadlineLabel ?? new Date(deadlineAt).toISOString()}`;
      ctx.runLog?.info(`本次运行硬截止 ${deadlineLabel ?? new Date(deadlineAt).toISOString()}`);
      ctx.deadlineTimer = setTimeout(() => {
        ctx.deadlineTimer = null;
        ctx.runLog?.error(reason);
        const entry = running.get(taskId);
        if (entry?.queued) {
          finish(ctx, "failed", reason);
        } else if (ctx.runner) {
          ctx.runner.stop(reason);
        }
      }, Math.max(0, deadlineAt - now()));
      ctx.deadlineTimer.unref?.();
    }

    // 用户在场时的自动补装（PRD-7 A5）：只有手动/控制台触发（trigger=manual）才装；定时、补跑、hub、对等一律不装
    if (trigger === "manual" && packInstaller?.needsInstall?.(steps)) {
      running.set(taskId, { state: "working", queued: true, lock: null, ctx, skillId });
      notifyActivity();
      const installing = packInstaller
        .ensureFor(steps, {
          onProgress: (message) => {
            ctx.runLog?.info(message);
            try { onProgress?.(0, total, message); } catch {}
          },
        })
        .catch((error) => ({ ok: false, reason: error?.message ?? String(error) }))
        .then((r) => {
          if (finished.has(taskId)) return;
          if (!r.ok) {
            finish(ctx, "failed", r.reason);
            return;
          }
          if (stopping) {
            finish(ctx, "canceled", "agent-stopping");
            return;
          }
          lockThenBegin(ctx, input, timeoutMs, total);
        })
        .finally(() => executions.delete(installing));
      executions.add(installing);
      return { ok: true, reason: "installing-packs", log: ctx.runLog?.relative ?? null };
    }
    return lockThenBegin(ctx, input, timeoutMs, total);
  }

  function lockThenBegin(ctx, input, timeoutMs, total) {
    const { taskId, skillId, vars, steps, onProgress } = input;
    const keys = lockKeysFor(steps, { ...targetVarsOf(skillId), ...(vars ?? {}) });
    const lock = pathLocks.acquire(keys);
    ctx.lock = lock;
    if (!lock.immediate) {
      const waitText = `排队中：等待 ${lock.blockedBy.join("、")} 释放`;
      running.set(taskId, { state: "working", queued: true, lock, ctx, skillId });
      notifyActivity();
      ctx.runLog?.info(waitText);
      log.info?.(`[shortcut] 排队 target=${skillId} task=${taskId} ${waitText}`);
      try { onProgress?.(0, total, waitText); } catch {}
      lock.ready.then(() => {
        const entry = running.get(taskId);
        if (!entry?.queued || finished.has(taskId)) {
          lock.release();
          return;
        }
        ctx.runLog?.info("已拿到路径锁，开始执行");
        begin(ctx, input, timeoutMs);
      });
      return { ok: true, reason: "queued", log: ctx.runLog?.relative ?? null };
    }
    begin(ctx, input, timeoutMs);
    return { ok: true, reason: "working", log: ctx.runLog?.relative ?? null };
  }

  function begin(ctx, input, timeoutMs) {
    const { taskId, skillId, vars, steps, onProgress } = input;
    if (stopping) {
      finish(ctx, "canceled", "agent-stopping");
      return;
    }
    let runner;
    try {
      runner = createRunner({
        vars: targetVarsOf(skillId),
        steps,
        timeoutMs,
        baseEnv: scriptEnv,
        packs,
        onOutput: (stream, text) => ctx.runLog?.output(stream, text),
        onProgress: (i, n) => onProgress?.(i, n, `第 ${i}/${n} 步`),
        onDetail: (i, message) => {
          ctx.runLog?.info(`进度 第 ${i} 步：${message}`);
          onProgress?.(i, steps.length, `第 ${i}/${steps.length} 步：${message}`);
        },
        onStepStart: ({ index, command }) => {
          emitTrace(ctx, { type: "step/start", index, command, target: skillId });
        },
        onStepEnd: ({ index, exit }) => {
          emitTrace(ctx, { type: "step/end", index, exit, target: skillId });
        },
      });
    } catch (error) {
      running.delete(taskId);
      finish(ctx, "failed", error?.message ?? error);
      return;
    }
    ctx.runner = runner;
    running.set(taskId, { state: "working", runner, skillId, ctx });
    notifyActivity();
    const execution = runner
      .run(vars)
      .then((result) => finish(ctx, result.state ?? (result.ok ? "completed" : "failed"), result.stderr))
      .catch((error) => finish(ctx, "failed", error?.message ?? error))
      .finally(() => executions.delete(execution));
    executions.add(execution);
  }

  const finished = new Set();
  function finish(ctx, state, detail) {
    const { skillId, taskId, startedAt, runLog, onTerminal } = ctx;
    if (finished.has(taskId)) return;
    finished.add(taskId);
    if (ctx.deadlineTimer) clearTimeout(ctx.deadlineTimer);
    ctx.deadlineTimer = null;
    releaseLock(ctx);
    activeByTarget.set(skillId, Math.max(0, (activeByTarget.get(skillId) ?? 1) - 1));
    activeCount = Math.max(0, activeCount - 1);
    running.delete(taskId);
    notifyActivity();
    const elapsed = now() - startedAt;
    const text = String(detail ?? "");
    if (state === "failed" && text.includes("运行超时")) runLog?.error("运行超时");
    if (state === "failed" && text && !text.includes("运行超时")) runLog?.error(text);
    runLog?.info(`结束 state=${state} elapsed=${elapsed}ms`);
    emitTrace(ctx, { type: "run/end", state, target: skillId });
    log.info?.(`[shortcut] 结束 target=${skillId} task=${taskId} state=${state} elapsed=${elapsed}ms${runLog ? ` log=${runLog.relative}` : ""}`);
    const summary = state === "failed" && text.includes("运行超时")
      ? "运行超时"
      : state === "failed" && text.includes("硬截止")
        ? text
        : state === "failed" ? "失败" : "";
    try { onTerminal?.(state, summary); } catch { /* 状态回调不能把并发计数弄乱 */ }
  }

  function releaseLock(ctx) {
    ctx.lock?.release();
  }

  /** 收集需要独占工作区的 uses step 的 cwd（插值失败的交给 runner 报错，这里不加锁）。 */
  function lockKeysFor(steps, vars) {
    if (!packs || !Array.isArray(steps)) return [];
    const keys = [];
    for (const step of steps) {
      if (typeof step?.uses !== "string" || typeof step.cwd !== "string") continue;
      const slash = step.uses.indexOf("/");
      if (slash <= 0) continue;
      const tool = packs.lookupTool?.(step.uses.slice(0, slash), step.uses.slice(slash + 1));
      if (!tool?.requiresExclusiveWorkspace) continue;
      let cwd;
      try {
        cwd = step.cwd.replace(VAR_RE, (_, key) => {
          if (!(key in vars)) throw new Error(key);
          return String(vars[key]);
        });
      } catch {
        continue;
      }
      keys.push(normalizePathKey(cwd));
    }
    return keys;
  }

  function openTrace(taskId) {
    try {
      return openRunTrace({ root: runTraceDir, taskId });
    } catch (error) {
      log.warn?.(`[run-trace] 无法写运行记录 task=${taskId} ${error.message}`);
      return null;
    }
  }

  function emitTrace(ctx, partial) {
    if (!ctx.trace) return;
    const event = ctx.trace.append(partial);
    try { ctx.onTrace?.(event); } catch { /* 上行失败不挡住已经落盘的记录 */ }
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
    notifyActivity();
    return { ok: true, reason: "resumed" };
  }

  /** 取消：杀 runner 子进程；排队中的出锁队列并收成 canceled；审批中的直接出队，终态由 hub 侧判（canceled）。 */
  function cancel(taskId) {
    const entry = running.get(taskId);
    if (!entry) return { ok: false, reason: "not-running" };
    if (entry.queued) {
      finish(entry.ctx, "canceled", "排队中取消");
      return { ok: true, reason: "dequeued" };
    }
    if (entry.state === "working") {
      entry.runner.cancel();
      running.delete(taskId);
      notifyActivity();
      return { ok: true, reason: "cancel-signal-sent" };
    }
    running.delete(taskId);
    notifyActivity();
    return { ok: true, reason: "dequeued" };
  }

  /**
   * 统一停机：拒绝新任务，清掉排队/审批任务，取消运行中子进程并等待回收。
   * timeout 只是 sidecar 内部上限；桌面壳仍会在协议超时后做进程级强杀兜底。
   */
  async function shutdown({ timeoutMs = 4_000 } = {}) {
    if (stopping && executions.size === 0) return { ok: true, remaining: 0 };
    stopping = true;
    for (const [taskId, entry] of [...running]) {
      if (entry.queued) {
        finish(entry.ctx, "canceled", "agent-stopping");
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
    activity,
    get stopping() {
      return stopping;
    },
    get runningTasks() {
      return [...running.entries()].map(([id, e]) => ({ id, state: e.state, ...(e.queued ? { queued: true } : {}) }));
    },
  };
}
