#!/usr/bin/env node
/**
 * 不变量例外守卫（invariant exception guard）—— 双向校验「代码标记 ⋈ 文档登记」。
 *
 * ## 为什么要有这个脚本
 *
 * `docs/protocol-invariants.md` 里的 21 节不变量是**无条件**的，而 AI 的必读清单
 * （`docs/AI_ENGINEERING_INDEX.md`）明确指向它。所以一段**正当**的例外如果只写在实现旁边、
 * 没写进那份文档，就会产生一条很具体的误修路径：
 *
 *   ① AI 读到 INV-P04「发送可靠消息 → insert message + insert outbox」；
 *   ② 看到 `insert_self_message` 只 insert_message、没有 outbox；
 *   ③ 按文档判定这是 bug 并"修"它；
 *   ④ 自聊消息进入 outbox ⇒ 永远等不到 Ack ⇒ `flush_outbox` 每次心跳重发
 *      ⇒ 「outbox 必然排空」被真的破掉。
 *
 * **这次回归是"照文档修"造成的** —— 所以例外必须写进那份文档，且必须由机器保证两边一致。
 * 真实起因见提交 `7c03341`（「和自己聊天」）。
 *
 * ## 校验方式
 *
 *   代码侧：扫 `src-tauri/src` 与 `src`，取 `INV-EXCEPTION:` 标记里的 `INV-P<数字>` id。
 *   文档侧：只取 `docs/protocol-invariants.md` 中
 *           `<!-- BEGIN EXCEPTION REGISTRY -->` … `<!-- END EXCEPTION REGISTRY -->`
 *           之间的 id。
 *
 * 用显式注释当边界是刻意的：那份文档正文本来就到处是 `INV-Pxx`，不划边界就没法区分
 * "正文提到"与"登记为例外"。
 *
 * ## 判据（两个方向都会红）
 *
 *   · 代码标了、文档没登记 ⇒ **FAIL**（未登记的例外 —— 下一个人/AI 会照文档误修）
 *   · 文档登记了、代码没标 ⇒ **FAIL**（登记已过期，或标记被删了 —— 文档在说谎）
 *   · 登记了不存在的 id（例如 `INV-P99`）⇒ **FAIL**（文档里的 id 打错了）
 *
 * ## 用法
 *
 *     node scripts/check-invariant-exceptions.mjs
 *
 * 退出码：0 = 双向一致；1 = 有任何不一致。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INVARIANTS = path.join(ROOT, "docs", "protocol-invariants.md");

/** 登记区的边界（显式，见文件头说明）。 */
const BEGIN = "<!-- BEGIN EXCEPTION REGISTRY -->";
const END = "<!-- END EXCEPTION REGISTRY -->";

/** 一条例外 id 的形状：`INV-P` + 数字（与那份文档的 id 命名一致）。 */
const ID_RE = /INV-P\d+/g;

/** 代码里声明例外的标记：`INV-EXCEPTION: INV-P03, INV-P04 — 理由…`。 */
const MARKER_RE = /INV-EXCEPTION\s*:\s*([^\n]*)/;

/** 被扫描的源码根（相对仓库根）。 */
const SOURCE_ROOTS = ["src-tauri/src", "src"];
/** 只扫这些后缀，避免钻进 node_modules / target。 */
const SOURCE_EXT = [".rs", ".ts", ".vue"];

function collectFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // vendor 是第三方副本，它的注释不是我们的不变量纪律。
      if (e.name === "vendor" || e.name === "target" || e.name === "node_modules") continue;
      collectFiles(p, acc);
    } else if (SOURCE_EXT.some((x) => e.name.endsWith(x))) {
      acc.push(p);
    }
  }
  return acc;
}

/** 文档侧：登记区内的全部 id。 */
function docExceptions() {
  if (!existsSync(INVARIANTS)) {
    console.error(`✗ 找不到不变量文档：${path.relative(ROOT, INVARIANTS)}`);
    return null;
  }
  const text = readFileSync(INVARIANTS, "utf8");
  const start = text.indexOf(BEGIN);
  const stop = text.indexOf(END);
  if (start < 0 || stop < 0 || stop < start) {
    // 边界缺失时不猜：没有边界就无法区分"正文提到"与"登记为例外"，
    // 静默当成"没有例外"会让这个守卫变成空转（本仓库最忌讳的那类故障）。
    console.error("✗ 不变量文档里找不到例外登记区的边界注释：");
    console.error(`    ${BEGIN}`);
    console.error(`    ${END}`);
    console.error("  没有边界就无法可靠区分「正文提到」与「登记为例外」—— 请勿删掉这两个标记。");
    return null;
  }
  const region = text.slice(start + BEGIN.length, stop);
  return { ids: new Set(region.match(ID_RE) ?? []), region };
}

/** 代码侧：带标记的文件与 id。 */
function codeExceptions() {
  /** @type {Map<string, Set<string>>} id → 出现它的文件（相对路径） */
  const found = new Map();
  for (const root of SOURCE_ROOTS) {
    for (const file of collectFiles(path.join(ROOT, root))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("INV-EXCEPTION")) continue;
      for (const line of text.split("\n")) {
        const m = MARKER_RE.exec(line);
        if (!m) continue;
        const rel = path.relative(ROOT, file);
        for (const id of m[1].match(ID_RE) ?? []) {
          if (!found.has(id)) found.set(id, new Set());
          found.get(id).add(rel);
        }
      }
    }
  }
  return found;
}

const doc = docExceptions();
if (!doc) {
  console.error("\n不变量例外守卫失败：无法确定文档侧的例外清单。");
  process.exit(1);
}
const code = codeExceptions();

/** 文档里**定义**过的全部不变量 id（用来抓登记时的笔误）。 */
const definedIds = new Set(readFileSync(INVARIANTS, "utf8").match(/^### (INV-P\d+)/gm)?.map((s) => s.replace("### ", "")) ?? []);

const unregistered = [...code.keys()].filter((id) => !doc.ids.has(id));
const stale = [...doc.ids].filter((id) => !code.has(id));
const typos = [...doc.ids].filter((id) => !definedIds.has(id));

let ok = true;

if (unregistered.length > 0) {
  ok = false;
  console.error(`✗ 有 ${unregistered.length} 条例外在代码里标了，但没登记进不变量文档 §22：`);
  for (const id of unregistered) {
    console.error(`    · ${id}  ← ${[...code.get(id)].join("、")}`);
  }
  console.error("  为什么要紧：AI 的必读清单里只有那份文档。没登记的例外，");
  console.error("  下一个人会照文档把这段代码当 bug「修」掉。");
}

if (stale.length > 0) {
  ok = false;
  console.error(`✗ 有 ${stale.length} 条例外在文档 §22 里登记了，但代码里找不到对应标记：`);
  for (const id of stale) console.error(`    · ${id}`);
  console.error("  要么标记被删了（那这段代码的例外已无人声明），");
  console.error("  要么例外已不存在而登记忘了撤 —— 两种都会让文档变得不可信。");
}

if (typos.length > 0) {
  ok = false;
  console.error(`✗ 登记里出现文档未定义的不变量 id（可能是笔误）：`);
  for (const id of typos) console.error(`    · ${id}`);
}

if (ok) {
  const list = [...doc.ids].sort();
  console.log(
    `✓ 不变量例外：代码标记与文档登记一致（${list.length} 条）` +
      (list.length ? ` —— ${list.join("、")}` : "（当前没有例外）"),
  );
  console.log("  代码侧：");
  for (const id of list) console.log(`    · ${id}  ← ${[...code.get(id)].join("、")}`);
}

process.exit(ok ? 0 : 1);
