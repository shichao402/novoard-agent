/**
 * macOS 本地开发版部署。
 *
 * 与正式版同一条路：打 Tauri app bundle，再 ditto 到 ~/Applications。
 * 产品名、bundle id、图标、端口均与正式版不同，两档可同时运行。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deployMacosEdition } from "./deploy-macos-edition.mjs";

function isDirectRun(entry = process.argv[1], url = import.meta.url) {
  if (!entry) return false;
  return url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  try {
    deployMacosEdition("dev");
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
}
