/**
 * 将本机 SEA 产物放到 Tauri externalBin 约定的位置。
 *
 * Tauri 构建时会按 Rust target triple 查找：
 *   desktop/src-tauri/binaries/novoard-agent-<triple>[.exe]
 * 本脚本只做同平台 staging；SEA 本体仍由 build-agent.mjs 唯一生成。
 */
import { copyFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.NOVOARD_BUILD_PLATFORM ?? process.platform;
const arch = process.env.NOVOARD_BUILD_ARCH ?? process.arch;
const triple = process.env.TAURI_TARGET_TRIPLE ?? targetTriple(platform, arch);
const isWindows = platform === "win32";
const executable = isWindows ? "novoard-agent.exe" : "novoard-agent";
const source = join(ROOT, "build", "dist", `${platform}-${arch}`, executable);
const destination = join(
  ROOT,
  "desktop",
  "src-tauri",
  "binaries",
  `novoard-agent-${triple}${isWindows ? ".exe" : ""}`,
);

if (!existsSync(source)) {
  throw new Error(`SEA sidecar 不存在：${source}（先执行 npm run build）`);
}
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
if (!isWindows) chmodSync(destination, 0o755);
console.log(`✓ Tauri sidecar：${destination}`);

function targetTriple(os, cpu) {
  const triples = {
    "darwin:x64": "x86_64-apple-darwin",
    "darwin:arm64": "aarch64-apple-darwin",
    "win32:x64": "x86_64-pc-windows-msvc",
  };
  const value = triples[`${os}:${cpu}`];
  if (!value) {
    throw new Error(`桌面壳不支持目标 ${os}-${cpu}（Linux 保持无头 SEA，不执行 Tauri staging）`);
  }
  return value;
}
