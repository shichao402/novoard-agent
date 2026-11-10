/**
 * 执行内核（契约 §1.2 steps 语法）：
 * 五种 step：script（shell）/ openApp / openPath / uses（能力包，契约 v2.4）/ template（装载期已展开）。
 * 插值 {{var}}：触发时 vars > target vars > 模板默认值；无来源即失败（不静默空串）。
 * 任一步失败即 target 失败（终态 failed，携带失败步骤号与 stderr 摘要）。
 * cancel：SIGTERM → 3s 后 SIGKILL；Unix 回收独立进程组，Windows 用 taskkill /T 回收进程树。
 * stop(reason)：同 cancel，但终态记 failed 并带原因（超时、运行窗口硬截止）。
 * uses step（ADR-0019）：进程外调用能力包；stdout 中 {"type":"progress"} 行转为进度；
 *   retry/retryInterval 只对 idempotent !== false 的工具生效。
 */
import { spawn } from "node:child_process";
import { constants as osConstants, setPriority } from "node:os";
import { parseDuration } from "./duration.mjs";
import { parseProgressLine, prepareInvocation, readResult, EXIT } from "./packs/invoke.mjs";

const VAR_RE = /\{\{(\w+)\}\}/g;
const DEFAULT_RETRY_INTERVAL_MS = 3_000;

/**
 * script step 的 shell 调用。Windows 与 Node 的 shell:true 一致：
 * cmd /d /s /c "<命令>" 并关掉参数转义。否则 Node 会把命令里的引号写成 \"，
 * cmd 不认，`start "" "带空格的路径"` 会被拆坏并挂住整个 step。
 */
export function shellInvocation(cmd, platform = process.platform, comspec = process.env.ComSpec) {
  if (platform === "win32") {
    return { file: comspec || "cmd.exe", args: ["/d", "/s", "/c", `"${cmd}"`], verbatim: true };
  }
  return { file: "/bin/sh", args: ["-c", cmd], verbatim: false };
}

/** openApp/openPath 平台化：win32 用 start，darwin 用 open，linux 用 xdg-open。 */
export function openCommand(value, platform = process.platform) {
  // Windows 路径不会含引号，直接包一层；JSON.stringify 会把反斜杠加倍
  if (platform === "win32") return `start "" "${value}"`;
  const quoted = JSON.stringify(value);
  if (platform === "linux") return `xdg-open ${quoted}`;
  return `open ${quoted}`;
}

export function createRunner({
  vars: targetVars = {},
  steps,
  cwd = process.cwd(),
  timeoutMs = 0,
  baseEnv = null,
  packs = null,
  dryRun = false,
  onOutput = () => {},
  onProgress = () => {},
  onDetail = () => {},
  onStepStart = () => {},
  onStepEnd = () => {},
} = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("steps 必须是非空数组");
  }
  let currentChild = null;
  let canceled = false;
  let failReason = null;
  let forceKillTimer = null;
  let wakeSleep = null;

  async function run(triggerVars = {}) {
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        onOutput("status", `运行超过 ${timeoutMs}ms，正在停止`);
        stop("运行超时");
      }, timeoutMs)
      : null;
    timer?.unref?.();
    try {
      const resolved = { ...targetVars, ...triggerVars };
      for (let i = 0; i < steps.length; i++) {
        if (failReason) return { ok: false, step: i + 1, state: "failed", stderr: failReason };
        if (canceled) return { ok: false, step: i + 1, state: "canceled", stderr: "canceled before step" };
        let result;
        try {
          result = await runStep(steps[i], resolved, i);
        } catch (error) {
          result = { ok: false, stderr: error?.message ?? String(error) };
        }
        onProgress?.(i + 1, steps.length, describeStep(steps[i], i));
        if (failReason) return { ok: false, step: i + 1, state: "failed", stderr: failReason };
        if (!result.ok) return { ok: false, step: i + 1, state: result.state ?? "failed", stderr: result.stderr };
      }
      return { ok: true, step: steps.length, state: "completed" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function runStep(step, vars, index) {
    if (typeof step.script === "string") {
      const cmd = interp(step.script, vars);
      return execScript(cmd, {
        cwd: step.cwd ? interp(step.cwd, vars) : cwd,
        env: step.env ? mapEnv(step.env, vars) : undefined,
        index,
      });
    }
    if (typeof step.openApp === "string") return execScript(openCmd(step.openApp, vars), { index, detachOutput: true });
    if (typeof step.openPath === "string") return execScript(openCmd(step.openPath, vars), { index, detachOutput: true });
    if (typeof step.uses === "string") return execUses(step, vars, index);
    return Promise.resolve({ ok: false, stderr: `未知 step 类型：${JSON.stringify(Object.keys(step))}` });
  }

  /**
   * detachOutput：openApp/openPath 拉起的是长驻 GUI，会继承 stdout/stderr 管道，
   * 管道不关 step 就永远等不到 close（Windows 上必现）。这类 step 不接管道，只看启动命令的退出码。
   */
  function execScript(cmd, { cwd: workDir, env, index, detachOutput = false }) {
    const shell = shellInvocation(cmd);
    return execProcess({
      file: shell.file,
      args: shell.args,
      verbatim: shell.verbatim,
      detachOutput,
      cwd: workDir,
      env: env ? { ...(baseEnv ?? process.env), ...env } : (baseEnv ?? process.env),
      index,
      label: cmd,
    });
  }

  async function execUses(step, vars, index) {
    if (!packs) return { ok: false, stderr: `${step.uses}：本机没有配置能力包目录` };
    const projectRoot = step.cwd ? interp(step.cwd, vars) : cwd;
    const params = mapWith(step.with, vars);
    const tool = packs.lookupTool?.(...splitUses(step.uses));
    const requested = Number.isInteger(step.retry) ? step.retry : 0;
    const attempts = tool?.idempotent === false ? 1 : requested + 1;
    if (tool?.idempotent === false && requested > 0) {
      onOutput("status", `[step ${index + 1}] ${step.uses} 工具非幂等，忽略 retry=${requested}，仅执行 1 次`);
    }
    const intervalMs = parseDuration(step.retryInterval, DEFAULT_RETRY_INTERVAL_MS);
    let last = { ok: false, stderr: "未执行" };
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (canceled || failReason) break;
      const inv = prepareInvocation({ registry: packs, uses: step.uses, params, projectRoot, dryRun, env: baseEnv ?? process.env });
      if (!inv.ok) {
        // 包缺失、参数错误等不是偶发问题，重试没有意义
        onOutput("status", `[step ${index + 1}] ${step.uses}：${inv.reason}`);
        try { onStepStart({ index: index + 1, command: `uses ${step.uses}` }); } catch {}
        try { onStepEnd({ index: index + 1, exit: 1 }); } catch {}
        return { ok: false, stderr: inv.reason, code: inv.code };
      }
      last = await execProcess({
        file: inv.command,
        args: inv.args,
        cwd: inv.cwd,
        env: baseEnv ?? process.env,
        index,
        label: inv.label,
        traceCommand: inv.label,
        lowPriority: inv.tool.lowPriority === true,
        parseProgress: true,
        interpret: (code, out) => readResult({ resultJson: inv.resultJson, code, stdout: out.stdout, stderr: out.stderr, tool: inv.tool }),
      });
      if (last.ok || canceled || failReason) break;
      if (attempt < attempts) {
        onOutput("status", `[step ${index + 1}] 第 ${attempt}/${attempts} 次失败：${last.stderr}，${Math.round(intervalMs / 1000)} 秒后重试`);
        await sleep(intervalMs);
      }
    }
    return last;
  }

  function execProcess({ file, args, cwd: workDir, env, index, label, traceCommand, verbatim = false, detachOutput = false, lowPriority = false, parseProgress = false, interpret = null }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      onOutput("status", `[step ${index + 1}] ${label}`);
      try {
        onStepStart({ index: index + 1, command: traceCommand ?? label });
      } catch (error) {
        finish({ ok: false, stderr: `运行记录写入失败：${error.message}` });
        return;
      }
      let child;
      try {
        child = spawn(file, args, {
          cwd: workDir,
          env,
          detached: process.platform !== "win32",
          windowsHide: true,
          windowsVerbatimArguments: verbatim,
          ...(detachOutput ? { stdio: "ignore" } : {}),
        });
      } catch (error) {
        try { onStepEnd({ index: index + 1, exit: 1 }); } catch {}
        finish({ ok: false, stderr: `spawn 失败：${error.message}` });
        return;
      }
      if (lowPriority && child.pid) {
        try { setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 降优先级失败不影响执行 */ }
      }
      let stdout = "";
      let stderr = "";
      let lineBuf = "";
      let stepClosed = false;
      const endStep = (exit) => {
        if (stepClosed) return;
        stepClosed = true;
        try { onStepEnd({ index: index + 1, exit }); } catch { /* 记录失败不挡住终态 */ }
      };
      const takeLine = (line) => {
        const progress = parseProgressLine(line);
        if (progress) {
          const pct = progress.percent === null ? "" : ` ${Math.round(progress.percent)}%`;
          try { onDetail(index + 1, `${progress.message}${pct}`.trim()); } catch {}
          return;
        }
        stdout = tail(stdout, `${line}\n`);
        onOutput("stdout", `${line}\n`);
      };
      child.stdout?.on("data", (chunk) => {
        const text = String(chunk);
        if (!parseProgress) {
          stdout = tail(stdout, text);
          onOutput("stdout", text);
          return;
        }
        lineBuf += text;
        let nl;
        while ((nl = lineBuf.indexOf("\n")) >= 0) {
          takeLine(lineBuf.slice(0, nl).replace(/\r$/, ""));
          lineBuf = lineBuf.slice(nl + 1);
        }
      });
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk);
        stderr = tail(stderr, text);
        onOutput("stderr", text);
      });
      child.on("error", (error) => {
        endStep(1);
        if (currentChild === child) currentChild = null;
        finish({ ok: false, stderr: `spawn 失败：${error.message}` });
      });
      child.on("close", (code) => {
        if (parseProgress && lineBuf) takeLine(lineBuf);
        lineBuf = "";
        endStep(code ?? 1);
        if (currentChild === child) currentChild = null;
        if (failReason) return finish({ ok: false, state: "failed", stderr: failReason });
        if (canceled) return finish({ ok: false, state: "canceled", stderr: stderr || "canceled" });
        if (interpret) {
          const exit = code ?? 1;
          const res = interpret(exit, { stdout, stderr });
          if (res.ok) onOutput("status", `[step ${index + 1}] ${res.detail}`);
          return finish(res.ok
            ? { ok: true, stdout, stderr, detail: res.detail, skipped: res.skipped }
            : { ok: false, stderr: exit === EXIT.INTERRUPTED ? `被中断：${res.detail}` : res.detail });
        }
        if (code === 0) finish({ ok: true, stdout, stderr });
        else finish({ ok: false, stderr: stderr || `exit ${code}` });
      });
      currentChild = child;
    });
  }

  function describeStep(step, index) {
    const head = typeof step.script === "string"
      ? step.script
      : typeof step.openApp === "string"
        ? `openApp ${step.openApp}`
        : typeof step.uses === "string"
          ? `uses ${step.uses}`
          : `openPath ${step.openPath ?? ""}`;
    return `step ${index + 1}/${steps.length}: ${head.slice(0, 60)}`;
  }

  function openCmd(target, vars) {
    return openCommand(interp(target, vars));
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

  /** uses 的 with：字符串与字符串数组插值，数字、布尔原样传。 */
  function mapWith(withParams, vars) {
    const out = {};
    for (const [k, v] of Object.entries(withParams ?? {})) {
      if (typeof v === "string") out[k] = interp(v, vars);
      else if (Array.isArray(v)) out[k] = v.map((item) => (typeof item === "string" ? interp(item, vars) : item));
      else out[k] = v;
    }
    return out;
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      // 不 unref：重试等待是真实的待办工作，unref 后若无其他句柄，进程会在等待中途退出。
      // 取消时由 wakeSleep 立即唤醒，不会拖住退出。
      const timer = setTimeout(() => { wakeSleep = null; resolve(); }, ms);
      wakeSleep = () => { clearTimeout(timer); wakeSleep = null; resolve(); };
    });
  }

  /** 取消：终态 canceled，杀当前子进程。 */
  function cancel() {
    canceled = true;
    wakeSleep?.();
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

  /** 带原因停止：终态 failed（超时、运行窗口硬截止）。 */
  function stop(reason) {
    if (!failReason) failReason = String(reason || "已停止");
    cancel();
  }

  return { run, cancel, stop };
}

function splitUses(uses) {
  const text = String(uses ?? "");
  const slash = text.indexOf("/");
  return slash > 0 ? [text.slice(0, slash), text.slice(slash + 1)] : [text, ""];
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
