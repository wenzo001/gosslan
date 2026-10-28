#!/usr/bin/env node
/**
 * panic 站点棘轮：生产代码里"能 abort 整个进程"的语法形态只许减少、不许增加。
 *
 * 为什么需要它：release 是 `panic = "abort"`（安卓入口宏的硬约束），任意一处
 * `panic!` / `unwrap` / `expect` 都会让整个应用消失。2026-10-25 的 macOS 连续
 * SIGABRT 就是 vendored CoreBluetooth 里一条迟到回调 panic 放大的。
 *
 * 判据分两层：
 * 1. **vendored btleplug CoreBluetooth：硬零**（生产块里 `panic!` / `.expect(` /
 *    非锁 `.unwrap()` 都必须为 0）。这是已经清完的类，不允许再长回来。
 * 2. 本仓 `src-tauri/src/**`：按文件计数对 `scripts/panic-sites-baseline.json` 做棘轮
 *    （涨则红，降允许；基线只能由本脚本的 `--update` 生成）。
 *
 * 两条"尺子"必须先剔干净，否则读数全是假的：
 * - **注释与字符串**：`panic!(` 出现在注释或消息字符串里不算站点（`central_delegate.rs`
 *   的注释就写着 `try_into().unwrap()`）。
 * - **`#[cfg(test)]` 条目**：生产文件里有 102 处文件内测试模块/函数；只剔 `mod tests`
 *   会把测试 panic 算进基线，还会把测试块之后的生产代码整段漏掉。
 *
 * 用法：
 *   node scripts/check-panic-sites.mjs --check   # 门禁用（默认）
 *   node scripts/check-panic-sites.mjs --update  # 重新生成基线（只在真实收敛/新增文件时）
 *   node scripts/check-panic-sites.mjs --self-test
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src-tauri", "src");
const VENDOR = join(ROOT, "src-tauri", "vendor", "btleplug", "src", "corebluetooth");
const BASELINE = join(ROOT, "scripts", "panic-sites-baseline.json");

const args = new Set(process.argv.slice(2));
const UPDATE = args.has("--update");
const SELF_TEST = args.has("--self-test");

/** 把注释、字符串、字符字面量抹成空格；**保持长度与换行**（行号仍可回读）。 */
export function stripRust(src) {
  const n = src.length;
  let out = "";
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) out += src[k] === "\n" ? "\n" : " ";
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }
    const raw = /^(b?r)(#*)"/.exec(src.slice(i, i + 32));
    if (raw) {
      const endMarker = '"' + raw[2];
      let j = i + raw[0].length;
      while (j < n && !src.startsWith(endMarker, j)) j++;
      j = Math.min(n, j + endMarker.length);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'") {
      const ch = /^'(?:\\.|[^\\'])'/.exec(src.slice(i, i + 8));
      if (ch) {
        blank(i, i + ch[0].length);
        i += ch[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * `cfg` 属性里是否含**裸标识符** `test`。
 *
 * ⚠️ 不能只认 `#[cfg(test)]`（审计 P1 #15）：本仓已有 `#[cfg(all(test, desktop))]`
 * （`commands/updater.rs`），旧正则认不出它 ⇒ 那个模块里的 1 个 panic! + 2 个 unwrap
 * 一直被算成"生产站点"，基线把它们写进期望值之后**棘轮反向失效**：再往生产段加
 * 一处 panic! + 两处 unwrap，读数仍不超过基线 ⇒ 门禁不红。
 * 用词边界而不是子串：`test_mode` 这类标识符不算 `test` 门。
 */
function cfgInnerHasTest(inner) {
  return /(^|[^A-Za-z0-9_])test([^A-Za-z0-9_]|$)/.test(inner);
}

/** 抹掉所有 `cfg(...test...)` 标注的条目（mod / fn / impl / use…），保持长度。 */
export function stripCfgTest(text) {
  const ranges = [];
  // 只用到 `#[cfg(` 起点，括号配对在循环内自己扫（cfg 里可以嵌套 `all(...)` / `any(...)`）。
  const re = /#\[cfg\(/g;
  let m;
  while ((m = re.exec(text))) {
    // 找配对的右括号，再要求紧跟 `]`（即整条是 `#[cfg(...)]`）。
    let depth = 1;
    let k = m.index + m[0].length;
    for (; k < text.length && depth > 0; k++) {
      if (text[k] === "(") depth++;
      else if (text[k] === ")") depth--;
    }
    if (depth !== 0 || text[k] !== "]") continue;
    const inner = text.slice(m.index + m[0].length, k - 1);
    if (!cfgInnerHasTest(inner)) continue;
    let i = k + 1;
    // 跳过紧随其后的其它属性（`#[allow(…)]` 等）
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (!text.startsWith("#[", i)) break;
      const end = text.indexOf("]", i);
      if (end < 0) break;
      i = end + 1;
    }
    let j = i;
    let brace = -1;
    let semi = -1;
    while (j < text.length) {
      if (text[j] === "{") {
        brace = j;
        break;
      }
      if (text[j] === ";") {
        semi = j;
        break;
      }
      j++;
    }
    if (brace >= 0) ranges.push([m.index, matchBrace(text, brace)]);
    else if (semi >= 0) ranges.push([m.index, semi + 1]);
    else ranges.push([m.index, text.length]);
  }
  let out = text;
  // 长度保持 ⇒ 索引不会因前面的替换而失效。
  for (const [s, e] of ranges) {
    out = out.slice(0, s) + out.slice(s, e).replace(/[^\n]/g, " ") + out.slice(e);
  }
  return out;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** 分析一段 Rust 源码，返回生产块的站点清单。 */
export function analyze(src) {
  const clean = stripCfgTest(stripRust(src));
  const lockUnwraps = [];
  for (const m of clean.matchAll(/\block\(\)\s*\.unwrap\s*\(\s*\)/g)) {
    lockUnwraps.push([m.index, m.index + m[0].length]);
  }
  const insideLock = (at) => lockUnwraps.some(([s, e]) => at >= s && at < e);
  const sites = [];
  for (const [kind, re] of [
    ["panic", /panic!\s*\(/g],
    ["expect", /\.expect\s*\(/g],
    ["unwrap", /\.unwrap\s*\(\s*\)/g],
  ]) {
    for (const m of clean.matchAll(re)) {
      if (kind === "unwrap" && insideLock(m.index)) continue;
      sites.push({ kind, line: lineAt(clean, m.index) });
    }
  }
  const counts = { panic: 0, expect: 0, unwrap: 0 };
  for (const s of sites) counts[s.kind]++;
  return { counts, sites };
}

function walkRust(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (name.endsWith(".rs") && !name.endsWith("_tests.rs") && name !== "tests.rs") out.push(p);
    }
  }
  return out.sort();
}

function addCounts(a, b) {
  return { panic: a.panic + b.panic, expect: a.expect + b.expect, unwrap: a.unwrap + b.unwrap };
}

function runSelfTest() {
  const cases = [
    ["生产 panic!", `fn f() { panic!("boom"); }`, { panic: 1, expect: 0, unwrap: 0 }],
    ["普通 unwrap", `fn f() { let x = y.unwrap(); }`, { panic: 0, expect: 0, unwrap: 1 }],
    ["锁 unwrap 放行", `fn f() { let x = m.lock().unwrap(); }`, { panic: 0, expect: 0, unwrap: 0 }],
    ["测试模块内 panic 不计", `#[cfg(test)]\nmod tests {\n  #[test]\n  fn t() { panic!("x"); }\n}\nfn prod() {}\n`, { panic: 0, expect: 0, unwrap: 0 }],
    ["测试函数内 unwrap 不计", `#[cfg(test)]\nfn helper() -> u8 { x.unwrap() }\n`, { panic: 0, expect: 0, unwrap: 0 }],
    ["注释里的 panic 不计", `// panic!("x")\nfn f() {}\n`, { panic: 0, expect: 0, unwrap: 0 }],
    ["字符串里的 unwrap 不计", `fn f() { let s = "x.unwrap()"; }`, { panic: 0, expect: 0, unwrap: 0 }],
    ["expect 计入", `fn f() { let x = y.expect("x"); }`, { panic: 0, expect: 1, unwrap: 0 }],
    // 审计 P1 #15：`all(test, desktop)` 与 `any(test, feature=…)` 都必须被剥离 ——
    // 旧正则只认字面 `#[cfg(test)]`，这两个形状会把测试段算成生产站点。
    ["all(test, desktop) 也要剥离", `#[cfg(all(test, desktop))]\nmod t {\n  fn x() { panic!("x"); }\n}\n`, { panic: 0, expect: 0, unwrap: 0 }],
    ["any(test, feature) 也要剥离", `#[cfg(any(test, feature = "x"))]\nmod t {\n  fn y() { z.unwrap(); }\n}\n`, { panic: 0, expect: 0, unwrap: 0 }],
    ["cfg(feature=test_util) 不算 test 门", `#[cfg(feature = "test_util")]\nfn f() { panic!("x"); }`, { panic: 1, expect: 0, unwrap: 0 }],
  ];
  for (const [name, src, want] of cases) {
    const got = analyze(src).counts;
    assert.deepEqual(got, want, `self-test 失败：${name}（实际 ${JSON.stringify(got)}）`);
  }
  console.log(`✓ self-test：${cases.length} 条正反控全部通过`);
}

function main() {
  if (SELF_TEST) {
    runSelfTest();
    return 0;
  }
  // 每次门禁都先跑正反控：提取器退化成"什么都认不出"时，基线检查会假装全绿。
  runSelfTest();
  assert.ok(existsSync(SRC), `找不到 ${SRC}`);
  assert.ok(existsSync(VENDOR), `找不到 ${VENDOR}`);

  const srcFiles = walkRust(SRC);
  const vendorFiles = readdirSync(VENDOR)
    .filter((n) => n.endsWith(".rs"))
    .map((n) => join(VENDOR, n))
    .sort();
  assert.ok(srcFiles.length >= 100, `只扫到 ${srcFiles.length} 个生产 rs（下限 100）⇒ 分母塌了`);
  assert.ok(vendorFiles.length >= 4, `只扫到 ${vendorFiles.length} 个 vendor corebluetooth rs`);

  let failures = 0;

  // ---- 第一层：vendored CoreBluetooth 硬零 ----
  for (const f of vendorFiles) {
    const { counts, sites } = analyze(readFileSync(f, "utf8"));
    if (counts.panic + counts.expect + counts.unwrap > 0) {
      failures += 1;
      console.error(`✗ vendored CoreBluetooth 必须零站点：${relative(ROOT, f)}`);
      for (const s of sites) console.error(`    ${relative(ROOT, f)}:${s.line}  ${s.kind}`);
    }
  }

  // ---- 第二层：本仓按文件棘轮 ----
  const current = {};
  let totals = { panic: 0, expect: 0, unwrap: 0 };
  for (const f of srcFiles) {
    const { counts } = analyze(readFileSync(f, "utf8"));
    const rel = relative(SRC, f);
    current[rel] = counts;
    totals = addCounts(totals, counts);
  }

  if (UPDATE) {
    const sorted = {};
    for (const k of Object.keys(current).sort()) sorted[k] = current[k];
    writeFileSync(
      BASELINE,
      JSON.stringify({ generatedBy: "scripts/check-panic-sites.mjs --update", files: sorted }, null, 2) + "\n",
      "utf8",
    );
    console.log(
      `✓ 基线已更新：panic ${totals.panic} / expect ${totals.expect} / unwrap ${totals.unwrap}（${srcFiles.length} 个文件）`,
    );
    return 0;
  }

  assert.ok(existsSync(BASELINE), `缺少基线 ${BASELINE}；先跑 --update`);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")).files ?? {};
  for (const [rel, counts] of Object.entries(current)) {
    const base = baseline[rel];
    if (!base) {
      if (counts.panic + counts.expect + counts.unwrap > 0) {
        failures += 1;
        console.error(
          `✗ 新文件不在基线里且带 panic 站点：${rel} → ${JSON.stringify(counts)}；先清掉或按流程 --update`,
        );
      }
      continue;
    }
    for (const kind of ["panic", "expect", "unwrap"]) {
      if (counts[kind] > base[kind]) {
        failures += 1;
        console.error(
          `✗ ${rel} 的 ${kind} 从 ${base[kind]} 涨到 ${counts[kind]}（棘轮只许降）`,
        );
        const { sites } = analyze(readFileSync(join(SRC, rel), "utf8"));
        for (const s of sites.filter((x) => x.kind === kind)) {
          console.error(`    ${rel}:${s.line}  ${s.kind}`);
        }
      }
    }
  }

  if (failures > 0) {
    console.error(`\npanic 站点检查失败：${failures} 处。`);
    return 1;
  }
  console.log(
    `✓ panic 站点棘轮：vendor 0 站点；本仓 panic ${totals.panic} / expect ${totals.expect} / unwrap ${totals.unwrap}（${srcFiles.length} 个生产文件，均未超过基线）`,
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
