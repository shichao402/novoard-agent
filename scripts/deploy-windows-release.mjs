/**
 * Windows 本地正式版部署。
 *
 * 与开发版同一条路：打 currentUser 的 NSIS，再用 /S /D= 静默覆盖安装到
 * %LOCALAPPDATA% 下 release.installDirName。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deployWindowsEdition } from "./deploy-windows-edition.mjs";

export { nsisArch, nsisSetupFileName, nsisSilentArgs, nsisSilentCommand } from "./nsis-silent.mjs";

export function isDirectRun(entry = process.argv[1], url = import.meta.url) {
  if (!entry) return false;
  return url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  try {
    deployWindowsEdition("release");
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
