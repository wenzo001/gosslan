import { test } from "node:test";
import assert from "node:assert/strict";
import { EMOJI_META } from "./emojis.ts";

test("表情映射：214 项、名字/文件名/display_name 全部唯一", () => {
  assert.equal(EMOJI_META.length, 214, "应为 214 个表情");

  const names = EMOJI_META.map((e) => e.name);
  const files = EMOJI_META.map((e) => e.file);
  const displays = EMOJI_META.map((e) => e.display_name);

  assert.equal(new Set(names).size, names.length, "name 存在重复");
  assert.equal(new Set(files).size, files.length, "file 存在重复");
  assert.equal(new Set(displays).size, displays.length, "display_name 存在重复");
});

test("表情映射：display_name 恒为 [名字] 语法，file 恒为 webp/png", () => {
  for (const e of EMOJI_META) {
    assert.equal(
      e.display_name,
      `[${e.name}]`,
      `display_name 应为 [name] 格式，实际 ${e.display_name}（name=${e.name}）`,
    );
    assert.ok(/\.(webp|png)$/.test(e.file), `file 应为 webp/png 扩展名，实际 ${e.file}`);
    assert.ok(e.name.length > 0, "name 不能为空");
  }
});
