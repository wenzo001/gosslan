import { test } from "node:test";
import assert from "node:assert/strict";
import { nameForms, pinyinMatch } from "./pinyinMatch.ts";

test("nameForms：汉字产出全拼/多音组合与首字母，非汉字原样保留", () => {
  const zhang3 = nameForms("张三");
  assert.equal(zhang3.raw, "张三");
  assert.equal(zhang3.full, "zhangsan");
  assert.deepEqual(zhang3.fullVariants, ["zhangsan"]);
  assert.equal(zhang3.initials, "zs");
  // 拉丁名没有拼音，退化为原文小写；raw.includes 已能覆盖首字母/子串查询。
  const alice = nameForms("Alice");
  assert.equal(alice.raw, "alice");
  assert.deepEqual(alice.fullVariants, ["alice"]);
  assert.equal(alice.initials, "alice");
  assert.equal(nameForms("张3").initials, "z3");
  const empty = nameForms("");
  assert.equal(empty.raw, "");
  assert.deepEqual(empty.fullVariants, [""]);
});

test("多音字产出两组全拼（姓读音 | 常用读音）", () => {
  const dan = nameForms("单田芳");
  assert.ok(dan.fullVariants.includes("shantianfang"), "姓读音 shan");
  assert.ok(dan.fullVariants.includes("dantianfang"), "常用读音 dan");
  const le = nameForms("张乐");
  assert.ok(le.fullVariants.includes("zhangle"), "乐作名用常用读音 le");
  assert.ok(le.fullVariants.includes("zhangyue"), "乐也可用姓读音 yue");
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

test("pinyinMatch：多音字姓位用姓读音、名位用常用读音都能搜到", () => {
  // 姓位（姓读音）
  assert.equal(pinyinMatch("单田芳", "shan"), true, "单→shan");
  assert.equal(pinyinMatch("单田芳", "stf"), true, "单田芳首字母 → stf");
  assert.equal(pinyinMatch("曾国藩", "zeng"), true, "曾→zeng");
  assert.equal(pinyinMatch("解晓东", "xie"), true, "解→xie");
  assert.equal(pinyinMatch("区桃", "ou"), true, "区→ou");
  // 名位（常用读音）——review 发现的缺口
  assert.equal(pinyinMatch("张乐", "zhangle"), true, "乐作名→le");
  assert.equal(pinyinMatch("李单", "lidan"), true, "单作名→dan");
  assert.equal(pinyinMatch("王曾", "wangceng"), true, "曾作名→ceng");
  assert.equal(pinyinMatch("陈仇", "chenchou"), true, "仇作名→chou");
});

test("pinyinMatch：ü 归一化为 v（吕/女等标准键盘输入）", () => {
  assert.equal(pinyinMatch("吕布", "lvbu"), true, "吕→lv，输入 lv 命中");
  assert.equal(pinyinMatch("吕布", "lb"), true, "吕布首字母 lb");
  assert.equal(pinyinMatch("女", "nv"), true, "女→nv");
  assert.equal(pinyinMatch("绿色", "lvse"), true, "绿→lv");
});

test("pinyinMatch：emoji 代理对不被拆坏", () => {
  assert.equal(pinyinMatch("张三😀", "zs"), true, "emoji 不影响拼音首字母");
  assert.equal(pinyinMatch("张三😀", "zhang"), true, "emoji 不影响全拼");
  assert.equal(pinyinMatch("😀", "😀"), true, "emoji 自身原文可匹配");
});
