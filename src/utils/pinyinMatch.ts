/**
 * 人名拼音匹配（纯函数，零 `@/` 依赖，node:test 可测）——按名字搜人的唯一判据。
 *
 * 为什么集中在这里：全仓多处要"按人名搜"（会话列表、搜索弹窗、附近节点、分享目标），
 * 过去各处都是 `name.toLowerCase().includes(k)` 字面包含，拼音一律搜不到。统一到本文件后，
 * 同一条"名字能不能被这个词搜到"只有一套规则，改一处全仓生效。
 *
 * 命中三条路（任一即可，大小写不敏感）：
 *   ① 原文包含：输入「张」命中「张三」；
 *   ② 全拼包含：输入「zhang」/「zhangs」命中「张三」（全拼串 "zhangsan"）；
 *   ③ 首字母包含：输入「zs」命中「张三」（首字母串 "zs"）。
 * 汉字取全拼/首字母用构建期生成表 hanPinyins.ts / hanInitials.ts（确定性、零运行时依赖）。
 * 非汉字（拉丁字母/数字/符号/emoji）原样保留，故「张3」→ 全拼 "zhang3"、首字母 "z3"。
 */
import { pinyinOf } from "../data/hanPinyins.ts";
import { HAN_INITIALS, HAN_START } from "../data/hanInitials.ts";

/** 首字母（复用通讯录分组的同一张表，判据只有一份）。 */
function initialOf(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp === undefined || cp < HAN_START || cp > 0x9fa5) return "";
  return HAN_INITIALS[cp - HAN_START] ?? "";
}

/** 把一个名字拆成可匹配的规范串。用 Array.from 保护 emoji 代理对。 */
export function nameForms(name: string): { raw: string; full: string; initials: string } {
  const chars = Array.from(name);
  let full = "";
  let initials = "";
  for (const ch of chars) {
    const py = pinyinOf(ch);
    if (py) {
      full += py;
      initials += py[0];
    } else {
      const init = initialOf(ch);
      full += ch.toLowerCase();
      initials += init || ch.toLowerCase();
    }
  }
  return { raw: name.toLowerCase(), full, initials };
}

/** 名字能否被查询词命中。空查询返回 true（不过滤）。 */
export function pinyinMatch(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const { raw, full, initials } = nameForms(name);
  return raw.includes(q) || full.includes(q) || initials.includes(q);
}
