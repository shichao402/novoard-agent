/**
 * 产品版本 SSOT：根目录 VERSION.json 只记 x.y.z。
 *
 * npm、Tauri、Cargo 各自的清单都是派生文件，由 `npm run version:sync` 从 SSOT 写入并入库；
 * `npm run version:check`（npm test 会跑）在任一派生文件漂移时失败。
 * releaseCode 不在这里：它由 relkit 服务器分配（relkit ADR 0025），见 scripts/relkit-version.mjs。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION_SCHEMA = "novoard.version/1";
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CARGO_MANIFEST = /(\[package\][\s\S]*?\r?\nversion = ")([^"]+)(")/;
const CARGO_LOCK = /(\[\[package\]\]\r?\nname = "novoard-agent-desktop"\r?\nversion = ")([^"]+)(")/;

export function readVersion(root = ROOT) {
  const path = resolve(root, "VERSION.json");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (doc?.schema !== VERSION_SCHEMA) throw new Error(`VERSION.json schema 应为 ${VERSION_SCHEMA}，实际 ${doc?.schema}`);
  if (!SEMVER.test(String(doc.version ?? ""))) throw new Error(`VERSION.json 的 version 必须是 x.y.z，实际 ${doc.version}`);
  return doc.version;
}

/** stable 由 tag 触发：tag 只能是 v<VERSION.json>，不再反向改写清单。 */
export function assertTagMatches(tag, version) {
  const value = String(tag ?? "").trim();
  if (value !== `v${version}`) {
    throw new Error(`stable tag 必须等于 v${version}（VERSION.json），实际为 ${value || "<空>"}；先改 VERSION.json 并 version:sync，再打 tag`);
  }
}

/** 每个派生文件：读出当前版本、写入目标版本。 */
function derivedFiles(root) {
  const json = (path, keys) => ({
    path: resolve(root, path),
    read(text) {
      const doc = JSON.parse(text);
      return keys.map((key) => key.reduce((node, part) => node?.[part], doc));
    },
    write(text, version) {
      const doc = JSON.parse(text);
      for (const key of keys) {
        const parent = key.slice(0, -1).reduce((node, part) => node?.[part], doc);
        if (parent && key.at(-1) in parent) parent[key.at(-1)] = version;
      }
      return `${JSON.stringify(doc, null, 2)}\n`;
    },
  });
  const pattern = (path, regex, label) => ({
    path: resolve(root, path),
    read(text) {
      const match = regex.exec(text);
      if (!match) throw new Error(`${label} 缺少版本字段`);
      return [match[2]];
    },
    write(text, version) {
      if (!regex.test(text)) throw new Error(`${label} 缺少版本字段`);
      return text.replace(regex, `$1${version}$3`);
    },
  });
  const lockKeys = [["version"], ["packages", "", "version"]];
  return [
    json("package.json", [["version"]]),
    json("package-lock.json", lockKeys),
    json("desktop/package.json", [["version"]]),
    json("desktop/package-lock.json", lockKeys),
    json("desktop/src-tauri/tauri.conf.json", [["version"]]),
    pattern("desktop/src-tauri/Cargo.toml", CARGO_MANIFEST, "Cargo.toml [package]"),
    pattern("desktop/src-tauri/Cargo.lock", CARGO_LOCK, "Cargo.lock novoard-agent-desktop"),
  ];
}

/** 返回与 SSOT 不一致的派生文件（相对路径 + 实际值）。 */
export function checkVersion(root = ROOT) {
  const version = readVersion(root);
  const drift = [];
  for (const file of derivedFiles(root)) {
    const values = file.read(readFileSync(file.path, "utf8")).filter((value) => value !== undefined);
    const wrong = values.filter((value) => value !== version);
    if (values.length === 0 || wrong.length) drift.push({ path: relative(root, file.path), actual: wrong[0] ?? "<缺失>" });
  }
  return { version, drift };
}

export function syncVersion(root = ROOT) {
  const version = readVersion(root);
  const changed = [];
  for (const file of derivedFiles(root)) {
    const before = readFileSync(file.path, "utf8");
    const after = file.write(before, version);
    if (after !== before) {
      writeFileSync(file.path, after, "utf8");
      changed.push(relative(root, file.path));
    }
  }
  return { version, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const action = process.argv[2];
    if (action === "sync") {
      const { version, changed } = syncVersion();
      console.log(`✓ 版本 ${version} 已同步${changed.length ? `：${changed.join("、")}` : "（无变化）"}`);
    } else if (action === "check") {
      const { version, drift } = checkVersion();
      if (drift.length) {
        for (const item of drift) console.error(`✗ ${item.path} 是 ${item.actual}，VERSION.json 是 ${version}`);
        throw new Error("派生文件与 VERSION.json 不一致；执行 npm run version:sync 后提交");
      }
      console.log(`✓ 所有清单版本与 VERSION.json 一致：${version}`);
    } else {
      throw new Error("用法：node scripts/version.mjs <sync|check>");
    }
  } catch (error) {
    console.error(`版本处理失败：${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
