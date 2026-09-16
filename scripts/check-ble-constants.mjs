#!/usr/bin/env node
/**
 * BLE 常量/换算的「单一事实来源」守门。
 *
 * ## 为什么需要它（这不是假想的架构洁癖）
 *
 * CHANGELOG `4.18.7 → 4.18.10` **连着四个版本**修同一个分片预算问题：
 *
 *   4.18.7  「分片预算没减 ATT 头 ⇒ 多分片帧写不出去（好友申请永远发不出）」
 *   4.18.8  「写入失败日志补上帧长（**上一版修复生效但不够**）」
 *   4.18.9  「每片 514 字节 > AOSP 硬上限 512 ⇒ 多分片帧永远发不出去」
 *   4.18.10 「外设启动失败的原因被丢掉」
 *
 * 根因不是某一行写错，而是**同一个概念在多个地方各算一遍**：「一片能装多少字节」
 * 这件事，central 侧按「协商 MTU − ATT 头」算，macOS 外设侧另有一份自己算的
 * （`const DEFAULT = 20` / `const MAX = 512`，匿名、靠注释解释语义），Windows 外设侧
 * 又走共享函数。数值恰好一致所以没立刻发作 —— 任一处改动就会复发。
 *
 * 2026-09-16 已把常量与换算收敛到 `transport/ble_framing.rs` 一处。本脚本负责**不让它漂回去**。
 *
 * ## 判据（两条，都刻意避开"扫数字字面量"）
 *
 * **A. 唯一具名定义点** —— 下列名字在整个 crate 里必须**恰好定义一次**：
 *      `BLE_DEFAULT_MTU` / `ATT_HEADER_LEN` / `GATT_MAX_ATTR_LEN` / `DEFAULT_PAYLOAD_BUDGET`
 *      `att_payload_budget` / `notify_payload_budget`
 *    （`use ... ::NAME` 引用不算定义。）
 *
 * **B. 概念不许用匿名常量重述** —— 在 BLE 领域文件里，`const/static` 定义**同时**满足
 *    下面两条 ⇒ FAIL：
 *      · 名字像在讲这件事（按 `_` 分词后命中 `MTU/ATT/GATT/PAYLOAD/NOTIFY/CHUNK`，
 *        或本身就是 `DEFAULT`/`MAX`/`MIN`/`LIMIT`/`SIZE`/`LEN` 这类语义空名）；
 *      · 值**恰好是**受保护字面量（`23` / `3` / `512` / `20`）之一。
 *
 *    目标正是 `const DEFAULT: usize = 20` / `const MAX: usize = 512` ——
 *    2026-09-13 就是这两个匿名常量在 macOS 外设侧埋下了第二份实现。
 *
 *    ⚠️ **为什么必须"两条同时满足"**（这条规则改过两版，都因误报被推翻）：
 *      · 只看值 → `const CONNECT_ATTEMPTS = 3`（重试次数）、`const FREE_ATTEMPTS = 3`
 *        全被误伤；误报会招来白名单，白名单会让守卫形同虚设。
 *      · 只看名字 → 漏掉真正的目标（`DEFAULT` / `MAX` 的名字里没有任何概念词）。
 *      · 名字必须**按 `_` 分词**而不是子串匹配：`CONNECT_ATTEMPTS` 含子串 `ATT`，
 *        子串匹配一样会误伤。
 *      · 不 grep 全文件的裸数字（`512 * 1024` 是合法的消息上限，不是这个概念的重复）。
 *
 * ## 本脚本**不**保证的（诚实边界）
 *
 * 它拦不住"把换算内联写成表达式"（例如别处写 `mtu - 3`）。那类只能靠 review；
 * 硬扫会误伤到不能用。这条边界是有意留下的，不是漏掉。
 *
 * ## 用法
 *
 *     node scripts/check-ble-constants.mjs
 *
 * 退出码：0 = 单一事实来源成立；1 = 有重复定义或匿名重述。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src-tauri", "src");

/** 规范名字 → 它应该住在哪个文件（相对 src-tauri/src）。 */
const CANONICAL = {
  BLE_DEFAULT_MTU: "transport/ble_framing.rs",
  ATT_HEADER_LEN: "transport/ble_framing.rs",
  GATT_MAX_ATTR_LEN: "transport/ble_framing.rs",
  DEFAULT_PAYLOAD_BUDGET: "transport/ble_framing.rs",
  att_payload_budget: "transport/ble_framing.rs",
  notify_payload_budget: "transport/ble_framing.rs",
};

/**
 * BLE 领域的文件（判据 B 的扫描范围）。
 *
 * 只放**确实在算 GATT 载荷**的文件，不放整个 transport/ ——
 * 范围越宽越容易误报，而误报会让这条守卫失去可信度。
 */
const BLE_DOMAIN_FILES = [
  "transport/ble_framing.rs",
  "transport/bluetooth.rs",
  "transport/bluetooth_peripheral.rs",
  "transport/bluetooth_peripheral_windows.rs",
  "transport/ble_android.rs",
  "network/ble.rs",
];

/**
 * 受保护的字面量：它们的含义由 ble_framing 的具名常量承担，别处不许用匿名常量重述。
 *
 * 判据 B 要求**同时**满足「名字像在说这件事」与「值恰好是这些字面量之一」——
 * 只看值会误伤（`const CONNECT_ATTEMPTS = 3` 是重试次数，与 ATT 头无关），
 * 只看名字会漏掉真正的目标（`const MAX = 512` 的名字里没有任何概念词）。
 */
const PROTECTED_VALUES = ["23", "3", "512", "20"];

/**
 * 名字里出现这些 **token**（按 `_` 分词，不是子串匹配）说明它在讲 BLE 载荷这件事。
 *
 * 为什么必须分词：`CONNECT_ATTEMPTS` 含子串 `ATT`，用子串匹配会误伤 ——
 * 这条守卫一旦误报就会被加白名单，然后就形同虚设（本项目最忌讳的那种失效）。
 */
const CONCEPT_TOKENS = new Set(["MTU", "ATT", "GATT", "PAYLOAD", "NOTIFY", "CHUNK"]);

/** 语义真空的名字：它们对读者没有任何信息量，值又恰好是受保护字面量时最可疑。 */
const VACUOUS_NAMES = new Set(["DEFAULT", "MAX", "MIN", "LIMIT", "SIZE", "LEN"]);

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "target" || e.name === "vendor") continue;
      walk(p, acc);
    } else if (e.name.endsWith(".rs")) {
      acc.push(p);
    }
  }
  return acc;
}

const files = walk(SRC).map((p) => ({ abs: p, rel: path.relative(SRC, p) }));
const byRel = new Map(files.map((f) => [f.rel, f]));

let ok = true;

// ---------------- 判据 A：唯一具名定义点 ----------------
/** 定义 = `const NAME` / `fn NAME`（带可选 `pub`），且不在注释里。 */
function definitionsOf(src, name) {
  const hits = [];
  const lines = src.split("\n");
  const constRe = new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const|static)\\s+${name}\\s*[:=]`);
  const fnRe = new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:const\\s+)?(?:async\\s+)?fn\\s+${name}\\s*[(<]`);
  lines.forEach((ln, i) => {
    if (ln.trim().startsWith("//")) return; // 注释里提到不算定义
    if (constRe.test(ln) || fnRe.test(ln)) hits.push(i + 1);
  });
  return hits;
}

console.log("判据 A：唯一具名定义点");
for (const [name, home] of Object.entries(CANONICAL)) {
  const found = [];
  for (const f of files) {
    const src = readFileSync(f.abs, "utf8");
    if (!src.includes(name)) continue;
    for (const line of definitionsOf(src, name)) found.push({ rel: f.rel, line });
  }
  if (found.length === 0) {
    ok = false;
    console.error(`  ✗ ${name}：整个 crate 里找不到定义（应住在 ${home}）`);
  } else if (found.length > 1) {
    ok = false;
    console.error(`  ✗ ${name}：有 ${found.length} 处定义（应只有 ${home} 一处）：`);
    for (const h of found) console.error(`      ${h.rel}:${h.line}`);
  } else if (found[0].rel !== home) {
    ok = false;
    console.error(`  ✗ ${name}：定义在 ${found[0].rel}:${found[0].line}，应在 ${home}`);
  } else {
    console.log(`  ✓ ${name} —— 唯一，位于 ${home}`);
  }
}

// ---------------- 判据 B：概念不许用匿名常量重述 ----------------
console.log("\n判据 B：BLE 领域内不许用匿名常量重述受保护的字面量");
const constDefRe = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[^=]+=\s*([^;]+);/;
let bFindings = 0;
for (const rel of BLE_DOMAIN_FILES) {
  const f = byRel.get(rel);
  if (!f) {
    ok = false;
    console.error(`  ✗ 清单里的文件不存在：${rel}（文件被改名/删除了？请同步本脚本）`);
    continue;
  }
  const lines = readFileSync(f.abs, "utf8").split("\n");
  lines.forEach((ln, i) => {
    if (ln.trim().startsWith("//")) return;
    const m = constDefRe.exec(ln);
    if (!m) return;
    const [, name, rawValue] = m;
    const value = rawValue.trim();
    if (!PROTECTED_VALUES.includes(value)) return;
    if (name in CANONICAL) return; // 规范名字，合法
    // 名字得**确实在讲这件事**：按 `_` 分词后命中概念词，或本身就是语义空名。
    const tokens = name.toUpperCase().split("_");
    const looksLikeConcept =
      tokens.some((t) => CONCEPT_TOKENS.has(t)) || VACUOUS_NAMES.has(name.toUpperCase());
    if (!looksLikeConcept) return;
    bFindings++;
    ok = false;
    console.error(
      `  ✗ ${rel}:${i + 1}  const ${name} = ${value}\n` +
        `      「${value}」的含义由 transport/ble_framing.rs 的具名常量承担；\n` +
        `      匿名常量 + 注释解释语义 = 第二份事实来源（4.18.7→4.18.10 就是这么埋下的）。`,
    );
  });
}
if (bFindings === 0) {
  console.log(`  ✓ BLE 领域的 ${BLE_DOMAIN_FILES.length} 个文件里没有匿名重述`);
}

// ---------------- 汇总 ----------------
if (ok) {
  console.log("\n✓ BLE 常量/换算的单一事实来源成立。");
  console.log("  （已知边界：拦不住把换算内联成表达式，那类只能靠 review。）");
  process.exit(0);
}
console.error("\n✗ BLE 常量/换算存在第二份事实来源。");
process.exit(1);
