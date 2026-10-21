import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ANNOUNCEMENT_CHARS,
  MAX_GROUP_NAME_CHARS,
  MAX_LIST_FILTER_KEYWORD_CHARS,
  MAX_NICKNAME_CHARS,
  MAX_SEARCH_KEYWORD_CHARS,
} from "./validation.ts";
import { MAX_LOG_FILTER_CHARS } from "./logFilter.ts";
import { MAX_TODO_DESC_CHARS, MAX_TODO_TITLE_CHARS, TODO_CUSTOM_CATEGORY_MAX_LEN } from "./todos.ts";
import { MAX_LINK_NAME_CHARS } from "./externalLinks.ts";

/**
 * 「同一份长度规则有三个落点」的机器对账（P1 #8）。
 *
 * 形状是：Rust 侧一个 `const MAX_*_LEN`（多半是私有的）+ 前端输入框一个 `maxlength` +
 * 有时还有一份 zod 判据。三处只要有一处改了，另外两处不会红 —— 而发作方式是
 * **静默**的：后端拿到超长字符串会 `chars().take()` 直接截掉（`chat_search.rs`、
 * `group_membership.rs` 都是这个写法），用户以为存进去的是自己打的那串。
 *
 * 所以这里钉两件事：
 *  ① 前端每个长度常量与它在 Rust 侧的主人**数值相等**（现读两边，不抄数）；
 *  ② 生产模板里**不许再出现 `maxlength="数字"`**（分母现扫，白名单为空）。
 */

/** 读 Rust 源文件（相对仓库根，用 file URL 解析 ⇒ 不依赖 cwd）。 */
function rust(relPath: string): string {
  return readFileSync(new URL(`../../src-tauri/${relPath}`, import.meta.url), "utf8");
}

/** 现读 Rust 侧 `const NAME: usize = N;`（允许 `pub`）；读不到就抛 —— 名字漂了必须是响亮的。 */
function rustConst(relPath: string, name: string): number {
  const re = new RegExp(`^\\s*(?:pub\\s+)?const\\s+${name}\\s*:\\s*usize\\s*=\\s*([\\d_]+)\\s*;`, "m");
  const m = re.exec(rust(relPath));
  assert.ok(m, `Rust 侧找不到 ${relPath} 里的 \`const ${name}: usize\`（改名/搬家了？这条对账要同步）`);
  return Number(m[1].replace(/_/g, ""));
}

test("前端长度常量与 Rust 侧主人数值相等（七条，现读两边）", () => {
  const pairs: Array<[string, number, string, string]> = [
    ["MAX_GROUP_NAME_CHARS", MAX_GROUP_NAME_CHARS, "src/commands.rs", "MAX_GROUP_NAME_LEN"],
    ["MAX_NICKNAME_CHARS", MAX_NICKNAME_CHARS, "src/commands.rs", "MAX_NICKNAME_LEN"],
    ["MAX_SEARCH_KEYWORD_CHARS", MAX_SEARCH_KEYWORD_CHARS, "src/commands.rs", "MAX_SEARCH_LEN"],
    [
      "MAX_ANNOUNCEMENT_CHARS",
      MAX_ANNOUNCEMENT_CHARS,
      "src/commands/group_announcements.rs",
      "MAX_ANNOUNCEMENT_LEN",
    ],
    ["MAX_TODO_TITLE_CHARS", MAX_TODO_TITLE_CHARS, "src/commands/group_files.rs", "MAX_TODO_TITLE_LEN"],
    ["MAX_TODO_DESC_CHARS", MAX_TODO_DESC_CHARS, "src/commands/group_files.rs", "MAX_TODO_DESC_LEN"],
    [
      "TODO_CUSTOM_CATEGORY_MAX_LEN",
      TODO_CUSTOM_CATEGORY_MAX_LEN,
      "src/protocol.rs",
      "TODO_CUSTOM_CATEGORY_MAX_LEN",
    ],
    ["MAX_LINK_NAME_CHARS", MAX_LINK_NAME_CHARS, "src/commands/external_links.rs", "MAX_LINK_NAME_CHARS"],
  ];
  for (const [tsName, tsValue, rsFile, rsName] of pairs) {
    assert.equal(tsValue, rustConst(rsFile, rsName), `${tsName} 与 ${rsFile}::${rsName} 不同值`);
  }
});

/** 递归列出 `src` 下的生产模板（测试文件不算：测试里出现 `maxlength="9"` 是夹具，不是产品规则）。 */
function vueFiles(dir: URL, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const u = new URL(`${e.name}/`, dir);
    if (e.isDirectory()) {
      if (e.name === "assets") continue;
      vueFiles(u, acc);
    } else if (e.name.endsWith(".vue")) {
      acc.push(decodeURIComponent(new URL(e.name, dir).pathname));
    }
  }
  return acc;
}

test("生产模板里不许再有手抄的 maxlength 数字（分母现扫，白名单为空）", () => {
  const offenders: string[] = [];
  const bound: string[] = [];
  for (const file of vueFiles(new URL("../../src/", import.meta.url))) {
    const src = readFileSync(file, "utf8");
    for (const line of src.split("\n")) {
      if (line.trimStart().startsWith("/*") || line.trimStart().startsWith("//")) continue;
      const bare = /maxlength="\d+"/.exec(line);
      if (bare) offenders.push(`${file}: ${line.trim()}`);
      const named = /:maxlength="([A-Z_][A-Z0-9_]*)"/.exec(line);
      if (named) bound.push(named[1]);
    }
  }
  assert.deepEqual(offenders, [], `还有 ${offenders.length} 处手抄数字：\n${offenders.join("\n")}`);
  // 绑到常量的每一处都必须用得上表里那几个名字（防止"绑到一个组件内的私有魔法数"）。
  const allowed = new Set([
    "MAX_GROUP_NAME_CHARS",
    "MAX_NICKNAME_CHARS",
    "MAX_SEARCH_KEYWORD_CHARS",
    "MAX_ANNOUNCEMENT_CHARS",
    "MAX_LIST_FILTER_KEYWORD_CHARS",
    "MAX_LOG_FILTER_CHARS",
    "MAX_TODO_TITLE_CHARS",
    "MAX_TODO_DESC_CHARS",
    "TODO_CUSTOM_CATEGORY_MAX_LEN",
    "MAX_LINK_NAME_CHARS",
  ]);
  const unknown = [...new Set(bound)].filter((n) => !allowed.has(n));
  assert.deepEqual(unknown, [], `绑到了不在对账表里的名字：${unknown.join(", ")}`);
  assert.ok(bound.length >= 10, `绑定处只有 ${bound.length} 个，少于已知站点数 ⇒ 有模板被改回裸数字或漏扫`);
});

test("只有本地过滤框允许没有 Rust 主人，且必须显式命名", () => {
  // 这两格刻意不参与跨语言对账：它们不把字符串交给后端，纯粹防"把整篇日志粘进过滤框"。
  assert.ok(MAX_LIST_FILTER_KEYWORD_CHARS > 0 && MAX_LOG_FILTER_CHARS > 0);
  assert.ok(MAX_LOG_FILTER_CHARS > MAX_LIST_FILTER_KEYWORD_CHARS, "日志过滤框留的就是「长一截」这件事");
});
