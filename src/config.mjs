/**
 * lite-agent 配置（契约 §8 + issue-handler secrets 模式）：
 * agent.json（.state 同级，0600）：agentId、hubUrl、agentToken、contractVersion。
 * 环境变量回退；agentId 默认从 targets.yaml 派生（目录名）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { validateUiConfig } from "./ui-access.mjs";

export function loadAgentConfig({ configPath, env = process.env } = {}) {
  const file = configPath ?? join(process.cwd(), "agent.json");
  if (!existsSync(file)) {
    return {
      ok: false,
      reason: `配置文件不存在：${file}（字段：agentId、hubUrl、agentToken、contractVersion；或用环境变量 NOVOARD_AGENT_ID / NOVOARD_HUB_URL / NOVOARD_AGENT_TOKEN）`,
      file,
    };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, version: "2.0", reason: `配置解析失败：${error.message}`, file };
  }
  const agentId = String(data.agentId ?? env.NOVOARD_AGENT_ID ?? "").trim();
  const hubUrl = String(data.hubUrl ?? env.NOVOARD_HUB_URL ?? "").trim();
  const agentToken = String(data.agentToken ?? env.NOVOARD_AGENT_TOKEN ?? "").trim();
  const contractVersion = String(data.contractVersion ?? env.NOVOARD_CONTRACT_VERSION ?? "2.0").trim();
  // UI 监听项允许环境变量显式覆盖文件：桌面壳据此强制回环，Linux 可按需开放测试入口。
  const localPort = Number(env.NOVOARD_LOCAL_PORT ?? data.localPort ?? data.uiPort ?? 0) || 0;
  const uiHost = String(env.NOVOARD_UI_HOST ?? data.uiHost ?? "127.0.0.1").trim();
  const uiToken = String(env.NOVOARD_UI_TOKEN ?? data.uiToken ?? "");
  const fields = { agentId, hubUrl, agentToken, contractVersion };
  const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return { ok: false, reason: `缺少字段：${missing.join(", ")}`, file };
  }
  if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535) {
    return { ok: false, reason: `localPort 不合法：${localPort}`, file };
  }
  const ui = validateUiConfig({ host: uiHost, token: uiToken });
  if (!ui.ok) return { ok: false, reason: ui.reason, file };
  return {
    ok: true,
    version: contractVersion,
    ...fields,
    localPort,
    uiHost: ui.host,
    uiToken: ui.token,
    uiRemote: ui.remote,
    file,
  };
}
