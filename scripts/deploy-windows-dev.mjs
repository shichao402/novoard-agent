/**
 * Windows 本地开发版部署。
 *
 * 与正式版同一条路：打 currentUser 的 NSIS，再用 /S /D= 静默安装到
 * %LOCALAPPDATA% 下 dev.installDirName（正式版目录名后加 Dev）。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deployWindowsEdition } from "./deploy-windows-edition.mjs";

function isDirectRun(entry = process.argv[1], url = import.meta.url) {
  if (!entry) return false;
  return url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  try {
    deployWindowsEdition("dev");
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
