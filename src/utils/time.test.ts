/**
 * 时间格式化的单一入口：三个手写实现（日志、诊断、导出文件名）收敛到 dayjs。
 * 这里同时钉住「消费点确实用统一入口」，防止以后再长回 `new Date()` + padStart。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fmtClock,
  fmtDateStamp,
  fmtDateTime,
  fmtTimeDivider,
  fmtConversationTime,
  type Translate,
} from "./time.ts";
import { enUS, zhCN } from "../i18n/locales.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 本地时间构造：断言不随测试机器时区变化。
const localTs = new Date(2026, 9, 18, 13, 45, 9).getTime();

test("fmtDateTime / fmtClock / fmtDateStamp：固定形状，不随 WebView 区域设置变化", () => {
  assert.equal(fmtDateTime(localTs), "2026-10-18 13:45:09");
  assert.equal(fmtClock(localTs), "13:45:09");
  assert.equal(fmtDateStamp(localTs), "20261018");
});

test("接线判据：三个消费点走 utils/time，不再手写 new Date / toLocaleTimeString / padStart", () => {
  const log = read("components/LogViewer.vue");
  assert.match(log, /from "@\/utils\/time"/);
  assert.ok(!log.includes("String(n).padStart(2, \"0\")"), "LogViewer 又长回手写补零");

  const diag = read("components/DevDiagPanel.vue");
  assert.match(diag, /fmtClock\(ts\)/);
  assert.ok(!diag.includes("toLocaleTimeString()"), "诊断面板又用了随区域设置变化的本地化格式");

  const storage = read("components/settings/StorageSection.vue");
  assert.match(storage, /fmtDateStamp\(/);
  assert.ok(!storage.includes("getMonth() + 1"), "导出文件名又长回手写日期戳");
});

/**
 * 用**真词典原文**插值的翻译器。测试在裸 node 下跑，不引 vue-i18n（那是应用层的事），
 * 但读的串与上屏的那一份完全相同 ⇒ 词典里改了措辞，这里立刻跟着红。
 */
const trFrom = (dict: Record<string, string>): Translate => (key, params) => {
  const tpl = dict[key];
  if (!tpl) throw new Error(`词典缺 key：${key}`);
  return tpl.replace(/\{(\w+)\}/g, (_m, name) => String(params?.[name] ?? `{${name}}`));
};

/** 用"正午"避开跨日边界：这套判据读的是日历日，不是 24 小时。 */
const atNoon = (daysAgo: number): number => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
};
const mmdd = (ts: number): string => {
  const d = new Date(ts);
  return String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
const at = (month: number, day: number, h: number, m: number, year = 2026) =>
  new Date(year, month - 1, day, h, m, 0).getTime();
const NOW_WED = new Date(2026, 8, 9, 16, 0, 0).getTime();

test("时间分割线：五档形状在中文下与迁移前逐字一致", () => {
  assert.equal(fmtTimeDivider(at(9, 9, 10, 5), trFrom(zhCN), "zh-CN", NOW_WED), "10:05", "今天只报时分");
  assert.equal(fmtTimeDivider(at(9, 8, 23, 5), trFrom(zhCN), "zh-CN", NOW_WED), "昨天 23:05", "昨天带前缀");
  assert.equal(fmtTimeDivider(at(9, 5, 8, 0), trFrom(zhCN), "zh-CN", NOW_WED), "周六 08:00", "一周内报星期");
  assert.equal(fmtTimeDivider(at(8, 30, 12, 0), trFrom(zhCN), "zh-CN", NOW_WED), "8月30日 12:00", "今年更早报月日");
  assert.equal(
    fmtTimeDivider(at(12, 31, 18, 30, 2025), trFrom(zhCN), "zh-CN", NOW_WED),
    "2025年12月31日 18:30",
    "跨年带年份",
  );
});

test("时间分割线：换语言后文案、月日顺序与星期名一起换（迁移前这里是硬编码中文）", () => {
  assert.equal(fmtTimeDivider(at(9, 8, 23, 5), trFrom(enUS), "en-US", NOW_WED), "Yesterday 23:05");
  assert.equal(fmtTimeDivider(at(9, 5, 8, 0), trFrom(enUS), "en-US", NOW_WED), "Sat 08:00", "星期名归 dayjs locale");
  assert.equal(fmtTimeDivider(at(8, 30, 12, 0), trFrom(enUS), "en-US", NOW_WED), "Aug 30 12:00");
  assert.equal(fmtTimeDivider(at(12, 31, 18, 30, 2025), trFrom(enUS), "en-US", NOW_WED), "Dec 31, 2025 18:30");
  // 反面对照：同一份时间戳，中英文必须**不一样**，否则"跟着语言走"这句是空的
  assert.notEqual(
    fmtTimeDivider(at(9, 5, 8, 0), trFrom(enUS), "en-US", NOW_WED),
    fmtTimeDivider(at(9, 5, 8, 0), trFrom(zhCN), "zh-CN", NOW_WED),
  );
});

test("格式化不许动全局：语言只从参数进来（真实浏览器实测到过切回中文仍印 Fri）", () => {
  const code = read("utils/time.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?:^|(?<=\s))\/\/[^\n]*/g, "");
  assert.ok(!/dayjs\.locale\(/.test(code), "time.ts 又去改 dayjs 的全局 locale ⇒ 换语言不会重算");
  assert.match(code, /\.locale\(L\)/, "分割线那两支没按传入语言取本地化数据");
});

test("会话列表时间列：今天时分 / 昨天文案 / 更早 MM-DD（数字形状两种语言共用）", () => {
  assert.equal(fmtConversationTime(null, trFrom(zhCN)), "", "空时间戳给空串，不给 Invalid Date");
  assert.equal(fmtConversationTime(atNoon(0), trFrom(zhCN)), "12:00");
  assert.equal(fmtConversationTime(atNoon(1), trFrom(zhCN)), "昨天");
  assert.equal(fmtConversationTime(atNoon(3), trFrom(zhCN)), mmdd(atNoon(3)));
  assert.equal(fmtConversationTime(atNoon(1), trFrom(enUS)), "Yesterday");
});

/** 取出从 `from`（左括号之后）到配对右括号之间的实参表。 */
function argsOf(src: string, from: number): string | null {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) return src.slice(from, i);
    }
  }
  return null;
}

test("接线判据：相对日期只有一份实现，且**每一处**调用都注入文案与语言（分母现算）", () => {
  assert.ok(!/WEEKDAYS|formatTimeDivider|dayjs/.test(read("utils/chatStyle.ts")),
    "chatStyle 又长回一份时间格式化");

  const display = read("composables/useMessageDisplay.ts");
  assert.match(display, /fmtDateTime\(message\.value\.ts\)/, "完整时间又长回手写 dayjs");
  assert.ok(!display.includes("dayjs"), "composable 里不该再有 dayjs 直用");

  /*
   * ⚠️ 这里刻意按**次数**判，而不是"这个文件里出现过一次"：
   * 第一版写成 `assert.match(read(rel), /fmtConversationTime\([^()]+, t\)/)`，护栏跑注入时
   * 当场被判成空转 —— FavoritePanel 有两处调用，摘掉其中一处的 `, t`，另一处照样让那条正则命中。
   * 存在性断言只能证明"有"，证明不了"全都"（本仓这条教训已经是第二次了）。
   * 分母同样从磁盘现算：新增一个调用点忘了注入，这里直接少一。
   */
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(?:vue|ts)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const HOME = path.join(ROOT, "utils", "time.ts");
  const CALL = /fmt(?:ConversationTime|TimeDivider)\(/g;
  const totalOf = (s: string) => (s.match(CALL) ?? []).length;
  let total = 0;
  const bad: string[] = [];
  for (const f of walk(ROOT)) {
    if (f === HOME) continue; // 单口自己不算是调用点（它的定义行会被同一条正则捞到）
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(CALL)) {
      total++;
      const args = argsOf(src, m.index + m[0].length);
      if (args === null) { bad.push(`${path.relative(ROOT, f)}：括号配不上对，读不出实参`); continue; }
      if (!/(?:^|,)\s*\bt\s*(?:,|$)/.test(args)) bad.push(`${path.relative(ROOT, f)}：这一处没注入 t ⇒ ${args.trim().slice(0, 60)}`);
      if (m[0].startsWith("fmtTimeDivider") && !/currentLocale\(\)/.test(args)) {
        bad.push(`${path.relative(ROOT, f)}：分割线没把当前语言传进去 ⇒ ${args.trim().slice(0, 60)}`);
      }
    }
  }
  assert.ok(total >= 12, `现读到的调用点只有 ${total} 处 ⇒ 这条判据大概失效了`);
  assert.deepEqual(bad, [], `时间格式化没走 vue-i18n 文案（界面会退回裸 key / 硬编码语言）：\n${bad.join("\n")}`);
  console.log(`· 时间格式化分母：${total} 处调用点，文案与语言注入齐全`);
});

test("utils/time 用到的词典 key 在中英两本里都存在（防裸 key 上屏）", () => {
  const keys = [...read("utils/time.ts").matchAll(/tr\("([\w.]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length >= 2, `只扫到 ${keys.length} 个 key ⇒ 这条判据本身在空转`);
  const missing: string[] = [];
  for (const k of new Set(keys)) {
    if (!zhCN[k]) missing.push(`zh-CN 缺 ${k}`);
    if (!enUS[k]) missing.push(`en-US 缺 ${k}`);
  }
  assert.deepEqual(missing, [], `时间格式化引用了不存在的 key：${missing.join(", ")}`);
});
