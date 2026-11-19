import assert from "node:assert/strict";
import test from "node:test";
import { createOutputDecoder, incompleteGbkTail, incompleteUtf8Tail } from "../src/output-decoder.mjs";

const GBK_ZHONGWEN = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // 中文

function decodeAll(decoder, chunks) {
  return chunks.map((chunk) => decoder.write(chunk)).join("") + decoder.end();
}

test("Windows 上 UTF-8 输出原样解码", () => {
  const decoder = createOutputDecoder({ platform: "win32" });
  assert.equal(decodeAll(decoder, [Buffer.from("构建成功 ok\n", "utf8")]), "构建成功 ok\n");
});

test("Windows 上 GBK 输出回退解码", () => {
  const decoder = createOutputDecoder({ platform: "win32" });
  assert.equal(decodeAll(decoder, [Buffer.concat([Buffer.from("x "), GBK_ZHONGWEN, Buffer.from("\r\n")])]), "x 中文\r\n");
});

test("UTF-8 多字节字符被分块切断也能拼回来", () => {
  const bytes = Buffer.from("中文输出", "utf8");
  const decoder = createOutputDecoder({ platform: "win32" });
  assert.equal(decodeAll(decoder, [bytes.subarray(0, 4), bytes.subarray(4, 7), bytes.subarray(7)]), "中文输出");
});

test("GBK 双字节字符被分块切断也能拼回来", () => {
  const decoder = createOutputDecoder({ platform: "win32" });
  const head = Buffer.concat([Buffer.from("a"), GBK_ZHONGWEN.subarray(0, 3)]);
  assert.equal(decodeAll(decoder, [head, GBK_ZHONGWEN.subarray(3)]), "a中文");
});

test("非 Windows 只走 UTF-8", () => {
  const bytes = Buffer.from("日志", "utf8");
  const decoder = createOutputDecoder({ platform: "linux" });
  assert.equal(decodeAll(decoder, [bytes.subarray(0, 2), bytes.subarray(2)]), "日志");
});

test("尾部字节计数", () => {
  assert.equal(incompleteUtf8Tail(Buffer.from("ab", "utf8")), 0);
  assert.equal(incompleteUtf8Tail(Buffer.from("中", "utf8").subarray(0, 2)), 2);
  assert.equal(incompleteGbkTail(GBK_ZHONGWEN), 0);
  assert.equal(incompleteGbkTail(GBK_ZHONGWEN.subarray(0, 3)), 1);
});
