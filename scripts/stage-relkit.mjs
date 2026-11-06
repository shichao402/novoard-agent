/**
 * 取回并验签桌面壳构建所需的 relkit 引擎，并守住协议副本不漂移：
 *
 *   updater → desktop/src-tauri/binaries/relkit-updater-<triple>[.exe]
 *             （tauri externalBin，安装后与主程序同目录，随版本一起发布，ADR 0027）
 *
 * relkit 不再提供 SDK（ADR 0026）：宿主类型从仓内
 * desktop/src-tauri/proto/updater/v2/updater.proto 生成。这里用刚验签的引擎
 * 执行 `relkit-updater proto`，与副本逐字节比对，不一致即失败。
 *
 * 引擎只从 relkit.project.json 声明的服务器 `current/` 拿，用根公钥验签；
 * 宿主仓不记录任何版本、摘要或二进制（ADR-0017）。
 *
 * 离线复用：NOVOARD_RELKIT_OFFLINE=1 且引擎已存在时跳过下载。
 * 交叉构建（目标与本机架构不同、引擎无法在本机执行）时跳过比对，由同平台 CI 守住。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROTO_COPY = join(ROOT, "desktop", "src-tauri", "proto", "updater", "v2", "updater.proto");

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
  const binaries = join(ROOT, "desktop", "src-tauri", "binaries");
  const updaterName = `relkit-updater-${triple}${isWindows ? ".exe" : ""}`;
  const updaterPath = join(binaries, updaterName);
  const offline = process.env.NOVOARD_RELKIT_OFFLINE === "1";

  // 旧接入遗留的 SDK 目录，relkit 已不再发布。
  rmSync(join(ROOT, ".relkit", "sdk-rust"), { recursive: true, force: true });

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

  if (relkitPlatform(triple) === hostPlatform()) {
    checkProtoDrift(updaterPath);
  } else {
    console.log(`… 交叉构建 ${triple}，跳过 updater proto 比对`);
  }
}

function hostPlatform() {
  const os = { darwin: "darwin", win32: "windows", linux: "linux" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  return `${os}-${arch}`;
}

export function checkProtoDrift(updaterPath) {
  const result = spawnSync(updaterPath, ["proto"], { encoding: "buffer", maxBuffer: 16 << 20 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`relkit-updater proto 失败：${result.stderr.toString().trim()}`);
  }
  const copy = existsSync(PROTO_COPY) ? readFileSync(PROTO_COPY) : Buffer.alloc(0);
  if (!copy.equals(result.stdout)) {
    throw new Error(
      `updater proto drift: ${PROTO_COPY} 与引擎导出不一致；` +
        `用 'relkit-updater proto > desktop/src-tauri/proto/updater/v2/updater.proto' 刷新副本并适配宿主代码`,
    );
  }
  console.log("✓ updater proto 副本与引擎一致");
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
