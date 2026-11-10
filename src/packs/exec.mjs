/**
 * 包管理用的子进程辅助：不走 shell，参数逐个传；收集 stdout/stderr；可选超时。
 * → Promise<{ code, stdout, stderr, spawnError? }>，命令不存在时 code=-1 且带 spawnError。
 */
import { spawn } from "node:child_process";

export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const done = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...value });
    };
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...env, GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: -1, stdout, stderr, spawnError: error?.code ?? String(error) });
      return;
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
          done({ code: -1, stderr: `${stderr}\n超时（${Math.round(timeoutMs / 1000)} 秒）` });
        }, timeoutMs)
      : null;
    timer?.unref?.();
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (error) => done({ code: -1, spawnError: error?.code ?? String(error) }));
    child.on("close", (code) => done({ code: code ?? -1 }));
  });
}
