/**
 * target 脚本的执行环境。
 *
 * 问题：agent 是 GUI 应用。从 Finder、开机自启或其他程序拉起时，拿到的环境和用户终端不一样：
 * launchd 给的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，没有 LANG；被别的程序拉起时又继承那个程序的环境。
 * 结果是同一个脚本在终端里能跑，接进 agent 就找不到 gh / node / pnpm，或者因为 locale 不同行为不同。
 *
 * 做法（与 VS Code 的 resolveShellEnv 同思路）：启动时用用户的登录 shell（$SHELL -ilc）取一次环境，
 * 作为 script 步骤的基础环境。这样「在终端里跑通」和「在 agent 里跑通」是同一个环境。
 * 取不到（超时、shell 异常、Windows）时退回进程环境，并在 macOS 上补齐常见工具目录。
 */
import { execFileSync } from "node:child_process";

const BEGIN = "__NOVOARD_ENV_BEGIN__";
const END = "__NOVOARD_ENV_END__";

/** 登录 shell 里这些变量描述的是那个临时 shell 本身，不该带给脚本。 */
const VOLATILE = new Set(["PWD", "OLDPWD", "SHLVL", "_", "PS1", "PS2", "PROMPT", "RPROMPT", "TERM_SESSION_ID"]);

const DARWIN_FALLBACK_PATH = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** 解析 `env -0` 输出（可能夹着 shell 启动时打印的杂讯，只取标记之间）。 */
export function parseShellEnvOutput(output) {
  const text = String(output ?? "");
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END, begin + BEGIN.length);
  if (begin < 0 || end < 0) return null;
  const env = {};
  for (const entry of text.slice(begin + BEGIN.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).replace(/^\n+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || VOLATILE.has(key)) continue;
    env[key] = entry.slice(eq + 1);
  }
  return Object.keys(env).length > 0 && env.PATH ? env : null;
}

/** macOS 兜底：保留原 PATH 顺序，把缺的常见目录补到后面。 */
export function supplementPath(path = "", dirs = DARWIN_FALLBACK_PATH) {
  const parts = String(path).split(":").filter(Boolean);
  for (const dir of dirs) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(":");
}

/**
 * 计算 script 步骤的基础环境。只在启动时调用一次。
 * 返回 { env, source, detail }：source 为 login-shell / fallback / inherited，写进日志方便排查。
 */
export function resolveScriptEnv({
  platform = process.platform,
  env = process.env,
  timeoutMs = 5000,
  exec = execFileSync,
} = {}) {
  if (platform === "win32") return { env: { ...env }, source: "inherited", detail: "Windows 沿用进程环境" };

  const shell = env.SHELL || (platform === "darwin" ? "/bin/zsh" : "");
  let failure = "";
  if (shell) {
    try {
      const out = exec(shell, ["-ilc", `printf '%s' ${BEGIN}; /usr/bin/env -0; printf '%s' ${END}`], {
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
        env,
        maxBuffer: 4 * 1024 * 1024,
      });
      const shellEnv = parseShellEnvOutput(out);
      if (shellEnv) {
        return { env: { ...env, ...shellEnv }, source: "login-shell", detail: `${shell} -ilc` };
      }
      failure = "输出里没有找到环境";
    } catch (error) {
      failure = error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM" ? `超过 ${timeoutMs}ms` : String(error?.message ?? error).split("\n")[0];
    }
  } else {
    failure = "没有 SHELL";
  }

  const merged = { ...env };
  if (platform === "darwin") merged.PATH = supplementPath(env.PATH);
  return { env: merged, source: "fallback", detail: `登录 shell 取环境失败（${failure}），沿用进程环境${platform === "darwin" ? "并补齐常见 PATH" : ""}` };
}
