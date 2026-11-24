import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { filterSelectOptions } from "../desktop/src/lib/select-options.mjs";

const options = [
  { value: "trunk", label: "主干", hint: "常驻，就绪" },
  { value: "OSTY_S2_20261116", label: "体验服", hint: "最近提交，需切换" },
  { value: "OSPub_S2", label: "发布服", hint: "阻塞：SVN conflict" },
  { value: "Unity", label: "打开工程" },
];

test("所有下拉筛选：空白保持来源顺序，名称 / 值 / 提示均可查", () => {
  assert.equal(filterSelectOptions(options, "  "), options);
  assert.deepEqual(filterSelectOptions(options, "体验"), [options[1]]);
  assert.deepEqual(filterSelectOptions(options, "osty_s2"), [options[1]]);
  assert.deepEqual(filterSelectOptions(options, "常驻"), [options[0]]);
  assert.deepEqual(filterSelectOptions(options, "SVN"), [options[2]]);
  assert.deepEqual(filterSelectOptions(options, "不存在"), []);
});

test("所有下拉筛选：多关键词取交集，全半角与大小写无关，特殊字符按字面匹配", () => {
  assert.deepEqual(filterSelectOptions(options, "s2 切换"), [options[1]]);
  assert.deepEqual(filterSelectOptions(options, "ＵＮＩＴＹ"), [options[3]]);
  assert.deepEqual(filterSelectOptions(options, ".*"), []);
  assert.deepEqual(filterSelectOptions([{ value: "x", label: "工具", searchText: "pack/tool" }], "pack/tool").length, 1);
});

test("所有下拉筛选：不得绕过共用 Select 增加原生 select 或 datalist", () => {
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (path.endsWith(".tsx") && entry.name !== "select.tsx") {
        assert.doesNotMatch(readFileSync(path, "utf8"), /<(select|datalist)\b/, `${path} 应使用共用的可筛选 Select`);
      }
    }
  }
  scan(fileURLToPath(new URL("../desktop/src", import.meta.url)));
});
