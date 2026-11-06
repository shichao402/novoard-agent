/**
 * 本机应用身份（契约 v2.3 agent.hello.app）：hub 只拿来展示“谁跑的是哪个版本”，不据此做任何决策。
 * 版本与渠道以 relkit 服务器为准（ADR-0017），这里只如实上报。
 *
 * - version：桌面壳经 NOVOARD_APP_VERSION 传入（CI 发布构建是 relkit 版本 `0.3.4+57`）；
 *   没有时取 VERSION.json 的 x.y.z（本地构建、Linux 无头）。
 * - channel：桌面壳经 NOVOARD_APP_CHANNEL 传入 stable / dev；未接入更新的构建是 local。
 * - platform：<process.platform>-<process.arch>，与发布产物命名一致（darwin-arm64、win32-x64、linux-x64）。
 */
import versionFile from "../VERSION.json" with { type: "json" };

export function appInfo({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const version = String(env.NOVOARD_APP_VERSION ?? "").trim() || String(versionFile.version);
  const channel = String(env.NOVOARD_APP_CHANNEL ?? "").trim() || "local";
  return { version, channel, platform: `${platform}-${arch}` };
}
