/**
 * 契约版本（agent 侧单一来源）。
 *
 * 为什么单独一个模块：
 * 版本号此前散落在运行时配置默认值、门禁脚本、测试样例里，且 agent.json 会把它持久化，
 * 导致契约升级后只更新二进制而不重装的环境会永久停在旧版本号上握手失败。
 * 现在运行时、门禁、测试都从这里取，升级契约只需改这一处。
 *
 * 与 SSOT 的一致性：hub 仓 docs/architecture/contracts.md 是权威源，
 * scripts/check-contract-copy.mjs 在设置 NOVOARD_HUB_ROOT 时会校验本常量与 SSOT 一致。
 * 字面格式统一为不带 `v` 前缀（契约 §0 的 contractVersion pattern 为 ^\d+\.\d+$）。
 */
export const CONTRACT_VERSION = "2.2";
