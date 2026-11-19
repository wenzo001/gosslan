/**
 * 外部分享到会话的**纯逻辑**（可单测）：默认正文拼接、来源展示、长度闸、会话检索。
 *
 * 展示与副作用在 `SharePanel.vue`；这里只放能复算的东西。
 *
 * 与后端的分工：后端 `crate::share` 负责「入口解析 + 限额 + 排队」，本文件负责
 * 「把一条 payload 变成一个可编辑的默认正文」与「面板上的即时校验」。两边的长度上限
 * 必须是同一把尺（`src/utils/share.test.ts` 会去 `src-tauri/src/share.rs` 现读断言，
 * 手抄的第二份一旦漂就会被抓）。
 */
import type { Conversation, SharePayload } from "@/types";
// ⚠️ 值导入必须**相对路径带扩展名**：`npm test`（node:test + strip-types）不解析 `@/` 别名。
// 类型导入无所谓（编译期擦除），所以 `@/types` 照旧。
import { charCount } from "./text.ts";
import { pinyinMatch } from "./pinyinMatch.ts";

/** 后端 `share::MAX_TEXT_CHARS` / `MAX_TITLE_CHARS` / `MAX_URL_CHARS` 的镜像。 */
export const MAX_SHARE_TEXT_CHARS = 2000;
export const MAX_SHARE_TITLE_CHARS = 300;
export const MAX_SHARE_URL_CHARS = 2048;

/**
 * 默认正文：把「谁给的哪一页」压成一段用户可以直接发的话。
 *
 * 顺序刻意是 `text` → `title` → `url`：调用方给了选中的原文就以原文为主（那才是用户
 * 真正想分享的），标题次之，只有链接时就是链接本身。**去重**：很多站点分享出来的
 * `text` 就等于标题，重复两遍会显得很傻。
 */
export function composeShareText(p: SharePayload): string {
  const lines: string[] = [];
  const push = (v: string | null) => {
    const s = (v ?? "").trim();
    if (s && !lines.includes(s)) lines.push(s);
  };
  push(p.text);
  push(p.title);
  push(p.url);
  return lines.join("\n");
}

/**
 * 来源展示：只回**主机名**。
 *
 * 为什么不是整条 origin：面板上这一行的作用是「这内容是否来自我以为的那个网站」，
 * 主机名足够判断，而整条 URL 又长又容易被构造成看起来像别家的样子。
 * 再说一次：这是**调用方自称**的线索，不是信任依据（活契约 §6/§D）。
 */
export function shareOriginHost(p: SharePayload): string | null {
  const raw = (p.claimedOrigin ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

/** 面板上的即时闸：长度与空值。与后端同一把尺（码点），不另算一套。 */
export function shareTextError(text: string): "empty" | "tooLong" | null {
  if (!text.trim()) return "empty";
  if (charCount(text) > MAX_SHARE_TEXT_CHARS) return "tooLong";
  return null;
}

/**
 * 会话检索：按名字匹配（字面 / 全拼 / 首字母，统一走 pinyinMatch）。
 *
 * 2026-11-19 起支持拼音：内置生成表让全仓按人名搜的规则只有一份（之前这里刻意不做，
 * 因为当时还没有表；现在表随 hanInitials.ts 同构生成，零运行时依赖）。空查询返回 true（不筛）。
 */
export function matchShareTarget(
  conv: Pick<Conversation, "name">,
  query: string,
): boolean {
  return pinyinMatch(conv.name, query);
}

/**
 * 分享目标列表的排序：置顶优先，其余按最近活跃。
 *
 * 与左栏会话列表同一套口径（`conversationSortKey`），但这里**不复用**那个函数：
 * 它依赖 `last_ts ?? 0` 与置顶分组的细节，而分享面板要的是「最近说过的排前面」，
 * 直接在本文件写明，避免为了复用把左栏的排序口径绑死在分享上。
 * 没有 `last_ts` 的会话排在最后（既不置顶也没说过话）。
 */
export function sortShareTargets<
  T extends { pinned: boolean; last_ts: number | null },
>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (b.last_ts ?? -1) - (a.last_ts ?? -1);
  });
}
