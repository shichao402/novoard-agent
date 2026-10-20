/**
 * macOS 本地正式版部署。
 *
 * 与开发版同一条路：打 Tauri app bundle，再 ditto 到 ~/Applications。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deployMacosEdition } from "./deploy-macos-edition.mjs";

export { appBundlePath, deployDestination, stopAppBundle } from "./deploy-macos-edition.mjs";

export function isDirectRun(entry = process.argv[1], url = import.meta.url) {
  if (!entry) return false;
  return url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  try {
    deployMacosEdition("release");
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
