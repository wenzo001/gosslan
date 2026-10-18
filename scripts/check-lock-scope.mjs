#!/usr/bin/env node
/**
 * db 锁作用域守卫（lock-scope guard）—— 挡住「emit 发生在 db 锁还活着的时候」。
 *
 * ## 为什么要有这个脚本
 *
 * 生产环境**只有一条** SQLite 连接，挂在 `AppState.db: Mutex<Connection>` 上
 * （取锁点条数由本脚本每次实算并打印，注释与文档里一律不留副本）。前端每个 IPC 命令都要抢这同一把锁。于是「锁内 emit」不是风格问题，
 * 是一条真实的卡顿链：
 *
 *   ① 后端在锁内 `app.emit("file-failed", …)`；
 *   ② Tauri 把事件投给 WebView，前端监听器立刻去调 `list_transfers` / `get_messages`；
 *   ③ 那次 IPC 抢不到 db 锁 —— 而持锁的这一帧还在做剩下的写库；
 *   ④ 用户看到的现象：传输出错的那一刻界面整个冻一下。
 *
 * 这条纪律早就写在 `network/transport.rs:90`（"锁只圈住写库，emit 一律出锁再做"），
 * `lib.rs` 里也有一条针对中继回收的源码守卫。但**注释管不住新写的分支**：2026-09-25 给接收侧
 * 补静默回收时，`fail_taken_receive`（`network/file.rs`）就是照着"写库 + emit 连着写"的形状
 * 长出来的 —— 同一个函数体内两条相邻语句，逐行看谁都觉得它没错，只有全局扫才看得见它违约。
 * 所以现在把判据从"一条注释 + 一个点的守卫"升级成"全部取锁点逐处扫"。
 *
 * ## 判据
 *
 *  A. **guard 本身就是绑定值**：`let NAME = …lock()…;` 且那个 `.lock()` 在括号深度 0
 *     （= 右值的主体就是这把锁，不是"作为实参传给另一个函数"）。`MutexGuard` 活在
 *     语句所在块里，所以从绑定行到**存活终点**之间不得出现 emit。存活终点取更早的：
 *       · 所在块的结束行；
 *       · 第一条 `drop(NAME)`。
 *     块结束行用缩进判定：rustfmt 保证语句缩进 I、其所在块的闭合 `}` 缩进 I-4，
 *     更深的嵌套闭合只会缩进得更厉害 ⇒ 第一条"缩进恰为 I-4 且以 `}` 开头"的行就是终点。
 *     这条路**不需要数大括号**，因此不受字符串字面量 / `format!` / raw string 干扰。
 *  B. **其余位置的取锁**（实参里的 `db::get_group(&state.db.lock()…)`、`if let` 条件、
 *     let-else）：临时量在**本语句结束**时析构 ⇒ 只判"到本语句结束前不得 emit"。
 *     ⚠️ 这一半依赖 `edition = "2021"`（实测 Cargo.toml:6）：2024 版把 `if let` / `while let`
 *     条件式里的临时量延长到整个表达式结束 ⇒ **将来升 edition 时 B 类必须改成块级判据**，
 *     否则这里会假绿。升 edition 是全局大事，届时这条注释就是唯一的地图。
 *  C. **覆盖率不许作假**：A 类找不到块结束行 ⇒ **直接 FAIL**（不是跳过）。否则这个脚本会
 *     因为"看不懂"而静默变绿，那正是本仓库最忌讳的失效方式。
 *  D. **持锁期间不许调用"自锁 helper"**（`db 自死锁`，真机 2026-10-18 J2 21 连红的根因）：
 *     `AppState.db` 是 `std::sync::Mutex`，**不可重入** ⇒ 守卫活着时调用一个内部还会
 *     `state.db.lock()` 的函数 = 同一线程二次取锁 = 永久 park。它比锁内 emit 狠一个量级：
 *     emit 只是冻一下，这一条把整进程的接收侧读循环停住，**只有重启才恢复**。
 *     判法：先全仓**第一遍**收集"函数体内出现 db 取锁"的函数名（自锁 helper 集合，条数每次实算打印），
 *     **第二遍**在每个 A 类守卫的存活期（同样认 `drop(NAME)`）内找 `NAME(` 形式的调用。
 *     修法与本仓既有先例一致：`drop(dbc);` → 调用 → 需要时再 `let dbc = …`（见 `group_file.rs` 那段注释）。
 *
 * ## ⚠️ 本脚本守不住的事（别把它当完整的数据流分析）
 *
 * · **跨函数的 emit**：锁内调了一个内部会 emit 的函数，而函数名不带 `emit` ⇒ 看不见。
 *   缓解靠命名纪律：**会 emit 的一律叫 `emit*`**（现状如此 —— `emit_failed` 是唯一 helper）。
 * · **D 类认不出"把守卫当参数传下去后再调自锁 helper"**：存活期只算到当前函数的当前块，
 *   跨函数把 `&dbc` 交出去、被调方在自己的作用域里再调自锁 helper ⇒ 看不见。
 * · **D 类的自锁集合按"函数体里有没有 db 取锁"认**：内部取锁但字段名不叫 `db*`
 *   （例如把 `&DbLock` 改名成别的）⇒ 漏收；宏展开里取锁 ⇒ 漏收。
 * · **D 类只判 A 类守卫**：B 类语句临时量在本语句结束就析构，本语句内的调用按 Rust 求值顺序
 *   理论上仍可能撞上，实测本仓 0 例 ⇒ 未纳入，升 edition 2024 时要重判。
 * · **别的 Mutex**（`peers` / `file_receivers` / `relay`）：本脚本只管 db 那把，因为只有它
 *   被前端 IPC 抢。把规则推广到全部锁需要逐个论证"谁在抢它"，属另一轮。
 * · **宏生成的代码**：不扫，行级分析分不清展开后的作用域。
 * · **测试代码为什么不用排除**：测试里确实也有 `db.lock()` 形状，但那里的"emit"全是源码守卫
 *   探针里的**字符串字面量**（`body.find("state.app.emit")`）—— 判据先把字符串抹掉再找发射点，
 *   所以测试自然静音（实测：抹掉字符串后 `lib.rs` 的测试模块贡献 0 条判定）。
 *
 * ## 用法
 *
 *     node scripts/check-lock-scope.mjs             # 扫全仓（verify 快速层跑的就是这个）
 *     node scripts/check-lock-scope.mjs --self-test # 只跑夹具自证（判据本身是否非空转）
 *
 * 退出码：0 = 通过；1 = 有违约 / 有判不了的取锁点 / 自证失败。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = path.join(ROOT, "src-tauri", "src");

/** 绑定语句的头：`let [mut] NAME =`。 */
const BIND_RE = /^(\s*)let\s+(?:mut\s+)?([A-Za-z_]\w*)\s*=/;
/** 取锁本身。 */
const LOCK_RE = /\.lock\s*\(\s*\)/;
/** 被 lock 的那个字段是不是 db 那把锁（`state.db.lock()` / `self.db.lock()` / `s.db.lock()`）。 */
const DB_LOCK_RE = /\bdb\w*\s*\.\s*lock\s*\(/;
/** 事件发射点：`state.app.emit(` / `emit_to(` / `emit_failed(` 都算。 */
const EMIT_RE = /\.emit\b|\bemit_\w+\s*\(/;
/** 函数定义头（含 `pub(crate)` / `async` / `unsafe` / `const` / 泛型名）。 */
const FN_RE = /^(\s*)(?:[^=()]*?\bfn\s+)([A-Za-z_]\w*)\b/;
/** 只有声明没有体的trait 方法：本行到语句结束是 `;` ⇒ 不当函数体处理。 */
const NO_BODY_RE = /^\s*(?:[^=]*?\bfn\s+[A-Za-z_]\w*\b[^{};]*)?;\s*$/;

function collectRs(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === "target" || e === "node_modules" || e === "vendor") continue;
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) collectRs(p, acc);
    else if (e.endsWith(".rs")) acc.push(p);
  }
  return acc;
}

/**
 * 抹掉行尾注释与**字符串字面量**（保留引号本身所占的位置）。
 * 两步都必要：
 *  · 注释里的 `emit` 不是发射点；
 *  · 测试代码里的 `body.find("state.app.emit")` 是源码守卫的**探针**，不是发射点 ——
 *    本脚本因此不需要排除 `#[cfg(test)]`（实测：抹掉字符串后测试贡献 0 条判定）。
 */
function code(line) {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])'/g, "''");
}

/** 一段文本里第一个 `.lock()` 处于第几层括号。0 = 右值主体就是这把锁；>0 = 它是别人的实参。 */
function lockParenDepth(text) {
  const at = text.search(LOCK_RE);
  if (at < 0) return -1;
  let depth = 0;
  for (let i = 0; i < at; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
  }
  return depth;
}

/**
 * 把 `lines[i]` 归并进它所在的**取锁链**：rustfmt 会把长链拆成
 * `let dbc = state` / `    .db` / `    .lock()` 三行，所以单看一行会漏判。
 * 向上回看最多 4 行，只要上一行"以 `.` 开头（链式续行）"或"以 `=` / `(` 收尾（链的头）"就继续。
 *
 * @returns {{head: number, text: string}|null} 链的起始行下标与拼接后的文本；
 *          这一行不含 db 取锁时返回 null。
 */
function dbLockChain(lines, i) {
  if (!LOCK_RE.test(code(lines[i]))) return null;
  let head = i;
  for (let k = 1; k <= 4; k++) {
    const up = i - k;
    if (up < 0) break;
    const u = code(lines[up]);
    if (!/^\s*\./.test(lines[up]) && !/[=(]\s*$/.test(u)) break;
    head = up;
  }
  const text = [];
  for (let j = head; j <= i; j++) text.push(code(lines[j]).trim());
  const joined = text.join("");
  return DB_LOCK_RE.test(joined) ? { head, text: joined } : null;
}

/**
 * 第一遍（D 类用）：收集"函数体内出现 db 取锁"的函数名 = 自锁 helper 集合。
 * 体范围沿用 A 类那套缩进判据：`fn` 头缩进 I，体结束 = 第一条"缩进恰为 I 且以 `}` 开头"的行；
 * 只有声明没有体的 trait 方法跳过。嵌套 `fn` 不跳过外层，各自算一次。
 */
function collectSelfLockers(lines, set) {
  for (let i = 0; i < lines.length; i++) {
    const c = code(lines[i]);
    if (NO_BODY_RE.test(c)) continue;
    const m = FN_RE.exec(c);
    if (!m) continue;
    const closeRe = new RegExp(`^ {${m[1].length}}}`);
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    for (let j = i; j <= end; j++) {
      if (DB_LOCK_RE.test(code(lines[j]))) {
        set.add(m[2]);
        break;
      }
    }
  }
}

/** 单文件自锁集合（只在省略 `scanFile` 第二参时用，即夹具自证）。 */
function collectInto(lines) {
  const s = new Set();
  collectSelfLockers(lines, s);
  return s;
}

/**
 * `lines[i]`（缩进 ind 的一条语句）所在块的结束行下标。
 * 判据：第一条"缩进正好 ind-4 且以 `}` 开头"的行。找不到返回 -1（= 无法判定）。
 */
function blockEnd(lines, i, ind) {
  if (ind < 4) return -1;
  const re = new RegExp(`^ {${ind - 4}}}`);
  for (let j = i + 1; j < lines.length; j++) if (re.test(lines[j])) return j;
  return -1;
}

/**
 * 语句结束行：第一条以 `;` 收尾、或以 `{` 收尾的行。
 * 后者是给 `if let Some(x) = f(&lock)` 这种形态准备的 —— 条件表达式在 `{` 处就结束了，
 * edition 2021 下临时量正是那一刻析构（见文件头判据 B）。
 */
function stmtEnd(lines, i) {
  for (let j = i; j < lines.length; j++) {
    const t = code(lines[j]).trimEnd();
    if (t.endsWith(";") || t.endsWith("{")) return j;
  }
  return lines.length - 1;
}

/**
 * 扫描单个文件源码。返回 { guardSites, tempSites, violations, undecidable, reentries }。
 * violations: { line, emitLine, name, kind }；reentries: { line, callLine, name, helper }
 * @param selfLockers 全仓自锁 helper 名集合；省略时按本文件自建（供夹具自证用）。
 */
function scanFile(text, selfLockers) {
  const lines = text.split("\n");
  const helpers = selfLockers ?? new Set(collectInto(lines));
  const violations = [];
  const undecidable = [];
  const reentries = [];
  const seen = new Set();
  let guardSites = 0;
  let tempSites = 0;

  for (let i = 0; i < lines.length; i++) {
    const chain = dbLockChain(lines, i);
    if (!chain) continue;
    // 链被拆成多行时，同一条语句只判一次。
    if (seen.has(chain.head)) continue;
    seen.add(chain.head);
    const headLine = lines[chain.head];
    const bind = BIND_RE.exec(code(headLine));
    // A 类：绑定值就是这把锁本身（`.lock()` 在括号深度 0）。
    if (bind && lockParenDepth(chain.text) === 0) {
      guardSites++;
      const ind = bind[1].length;
      const name = bind[2];
      const end = blockEnd(lines, chain.head, ind);
      if (end < 0) {
        undecidable.push({
          line: chain.head + 1,
          why: `判不出 ${name} 所在块的结束行（缩进 ${ind}）`,
        });
        continue;
      }
      let aliveTo = end;
      for (let j = chain.head + 1; j < end; j++) {
        if (new RegExp(`\\bdrop\\(\\s*${name}\\s*\\)`).test(code(lines[j]))) {
          aliveTo = j;
          break;
        }
      }
      for (let j = chain.head + 1; j < aliveTo; j++) {
        if (EMIT_RE.test(code(lines[j]))) {
          violations.push({ line: chain.head + 1, emitLine: j + 1, name, kind: "guard 绑定" });
          break;
        }
      }
      // D 类：同一个存活期内调用自锁 helper = 同线程二次取锁 ⇒ 永久 park。
      outer: for (let j = chain.head + 1; j < aliveTo; j++) {
        const c = code(lines[j]);
        for (const h of helpers) {
          if (new RegExp(`(?<![\\w:])${h}\\s*\\(`).test(c)) {
            reentries.push({ line: chain.head + 1, callLine: j + 1, name, helper: h });
            break outer;
          }
        }
      }
      continue;
    }

    // B 类：语句级临时借用（实参 / if let 条件 / let-else），存活到本语句结束。
    tempSites++;
    const end = stmtEnd(lines, chain.head);
    for (let j = chain.head; j <= end; j++) {
      if (EMIT_RE.test(code(lines[j]))) {
        violations.push({
          line: chain.head + 1,
          emitLine: j + 1,
          name: "(语句临时量)",
          kind: "实参/条件临时量",
        });
        break;
      }
    }
  }
  return { guardSites, tempSites, violations, undecidable, reentries };
}

/** 打印人话报告；返回是否通过。`helperCount` = 全仓自锁 helper 名条数（分母，现算打印）。 */
function report(results, helperCount = 0) {
  let guard = 0;
  let temp = 0;
  const all = [];
  const re = [];
  const und = [];
  for (const [rel, r] of results) {
    guard += r.guardSites;
    temp += r.tempSites;
    for (const v of r.violations) all.push([rel, v]);
    for (const x of r.reentries) re.push([rel, x]);
    for (const u of r.undecidable) und.push([rel, u]);
  }
  if (und.length > 0) {
    console.error(`✗ 有 ${und.length} 处 db 取锁**判不出**作用域（判据 C 不许静默放过）：`);
    for (const [rel, u] of und) console.error(`    · ${rel}:${u.line} —— ${u.why}`);
    console.error("  通常是缩进异常（忘了 `cargo fmt`）或链式换行超过回看深度。");
    console.error("  改成「`let dbc = state.db.lock()…;` 独占一行、外面用 `{ }` 圈住写库」就又能判了。");
    return false;
  }
  if (re.length > 0) {
    console.error(
      `✗ db 守卫活着时调用自锁 helper（同线程二次取锁 ⇒ std Mutex 永久 park）：${re.length} 处`,
    );
    for (const [rel, x] of re) {
      console.error(
        `    · ${rel}:${x.line} ${x.name} 存活期内，第 ${x.callLine} 行调用 ${x.helper}()（它内部也取 db 锁）`,
      );
    }
    console.error("  为什么要紧：这不是「冻一下」，是那条电路整个停住 —— 收不到帧、不回执、");
    console.error("           发送侧台账永不收口，只有重启才恢复（真机 2026-10-18 J2 的根因）。");
    console.error("  修法：`drop(dbc);` 后再调用，需要继续写库就重新 `let dbc = …`（先例见 group_file.rs）。");
    return false;
  }
  if (all.length > 0) {
    console.error(`✗ db 锁活着的时候 emit：${all.length} 处（共判 ${guard + temp} 个取锁点）`);
    for (const [rel, v] of all) {
      console.error(
        `    · ${rel}:${v.line} ${v.name}（${v.kind}）的存活期内，第 ${v.emitLine} 行在 emit`,
      );
    }
    console.error("  为什么要紧：只有一条 SQLite 连接，前端收到事件后的第一次 IPC 要抢同一把锁");
    console.error("           ⇒ 事件发出的那一刻界面会冻一下（完整机制见本文件头部）。");
    console.error("  修法：把写库用 `{ … }` 圈住（或 `drop(dbc);`），emit 放到存活期之外。");
    return false;
  }
  console.log(
    `✓ db 锁作用域：${guard} 个 guard 绑定 + ${temp} 个语句临时量全部判过，` +
      `没有一处锁活着时 emit；自锁 helper ${helperCount} 个名字，持锁调用它们 0 处`,
  );
  return true;
}

/* ----------------------------- 判据自证 ----------------------------- */

/** 锁内 emit：必须被抓。 */
const FIX_GUARD_EMIT = [
  "fn f(state: &AppState) {",
  "    let dbc = state.db.lock().unwrap();",
  "    db::upsert(&dbc);",
  "    let _ = state.app.emit(\"file-failed\", &1);",
  "}",
].join("\n");

/** `{ }` 出锁：必须放过。 */
const FIX_BLOCK = [
  "fn f(state: &AppState) {",
  "    {",
  "        let dbc = state.db.lock().unwrap();",
  "        db::upsert(&dbc);",
  "    }",
  "    let _ = state.app.emit(\"file-failed\", &1);",
  "}",
].join("\n");

/** `drop(dbc)` 出锁：必须放过。 */
const FIX_DROP = [
  "fn f(state: &AppState) {",
  "    let dbc = state.db.lock().unwrap();",
  "    db::upsert(&dbc);",
  "    drop(dbc);",
  "    emit_failed(state, \"x\");",
  "}",
].join("\n");

/** 实参位置的临时量：锁在本语句结束就没了，后面的 emit 必须放过（B 类）。 */
const FIX_ARGTEMP = [
  "fn f(state: &AppState) {",
  "    let g = db::get_group(&state.db.lock().unwrap(), \"x\").ok()?;",
  "    let _ = state.app.emit(\"group-updated\", &g);",
  "}",
].join("\n");

/** `if let` 条件里的临时量：edition 2021 下析构在块之前，必须放过（B 类）。 */
const FIX_IFLET = [
  "fn f(state: &AppState) {",
  "    if let Some(g) = db::get_friend(&state.db.lock().unwrap(), id) {",
  "        let _ = state.app.emit(\"friend\", &g);",
  "    }",
  "}",
].join("\n");

/** 临时量和 emit 挤在同一条语句里：必须被抓（B 类的正例，防止 B 类只会放过）。 */
const FIX_ARGTEMP_EMIT = [
  "fn f(state: &AppState) {",
  "    let g = db::get_group(&state.db.lock().unwrap(), \"x\")",
  "        .map(|x| emit_one(&x))",
  "        .ok()?;",
  "}",
].join("\n");

/** 判不出块结束行：必须走 undecidable（判据 C），不能静默放过。 */
const FIX_UNDECIDABLE = ["    let dbc = state.db.lock().unwrap();", "    db::upsert(&dbc);"].join(
  "\n",
);

/** D 类正例：守卫活着时调用"内部也取 db 锁"的 helper ⇒ 同线程二次取锁，必须被抓。 */
const FIX_REENTER = [
  "fn nickname(state: &AppState) -> String {",
  "    let dbc = state.db.lock().unwrap();",
  "    String::new()",
  "}",
  "fn f(state: &AppState) {",
  "    let dbc = state.db.lock().unwrap();",
  "    db::upsert(&dbc);",
  "    let nm = nickname(state);",
  "    db::touch(&dbc, &nm);",
  "}",
].join("\n");

/** D 类反证：先 `drop(dbc)` 再调用同一个人 ⇒ 放过（这条就是本仓 group_file.rs 的先例形状）。 */
const FIX_REENTER_DROP = [
  "fn nickname(state: &AppState) -> String {",
  "    let dbc = state.db.lock().unwrap();",
  "    String::new()",
  "}",
  "fn f(state: &AppState) {",
  "    let dbc = state.db.lock().unwrap();",
  "    db::upsert(&dbc);",
  "    drop(dbc);",
  "    let nm = nickname(state);",
  "}",
].join("\n");

function selfTest() {
  const cases = [
    ["guard 绑定后立刻 emit → 抓", FIX_GUARD_EMIT, { violations: 1, undecidable: 0, reentries: 0 }],
    ["`{ }` 出锁 → 放", FIX_BLOCK, { violations: 0, undecidable: 0, reentries: 0 }],
    ["`drop(dbc)` 出锁 → 放", FIX_DROP, { violations: 0, undecidable: 0, reentries: 0 }],
    [
      "实参临时量、emit 在下一条语句 → 放",
      FIX_ARGTEMP,
      { violations: 0, undecidable: 0, reentries: 0 },
    ],
    [
      "if let 条件临时量（edition 2021）→ 放",
      FIX_IFLET,
      { violations: 0, undecidable: 0, reentries: 0 },
    ],
    [
      "临时量存活期内（同一条语句）emit → 抓",
      FIX_ARGTEMP_EMIT,
      { violations: 1, undecidable: 0, reentries: 0 },
    ],
    [
      "判不出块结束 → 报无法判定",
      FIX_UNDECIDABLE,
      { violations: 0, undecidable: 1, reentries: 0 },
    ],
    [
      "持锁调用自锁 helper → 抓（D 类）",
      FIX_REENTER,
      { violations: 0, undecidable: 0, reentries: 1 },
    ],
    [
      "drop(dbc) 后调用自锁 helper → 放（D 类反证）",
      FIX_REENTER_DROP,
      { violations: 0, undecidable: 0, reentries: 0 },
    ],
  ];
  let ok = true;
  for (const [name, src, want] of cases) {
    const got = scanFile(src);
    if (
      got.violations.length !== want.violations ||
      got.undecidable.length !== want.undecidable ||
      got.reentries.length !== want.reentries
    ) {
      ok = false;
      console.error(
        `✗ 自证失败：「${name}」期望 抓${want.violations}/判不了${want.undecidable}/自锁调用${want.reentries}，` +
          `实得 抓${got.violations.length}/判不了${got.undecidable.length}/自锁调用${got.reentries.length}`,
      );
    }
  }
  const caught = cases.filter(
    (c) => c[2].violations + c[2].undecidable + c[2].reentries > 0,
  ).length;
  if (ok) {
    console.log(
      `✓ 判据自证：${cases.length} 段夹具全部符合预期（抓 ${caught} / 放 ${cases.length - caught}）`,
    );
  }
  return ok;
}

if (process.argv.includes("--self-test")) {
  process.exit(selfTest() ? 0 : 1);
}

const texts = collectRs(SOURCE_ROOT).map((f) => [path.relative(ROOT, f), readFileSync(f, "utf8")]);
// D 类要跨文件知道"哪些函数内部取 db 锁"⇒ 先整遍收集名字（分母现算打印），再逐文件判存活期。
const helpers = new Set();
for (const [, t] of texts) collectSelfLockers(t.split("\n"), helpers);
const results = texts.map(([rel, text]) => [rel, scanFile(text, helpers)]);

process.exit(selfTest() && report(results, helpers.size) ? 0 : 1);
