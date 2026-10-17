import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertReleaseMatches, BAKED_EDITION_FILE, bakeEdition, editionId, loadEditions, resolveEdition } from "../scripts/edition.mjs";
import { pinEditionListenPort, pinPanelPort } from "../src/config.mjs";
import { edition } from "../src/edition.mjs";

const tauriConf = JSON.parse(readFileSync(join("desktop", "src-tauri", "tauri.conf.json"), "utf8"));

test("版本宏默认是 release，开发档由 NOVOARD_EDITION 选中", () => {
  assert.equal(editionId({}), "release");
  const release = resolveEdition({});
  const dev = resolveEdition({ NOVOARD_EDITION: "dev" });
  assert.equal(release.id, "release");
  assert.equal(dev.id, "dev");
  assert.notEqual(release.productName, dev.productName);
  assert.notEqual(release.identifier, dev.identifier);
  assert.notEqual(release.icons[0], dev.icons[0]);
  assert.equal(dev.installDirName, `${release.installDirName}Dev`);
  assert.equal(dev.markTone, "dev");
  assert.equal(release.localPort, 41783);
  assert.equal(dev.localPort, 52641);
  assert.notEqual(release.localPort, dev.localPort);
  assert.throws(() => editionId({ NOVOARD_EDITION: "beta" }), /release 或 dev/);
});

test("tauri.conf.json 的正式版字段与 edition.json 一致", () => {
  assert.doesNotThrow(() => assertReleaseMatches(tauriConf));
  assert.equal(loadEditions().release.productName, tauriConf.productName);
});

test("构建写入的运行时宏就是当时选中的那一档", async (t) => {
  t.after(() => bakeEdition({}));
  const baked = bakeEdition({ NOVOARD_EDITION: "dev" });
  const fresh = await import(`${pathToFileURL(BAKED_EDITION_FILE).href}?dev=${Date.now()}`);
  assert.equal(fresh.edition.productName, baked.productName);
  assert.equal(fresh.edition.identifier, "com.novoard.agent.dev");
  bakeEdition({});
  const restored = await import(`${pathToFileURL(BAKED_EDITION_FILE).href}?release=${Date.now()}`);
  assert.equal(restored.edition.productName, resolveEdition({}).productName);
});

test("未指定或写成 0 的控制台端口回落到当前版本的固定端口", () => {
  const setup = {};
  assert.equal(pinEditionListenPort(setup), edition.localPort);
  assert.equal(setup.NOVOARD_SETUP_PORT, String(edition.localPort));
  const panel = {};
  assert.equal(pinPanelPort(0, panel), edition.localPort);
  assert.equal(panel.NOVOARD_LOCAL_PORT, String(edition.localPort));
  assert.equal(pinPanelPort(46000, {}), 46000);
  assert.equal(pinPanelPort(0, { NOVOARD_LOCAL_PORT: "45000" }), 45000);
});
