/**
 * 自定义类型图标的**映射完整性**判据（用户 2026-10-14：「自定义类型名称，图标」）。
 *
 * 三条各钉一种"接了一半"的形状：
 *  ① 白名单里有键、映射里没有 ⇒ 选中它之后界面是空白（存得进、显示不出来）；
 *  ② 映射里有键、白名单里没有 ⇒ 选择器多出一个选项，而后端会把它当非法值拒收；
 *  ③ 键有映射但没有文案键 ⇒ 屏幕阅读器读到一枚无名图标（a11y 上的空白）。
 * 三条都是双向比，不用"我以为写全了"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TODO_CUSTOM_ICONS, TODO_CUSTOM_ICON_DEFAULT } from "./todos.ts";
import { TODO_CUSTOM_ICON_COMPONENTS, TODO_CUSTOM_ICON_LABEL_KEY } from "./todoCustomIcons.ts";

const ROOT = join(import.meta.dirname, "..");

test("图标映射与白名单双向一致（少一个渲染空白、多一个存不进载荷）", () => {
  const keys = Object.keys(TODO_CUSTOM_ICON_COMPONENTS).sort();
  assert.deepEqual(keys, [...TODO_CUSTOM_ICONS].sort(), "映射键集合必须与白名单同集合");
  for (const k of TODO_CUSTOM_ICONS) {
    assert.ok(TODO_CUSTOM_ICON_COMPONENTS[k], `白名单键 ${k} 没有组件映射`);
  }
});

test("默认那枚一定在表内（否则旧对端的载荷落到一个画不出来的键）", () => {
  assert.ok(
    (TODO_CUSTOM_ICONS as readonly string[]).includes(TODO_CUSTOM_ICON_DEFAULT),
    `默认图标键 ${TODO_CUSTOM_ICON_DEFAULT} 不在白名单里`,
  );
});

test("每一枚都有中英两份文案键（屏幕阅读器不许读到无名图标）", () => {
  const locales = ["zh-cn", "en-us"].map(
    (n) => new Set([...readFileSync(join(ROOT, "i18n", "locales", `${n}.ts`), "utf8").matchAll(/"(todo\.icon\.[a-z]+)"/g)].map((m) => m[1])),
  );
  for (const k of TODO_CUSTOM_ICONS) {
    const key = TODO_CUSTOM_ICON_LABEL_KEY[k];
    assert.ok(key, `键 ${k} 没有文案键映射`);
    for (const [i, have] of locales.entries()) {
      assert.ok(have.has(key), `${["zh-cn", "en-us"][i]} 缺少 ${key} ⇒ 该枚图标没有可读名称`);
    }
  }
});
