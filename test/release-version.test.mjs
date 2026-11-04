import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertTagMatches, checkVersion, readVersion, syncVersion } from "../scripts/version.mjs";

const REPO = new URL("..", import.meta.url).pathname;

test("仓库里所有清单版本都与 VERSION.json 一致", () => {
  const { version, drift } = checkVersion(REPO);
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(drift, [], "执行 npm run version:sync 后提交");
});

test("VERSION.json 只接受 x.y.z", (t) => {
  const root = fixture(t, "0.1.0");
  for (const bad of ["1.2", "1.2.3-rc.1", "1.2.3+4", "01.2.3"]) {
    writeJson(join(root, "VERSION.json"), { schema: "novoard.version/1", version: bad });
    assert.throws(() => readVersion(root), /x\.y\.z/);
  }
  writeJson(join(root, "VERSION.json"), { schema: "other", version: "1.2.3" });
  assert.throws(() => readVersion(root), /schema/);
});

test("version:sync 把 VERSION.json 写进 npm、Tauri 与 Cargo 清单", (t) => {
  const root = fixture(t, "0.1.0");
  writeJson(join(root, "VERSION.json"), { schema: "novoard.version/1", version: "2.3.4" });
  assert.equal(checkVersion(root).drift.length, 7);

  const { version, changed } = syncVersion(root);
  assert.equal(version, "2.3.4");
  assert.equal(changed.length, 7);
  assert.deepEqual(checkVersion(root).drift, []);
  assert.equal(readJson(join(root, "package-lock.json")).packages[""].version, "2.3.4");
  assert.equal(readJson(join(root, "desktop", "package-lock.json")).packages[""].version, "2.3.4");
  assert.match(readFileSync(join(root, "desktop", "src-tauri", "Cargo.toml"), "utf8"), /version = "2\.3\.4"/);
  const lock = readFileSync(join(root, "desktop", "src-tauri", "Cargo.lock"), "utf8");
  assert.match(lock, /name = "novoard-agent-desktop"\r\nversion = "2\.3\.4"/);
  assert.match(lock, /name = "other"\r\nversion = "9\.9\.9"/, "只改本包，不碰依赖");
  assert.deepEqual(syncVersion(root).changed, [], "再次同步无变化");
});

test("stable tag 必须等于 v<VERSION.json>", () => {
  assertTagMatches("v1.2.3", "1.2.3");
  assert.throws(() => assertTagMatches("v1.2.4", "1.2.3"), /v1\.2\.3/);
  assert.throws(() => assertTagMatches("", "1.2.3"), /<空>/);
});

function fixture(t, version) {
  const root = mkdtempSync(join(tmpdir(), "novoard-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "desktop", "src-tauri"), { recursive: true });
  const lock = (name) => ({ name, version, packages: { "": { name, version } } });
  writeJson(join(root, "VERSION.json"), { schema: "novoard.version/1", version });
  writeJson(join(root, "package.json"), { name: "novoard-agent", version });
  writeJson(join(root, "package-lock.json"), lock("novoard-agent"));
  writeJson(join(root, "desktop", "package.json"), { name: "novoard-agent-desktop", version });
  writeJson(join(root, "desktop", "package-lock.json"), lock("novoard-agent-desktop"));
  writeJson(join(root, "desktop", "src-tauri", "tauri.conf.json"), { productName: "Novoard Agent", version });
  writeFileSync(
    join(root, "desktop", "src-tauri", "Cargo.toml"),
    `[package]\r\nname = "novoard-agent-desktop"\r\nversion = "${version}"\r\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "desktop", "src-tauri", "Cargo.lock"),
    `version = 4\r\n\r\n[[package]]\r\nname = "novoard-agent-desktop"\r\nversion = "${version}"\r\n\r\n[[package]]\r\nname = "other"\r\nversion = "9.9.9"\r\n`,
    "utf8",
  );
  return root;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value), "utf8");
}
