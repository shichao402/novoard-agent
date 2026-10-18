/**
 * Windows 本地部署。正式版和开发版走同一条路。
 *
 * 打 currentUser 的 NSIS，停掉目标目录里的进程，再用 /S /D= 静默安装。
 * 目录固定为 %LOCALAPPDATA% 下该档的 installDirName：
 * 开发版是正式版目录名后面加 Dev，不跟随产品名里的空格，
 * 也不跟随注册表里上一次向导选过的路径。
 *
 * tauri.conf.json 始终是正式档。开发档只在本次构建写入 overlay。
 * 构建结束把运行时宏恢复成正式档。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseMatches, bakeEdition, tauriOverlay } from "./edition.mjs";
import { installSilently, nsisInstallerPath, stopInstallDir } from "./nsis-silent.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "desktop");

function run(file, args, cwd = ROOT) {
  execFileSync(file, args, { cwd, stdio: "inherit", env: process.env });
}

function runNpm(args, cwd) {
  execFileSync("npm", args, { cwd, stdio: "inherit", shell: true, env: process.env });
}

export function deployWindowsEdition(editionId) {
  if (editionId !== "release" && editionId !== "dev") {
    throw new Error(`部署档只能是 release 或 dev，当前是 ${editionId}`);
  }
  if (process.platform !== "win32") {
    throw new Error("本地部署只用于 Windows。两档都通过 NSIS currentUser 安装到 %LOCALAPPDATA%。");
  }
  if (!process.env.LOCALAPPDATA) {
    throw new Error("缺少 LOCALAPPDATA，无法定位 NSIS 默认安装目录。");
  }

  const label = editionId === "dev" ? "开发版" : "正式版";
  const other = editionId === "dev" ? "正式版" : "开发版";
  process.env.NOVOARD_EDITION = editionId;
  try {
    const edition = bakeEdition();
    const tauriConf = JSON.parse(readFileSync(join(DESKTOP, "src-tauri", "tauri.conf.json"), "utf8"));
    assertReleaseMatches(tauriConf);

    const destination = join(process.env.LOCALAPPDATA, edition.installDirName);
    const installer = nsisInstallerPath(DESKTOP, edition.productName, tauriConf.version);
    const tauriArgs = ["exec", "--", "tauri", "build", "--bundles", "nsis"];
    if (editionId === "dev") {
      const overlayPath = join(DESKTOP, "src-tauri", "target", "edition-overlay.json");
      mkdirSync(dirname(overlayPath), { recursive: true });
      writeFileSync(overlayPath, JSON.stringify(tauriOverlay(edition, tauriConf), null, 2));
      tauriArgs.push("--config", "src-tauri/target/edition-overlay.json");
    }

    console.log(`${label}安装目录：${destination}`);
    console.log(`NSIS 安装包：${installer}`);

    run(process.execPath, ["scripts/build-agent.mjs"]);
    run(process.execPath, ["scripts/stage-agent-runtime.mjs"]);
    run(process.execPath, ["scripts/stage-desktop-sidecar.mjs"]);
    runNpm(tauriArgs, DESKTOP);

    if (!existsSync(installer)) throw new Error(`缺少 NSIS 安装包：${installer}`);

    stopInstallDir(destination);
    console.log(`静默安装${label}（/S）`);
    installSilently(installer, destination);

    if (!existsSync(join(destination, "uninstall.exe"))) {
      throw new Error(`安装结束，但没有在 ${destination} 找到 uninstall.exe`);
    }

    console.log(`${label}已安装：${destination}`);
    console.log(`数据目录与${other}分开：%APPDATA%\\${edition.identifier}`);
    console.log("安装包已写入开始菜单和桌面快捷方式。需要现在打开时，从那里启动。");
  } finally {
    process.env.NOVOARD_EDITION = "release";
    bakeEdition({ NOVOARD_EDITION: "release" });
  }
}
