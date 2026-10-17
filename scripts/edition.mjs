/**
 * 版本宏的唯一来源是仓库根目录的 edition.json。
 * 构建时读 NOVOARD_EDITION（dev 或 release），把选中的那一档写进各端二进制。
 * 运行时只读写进去的结果，不再回看环境变量。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EDITION_FILE = join(ROOT, "edition.json");
export const BAKED_EDITION_FILE = join(ROOT, "src", "edition.gen.mjs");

export function loadEditions() {
  return JSON.parse(readFileSync(EDITION_FILE, "utf8"));
}

export function editionId(env = process.env) {
  const id = env.NOVOARD_EDITION || "release";
  if (id !== "release" && id !== "dev") {
    throw new Error(`NOVOARD_EDITION 只能是 release 或 dev，当前是 ${id}`);
  }
  return id;
}

export function resolveEdition(env = process.env) {
  const id = editionId(env);
  const edition = loadEditions()[id];
  if (!edition) throw new Error(`edition.json 缺少 ${id}`);
  const port = edition.localPort;
  if (!Number.isInteger(port) || port < 10000 || port > 65535) {
    throw new Error(`${id} 的 localPort 必须是 10000–65535 的固定端口，当前是 ${port}`);
  }
  return edition;
}

export function bakeEdition(env = process.env) {
  const edition = resolveEdition(env);
  writeFileSync(
    BAKED_EDITION_FILE,
    `/** 构建时从 edition.json 写入。运行时只读这份结果。 */\nexport const edition = ${JSON.stringify(edition, null, 2)};\n`,
  );
  return edition;
}

export function tauriOverlay(edition, tauriConf) {
  const windows = (tauriConf.app?.windows ?? []).map((window) => ({
    ...window,
    title: edition.windowTitle,
  }));
  return {
    productName: edition.productName,
    identifier: edition.identifier,
    app: { windows },
    bundle: { icon: edition.icons },
  };
}

export function assertReleaseMatches(tauriConf) {
  const release = loadEditions().release;
  const mismatches = [];
  if (tauriConf.productName !== release.productName) mismatches.push("productName");
  if (tauriConf.identifier !== release.identifier) mismatches.push("identifier");
  if (tauriConf.app?.windows?.[0]?.title !== release.windowTitle) mismatches.push("windowTitle");
  if (JSON.stringify(tauriConf.bundle?.icon ?? []) !== JSON.stringify(release.icons)) mismatches.push("icon");
  if (mismatches.length) {
    throw new Error(`tauri.conf.json 与 edition.json 的 release 不一致：${mismatches.join("、")}`);
  }
}
