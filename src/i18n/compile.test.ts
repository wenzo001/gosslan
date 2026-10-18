/**
 * 全量消息编译判据：vue-i18n 的消息编译器有自己的一套语法（`@` 链接、`|` 复数、
 * `{name}` 插值）；词典里出现字面 `@` 时会在 `t()` 调用那一刻抛 SyntaxError。
 * 迁移时实测 1003×2 条里只有 5 条字面 `@` 会炸（已写成 `{'@'}`），这条把整份词典钉住：
 * 以后新增文案只要带未转义的 `@`/非法语法，这里先红，而不是等用户看到裸 key。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createI18n } from "vue-i18n";
import { zhCN, enUS } from "./locales.ts";

test("两种语言的全部消息都能被 vue-i18n 编译；字面 @ 按文本渲染", () => {
  const messages = { "zh-CN": zhCN, "en-US": enUS };
  const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    fallbackLocale: "en-US",
    messages,
    missingWarn: false,
    fallbackWarn: false,
    warnHtmlMessage: false,
  });

  const keys = Object.keys(zhCN);
  assert.ok(keys.length > 900, `词典规模异常，判据可能空转：${keys.length}`);
  for (const loc of ["zh-CN", "en-US"] as const) {
    i18n.global.locale.value = loc;
    for (const [key, template] of Object.entries(messages[loc])) {
      assert.doesNotThrow(() => i18n.global.t(key, {}), `${loc} 的 ${key} 编译失败：${template}`);
    }
  }

  i18n.global.locale.value = "zh-CN";
  assert.equal(i18n.global.t("mention.self"), "@你");
  assert.equal(i18n.global.t("msg.mentioned"), "[有人@我]");
});
