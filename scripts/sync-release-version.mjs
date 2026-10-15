/**
 * Release 由 git tag 驱动；构建前把 npm 与 Tauri 的产品版本统一到 tag。
 * 源码清单中的版本仅是开发基线，发行安装包必须以 v<semver> tag 为准。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function versionFromTag(tag) {
  const value = String(tag ?? "").trim();
  if (!SEMVER_TAG.test(value)) {
    throw new Error(`发行 tag 必须是 v<semver>，实际为：${value || "<空>"}`);
  }
  return value.slice(1);
}

export function syncReleaseVersion({
  root = ROOT,
  tag = process.env.NOVOARD_RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
} = {}) {
  const version = versionFromTag(tag);
  const packagePath = resolve(root, "package.json");
  const lockPath = resolve(root, "package-lock.json");
  const tauriPath = resolve(root, "desktop", "src-tauri", "tauri.conf.json");
  const cargoPath = resolve(root, "desktop", "src-tauri", "Cargo.toml");
  const cargoLockPath = resolve(root, "desktop", "src-tauri", "Cargo.lock");

  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);
  const tauriConfig = readJson(tauriPath);
  const cargoToml = readFileSync(cargoPath, "utf8");
  const cargoLock = readFileSync(cargoLockPath, "utf8");

  packageJson.version = version;
  packageLock.version = version;
  if (packageLock.packages?.[""]) packageLock.packages[""].version = version;
  tauriConfig.version = version;

  writeJson(packagePath, packageJson);
  writeJson(lockPath, packageLock);
  writeJson(tauriPath, tauriConfig);
  writeFileSync(cargoPath, replaceCargoManifestVersion(cargoToml, version), "utf8");
  writeFileSync(cargoLockPath, replaceCargoLockVersion(cargoLock, version), "utf8");
  return version;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function replaceCargoManifestVersion(text, version) {
  const pattern = /(\[package\][\s\S]*?\r?\nversion = ")[^"]+(")/;
  if (!pattern.test(text)) throw new Error("Cargo.toml 缺少 [package] version");
  return text.replace(pattern, `$1${version}$2`);
}

function replaceCargoLockVersion(text, version) {
  const pattern = /(\[\[package\]\]\r?\nname = "novoard-agent-desktop"\r?\nversion = ")[^"]+(")/;
  if (!pattern.test(text)) throw new Error("Cargo.lock 缺少 novoard-agent-desktop package");
  return text.replace(pattern, `$1${version}$2`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = syncReleaseVersion();
    console.log(`✓ Release 产品版本已同步为 ${version}`);
  } catch (error) {
    console.error(`版本同步失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
