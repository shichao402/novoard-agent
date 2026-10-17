import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CODEBUDDY_ENVIRONMENTS = ["internal", "external", "ioa", "cloudhosted"];

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

export function publicCodebuddyConfig(config) {
  return {
    model: config.model,
    environment: config.environment,
    hasApiKey: Boolean(config.apiKey),
  };
}

export function saveCodebuddyConfig(file, input, previous = readCodebuddyConfig(file)) {
  const next = normalize({
    model: input?.model ?? previous.model,
    environment: input?.environment ?? previous.environment,
    apiKey: String(input?.apiKey ?? "").trim() || previous.apiKey,
  });
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ model: next.model, environment: next.environment, apiKey: next.apiKey }, null, 2));
  try { chmodSync(tmp, 0o600); } catch { /* Windows 上权限位有限 */ }
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* 同上 */ }
  return next;
}

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
