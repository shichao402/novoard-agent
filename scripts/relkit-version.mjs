/**
 * Relkit 发布身份：version / channel / releaseCode / edition 的唯一计算处。
 *
 *   x.y.z ：只取自 VERSION.json（scripts/version.mjs）
 *   code  ：由 relkit 服务器分配（relkit ADR 0025），CI 在 plan job 用
 *           `relkit release-code claim` 领一次，再经 --code 传进来
 *   stable：由 tag v<x.y.z> 触发，tag 必须等于 VERSION.json；version = <x.y.z>+<code>
 *   dev   ：手动触发，version = <x.y.z>-dev.<code>+<code>
 *
 * 一次发布只领一个号，矩阵各平台共用；号可以空缺，但不会重复或倒退。
 * Tauri / Cargo / NSIS 仍只用纯 semver；code 由 producer 经编译期环境变量注入。
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTagMatches, readVersion } from "./version.mjs";

export const CHANNELS = ["stable", "dev"];

export function computeRelease({ channel, tag, baseVersion, code: rawCode }) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`渠道只能是 stable 或 dev，当前是 ${channel || "<空>"}`);
  }
  const code = Number(String(rawCode ?? "").trim());
  if (!Number.isSafeInteger(code) || code <= 0) {
    throw new Error(`releaseCode 必须是服务器分配的正整数，当前是 ${rawCode ?? "<空>"}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(baseVersion ?? ""))) {
    throw new Error(`VERSION.json 版本不是 x.y.z：${baseVersion}`);
  }
  if (channel === "stable") {
    assertTagMatches(tag, baseVersion);
    return { channel, code, semver: baseVersion, version: `${baseVersion}+${code}`, edition: "release" };
  }
  return { channel, code, semver: baseVersion, version: `${baseVersion}-dev.${code}+${code}`, edition: "dev" };
}

/** producer 侧：从 relkit 传入的 version 取回 releaseCode（`+N`）。 */
export function releaseCodeFromVersion(version) {
  const match = /\+(\d+)$/.exec(String(version ?? ""));
  if (!match) throw new Error(`relkit 版本必须以 +<releaseCode> 结尾：${version}`);
  const code = Number(match[1]);
  if (!Number.isSafeInteger(code) || code <= 0) throw new Error(`releaseCode 非法：${version}`);
  return code;
}

/** producer 侧：从 relkit 传入的 version 取回 x.y.z。 */
export function semverFromVersion(version) {
  const match = /^(\d+\.\d+\.\d+)(?:-dev\.\d+)?\+\d+$/.exec(String(version ?? ""));
  if (!match) throw new Error(`relkit 版本应为 <x.y.z>+<code> 或 <x.y.z>-dev.<code>+<code>：${version}`);
  return match[1];
}

export function editionForChannel(channel) {
  if (channel === "dev") return "dev";
  if (channel === "stable") return "release";
  throw new Error(`渠道只能是 stable 或 dev，当前是 ${channel}`);
}

function flag(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const channel = flag(args, "--channel");
    const code = flag(args, "--code");
    if (channel === undefined || code === undefined) {
      throw new Error('用法：node scripts/relkit-version.mjs --channel <stable|dev> --code "$(relkit release-code claim)"');
    }
    const release = computeRelease({
      channel,
      tag: process.env.NOVOARD_RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
      baseVersion: readVersion(),
      code,
    });
    for (const [key, value] of Object.entries(release)) {
      const line = `${key}=${value}\n`;
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
      process.stdout.write(line);
    }
  } catch (error) {
    console.error(`relkit 版本计算失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
