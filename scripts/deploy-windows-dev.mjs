/**
 * Windows 本地开发版部署。
 *
 * NSIS currentUser 的默认目录来自 edition.json 的 release.installDirName。
 * 开发版放到同级的 dev.installDirName。名字、图标、标识都读这一份宏，
 * 并在本次构建里写进桌面壳、界面和会话进程。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseMatches, bakeEdition, loadEditions, tauriOverlay } from "./edition.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "desktop");
const RELEASE = join(DESKTOP, "src-tauri", "target", "release");

if (process.platform !== "win32") {
  throw new Error("desktop:dev-deploy 只用于 Windows。NSIS 默认安装目录是 currentUser 的 LocalAppData。");
}
if (!process.env.LOCALAPPDATA) {
  throw new Error("缺少 LOCALAPPDATA，无法定位 NSIS 默认安装目录。");
}

process.env.NOVOARD_EDITION = "dev";
const release = loadEditions().release;
const edition = bakeEdition();
const tauriConf = JSON.parse(readFileSync(join(DESKTOP, "src-tauri", "tauri.conf.json"), "utf8"));
assertReleaseMatches(tauriConf);

const destination = join(process.env.LOCALAPPDATA, edition.installDirName);
const officialDir = join(process.env.LOCALAPPDATA, release.installDirName);
const overlayPath = join(DESKTOP, "src-tauri", "target", "edition-overlay.json");

function run(file, args, cwd = ROOT) {
  execFileSync(file, args, { cwd, stdio: "inherit", env: process.env });
}

function runNpm(args, cwd) {
  execFileSync("npm", args, { cwd, stdio: "inherit", shell: true, env: process.env });
}

console.log(`正式版 NSIS 默认目录：${officialDir}`);
console.log(`开发版部署目录：${destination}`);

try {
  run(process.execPath, ["scripts/build-agent.mjs"]);
  run(process.execPath, ["scripts/stage-agent-runtime.mjs"]);
  run(process.execPath, ["scripts/stage-desktop-sidecar.mjs"]);
  mkdirSync(dirname(overlayPath), { recursive: true });
  writeFileSync(overlayPath, JSON.stringify(tauriOverlay(edition, tauriConf), null, 2));
  runNpm(["exec", "--", "tauri", "build", "--no-bundle", "--config", "src-tauri/target/edition-overlay.json"], DESKTOP);

  const desktopExe = join(RELEASE, "novoard-agent-desktop.exe");
  const sidecarExe = join(RELEASE, "novoard-agent.exe");
  const runtime = join(RELEASE, "agent-runtime");
  for (const path of [desktopExe, sidecarExe, runtime]) {
    if (!existsSync(path)) throw new Error(`缺少构建产物：${path}`);
  }

  run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$dest = ${ps(destination)}; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($dest + '\\*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ]);

  mkdirSync(destination, { recursive: true });
  cpSync(desktopExe, join(destination, "novoard-agent-desktop.exe"));
  cpSync(sidecarExe, join(destination, "novoard-agent.exe"));
  rmSync(join(destination, "agent-runtime"), { recursive: true, force: true });
  cpSync(runtime, join(destination, "agent-runtime"), { recursive: true });
  const consoleDist = join(DESKTOP, "dist");
  rmSync(join(destination, "ui"), { recursive: true, force: true });
  if (existsSync(join(consoleDist, "index.html"))) {
    cpSync(consoleDist, join(destination, "ui"), { recursive: true });
  }

  console.log(`开发版已部署：${destination}`);
  console.log(`启动：${join(destination, "novoard-agent-desktop.exe")}`);
  console.log(`数据目录与正式版分开：%APPDATA%\\${edition.identifier}`);
} finally {
  bakeEdition({ NOVOARD_EDITION: "release" });
}

function ps(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
