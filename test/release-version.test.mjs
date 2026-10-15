import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncReleaseVersion, versionFromTag } from "../scripts/sync-release-version.mjs";

test("release tag 必须是 v<semver>", () => {
  assert.equal(versionFromTag("v1.2.3"), "1.2.3");
  assert.equal(versionFromTag("v1.2.3-rc.1"), "1.2.3-rc.1");
  assert.throws(() => versionFromTag("release-1.2.3"), /v<semver>/);
});

test("release tag 同步 npm、Tauri 与 Rust 产品版本", (t) => {
  const root = mkdtempSync(join(tmpdir(), "novoard-release-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "desktop", "src-tauri"), { recursive: true });

  writeJson(join(root, "package.json"), { name: "novoard-agent", version: "0.1.0" });
  writeJson(join(root, "package-lock.json"), {
    name: "novoard-agent",
    version: "0.1.0",
    packages: { "": { name: "novoard-agent", version: "0.1.0" } },
  });
  writeJson(join(root, "desktop", "src-tauri", "tauri.conf.json"), {
    productName: "Novoard Agent",
    version: "0.1.0",
  });
  writeFileSync(
    join(root, "desktop", "src-tauri", "Cargo.toml"),
    `[package]\r\nname = "novoard-agent-desktop"\r\nversion = "0.1.0"\r\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "desktop", "src-tauri", "Cargo.lock"),
    `version = 4\r\n\r\n[[package]]\r\nname = "novoard-agent-desktop"\r\nversion = "0.1.0"\r\n`,
    "utf8",
  );

  assert.equal(syncReleaseVersion({ root, tag: "v2.3.4" }), "2.3.4");
  assert.equal(readJson(join(root, "package.json")).version, "2.3.4");
  assert.equal(readJson(join(root, "package-lock.json")).packages[""].version, "2.3.4");
  assert.equal(readJson(join(root, "desktop", "src-tauri", "tauri.conf.json")).version, "2.3.4");
  assert.match(readFileSync(join(root, "desktop", "src-tauri", "Cargo.toml"), "utf8"), /version = "2\.3\.4"/);
  assert.match(readFileSync(join(root, "desktop", "src-tauri", "Cargo.lock"), "utf8"), /version = "2\.3\.4"/);
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value), "utf8");
}
