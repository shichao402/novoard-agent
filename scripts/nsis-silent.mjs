/**
 * Tauri currentUser NSIS 的静默安装。
 *
 * /D 必须是最后一项，且不能加引号，否则 NSIS 不认安装目录。
 * 安装目录用 edition 的 installDirName，不拿可能带空格的产品名当文件夹。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

export function nsisArch(arch = process.arch) {
  if (arch === "x64" || arch === "arm64") return arch;
  if (arch === "ia32") return "x86";
  throw new Error(`NSIS 不支持架构 ${arch}`);
}

export function nsisSetupFileName(productName, version, arch = process.arch) {
  return `${productName}_${version}_${nsisArch(arch)}-setup.exe`;
}

export function nsisInstallerPath(desktopRoot, productName, version, arch = process.arch) {
  return join(
    desktopRoot,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "nsis",
    nsisSetupFileName(productName, version, arch),
  );
}

/** /D 必须是最后一项，且不能加引号，否则 NSIS 不认安装目录。 */
export function nsisSilentArgs(destination) {
  return ["/S", `/D=${destination}`];
}

/**
 * cmd /s /c 会剥掉首尾引号。安装包路径含空格，所以单独加引号；
 * /D 的目录含空格，但必须留在引号外。
 */
export function nsisSilentCommand(installer, destination) {
  return `""${installer}" ${nsisSilentArgs(destination).join(" ")}"`;
}

export function stopInstallDir(destination) {
  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$dest = ${ps(destination)}; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ($dest + '\\*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ], { stdio: "inherit" });
}

export function installSilently(installer, destination) {
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", nsisSilentCommand(installer, destination)], {
    stdio: "inherit",
    windowsVerbatimArguments: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`NSIS 静默安装失败，退出码 ${result.status ?? "无"}`);
  }
}

function ps(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
