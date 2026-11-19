import { test } from "node:test";
import assert from "node:assert/strict";
import { nameForms, pinyinMatch } from "./pinyinMatch.ts";

test("nameForms：汉字产出全拼与首字母，非汉字原样保留", () => {
  assert.deepEqual(nameForms("张三"), { raw: "张三", full: "zhangsan", initials: "zs" });
  // 拉丁名没有拼音，三串都退化为原文小写；raw.includes 已能覆盖首字母/子串查询。
  assert.deepEqual(nameForms("Alice"), { raw: "alice", full: "alice", initials: "alice" });
  assert.deepEqual(nameForms("张3"), { raw: "张3", full: "zhang3", initials: "z3" });
  assert.deepEqual(nameForms(""), { raw: "", full: "", initials: "" });
});

test("pinyinMatch：原文 / 全拼 / 首字母三条路都命中", () => {
  assert.equal(pinyinMatch("张三", "张"), true, "原文命中");
  assert.equal(pinyinMatch("张三", "zhang"), true, "全拼命中");
  assert.equal(pinyinMatch("张三", "zhangs"), true, "全拼前缀命中");
  assert.equal(pinyinMatch("张三", "san"), true, "非首字的全拼也能命中");
  assert.equal(pinyinMatch("张三", "zs"), true, "首字母命中");
  assert.equal(pinyinMatch("张三", "s"), true, "单字首字母命中");
});

test("pinyinMatch：大小写不敏感、空查询放行、不相关词不命中", () => {
  assert.equal(pinyinMatch("张三", "ZHANG"), true, "大写查询命中小写全拼");
  assert.equal(pinyinMatch("Alice", "ali"), true, "拉丁原文大小写不敏感");
  assert.equal(pinyinMatch("张三", ""), true, "空查询不过滤");
  assert.equal(pinyinMatch("张三", "   "), true, "纯空白查询不过滤");
  assert.equal(pinyinMatch("张三", "lisi"), false, "不相关拼音不命中");
  assert.equal(pinyinMatch("张三", "xy"), false, "不相关首字母不命中");
});

test("pinyinMatch：姓氏多音字用姓读音（与首字母表同源）", () => {
  assert.equal(pinyinMatch("单田芳", "shan"), true, "单→shan");
  assert.equal(pinyinMatch("单田芳", "stf"), true, "单田芳首字母 shan tian fang → stf");
  assert.equal(pinyinMatch("曾国藩", "zeng"), true, "曾→zeng");
  assert.equal(pinyinMatch("解晓东", "xie"), true, "解→xie");
  assert.equal(pinyinMatch("区桃", "ou"), true, "区→ou");
});

test("pinyinMatch：emoji 代理对不被拆坏", () => {
  assert.equal(pinyinMatch("张三😀", "zs"), true, "emoji 不影响拼音首字母");
  assert.equal(pinyinMatch("张三😀", "zhang"), true, "emoji 不影响全拼");
  assert.equal(pinyinMatch("😀", "😀"), true, "emoji 自身原文可匹配");
});
