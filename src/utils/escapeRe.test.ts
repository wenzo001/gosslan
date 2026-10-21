import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { escapeRe } from "./escapeRe.ts";

/**
 * 这个函数的使用场景全是「把用户给的字符串嵌进正则」：表情名、成员昵称、@ 对象。
 * 元字符漏转义不会抛错，只会**静默匹配不到** ⇒ 这里逐字符钉住。
 */

test("正则元字符全部被转义（转义后自身仍是字面量）", () => {
  const s = "a.*+?^${}()|[]\\b";
  const escaped = escapeRe(s);
  // 转义结果应当能逐字匹配原字符串
  assert.ok(new RegExp(escaped).test(s), "转义后必须仍能匹配原串");
  // 且不能再当正则用：把 `a.b` 转义后不应匹配 "axb"
  assert.ok(!new RegExp(escapeRe("a.b")).test("axb"));
});

test("空串与无元字符串原样返回", () => {
  assert.equal(escapeRe(""), "");
  assert.equal(escapeRe("plain-name_123"), "plain-name_123");
});

test("真实场景：带元字符的名字不会把分组搞坏", () => {
  // emoji.ts 的用法：`\\[(${NAMES.map(escapeRe).join("|")})\\]`
  // ⚠️ 取捕获组别用 /g + String.match（那只会给整段匹配、不返回分组）⇒ 用 exec 或不带 g
  const escaped = new RegExp(`\\[(${escapeRe("a.b")})\\]`);
  assert.equal(escaped.exec("[a.b]")?.[1], "a.b", "转义后按字面匹配");
  assert.equal(escaped.exec("[axb]"), null, "转义后不再吃任意字符");
  // 反控：同一串不转义时 `.` 真的会匹配别的字符 ⇒ 证明这一格在测转义，不是自等
  const loose = new RegExp("\\[(a.b)\\]");
  assert.equal(loose.exec("[axb]")?.[1], "axb", "反控成立：不转义时它匹配到了别的串");
});

test("只有一份定义：emoji.ts 与 linkify.ts 都不再各自私有一份", () => {
  for (const rel of ["emoji.ts", "linkify.ts"]) {
    const src = readFileSync(new URL(`./${rel}`, import.meta.url), "utf8");
    assert.match(src, /from "\.\/escapeRe\.ts"/, `${rel} 必须从公共份导入`);
    assert.doesNotMatch(src, /function escapeRe\s*\(/, `${rel} 里又出现了私有副本`);
  }
});
