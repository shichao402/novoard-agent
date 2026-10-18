/**
 * 执行内核（契约 §1.2 steps 语法）：
 * 四种 step：script（shell）/ openApp / openPath / template（装载期已展开，运行期只剩前三类）。
 * 插值 {{var}}：触发时 vars > target vars > 模板默认值；无来源即失败（不静默空串）。
 * 任一步失败即 target 失败（终态 failed，携带失败步骤号与 stderr 摘要）。
 * cancel：SIGTERM → 3s 后 SIGKILL；Unix 回收独立进程组，Windows 用 taskkill /T 回收进程树。
 */
import { spawn } from "node:child_process";

const VAR_RE = /\{\{(\w+)\}\}/g;

export function createRunner({ vars: targetVars = {}, steps, cwd = process.cwd(), timeoutMs = 0, onOutput = () => {}, onProgress = () => {}, onStepStart = () => {}, onStepEnd = () => {} } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("steps 必须是非空数组");
  }
  let currentChild = null;
  let canceled = false;
  let timedOut = false;
  let forceKillTimer = null;

  async function run(triggerVars = {}) {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        onOutput("status", `运行超过 ${timeoutMs}ms，正在停止`);
        cancel();
      }, timeoutMs)
      : null;
    timer?.unref?.();
    try {
      const resolved = { ...targetVars, ...triggerVars };
      for (let i = 0; i < steps.length; i++) {
        if (timedOut) return { ok: false, step: i + 1, state: "failed", stderr: "运行超时" };
        if (canceled) return { ok: false, step: i + 1, state: "canceled", stderr: "canceled before step" };
        const result = await runStep(steps[i], resolved, i);
        onProgress?.(i + 1, steps.length, describeStep(steps[i], i));
        if (timedOut) return { ok: false, step: i + 1, state: "failed", stderr: "运行超时" };
        if (!result.ok) return { ok: false, step: i + 1, state: result.state ?? "failed", stderr: result.stderr };
      }
      return { ok: true, step: steps.length, state: "completed" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function runStep(step, vars, index) {
    if (typeof step.script === "string") {
      return execScript(interp(step.script, vars), {
        cwd: step.cwd ? interp(step.cwd, vars) : cwd,
        env: step.env ? mapEnv(step.env, vars) : undefined,
        index,
      });
    }
    if (typeof step.openApp === "string") return execScript(openCmd(step.openApp, vars), { index });
    if (typeof step.openPath === "string") return execScript(openCmd(step.openPath, vars), { index });
    return Promise.resolve({ ok: false, stderr: `未知 step 类型：${JSON.stringify(Object.keys(step))}` });
  }

  function execScript(cmd, { cwd: workDir, env, index }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
      const flag = process.platform === "win32" ? "/c" : "-c";
      onOutput("status", `[step ${index + 1}] ${cmd}`);
      try {
        onStepStart({ index: index + 1, command: cmd });
      } catch (error) {
        finish({ ok: false, stderr: `运行记录写入失败：${error.message}` });
        return;
      }
      const child = spawn(shell, [flag, cmd], {
        cwd: workDir,
        env: env ? { ...process.env, ...env } : process.env,
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout = tail(stdout, text);
        onOutput("stdout", text);
      });
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderr = tail(stderr, text);
        onOutput("stderr", text);
      });
      child.on("error", (error) => {
        try { onStepEnd({ index: index + 1, exit: 1 }); } catch { /* 记录失败不挡住终态 */ }
        finish({ ok: false, stderr: `spawn 失败：${error.message}` });
      });
      child.on("close", (code) => {
        try { onStepEnd({ index: index + 1, exit: code ?? 1 }); } catch { /* 记录失败不挡住终态 */ }
        if (currentChild === child) currentChild = null;
        if (timedOut) finish({ ok: false, state: "failed", stderr: "运行超时" });
        else if (code === 0) finish({ ok: true, stdout, stderr });
        else if (canceled) finish({ ok: false, state: "canceled", stderr: stderr || "canceled" });
        else finish({ ok: false, stderr: stderr || `exit ${code}` });
      });
      currentChild = child;
    });
  }

  function describeStep(step, index) {
    const head = typeof step.script === "string" ? step.script : typeof step.openApp === "string" ? `openApp ${step.openApp}` : `openPath ${step.openPath ?? ""}`;
    return `step ${index + 1}/${steps.length}: ${head.slice(0, 60)}`;
  }

  /** openApp/openPath 平台化：win32 用 start，darwin 用 open，linux 用 xdg-open。 */
  function openCmd(target, vars) {
    const value = JSON.stringify(interp(target, vars));
    if (process.platform === "win32") return `start "" ${value}`;
    if (process.platform === "linux") return `xdg-open ${value}`;
    return `open ${value}`;
  }

  /** 插值：无来源抛错（契约 §1.2），失败归入 target failed。 */
  function interp(str, vars) {
    return String(str).replace(VAR_RE, (_, key) => {
      if (!(key in vars)) throw new Error(`插值 {{${key}}} 无来源（契约 §1.2：不静默替换空串）`);
      return String(vars[key]);
    });
  }

  function mapEnv(env, vars) {
    const out = {};
    for (const [k, v] of Object.entries(env)) out[k] = interp(v, vars);
    return out;
  }

  /** 取消：终态 canceled，杀当前子进程。 */
  function cancel() {
    canceled = true;
    if (currentChild?.pid) {
      const pid = currentChild.pid;
      terminateTree(pid, false);
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          terminateTree(pid, true);
          forceKillTimer = null;
        }, 3000);
        forceKillTimer.unref?.();
      }
    }
  }

  return { run, cancel };
}

function tail(current, chunk, max = 4096) {
  const next = current + chunk;
  return next.length > max ? next.slice(-max) : next;
}

/** 跨平台终止脚本进程树：Unix 杀进程组，Windows 使用 taskkill /T。 */
function terminateTree(pid, force) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const child = spawn("taskkill", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref?.();
    } catch {}
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
  }
}
