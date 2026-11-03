import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zhCN, enUS } from "./locales.ts";

/**
 * 启动失败窗的文案护栏（B2）。
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
 * 1. **分母从源码现解析**（`t("startupError.…")` 字面量），不手抄 key 清单 —— 手抄的清单会漂，
 *    加/删一条文案忘了同步测试就等于没测。
 * 2. 至少 11 条（本批迁移前的硬编码条数）：少一条 = 有人删了文案或把 `t()` 改回了字面量，
 *    两种都该红；以后再加文案只会更多，不会误伤。
 * 3. 每条都必须在中英两册存在且非空。
 */
test("启动失败窗的文案 key 都在中英词典里（分母从源码现解析）", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "entries", "startup-error.ts"), "utf8");
  const keys = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*["'](startupError\.[\w]+)["']/g)) keys.add(m[1]);

  assert.ok(
    keys.size >= 11,
    `只解析到 ${keys.size} 条 startupError.* 文案（本批应为 11 条）—— ` +
      "要么有人把 t() 改回了硬编码，要么这条护栏的正则失效了。",
  );

  const missing: string[] = [];
  for (const key of [...keys].sort()) {
    for (const [name, dict] of [["zh-CN", zhCN], ["en-US", enUS]] as const) {
      if (!dict[key]) missing.push(`${name} 缺 ${key}`);
    }
  }
  assert.deepEqual(missing, [], `启动失败窗引用了词典里没有的 key（会印出裸 key）：\n${missing.join("\n")}`);
});
