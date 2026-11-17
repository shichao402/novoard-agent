import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CODEBUDDY_ENVIRONMENTS = ["internal", "external", "ioa", "cloudhosted"];

/** Dec 为 novoard-agent 下发的 env 条目名，即落地文件名（Dec 的 env 落点不能分子目录）。 */
export const DEC_CODEBUDDY_ENV_NAME = "novoard-agent.codebuddy.env";

/** 密钥来源：面板本地配置 > 进程环境变量 > Dec 下发文件。 */
export const API_KEY_SOURCES = ["panel", "env", "dec"];

const DEFAULTS = { model: "", apiKey: "", environment: "internal" };

export function readCodebuddyConfig(file) {
  if (!file || !existsSync(file)) return { ...DEFAULTS };
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return normalize({ ...DEFAULTS, ...data });
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Dec 落地位置：<home>/.dec/env/novoard-agent.codebuddy.env。
 * macOS/Linux 是 ~/.dec/env，Windows 是 %USERPROFILE%\.dec\env，与 dec-agent 的 os.UserHomeDir 一致。
 * 这个目录归 dec-agent 管，agent 只读不写。
 */
export function decCodebuddyEnvFile(home = homedir()) {
  return join(home, ".dec", "env", DEC_CODEBUDDY_ENV_NAME);
}

/** 解析 KEY=value 行。支持 # 注释、export 前缀、成对引号；不做变量展开。 */
export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 读 Dec 下发的 env 文件；不存在或读不了时返回空对象。 */
export function readDecCodebuddyEnv(file = decCodebuddyEnvFile()) {
  if (!file || !existsSync(file)) return {};
  try {
    return parseDotenv(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/**
 * 按层决定实际使用的密钥与类型。每次启动会话进程时调用，Dec 轮换后下次会话即生效。
 *
 * 类型跟着密钥走：密钥来自哪一层，就优先用那一层声明的类型（国际版 key 配国内类型会登录失败），
 * 那一层没写类型时退回面板的类型。模型只来自面板。
 */
export function resolveCodebuddyConfig(config, { env = process.env, decFile = decCodebuddyEnvFile() } = {}) {
  const panel = normalize(config);
  const pick = (value) => (CODEBUDDY_ENVIRONMENTS.includes(value) ? value : panel.environment);
  if (panel.apiKey) return { ...panel, apiKeySource: "panel" };
  const fromEnv = String(env?.CODEBUDDY_API_KEY ?? "").trim();
  if (fromEnv) {
    return { ...panel, apiKey: fromEnv, environment: pick(env.CODEBUDDY_INTERNET_ENVIRONMENT), apiKeySource: "env" };
  }
  const dec = readDecCodebuddyEnv(decFile);
  const fromDec = String(dec.CODEBUDDY_API_KEY ?? "").trim();
  if (fromDec) {
    return { ...panel, apiKey: fromDec, environment: pick(dec.CODEBUDDY_INTERNET_ENVIRONMENT), apiKeySource: "dec" };
  }
  return { ...panel, apiKeySource: "" };
}

/**
 * 给面板看的配置。model / environment 是面板自己保存的值（表单回填用），
 * effective 是会话实际会用的类型与密钥来源，不含密钥原文。
 */
export function publicCodebuddyConfig(config, resolved = null) {
  const panel = normalize(config);
  const effective = resolved ?? { ...panel, apiKeySource: panel.apiKey ? "panel" : "" };
  return {
    model: panel.model,
    environment: panel.environment,
    hasApiKey: Boolean(panel.apiKey),
    apiKeySource: effective.apiKeySource || "",
    effectiveEnvironment: normalize(effective).environment,
  };
}

/**
 * 保存面板配置。apiKey 留空表示不更换；clearApiKey=true 清掉面板密钥，
 * 让会话退回环境变量或 Dec 下发的密钥。
 */
export function saveCodebuddyConfig(file, input, previous = readCodebuddyConfig(file)) {
  const typed = String(input?.apiKey ?? "").trim();
  const next = normalize({
    model: input?.model ?? previous.model,
    environment: input?.environment ?? previous.environment,
    apiKey: input?.clearApiKey === true ? "" : typed || previous.apiKey,
  });
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ model: next.model, environment: next.environment, apiKey: next.apiKey }, null, 2));
  try { chmodSync(tmp, 0o600); } catch { /* Windows 上权限位有限 */ }
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* 同上 */ }
  return next;
}

/** 会话进程的环境变量。传入 resolveCodebuddyConfig 的结果，密钥已经按层选好。 */
export function codebuddyProcessEnv(config, base = {}) {
  const env = { ...base };
  const normalized = normalize(config);
  env.CODEBUDDY_INTERNET_ENVIRONMENT = normalized.environment;
  if (normalized.apiKey) env.CODEBUDDY_API_KEY = normalized.apiKey;
  else delete env.CODEBUDDY_API_KEY;
  if (normalized.model) env.NOVOARD_CODEBUDDY_MODEL = normalized.model;
  else delete env.NOVOARD_CODEBUDDY_MODEL;
  return env;
}

export function codebuddySessionFields(env = process.env) {
  const environment = CODEBUDDY_ENVIRONMENTS.includes(env.CODEBUDDY_INTERNET_ENVIRONMENT)
    ? env.CODEBUDDY_INTERNET_ENVIRONMENT
    : "internal";
  const model = String(env.NOVOARD_CODEBUDDY_MODEL ?? "").trim();
  return { environment, ...(model ? { model } : {}) };
}

function normalize(input) {
  const environment = CODEBUDDY_ENVIRONMENTS.includes(input?.environment) ? input.environment : "internal";
  return {
    model: String(input?.model ?? "").trim(),
    apiKey: String(input?.apiKey ?? "").trim(),
    environment,
  };
}
