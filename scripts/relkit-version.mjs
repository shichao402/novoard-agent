/**
 * Relkit 发布身份：version / channel / releaseCode / edition 的唯一计算处。
 *
 *   stable：由 tag v<semver> 触发，version = <semver>+<code>
 *   dev   ：手动触发，version = <package.json 版本>-dev.<code>+<code>
 *
 * code 取 `git rev-list --count HEAD`（CI 必须 fetch-depth: 0）。
 * relkit 按渠道各自要求 code 单调递增，同一渠道沿主线发布即满足。
 * Tauri / Cargo / NSIS 仍只用纯 semver；code 由 producer 经编译期环境变量注入。
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionFromTag } from "./sync-release-version.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CHANNELS = ["stable", "dev"];

export function computeRelease({ channel, tag, packageVersion, commitCount }) {
  if (!CHANNELS.includes(channel)) {
    throw new Error(`渠道只能是 stable 或 dev，当前是 ${channel || "<空>"}`);
  }
  const code = Number(commitCount);
  if (!Number.isInteger(code) || code <= 0) {
    throw new Error(`releaseCode 必须是正整数，当前是 ${commitCount}`);
  }
  if (channel === "stable") {
    const semver = versionFromTag(tag);
    if (semver.includes("+")) throw new Error(`stable tag 不能自带 build 元数据：${tag}`);
    return { channel, code, semver, version: `${semver}+${code}`, edition: "release" };
  }
  const base = String(packageVersion ?? "").split(/[-+]/)[0];
  if (!/^\d+\.\d+\.\d+$/.test(base)) throw new Error(`package.json 版本不是 semver：${packageVersion}`);
  return { channel, code, semver: base, version: `${base}-dev.${code}+${code}`, edition: "dev" };
}

/** producer 侧：从 relkit 传入的 version 取回 releaseCode（`+N`）。 */
export function releaseCodeFromVersion(version) {
  const match = /\+(\d+)$/.exec(String(version ?? ""));
  if (!match) throw new Error(`relkit 版本必须以 +<releaseCode> 结尾：${version}`);
  const code = Number(match[1]);
  if (!Number.isSafeInteger(code) || code <= 0) throw new Error(`releaseCode 非法：${version}`);
  return code;
}

export function editionForChannel(channel) {
  if (channel === "dev") return "dev";
  if (channel === "stable") return "release";
  throw new Error(`渠道只能是 stable 或 dev，当前是 ${channel}`);
}

function commitCount(root = ROOT) {
  return execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const channel = args[args.indexOf("--channel") + 1] ?? "";
    if (!args.includes("--channel")) throw new Error("用法：node scripts/relkit-version.mjs --channel <stable|dev>");
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    const release = computeRelease({
      channel,
      tag: process.env.NOVOARD_RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
      packageVersion: pkg.version,
      commitCount: commitCount(),
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
