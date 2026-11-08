import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zhCN, enUS } from "./locales.ts";

/**
 * 启动失败窗的文案护栏（B2 + 静态外壳那一批）。
 *
 * 为什么单独钉一条：这扇窗是**独立入口**，它出现在数据库都打不开的时刻 —— 文案要是退化成
 * 裸 key（`startupError.retryFailed`）或某一门语言漏了一条，用户看到的就是"错误窗口里
 * 印着一串英文标识符"，比原本的错误更难理解。
 *
 * ⚠️ 测试文件放在 `src/i18n/` 而不是 `src/entries/`：`windowEntries.test.ts` 把
 * `src/entries/*.ts` 当作"窗口入口集合"与登记表逐项对账（防新增窗口漏登记），
 * 测试文件列在那儿会被判成"没登记的入口"。这里只是读那份源码，不需要住在旁边。
 *
 * 判据口径：
 * 1. **分母从源码现解析**，不手抄 key 清单 —— 手抄的清单会漂，加/删一条文案忘了同步测试
 *    就等于没测。两个来源都要扫：
 *    - `entries/startup-error.ts` 里的 `t("startupError.…")`（动态反馈文案）；
 *    - `startup-error.html` 里的 `data-i18n="startupError.…"`（静态外壳，由入口首帧填充）。
 * 2. 至少 23 条（12 条动态 + 11 条静态；本批完成时的实际条数）：少一条 = 有人删了文案、
 *    把 `t()` 改回了字面量，或把 `data-i18n` 删了让静态文案又变成写死的中文。以后再加
 *    文案只会更多，不会误伤。
 * 3. 每条都必须在中英两册存在且非空。
 */
test("启动失败窗的文案 key 都在中英词典里（分母从源码与静态壳现解析）", () => {
  const root = join(import.meta.dirname, "..");
  const sources = [
    readFileSync(join(root, "entries", "startup-error.ts"), "utf8"),
    readFileSync(join(root, "..", "startup-error.html"), "utf8"),
  ];
  const keys = new Set<string>();
  for (const src of sources) {
    // 动态：t("startupError.xxx"[, params])
    for (const m of src.matchAll(/\bt\(\s*["'](startupError\.[\w]+)["']/g)) keys.add(m[1]);
    // 静态外壳：<… data-i18n="startupError.xxx">
    for (const m of src.matchAll(/data-i18n="(startupError\.[\w]+)"/g)) keys.add(m[1]);
  }

  assert.ok(
    keys.size >= 23,
    `只解析到 ${keys.size} 条 startupError.* 文案（本批应为 23 条：12 动态 + 11 静态）—— ` +
      "要么有人把 t() 改回了硬编码 / 删了 data-i18n，要么这条护栏的正则失效了。",
  );

  const missing: string[] = [];
  for (const key of [...keys].sort()) {
    for (const [name, dict] of [["zh-CN", zhCN], ["en-US", enUS]] as const) {
      if (!dict[key]) missing.push(`${name} 缺 ${key}`);
    }
  }
  assert.deepEqual(missing, [], `启动失败窗引用了词典里没有的 key（会印出裸 key）：\n${missing.join("\n")}`);
});
