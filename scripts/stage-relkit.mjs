/**
 * 取回并验签桌面壳构建所需的两件 relkit 工具：
 *
 *   1. sdk-rust  → .relkit/sdk-rust（desktop/src-tauri/Cargo.toml 的 path 依赖）
 *   2. updater   → desktop/src-tauri/binaries/relkit-updater-<triple>[.exe]
 *                  （tauri externalBin，安装后与主程序同目录）
 *
 * 两者都只从 relkit.project.json 声明的服务器 `current/` 拿，用根公钥验签；
 * 宿主仓不记录任何版本、摘要或二进制（ADR-0017）。
 *
 * 离线复用：NOVOARD_RELKIT_OFFLINE=1 且产物已存在时跳过下载。
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RELKIT_PLATFORMS = {
  "x86_64-apple-darwin": "darwin-amd64",
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-pc-windows-msvc": "windows-amd64",
};

export function relkitPlatform(triple) {
  const value = RELKIT_PLATFORMS[triple];
  if (!value) throw new Error(`relkit 不支持桌面目标 ${triple}`);
  return value;
}

export function stageRelkit({ triple }) {
  const isWindows = triple.includes("windows");
  const sdkDir = join(ROOT, ".relkit", "sdk-rust");
  const binaries = join(ROOT, "desktop", "src-tauri", "binaries");
  const updaterName = `relkit-updater-${triple}${isWindows ? ".exe" : ""}`;
  const updaterPath = join(binaries, updaterName);
  const offline = process.env.NOVOARD_RELKIT_OFFLINE === "1";

  if (!(offline && existsSync(join(sdkDir, "Cargo.toml")))) {
    fetchTool(["--component", "sdk-rust", "--platform", "all", "--extract-to", sdkDir]);
  }
  console.log(`✓ relkit sdk-rust：${sdkDir}`);

  if (!(offline && existsSync(updaterPath))) {
    mkdirSync(binaries, { recursive: true });
    fetchTool([
      "--component",
      "updater",
      "--platform",
      relkitPlatform(triple),
      "--out-dir",
      binaries,
      "--out-name",
      updaterName,
    ]);
    rmSync(join(binaries, "relkit_allowed_signers"), { force: true });
  }
  if (!isWindows) chmodSync(updaterPath, 0o755);
  console.log(`✓ relkit updater：${updaterPath}`);
}

function fetchTool(args) {
  const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  const result = spawnSync(python, [join(ROOT, "scripts", "relkit_tool.py"), ...args], {
    cwd: ROOT,
    stdio: ["ignore", 2, 2],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`relkit 工具取回失败：relkit_tool.py ${args.join(" ")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const triple = process.env.TAURI_TARGET_TRIPLE ?? process.argv[2];
  if (!triple) throw new Error("用法：node scripts/stage-relkit.mjs <target-triple>");
  stageRelkit({ triple });
}
