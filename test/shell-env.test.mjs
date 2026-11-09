import assert from "node:assert/strict";
import test from "node:test";
import { createRunner } from "../src/runner.mjs";
import { parseShellEnvOutput, resolveScriptEnv, supplementPath } from "../src/shell-env.mjs";

const wrap = (pairs, noise = "") =>
  `${noise}__NOVOARD_ENV_BEGIN__${pairs.join("\0")}\0__NOVOARD_ENV_END__`;

test("登录 shell 输出：只取标记之间，过滤临时变量和非法 key", () => {
  const env = parseShellEnvOutput(wrap(["PATH=/opt/homebrew/bin:/usr/bin", "LANG=zh_CN.UTF-8", "PWD=/tmp", "SHLVL=2", "A=b=c", "bad-key=1"], "欢迎登录\n"));
  assert.deepEqual(env, { PATH: "/opt/homebrew/bin:/usr/bin", LANG: "zh_CN.UTF-8", A: "b=c" });
});

test("登录 shell 输出：没有标记或没有 PATH 视为失败", () => {
  assert.equal(parseShellEnvOutput("PATH=/usr/bin"), null);
  assert.equal(parseShellEnvOutput(wrap(["LANG=C"])), null);
});

test("PATH 兜底：保留原顺序，缺的目录补到末尾且不重复", () => {
  assert.equal(supplementPath("/usr/bin:/bin", ["/opt/homebrew/bin", "/usr/bin"]), "/usr/bin:/bin:/opt/homebrew/bin");
  assert.equal(supplementPath("", ["/a"]), "/a");
});

test("Windows 沿用进程环境，不调用 shell", () => {
  const result = resolveScriptEnv({ platform: "win32", env: { PATH: "C:\\x" }, exec: () => { throw new Error("不该调用"); } });
  assert.equal(result.source, "inherited");
  assert.deepEqual(result.env, { PATH: "C:\\x" });
});

test("macOS 登录 shell 成功：用登录 shell 的环境覆盖进程环境", () => {
  let called;
  const result = resolveScriptEnv({
    platform: "darwin",
    env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin", KEEP: "1" },
    exec(file, args) { called = { file, args }; return wrap(["PATH=/opt/homebrew/bin:/usr/bin", "LANG=zh_CN.UTF-8"]); },
  });
  assert.equal(called.file, "/bin/zsh");
  assert.equal(called.args[0], "-ilc");
  assert.equal(result.source, "login-shell");
  assert.deepEqual(result.env, { SHELL: "/bin/zsh", PATH: "/opt/homebrew/bin:/usr/bin", KEEP: "1", LANG: "zh_CN.UTF-8" });
});

test("macOS 登录 shell 失败：退回进程环境并补齐 PATH", () => {
  const result = resolveScriptEnv({
    platform: "darwin",
    env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
    exec() { const e = new Error("spawnSync /bin/zsh ETIMEDOUT"); e.code = "ETIMEDOUT"; throw e; },
  });
  assert.equal(result.source, "fallback");
  assert.match(result.detail, /超过 5000ms/);
  assert.ok(result.env.PATH.startsWith("/usr/bin:/bin:"));
  assert.ok(result.env.PATH.split(":").includes("/opt/homebrew/bin"));
});

test("runner 用 baseEnv 作为脚本基础环境，step.env 仍可覆盖", { skip: process.platform === "win32" }, async () => {
  const outputs = [];
  const result = await createRunner({
    baseEnv: { PATH: process.env.PATH, NOVOARD_BASE: "base", NOVOARD_OVER: "base" },
    steps: [{ script: 'echo "${NOVOARD_BASE}-${NOVOARD_OVER}-${HOME:-nohome}"', env: { NOVOARD_OVER: "step" } }],
    onOutput(stream, text) { outputs.push(text); },
  }).run();
  assert.equal(result.ok, true);
  assert.match(outputs.join(""), /base-step-nohome/);
});
