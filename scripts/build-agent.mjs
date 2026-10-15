/**
 * SEA（Single Executable Application）打包脚本（M6 F2 二进制分发）：
 *   1. esbuild bundle：src/sea-entry.mjs → CJS 单文件（ws 可选原生依赖 external，运行时自行回退纯 JS）
 *   2. 生成 build/embedded-schemas.gen.mjs：九张 schema 内嵌（bundle 后 docs/ 不可读）
 *   3. node --experimental-sea-config 产出 blob
 *   4. 复制本机 node 二进制 → postject 注入 blob +signtool 可选
 *
 * 产物：build/dist/<platform>-<arch>/novoard-agent(.exe)
 * 用法：node scripts/build-agent.mjs [--platform win32|darwin|linux] [--arch x64|arm64]
 *   --platform 缺省 = 当前平台；仅本平台可产出可运行二进制（跨平台注入同理可行，CI 矩阵各跑各的）
 * 依赖：esbuild / postject 为 devDependencies，需本机有 node 与（macOS 签名时）codesign。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const DIST = join(BUILD, "dist");
const SCHEMA_DIR = join(ROOT, "src", "contract", "schemas");

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const targetPlatform = argOf("platform") ?? process.env.NOVOARD_BUILD_PLATFORM ?? process.platform;
const targetArch = argOf("arch") ?? process.env.NOVOARD_BUILD_ARCH ?? process.arch;

const SCHEMA_FILES = ["a2a-envelope.json", "frame-agent-hello.json", "frame-agent-ping.json", "frame-telemetry.json", "frame-card-update.json", "agent-card.json", "task.json", "audit-event.json", "target.json"];

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

/** 1. schema 内嵌模块生成（sea-entry 导入它，bundle 时进产物）。 */
function genEmbeddedSchemas() {
  step("生成内嵌 schema 模块 build/embedded-schemas.gen.mjs");
  const entries = SCHEMA_FILES.map((f) => JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")));
  const table = Object.fromEntries(SCHEMA_FILES.map((f, i) => [f, entries[i]]));
  const code = `/** 构建期生成（scripts/build-agent.mjs），勿手改：九张契约 schema 内嵌供 SEA 二进制。 */\nexport const EMBEDDED_SCHEMAS = ${JSON.stringify(table, null, 2)};\n`;
  mkdirSync(BUILD, { recursive: true });
  writeFileSync(join(BUILD, "embedded-schemas.gen.mjs"), code, "utf8");
}

/** 2. esbuild bundle（CJS，ws 原生可选依赖 external 由运行时 try/catch 回退）。程序化 API：跨平台无 .bin shim 差异（Windows .bin 是 .cmd，spawn 会 ENOENT）。 */
async function bundle() {
  step("esbuild bundle：sea-entry → build/sea-bundle.cjs");
  const esbuild = (await import("esbuild")).default ?? await import("esbuild");
  const r = await esbuild.build({
    entryPoints: [join(ROOT, "src", "sea-entry.mjs")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(BUILD, "sea-bundle.cjs"),
    external: ["bufferutil", "cpu-features", "utf-8-validate"],
    logLevel: "info",
  });
  if (r.errors.length) throw new Error("esbuild bundle 报错");
  if (!existsSync(join(BUILD, "sea-bundle.cjs"))) throw new Error("esbuild 产物缺失");
}

/** 3. SEA 配置与 blob 生成（blob 的 node 必须与注入基底同版本——官方文档要求）。 */
function seaBlob() {
  step("node --experimental-sea-config 生成 blob");
  const seaConfig = {
    main: join(BUILD, "sea-bundle.cjs"),
    output: join(BUILD, "sea-prep.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
  writeFileSync(join(BUILD, "sea-config.json"), JSON.stringify(seaConfig, null, 2));
  const blobNode = process.env.NODE_SEA_BASE ?? process.execPath; // 与注入基底一致，防版本错配
  execFileSync(blobNode, ["--experimental-sea-config", join(BUILD, "sea-config.json")], { stdio: "inherit" });
  if (!existsSync(join(BUILD, "sea-prep.blob"))) throw new Error("SEA blob 生成失败");
}

/** 4. 复制 node 并注入。程序化 postject API（跨平台无 .bin shim 问题）。 */
async function inject() {
  step(`注入 blob 到 node 二进制（${targetPlatform}-${targetArch}）`);
  const isWin = targetPlatform === "win32";
  const outDir = join(DIST, `${targetPlatform}-${targetArch}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const exeName = isWin ? "novoard-agent.exe" : "novoard-agent";
  const exePath = join(outDir, exeName);

  // 注入基底：官方 node 发行二进制（带 SEA fuse；Homebrew 等源码构建版缺 fuse 会注入失败）
  // NODE_SEA_BASE 显式指定；否则用当前 process.execPath（CI 上 setup-node 提供官方版）
  let nodeBin = process.env.NODE_SEA_BASE ?? process.execPath;
  if (!existsSync(nodeBin)) throw new Error(`node 基底不存在：${nodeBin}`);
  const hasFuse = readFileSync(nodeBin).toString("latin1").includes("NODE_SEA_FUSE_");
  if (!hasFuse) throw new Error(
    `注入基底缺 SEA fuse（源码构建的 node 无 fuse 串）：${nodeBin}\n` +
    `请用官方发行版 node（https://nodejs.org/dist/），或设 NODE_SEA_BASE 指向官方 node 可执行文件`
  );
  cpSync(nodeBin, exePath);
  // node 发行二进制只读（555），postject 需要可写
  chmodSync(exePath, isWin ? 0o666 : 0o755);

  const postject = (await import("postject")).inject ?? (await import("postject")).default?.inject;
  const sentinel = "NODE_SEA_BLOB";
  const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"; // Node.js 项目 SEA fuse（官方文档口径）
  const blobData = readFileSync(join(BUILD, "sea-prep.blob"));

  if (targetPlatform === "darwin") {
    // macOS：先去签名复制件，注入后重签（ad-hoc）
    try {
      execFileSync("codesign", ["--remove-signature", exePath], { stdio: "inherit" });
    } catch { /* 未签名二进制无妨 */ }
    await postject(exePath, sentinel, blobData, {
      sentinelFuse: FUSE,
      machoSegmentName: "NODE_SEA",
    });
    try {
      execFileSync("codesign", ["--sign", "-", exePath], { stdio: "inherit" });
    } catch { /* ad-hoc 签名失败不阻塞（用户可自签） */ }
  } else {
    await postject(exePath, sentinel, blobData, { sentinelFuse: FUSE });
  }

  // 附带发行件（Windows/macOS 的该二进制会作为 Tauri sidecar；Linux 直接分发）。
  const usage = targetPlatform === "linux"
    ? `无头使用：
- 本目录就是数据目录（agent.json / agents/ / .agent-state/）
- 未发现 agent.json 时启动 http://127.0.0.1:39870/setup
- 推荐 SSH 转发访问；测试网络远程开放需同时设置 NOVOARD_UI_HOST=0.0.0.0 与至少 16 字符的 NOVOARD_UI_TOKEN
`
    : `本文件是桌面安装包内使用的 Agent service sidecar，面向用户请运行 Novoard Agent 桌面应用。
如需诊断，可直接执行；工作目录即数据目录。
`;
  writeFileSync(
    join(outDir, "README.txt"),
    `Novoard agent（${targetPlatform}-${targetArch}）

${usage}
完整说明：https://github.com/shichao402/novoard-agent
`
  );

  const sizeMb = (statSync(exePath).size / 1024 / 1024).toFixed(1);
  console.log(`✓ 产物：${exePath}（${sizeMb} MB）`);
}

async function main() {
  console.log(`Novoard agent SEA 打包：目标 ${targetPlatform}-${targetArch}，node ${process.version}`);
  genEmbeddedSchemas();
  await bundle();
  seaBlob();
  await inject();
  console.log(`\n完成。产物目录：${DIST}`);
}

main().catch((error) => {
  console.error(`打包失败：${error?.message ?? error}`);
  if (error?.stack) console.error(error.stack);
  process.exit(1);
});
