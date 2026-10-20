/**
 * 契约一致性夹具测试（需求 5）。
 *
 * 夹具本体在 hub 仓 conformance/frames.json（契约仓是夹具的持有方）。
 * 本仓以只读方式加载同一份文件，用本仓的校验器实现跑一遍：
 * 两侧实现有语义偏差时，这里会失败，而字节比对发现不了这种偏差。
 *
 * NOVOARD_HUB_ROOT 未设置时跳过（本地开发）；CI 必须设置，否则门禁不完整。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createFrameValidator } from "../src/contract/frames.mjs";
import { CONTRACT_VERSION } from "../src/contract/version.mjs";

const HUB_ROOT = process.env.NOVOARD_HUB_ROOT ? resolve(process.cwd(), process.env.NOVOARD_HUB_ROOT) : "";
const FIXTURE_PATH = HUB_ROOT ? join(HUB_ROOT, "conformance", "frames.json") : "";
const RUNNER_PATH = HUB_ROOT ? join(HUB_ROOT, "conformance", "run-fixture.mjs") : "";

test("共享夹具：本仓校验器对每个样本的结论与预期一致", async (t) => {
  if (!HUB_ROOT) {
    t.skip("未设置 NOVOARD_HUB_ROOT，跳过跨仓夹具（CI 必须设置）");
    return;
  }
  if (!existsSync(FIXTURE_PATH) || !existsSync(RUNNER_PATH)) {
    assert.fail(`夹具不可达：${FIXTURE_PATH}（跨仓夹具缺失应视为失败，不能静默跳过）`);
  }

  const { loadFixture, assertFixture } = await import(pathToFileURL(RUNNER_PATH).href);
  const fixture = loadFixture(FIXTURE_PATH);
  const validate = createFrameValidator();
  const { results, failed } = assertFixture({ validate, fixture, expectedVersion: CONTRACT_VERSION });

  assert.ok(results.length >= 30, `夹具用例数量异常：${results.length}`);
  assert.deepEqual(
    failed.map((f) => ({ id: f.id, target: f.target, expect: f.expect, actual: f.actual, errors: f.errors })),
    [],
    "存在与预期不一致的样本：说明本仓实现与契约存在语义偏差",
  );
});

test("共享夹具：用例覆盖帧层开放与信封层封闭两类关键行为", async (t) => {
  if (!HUB_ROOT) {
    t.skip("未设置 NOVOARD_HUB_ROOT，跳过跨仓夹具（CI 必须设置）");
    return;
  }
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const ids = new Set(fixture.cases.map((c) => c.id));

  // 这两条是契约 §0 演进策略的机械保证，缺任一条夹具就失去意义
  assert.ok(ids.has("good-hello-with-unknown-field"), "夹具应包含帧层未知字段被接受的样本");
  assert.ok(ids.has("bad-envelope-unknown-field"), "夹具应包含信封层未知字段被拒的样本");
  assert.ok(ids.has("bad-hello-card-missing-description"), "夹具应包含字段级失败样本（触发 hello nack 的场景）");
});
