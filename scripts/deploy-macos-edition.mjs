/**
 * macOS 本地部署。正式版和开发版走同一条路。
 *
 * 打 Tauri app bundle，停掉目标 .app 里的进程，再用 ditto 复制到 ~/Applications。
 * 正式版和开发版并排放置，产品名、bundle id、图标、端口全不同，可同时运行。
 *
 * tauri.conf.json 始终是正式档。开发档只在本次构建写入 overlay。
 * 构建结束把运行时宏恢复成正式档。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertReleaseMatches, bakeEdition, tauriOverlay } from "./edition.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "desktop");

function run(file, args, cwd = ROOT) {
  execFileSync(file, args, { cwd, stdio: "inherit", env: process.env });
}

function runNpm(args, cwd) {
  execFileSync("npm", args, { cwd, stdio: "inherit", shell: true, env: process.env });
}

/** Tauri app bundle 产物路径（--bundles app）。 */
export function appBundlePath(desktopRoot, productName) {
  return join(desktopRoot, "src-tauri", "target", "release", "bundle", "macos", `${productName}.app`);
}

/** 部署目标路径：~/Applications/{productName}.app */
export function deployDestination(productName) {
  return join(homedir(), "Applications", `${productName}.app`);
}

/**
 * 停掉目标 .app 里的所有进程。
 * 匹配规则：可执行路径以 .app 目录为前缀。
 * 覆盖托盘主进程、sidecar、以及 agent-runtime 里的 node 子进程。
 */
export function stopAppBundle(appPath) {
  const normalized = resolve(appPath);
  try {
    const psOutput = execFileSync("ps", ["-eo", "pid,comm"], { encoding: "utf8" });
    const pids = [];
    for (const line of psOutput.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("PID")) continue;
      const parts = trimmed.split(/\s+/);
      const pid = parts[0];
      if (!pid) continue;
      try {
        const exePath = execFileSync("ps", ["-p", pid, "-o", "args="], { encoding: "utf8" });
        if (exePath.trim().startsWith(normalized)) {
          pids.push(pid);
        }
      } catch {
        // 进程可能已退出
      }
    }
    if (pids.length > 0) {
      console.log(`停止 ${pids.length} 个进程：${pids.join(" ")}`);
      execFileSync("kill", ["-9", ...pids], { stdio: "inherit" });
    }
  } catch (error) {
    // ps 失败不阻塞部署
    console.warn(`停进程时出错（继续部署）：${error.message}`);
  }
}

export function deployMacosEdition(editionId) {
  if (editionId !== "release" && editionId !== "dev") {
    throw new Error(`部署档只能是 release 或 dev，当前是 ${editionId}`);
  }
  if (process.platform !== "darwin") {
    throw new Error("本地部署只用于 macOS。两档都通过 ditto 复制 .app 到 ~/Applications。");
  }

  const label = editionId === "dev" ? "开发版" : "正式版";
  const other = editionId === "dev" ? "正式版" : "开发版";
  process.env.NOVOARD_EDITION = editionId;
  try {
    const edition = bakeEdition();
    const tauriConf = JSON.parse(readFileSync(join(DESKTOP, "src-tauri", "tauri.conf.json"), "utf8"));
    assertReleaseMatches(tauriConf);

    const destination = deployDestination(edition.productName);
    const tauriArgs = ["exec", "--", "tauri", "build", "--bundles", "app"];
    if (editionId === "dev") {
      const overlayPath = join(DESKTOP, "src-tauri", "target", "edition-overlay.json");
      mkdirSync(dirname(overlayPath), { recursive: true });
      writeFileSync(overlayPath, JSON.stringify(tauriOverlay(edition, tauriConf), null, 2));
      tauriArgs.push("--config", "src-tauri/target/edition-overlay.json");
    }

    console.log(`${label}安装目录：${destination}`);
    console.log(`数据目录：~/Library/Application Support/${edition.identifier}`);

    run(process.execPath, ["scripts/build-agent.mjs"]);
    run(process.execPath, ["scripts/stage-agent-runtime.mjs"]);
    run(process.execPath, ["scripts/stage-desktop-sidecar.mjs"]);
    runNpm(tauriArgs, DESKTOP);

    const appPath = appBundlePath(DESKTOP, edition.productName);
    if (!existsSync(join(appPath, "Contents", "Info.plist"))) {
      throw new Error(`缺少 .app 产物：${appPath}`);
    }

    stopAppBundle(destination);
    if (existsSync(destination)) {
      console.log(`删除旧 ${label}：${destination}`);
      rmSync(destination, { recursive: true, force: true });
    }
    mkdirSync(dirname(destination), { recursive: true });
    console.log(`复制${label}（ditto）`);
    execFileSync("ditto", [appPath, destination], { stdio: "inherit" });

    if (!existsSync(join(destination, "Contents", "Info.plist"))) {
      throw new Error(`安装结束，但没有在 ${destination} 找到 Contents/Info.plist`);
    }

    console.log(`${label}已安装：${destination}`);
    console.log(`数据目录与${other}分开：~/Library/Application Support/${edition.identifier}`);
    console.log("Launchpad 和 Spotlight 中可找到该应用。");
  } finally {
    process.env.NOVOARD_EDITION = "release";
    bakeEdition({ NOVOARD_EDITION: "release" });
  }
}
