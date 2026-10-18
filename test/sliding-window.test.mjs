import assert from "node:assert/strict";
import test from "node:test";
import { indexAt, prefixHeights, resolveWindow, windowBounds } from "../desktop/src/lib/sliding-window.mjs";

test("前缀和把没量过的高度当成估算值", () => {
  const prefix = prefixHeights([40, 0, 80], 72);
  assert.deepEqual(prefix, [0, 40, 112, 192]);
});

test("indexAt 落在条目内部时返回该条", () => {
  const prefix = [0, 100, 200, 300];
  assert.equal(indexAt(prefix, 0), 0);
  assert.equal(indexAt(prefix, 100), 1);
  assert.equal(indexAt(prefix, 150), 1);
  assert.equal(indexAt(prefix, 299), 2);
  assert.equal(indexAt(prefix, 5000), 2);
});

test("窗口包含视口两侧的过扫描，不装进更远的条目", () => {
  const prefix = prefixHeights(Array.from({ length: 100 }, () => 100), 100);
  const view = windowBounds(prefix, 5000, 500, 200);
  assert.equal(prefix[view.start] <= 4800, true);
  assert.equal(prefix[view.start + 1] > 4800, true);
  assert.equal(prefix[view.end - 1] < 5700, true);
  assert.equal(prefix[view.end] >= 5700, true);
  assert.equal(view.end - view.start < 20, true);
});

test("内容装得下时窗口就是全部", () => {
  const prefix = prefixHeights([40, 40, 40], 72);
  assert.deepEqual(windowBounds(prefix, 0, 800, 960), { start: 0, end: 3 });
});

test("还在保留带里就沿用旧窗口，滑出后才换窗", () => {
  const prefix = prefixHeights(Array.from({ length: 80 }, () => 100), 100);
  const first = windowBounds(prefix, 4000, 500, 960);
  const held = resolveWindow(prefix, 4300, 500, first, 960, 480);
  assert.deepEqual(held, first);
  const shifted = resolveWindow(prefix, 5200, 500, first, 960, 480);
  assert.equal(shifted.start > first.start, true);
  assert.equal(shifted.end > first.end, true);
  assert.equal(shifted.end - shifted.start < 40, true);
});
