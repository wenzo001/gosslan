import { test } from "node:test";
import assert from "node:assert/strict";
import { createMsgConvIndex } from "./msgConvIndex.ts";

/** 造一批带 msg_id 的"消息"，只关心 id。 */
function rows(prefix: string, n: number): Array<{ msg_id: string }> {
  return Array.from({ length: n }, (_, i) => ({ msg_id: `${prefix}-${i}` }));
}

test("反查表不封顶时会跟运行时长单调增长 —— 有上限就必须淘汰最旧的", () => {
  // 12 个会话 × 1000 条 = 12000 条，远超缓存上限（8 × 1000 = 8000）。
  const idx = createMsgConvIndex(8192);
  for (let c = 0; c < 12; c++) idx.remember(`c${c}`, rows(`c${c}`, 1000));
  assert.equal(idx.size, 8192, "条目数必须被压回上界，删掉 trimOldest 这一行这里就会变成 12000");
  // 淘汰的是最旧的一批：最后写入的会话仍然命中。
  assert.equal(idx.get("c11-999"), "c11");
  // 被淘汰的 id 返回 null（调用方随后回退全量扫描，正确性不受影响）。
  assert.equal(idx.get("c0-0"), null);
});

test("未超上界不淘汰：稳态下记住 8 个会话后一个都不少", () => {
  const idx = createMsgConvIndex(8192);
  for (let c = 0; c < 8; c++) idx.remember(`c${c}`, rows(`c${c}`, 1000));
  assert.equal(idx.size, 8000);
  assert.equal(idx.get("c0-0"), "c0");
  assert.equal(idx.get("c7-999"), "c7");
});

test("clear() 能把表真正清空（换实例 / 清空数据走同一条路）", () => {
  const idx = createMsgConvIndex(16);
  idx.remember("a", rows("a", 10));
  assert.equal(idx.size, 10);
  idx.clear();
  assert.equal(idx.size, 0);
  assert.equal(idx.get("a-0"), null);
});
