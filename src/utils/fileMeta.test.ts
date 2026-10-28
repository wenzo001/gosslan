/**
 * 文件/图片消息载荷解析的契约测试。
 *
 * 这份解析被两处共用（消息气泡 `useMessageFile`、引用块 `viewQuoted`），而两处对"缺字段"
 * 的兜底**不同**：气泡那侧用传输记录和 i18n 默认名补，引用那侧没有传输记录，缺 path 就提示。
 * 所以这里要钉住的核心契约是：**只填载荷里真的存在且类型正确的字段**，别替调用方编默认值。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { displayPathFor, parseFileMeta } from "./fileMeta.ts";

test("完整载荷：字段原样取出（含 sha256）", () => {
  assert.deepEqual(
    parseFileMeta(
      JSON.stringify({
        name: "报告.pdf",
        path: "C:/files/a.pdf",
        size: 1234,
        subtype: "file",
        sha256: "abc",
      }),
    ),
    { name: "报告.pdf", path: "C:/files/a.pdf", size: 1234, subtype: "file", sha256: "abc" },
  );
});

test("缺字段 ≠ 编默认值：没有的键就不出现（调用方各自兜底）", () => {
  // 乐观上屏时只有名字与大小：path 缺失 ⇒ 结果里**没有** path（气泡那侧会用传输记录补）
  assert.deepEqual(parseFileMeta(JSON.stringify({ name: "a.png", size: 10 })), {
    name: "a.png",
    size: 10,
  });
  assert.deepEqual(parseFileMeta(JSON.stringify({ path: "C:/f" })), { path: "C:/f" });
  assert.deepEqual(parseFileMeta("{}"), {});
});

test("类型不对 / 空串 一律丢弃（不能把脏值当真的用）", () => {
  assert.deepEqual(
    parseFileMeta(JSON.stringify({ name: 42, path: "", size: "9", subtype: null, sha256: 7 })),
    {},
  );
  // size 允许 0（空文件是合法的），但 NaN/Infinity 不是
  assert.deepEqual(parseFileMeta(JSON.stringify({ size: 0 })), { size: 0 });
  assert.deepEqual(parseFileMeta(JSON.stringify({ size: Number.NaN })), {});
});

test("畸形载荷返回 null（与 parseTodo 等解析器同一种约定）", () => {
  for (const bad of ["", "{", "null", "0", '"str"', "[1,2]", "true"]) {
    assert.equal(parseFileMeta(bad), null, bad);
  }
});

test("旧格式（data URL 正文）不算文件元信息 ⇒ null", () => {
  // 开发阶段遗留的 image 消息正文可能是 data URL，那不是 JSON
  assert.equal(parseFileMeta("data:image/png;base64,AAAA"), null);
});


test("图片像素尺寸：正整数才收，坏值当没有（回退 288）", () => {
  assert.deepEqual(
    parseFileMeta(JSON.stringify({ name: "a.png", subtype: "image", w: 320, h: 180, path: "/x" })),
    { name: "a.png", path: "/x", subtype: "image", w: 320, h: 180 },
  );
  assert.deepEqual(parseFileMeta(JSON.stringify({ name: "a.png", w: 0, h: -1 })), { name: "a.png" });
  assert.deepEqual(parseFileMeta(JSON.stringify({ name: "a.png", w: "320", h: 180 })), {
    name: "a.png",
    h: 180,
  });
});

test("路径来源：台账优先；台账缺失时只有本机消息能用载荷 path（对端可控，SEC-01）", () => {
  // 台账到了 ⇒ 一律用台账（收到文件的真实落盘位置只在那里）
  assert.equal(displayPathFor("/dl/recv.pdf", "/peer/whatever.pdf", false), "/dl/recv.pdf");
  assert.equal(displayPathFor("/dl/recv.pdf", "/mine/a.pdf", true), "/dl/recv.pdf");
  // 台账未到 + 对端消息 ⇒ 空串（绝不回退对端写的 path）
  assert.equal(displayPathFor(undefined, "/victim/.ssh/id_rsa", false), "");
  assert.equal(displayPathFor("", "/victim/.ssh/id_rsa", false), "");
  // 台账未到 + 本机消息 ⇒ 载荷路径（用户在文件对话框里选的）
  assert.equal(displayPathFor(undefined, "/Users/me/Documents/a.pdf", true), "/Users/me/Documents/a.pdf");
  assert.equal(displayPathFor(null, undefined, true), "");
});
