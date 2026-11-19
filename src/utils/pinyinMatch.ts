/**
 * 人名拼音匹配（纯函数，零 `@/` 依赖，node:test 可测）——按名字搜人的唯一判据。
 *
 * 为什么集中在这里：全仓多处要"按人名搜"（会话列表、搜索弹窗、附近节点、分享目标），
 * 过去各处都是 `name.toLowerCase().includes(k)` 字面包含，拼音一律搜不到。统一到本文件后，
 * 同一条"名字能不能被这个词搜到"只有一套规则，改一处全仓生效。
 *
 * 命中三条路（任一即可，大小写不敏感）：
 *   ① 原文包含：输入「张」命中「张三」；
 *   ② 全拼包含：输入「zhang」/「zhangs」命中「张三」（全拼 "zhangsan"）；
 *   ③ 首字母包含：输入「zs」命中「张三」（首字母串 "zs"）。
 *
 * 多音字（2026-11-19 review 修）：全拼表里每字可能存 `姓读音|常用读音`（如 乐→yue|le），
 * 构造全拼串时对多读音字做有限笛卡尔积（一个人名里双读音字通常 ≤2，组合 ≤4），
 * 让「单田芳→shantianfang」和「张乐→zhangle」都能命中。ü 已在生成时归一化为 v。
 * 非汉字（拉丁/数字/符号/emoji）原样保留，故「张3」→ 全拼 "zhang3"、首字母 "z3"。
 */
import { pinyinOf } from "../data/hanPinyins.ts";
import { HAN_INITIALS, HAN_START } from "../data/hanInitials.ts";

/** 首字母（复用通讯录分组的同一张表，判据只有一份）。 */
function initialOf(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp === undefined || cp < HAN_START || cp > 0x9fa5) return "";
  return HAN_INITIALS[cp - HAN_START] ?? "";
}

/** 双读音字组合上限：超过就只用主读音（极端的全多音字名，避免组合爆炸）。 */
const MAX_FULL_VARIANTS = 16;

/**
 * 把一个名字拆成可匹配的规范串。用 Array.from 保护 emoji 代理对。
 * fullVariants 是全拼串的所有可能（多音字组合）；initials 用每个字的第一读音首字母。
 */
export function nameForms(name: string): {
  raw: string;
  full: string;
  fullVariants: string[];
  initials: string;
} {
  const chars = Array.from(name);
  let variants: string[] = [""];
  let initials = "";
  for (const ch of chars) {
    const py = pinyinOf(ch);
    // 每字的读音候选：全拼表用 `|` 分隔多个读音；非汉字用自身小写。
    const readings = py ? py.split("|") : [ch.toLowerCase()];
    const next: string[] = [];
    for (const base of variants) {
      for (const r of readings) {
        if (next.length < MAX_FULL_VARIANTS) next.push(base + r);
      }
    }
    variants = next.length ? next : variants;
    // 首字母：汉字的第一个读音首字母；非汉字取自身（拉丁名退化成原文，raw 已覆盖）。
    initials += py ? readings[0][0] : initialOf(ch) || ch.toLowerCase();
  }
  return {
    raw: name.toLowerCase(),
    full: variants[0] ?? "",
    fullVariants: variants,
    initials,
  };
}

/** 名字能否被查询词命中。空查询返回 true（不过滤）。 */
export function pinyinMatch(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { raw, fullVariants, initials } = nameForms(name);
  if (raw.includes(q) || initials.includes(q)) return true;
  return fullVariants.some((f) => f.includes(q));
}
