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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseMatches, bakeEdition, resolveEdition } from "./edition.mjs";

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

/**
 * 契约 schema 文件清单：按目录动态发现，不维护手工清单。
 * 新增或重命名 schema 时构建会自动跟随，避免清单漏项导致内嵌缺失。
 */
function schemaFiles() {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`契约 schema 目录为空：${SCHEMA_DIR}`);
  return files;
}

function step(msg) {
  console.log(`\n▸ ${msg}`);
}

/** 1. schema 内嵌模块生成（sea-entry 导入它，bundle 时进产物）。 */
function genEmbeddedSchemas() {
  step("生成内嵌 schema 模块 build/embedded-schemas.gen.mjs");
  const files = schemaFiles();
  const entries = files.map((f) => JSON.parse(readFileSync(join(SCHEMA_DIR, f), "utf8")));
  const table = Object.fromEntries(files.map((f, i) => [f, entries[i]]));
  const code = `/** 构建期生成（scripts/build-agent.mjs），勿手改：${files.length} 张契约 schema 内嵌供 SEA 二进制。 */\nexport const EMBEDDED_SCHEMAS = ${JSON.stringify(table, null, 2)};\n`;
  mkdirSync(BUILD, { recursive: true });
  writeFileSync(join(BUILD, "embedded-schemas.gen.mjs"), code, "utf8");
  console.log(`  内嵌 ${files.length} 张：${files.join(", ")}`);
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

/** Windows 官方 node 是控制台子系统。改成 GUI 子系统后，桌面壳拉起 sidecar 不会再弹出黑色控制台。 */
function setWindowsGuiSubsystem(exePath) {
  const buf = readFileSync(exePath);
  if (buf.length < 0x40 || buf.toString("ascii", 0, 2) !== "MZ") {
    throw new Error(`无法修改子系统，不是 PE：${exePath}`);
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`PE 签名无效：${exePath}`);
  }
  const optional = peOffset + 24;
  const magic = buf.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`未知 PE magic：0x${magic.toString(16)}`);
  const subsystemAt = optional + 68;
  const current = buf.readUInt16LE(subsystemAt);
  if (current !== 2 && current !== 3) throw new Error(`未知 subsystem：${current}`);
  buf.writeUInt16LE(2, subsystemAt); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  writeFileSync(exePath, buf);
  console.log(`✓ Windows 子系统已设为 GUI（原 ${current}）`);
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
  // macOS 上 Node 24+ 的二进制地址布局会让注入后的 SEA 在 dyld 阶段直接 abort：
  // "unsupported thread-local, larger than 4GB"。发行产物统一用 Node 22（与 CI 一致）。
  if (targetPlatform === "darwin") {
    const baseMajor = Number(
      execFileSync(nodeBin, ["-p", "process.versions.node.split('.')[0]"], { encoding: "utf8" }).trim(),
    );
    if (baseMajor !== 22) {
      throw new Error(
        `macOS 的 SEA 注入基底必须是 Node 22（当前 ${baseMajor}）。\n` +
        `Node 24+ 注入的产物会在 dyld 阶段崩溃：unsupported thread-local, larger than 4GB。\n` +
        `请设 NODE_SEA_BASE 指向 Node 22 官方 node，例如：\n` +
        `  NODE_SEA_BASE=/path/to/node-v22.x-darwin-${targetArch}/bin/node node scripts/build-agent.mjs`
      );
    }
  }
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

  if (isWin) setWindowsGuiSubsystem(exePath);
  stageConsole(outDir);

  // 附带发行件（Windows/macOS 的该二进制会作为 Tauri sidecar；Linux 直接分发）。
  const usage = targetPlatform === "linux"
    ? `无头使用：
- 本目录就是数据目录（agent.json / agents/ / .agent-state/）
- 未发现 agent.json 时启动 http://127.0.0.1:${resolveEdition().localPort}/setup
- 推荐 SSH 转发访问。要对其他机器或公网开放，设置 NOVOARD_UI_HOST=0.0.0.0，并配置至少 16 字符的 NOVOARD_UI_TOKEN
- 若本目录有 ui/，浏览器打开控制台地址即可使用和桌面端同一套界面
`
    : `本文件是桌面安装包内使用的 Agent service sidecar，面向用户请运行 ${resolveEdition().productName} 桌面应用。
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

function stageConsole(outDir) {
  const dist = join(ROOT, "desktop", "dist");
  const destination = join(outDir, "ui");
  rmSync(destination, { recursive: true, force: true });
  if (!existsSync(join(dist, "index.html"))) {
    console.log("未找到 desktop/dist，发行目录不带控制台页面。需要时先在 desktop 执行 npm run build。");
    return;
  }
  cpSync(dist, destination, { recursive: true });
  console.log(`控制台页面：${destination}`);
}

async function main() {
  const edition = bakeEdition();
  assertReleaseMatches(JSON.parse(readFileSync(join(ROOT, "desktop", "src-tauri", "tauri.conf.json"), "utf8")));
  console.log(`Novoard agent SEA 打包：目标 ${targetPlatform}-${targetArch}，node ${process.version}，版本 ${edition.productName}`);
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
