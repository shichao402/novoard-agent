import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEditions } from "../scripts/edition.mjs";
import { isDirectRun, appBundlePath, deployDestination, stopAppBundle } from "../scripts/deploy-macos-release.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/deploy-macos-release.mjs", import.meta.url));

test("正式版 .app 产物路径与 Tauri 产物一致", () => {
  const { release } = loadEditions();
  const path = appBundlePath("/tmp/desktop", release.productName);
  assert.equal(path, "/tmp/desktop/src-tauri/target/release/bundle/macos/Novoard Agent.app");
});

test("开发版 .app 产物路径用开发版产品名", () => {
  const { dev } = loadEditions();
  const path = appBundlePath("/tmp/desktop", dev.productName);
  assert.equal(path, "/tmp/desktop/src-tauri/target/release/bundle/macos/Novoard Agent Dev.app");
});

test("部署目标路径在 ~/Applications 下，用产品名", () => {
  const { release, dev } = loadEditions();
  assert.equal(deployDestination(release.productName), join(homedir(), "Applications", "Novoard Agent.app"));
  assert.equal(deployDestination(dev.productName), join(homedir(), "Applications", "Novoard Agent Dev.app"));
});

test("两档部署路径不同，可共存", () => {
  const { release, dev } = loadEditions();
  assert.notEqual(deployDestination(release.productName), deployDestination(dev.productName));
});

test("停进程对不存在的路径不抛异常", () => {
  // 不存在的 .app 路径，ps 匹配不到任何进程，应静默完成
  assert.doesNotThrow(() => stopAppBundle("/tmp/does-not-exist.app"));
});

test("只有直接运行部署脚本时才安装", () => {
  assert.equal(isDirectRun(scriptPath), true);
  assert.equal(isDirectRun("test/deploy-macos-release.test.mjs"), false);
});
