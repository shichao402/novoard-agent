import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeRelease, editionForChannel, releaseCodeFromVersion, semverFromVersion } from "../scripts/relkit-version.mjs";
import { TARGETS, artifactNames, validateInput } from "../scripts/relkit_producer.mjs";
import { relkitPlatform } from "../scripts/stage-relkit.mjs";

const input = (overrides = {}) => ({
  schema: "relkit.artifact-producer-input/2",
  product: "novoard-agent",
  version: "0.3.3+412",
  channel: "stable",
  target: "darwin-arm64",
  outputDirectory: "/tmp/out",
  ...overrides,
});

test("stable 的 tag 必须等于 v<VERSION.json>，code 作 build 元数据", () => {
  const release = computeRelease({ channel: "stable", tag: "v0.4.0", baseVersion: "0.4.0", code: "412" });
  assert.deepEqual(release, { channel: "stable", code: 412, semver: "0.4.0", version: "0.4.0+412", edition: "release" });
  assert.throws(() => computeRelease({ channel: "stable", tag: "v0.4.1", baseVersion: "0.4.0", code: 3 }), /VERSION\.json/);
  assert.throws(() => computeRelease({ channel: "stable", tag: "main", baseVersion: "0.4.0", code: 3 }), /v0\.4\.0/);
});

test("dev 版本取 VERSION.json 并带 dev.<code>", () => {
  const release = computeRelease({ channel: "dev", baseVersion: "0.3.3", code: 7 });
  assert.equal(release.version, "0.3.3-dev.7+7");
  assert.equal(release.semver, "0.3.3");
  assert.equal(release.edition, "dev");
  assert.throws(() => computeRelease({ channel: "beta", baseVersion: "0.3.3", code: 7 }), /stable 或 dev/);
});

test("releaseCode 只接受服务器分配的正整数", () => {
  for (const code of [0, -1, "", undefined, "abc", 1.5]) {
    assert.throws(() => computeRelease({ channel: "dev", baseVersion: "0.3.3", code }), /服务器分配的正整数/);
  }
  assert.throws(() => computeRelease({ channel: "dev", baseVersion: "0.3", code: 1 }), /x\.y\.z/);
});

test("producer 从 version 取回 releaseCode 与 x.y.z", () => {
  assert.equal(releaseCodeFromVersion("0.4.0+412"), 412);
  assert.equal(releaseCodeFromVersion("0.3.3-dev.7+7"), 7);
  assert.throws(() => releaseCodeFromVersion("0.4.0"), /\+<releaseCode>/);
  assert.equal(semverFromVersion("0.4.0+412"), "0.4.0");
  assert.equal(semverFromVersion("0.3.3-dev.7+7"), "0.3.3");
  assert.throws(() => semverFromVersion("0.3.3-rc.1+7"), /x\.y\.z/);
  assert.equal(editionForChannel("stable"), "release");
  assert.equal(editionForChannel("dev"), "dev");
});

test("producer 校验输入并解析出构建参数", () => {
  const job = validateInput(input());
  assert.equal(job.triple, "aarch64-apple-darwin");
  assert.equal(job.code, 412);
  assert.equal(job.edition, "release");
  assert.throws(() => validateInput(input({ schema: "x" })), /schema/);
  assert.throws(() => validateInput(input({ product: "other" })), /product/);
  assert.throws(() => validateInput(input({ target: "linux-amd64" })), /不支持的 target/);
  assert.throws(() => validateInput(input({ channel: "beta" })), /stable 或 dev/);
});

test("制品文件名按档位与 target 区分，且不含 + 和空格", () => {
  const names = Object.keys(TARGETS).flatMap((target) =>
    ["release", "dev"].flatMap((edition) => Object.values(artifactNames({ semver: "0.4.0", code: 412, target, edition }))),
  );
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.doesNotMatch(name, /[+\s]/);
  assert.deepEqual(artifactNames({ semver: "0.4.0", code: 9, target: "windows-amd64", edition: "dev" }), {
    installer: "novoard-agent-dev-0.4.0-9-windows-amd64-setup.exe",
    payload: "novoard-agent-dev-0.4.0-9-windows-amd64.payload.zip",
  });
});

test("producer 的 target 与 relkit 平台、项目配置一致", () => {
  for (const [target, { triple }] of Object.entries(TARGETS)) assert.equal(relkitPlatform(triple), target);
  const project = JSON.parse(readFileSync(new URL("../relkit.project.json", import.meta.url), "utf8"));
  assert.equal(project.product, "novoard-agent");
  assert.deepEqual(project.artifactProducer.command, ["node", "scripts/relkit_producer.mjs"]);
  assert.equal(project.channels, undefined, "渠道由服务器定义，项目不声明（relkit ADR 0024）");
});
