#!/usr/bin/env node
/**
 * 私钥边界守卫（key-boundary guard）—— 钉住 INV-P18「私钥不跨过 UI 边界」。
 *
 * ## 为什么这条值得单独一个判据
 *
 * `Identity`（`crypto.rs`）与 `EphKeypair`（`transport/relay_seal.rs`）今天**没有**
 * `#[derive(Serialize)]`，所以它们序列化不到 JSON、也就到不了前端。
 * 但这件事**没有任何东西在守**：给其中一个加一行 derive、或者往某个 DTO 里加一个
 * `secret_key: String` 字段，都是"看起来无害的一行改动"，而后果是**长期身份私钥泄漏到界面**
 * —— 整条 E2EE 归零，且用户完全没有症状（消息照发、界面照用）。
 * 这正是总指令§二 A 类里"安全边界被破坏"那一格。
 *
 * ## 判据为什么是"两条"而不是"一条"
 *
 * Tauri 里东西到得了前端只有两条通道：**命令返回值**和 **emit 载荷**，
 * 而两者都要求 `Serialize`。所以
 *
 *   判据 A（出口形状）：任何 derive 了 `Serialize` 的类型，字段名与字段类型都不许是密钥材料。
 *
 * 这一条同时覆盖命令与事件，不需要分别扫两处 —— 覆盖面来自"序列化是唯一出口"这个事实。
 *
 * 但 A 有一条最短绕过路径：**不放进 struct，直接拼字符串返回**
 * （`fn export_identity() -> String { STANDARD.encode(id.x25519_secret.to_bytes()) }`）。
 * 所以补
 *
 *   判据 B（出口行为）：任何 `#[tauri::command]` 的函数体里，不许出现密钥材料标识符。
 *
 * A 与 B 都只拦"交出去"那一步，拦不住**在 crate 内部随手读字段**。2026-10-29 把 X25519 私钥
 * 字段改成私有（INV-P18 B-1a）之后，"读字段"这件事第一次有了机器凭据：
 *
 *   判据 C（字段边界）：`Identity.x25519_secret` 只许在 `crypto.rs` 内部被访问；
 *   两个 base64 导出器（`x25519_secret_b64` / `ed25519_secret_b64`）只许被**持久化那一家**
 *   （`state.rs`）调用。ECDH 的唯一出口是 `Identity::dh()`，签名是 `Identity::signer()`
 *   交出的 `IdentitySigner::sign()`（5.15.45 起）。
 *
 * ⚠️ 5.15.45 起这条覆盖两半：`ed25519_signing` 也私有化了（对外只剩 `Identity::signer()` 交出的
 * `IdentitySigner`）。历史注记（保留是为了说明当初为什么分两批）：私有化之前它**仍是公开字段** —— 中继拨号要把 owned
 * `SigningKey` 跨 `spawn` 传进 `relay_negotiate`/`build_wrap_offer`（含 10 处用裸 SigningKey 的
 * 协议测试），私有化它需要给那一层引入"签名能力"抽象，属 Frozen Core 线格式侧的设计改动。
 * 两半自 5.15.45 起都被这条判据覆盖；这段历史写在这里备查，也写在 `docs/protocol-invariants.md` 的 INV-P18。
 *
 * ## 为什么 B 不会"漏扫还判成通过"
 *
 * B 的覆盖面**与权威事实源对账**：`lib.rs` 的 `generate_handler!` 注册表里每一条命令，
 * 都必须能在扫描中找到对应的 `#[tauri::command]` 函数体；找不到 ⇒ **直接红**，
 * 而不是"少扫一条、照样绿"。（同一形状的教训：`include!` 分册漏登记就是假绿。）
 *
 * ## 词表：名字 + 类型双管
 *
 * 只按名字判会被绕开：`Identity` 的第二个私钥字段叫 `ed25519_signing`，
 * 不含 "secret"。所以名字词表带 `signing|keypair|seed|private_key|secret|sk`，
 * 类型词表带 `StaticSecret|EphemeralSecret|SharedSecret|SigningKey|VerifyingKey?`
 * （`VerifyingKey` 是**公钥**，不在禁令里 —— 收进来会把正常设计判成违规）。
 * 名字按**整词/下划线边界**匹配，不按子串，所以 `checked_state`、`task_seed_id` 这类
 * 不会误伤（`seed` 会命中 `task_seed_id` —— 见 `--self-test` 的反例夹具，宁可多报）。
 *
 * ## 用法
 *
 *     node scripts/check-key-boundary.mjs              # 扫真实源码
 *     node scripts/check-key-boundary.mjs --self-test  # 跑夹具：证明三条判据都抓得住
 *
 * 退出码：0 = 通过；1 = 有违规或覆盖面不自证。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src-tauri", "src");
const LIB = path.join(SRC, "lib.rs");

/** 密钥材料：名字词表（下划线/整词边界，避免子串误伤）。 */
const KEY_NAME = /(^|_)(secret|secret_key|private_key|privkey|signing|seed|keypair|key_pair|sk)(_|$)/;
/** 密钥材料：类型词表。公钥类型刻意不在这里。 */
const KEY_TYPE = /\b(StaticSecret|EphemeralSecret|SharedSecret|SigningKey|KeyPair|Zeroizing)\b/;

const argv = process.argv.slice(2);
const selfTest = argv.includes("--self-test");

/** 抹掉字符串字面量与行注释：避免"探针里写着这个词"被当成真实发射点。 */
const scrub = (line) =>
  line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/r#"[^"]*"/g, '""').replace(/\/\/.*$/, "");

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (p.endsWith(".rs")) acc.push(p);
  }
  return acc;
}

/** 从 { line: i } 处的开括号起，返回闭合块的文本（含首尾行）。 */
function blockFrom(lines, start) {
  let depth = 0;
  let opened = false;
  const out = [];
  for (let i = start; i < lines.length && i < start + 4000; i += 1) {
    const l = scrub(lines[i]);
    out.push(lines[i]);
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    if (depth > 0) opened = true;
    if (opened && depth === 0) return { text: out.join("\n"), end: i };
    // 一行式声明（`pub struct Foo;`、无体 enum 变体）才允许在**首行**就收尾；
    // 少了 `i === start` 这个条件，函数体里第一条不带括号的语句（`let g = lock();`）
    // 会让块在第二行就截断 —— 夹具自证第一次跑就是这样把判据 B 判成"抓不住"的。
    if (i === start && !opened && /;\s*$/.test(l)) return { text: out.join("\n"), end: i };
  }
  return { text: out.join("\n"), end: lines.length - 1 };
}

/** 收集 `#[derive(...Serialize...)]` 类型的字段，返回违规列表。 */
function scanSerializable(files) {
  const bad = [];
  let seenTypes = 0;
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split(/\n/);
    let attrs = [];
    for (let i = 0; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (t.startsWith("#") || t.startsWith("///") || t.startsWith("//")) {
        attrs.push(t);
        continue;
      }
      const m = t.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+([A-Z]\w*)/);
      if (!m) { if (t) attrs = []; continue; }
      const derives = attrs.join(" ");
      attrs = [];
      const { text, end } = blockFrom(lines, i);
      i = end;
      if (!/derive\s*\([^)]*\bSerialize\b/.test(derives)) continue;
      seenTypes += 1;
      for (const raw of text.split(/\n/)) {
        const fm = raw.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?([a-z0-9_]+)\s*:\s*([^=,;]+)/);
        if (!fm) continue;
        const [, field, type] = fm;
        if (KEY_NAME.test(field) || KEY_TYPE.test(type)) {
          bad.push({ where: `${path.relative(ROOT, f)}:${i + 1}`, kind: "A",
            msg: `可序列化类型 ${m[1]} 带密钥字段 ${field}: ${type.trim()}` });
        }
      }
    }
  }
  return { bad, seenTypes };
}

/**
 * 判据 B 的核心：把函数体切成语句，只看**会把值交出去的那些**
 * （`return …` / `Ok(…)` / `.emit(…)` / `.to(…)`），要求其中不出现密钥标识符。
 *
 * 为什么不直接"函数体里不许出现密钥标识符"：写第一版时那样判，扫真实码立刻报两处
 * —— `send_message` 与 `distribute_group_key` 都在**局部**读 `x25519_secret`
 * 去做 ECDH/签名，那是这条不变量允许（且必须）的用法。禁令要钉的是"交出去"，
 * 不是"碰过"。
 *
 * ⚠️ 已知残余（不要当成已封死）：两步搬运（`let k = id.x25519_secret.to_bytes();`
 * 再 `Ok(STANDARD.encode(k))`）文本判据抓不住。彻底的做法是**按构造不可导出**
 * （把 `Identity` 的私钥字段改成私有，只暴露 `sign()` / `dh()`，不返回字节）；
 * 已作为 B-1a 的后续项登记在 `docs/stability-roadmap.md`。
 */
const KEY_IDENT = /\b(x25519_secret|ed25519_signing|secret_key|private_key|signing_key|StaticSecret|EphemeralSecret|SigningKey|keypair|\.secret)\b/;
const OUTBOUND = /(return\b|\bOk\s*\(|\bemit\b|\.emit(?:_filter)?\s*\(|\.to\s*\()/;

function outboundKeyHits(body) {
  const cleaned = body.split(/\n/).map(scrub).join("\n");
  const hits = [];
  for (const st of cleaned.split(";")) {
    if (OUTBOUND.test(st) && KEY_IDENT.test(st)) {
      hits.push(st.trim().split(/\n/)[0].slice(0, 90));
    }
  }
  return hits;
}

/** 注册表里声明的命令名（`generate_handler![...]` 的叶子名）。 */
function registeredCommands() {
  const src = existsSync(LIB) ? readFileSync(LIB, "utf8") : "";
  const m = src.match(/generate_handler!\s*\[([^\]]*)\]/s);
  if (!m) return null;
  return [...m[1].matchAll(/([A-Za-z0-9_:]+)\s*,/g)].map((x) => x[1].split("::").pop());
}

/** 扫所有 `#[tauri::command]` 的函数体；返回违规 + "注册表里有条目但没扫到函数"的缺口。 */
function scanCommands(files) {
  const bad = [];
  const found = new Map();
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split(/\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/#\[\s*tauri::command/.test(lines[i].trim())) continue;
      let j = i + 1;
      while (j < lines.length && !/^\s*(pub(?:\([^)]*\))?\s+)?(async\s+)?fn\s/.test(lines[j])) {
        if (!/^\s*(#|\/\/|\/\/\/)/.test(lines[j])) break;
        j += 1;
      }
      const fm = j < lines.length ? lines[j].match(/fn\s+([a-z0-9_]+)/) : null;
      if (!fm) continue;
      const { text } = blockFrom(lines, j);
      found.set(fm[1], `${path.relative(ROOT, f)}:${j + 1}`);
      const hits = outboundKeyHits(text);
      if (hits.length) {
        bad.push({ where: `${path.relative(ROOT, f)}:${j + 1}`, kind: "B",
          msg: `命令 ${fm[1]} 把密钥材料放在交出值的位置：${hits[0]}` });
      }
    }
  }
  return { bad, found };
}

/// 判据 C：私有字段与两个导出器的**落点边界**（按文件判，纯文本扫描）。
///
/// `rel` 是相对 `src-tauri/src` 的正斜杠路径；`src` 是该文件内容。
/// 抽成纯函数是为了让夹具能在内存里喂它 —— 与 A/B 同一套自证形状。
function scanFieldBoundary(rel, src) {
  const bad = [];
  if (rel !== "crypto.rs") {
    for (const m of src.matchAll(/\b[A-Za-z_][\w.]*\.x25519_secret\b(?!_)/g)) {
      bad.push(`${rel} 直接读私钥字段 ${m[0]}`);
    }
    // 5.15.45：Ed25519 私钥字段也私有化了（INV-P18 的另一半）——
    // 对外只剩 `Identity::signer()` 交出的 `IdentitySigner`（只能签、能读公钥）。
    for (const m of src.matchAll(/\b[A-Za-z_][\w.]*\.ed25519_signing\b(?!_)/g)) {
      bad.push(`${rel} 直接读私钥字段 ${m[0]}（只许经 Identity::signer()）`);
    }
  }
  // 字段本身不许再被写"宽"（形状判据：私有化是个会被"顺手"改回去的东西）。
  // 5.15.47 起 `pub(crate)` / `pub(super)` 也算 —— 只认裸 `pub` 的话，
  // 把字段改成 `pub(crate)` 就能绕过（review 指出的对称性问题）。
  for (const field of ["ed25519_signing", "x25519_secret"]) {
    if (new RegExp(`\\bpub\\s*(\\([^)]*\\))?\\s+${field}\\s*:`).test(src)) {
      bad.push(`${rel} 把 ${field} 又写宽成 pub（INV-P18 收的口子）`);
    }
  }
  // 导出器只有持久化那一家能用（crypto.rs 内部的定义行不算调用）
  if (rel !== "crypto.rs" && rel !== "state.rs") {
    for (const m of src.matchAll(/\b(x25519_secret_b64|ed25519_secret_b64)\s*\(/g)) {
      bad.push(`${rel} 调用密钥导出器 ${m[1]}()（只许 state.rs 持久化用）`);
    }
  }
  return bad;
}

/** 夹具：故意做坏的几段源码，三条判据必须各抓得住。 */
const FIXTURES = [
  { name: "A：给 DTO 加一个私钥字段", probe: "A",
    src: `#[derive(Serialize)]
pub struct IdentityDto {
    pub device_id: String,
    pub secret_key: String,
}
` },
  { name: "A′：字段名不含密钥词但类型是私钥", probe: "A",
    src: `#[derive(Serialize, Clone)]
pub struct Wrapper {
    pub dh: StaticSecret,
}
` },
  { name: "B：命令体里直接读私钥", probe: "B",
    src: `#[tauri::command]
pub async fn export_identity(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let g = state.db.lock();
    Ok(STANDARD.encode(g.identity.x25519_secret.to_bytes()))
}
` },
  { name: "反例：公钥与无关字段不许误伤", probe: "none",
    src: `#[derive(Serialize)]
pub struct PeerDto {
    pub x25519_public_b64: String,
    pub verified: bool,
    pub checked_state: String,
}
#[tauri::command]
pub fn get_peer_peers() -> Vec<PeerDto> {
    let out = Vec::new();
    out
}
` },
  // 这条就是真实码里 `send_message` / `distribute_group_key` 的形状：**局部**读私钥去做
  // ECDH/签名是这条不变量允许的用法。少了这条反例，"收窄判据"就只是我的一次猜测。
  // 这条是真实码里 `send_message` / `distribute_group_key` 的形状：**局部**做 ECDH 是这条不变量
  // 允许的用法。2026-10-29 起它走 `identity.dh(…)`（判据 C 的正形）—— 夹具跟着改，
  // 否则"允许的形状"会和今天的代码不一致，反例就变成在钉一个已经不存在的老写法。
  { name: "反例：命令内部用 dh() 做 ECDH，只返回密文", probe: "none",
    rel: "commands/chat.rs",
    src: `#[tauri::command]
pub async fn send_message(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let shared = state.identity.dh(&peer_pub)?;
    let ct = crypto::seal(&shared, body.as_bytes());
    Ok(STANDARD.encode(ct))
}
` },
  { name: "C：生产码直接读私钥字段（字段私有化被绕过）", probe: "C", rel: "commands/chat.rs",
    src: `pub async fn send_message(s: &AppState) -> Result<String, String> {
    let raw = s.identity.x25519_secret.to_bytes();
    Ok(hex::encode(raw))
}
` },
  { name: "C″：生产码直接读 Ed25519 私钥字段", probe: "C", rel: "commands/sign.rs",
    src: `pub fn sign_it(s: &AppState) -> Vec<u8> {
    s.identity.ed25519_signing.to_bytes().to_vec()
}
` },
  { name: "C‴：把 Ed25519 私钥字段又写回 pub", probe: "C", rel: "crypto.rs",
    src: `pub struct Identity {
    pub ed25519_signing: SigningKey,
}
` },
  { name: "C′：命令调密钥导出器（持久化之外的第二家）", probe: "C", rel: "commands/export.rs",
    src: `#[tauri::command]
pub fn dump_identity(state: tauri::State<'_, AppState>) -> String {
    state.identity.x25519_secret_b64()
}
` },
  // 持久化那一家（state.rs）调两个导出器是**必要的** —— 不写这条反例，判据 C 就只是"我猜的一刀切"。
  { name: "反例：state.rs 持久化调两个 base64 导出器", probe: "none",
    rel: "state.rs",
    src: `let a = id.x25519_secret_b64();
let b = id.ed25519_secret_b64();
` },
  { name: "反例：crypto.rs 内部访问自己的私有字段", probe: "none",
    rel: "crypto.rs",
    src: `pub fn dh(&self, their_public_b64: &str) -> Option<[u8; 32]> {
    shared_secret(&self.x25519_secret, their_public_b64)
}
` },
];

/** 在内存里跑一条判据（夹具用）。 */
function runProbeOn(probe, src, rel = "scratch.rs") {
  if (probe === "A") {
    const dir = null;
    const lines = src.split(/\n/);
    let attrs = [];
    const bad = [];
    for (let i = 0; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (t.startsWith("#") || t.startsWith("//")) { attrs.push(t); continue; }
      const m = t.match(/^(?:pub\s+)?(?:struct|enum)\s+([A-Z]\w*)/);
      if (!m) { if (t) attrs = []; continue; }
      const derives = attrs.join(" ");
      attrs = [];
      const { text, end } = blockFrom(lines, i);
      i = end;
      if (!/derive\s*\([^)]*\bSerialize\b/.test(derives)) continue;
      for (const raw of text.split(/\n/)) {
        const fm = raw.match(/^\s*(?:pub\s+)?([a-z0-9_]+)\s*:\s*([^=,;]+)/);
        if (fm && (KEY_NAME.test(fm[1]) || KEY_TYPE.test(fm[2]))) bad.push(`${m[1]}.${fm[1]}`);
      }
    }
    return bad;
  }
  if (probe === "C") return scanFieldBoundary(rel, src);
  if (probe === "B") {
    const lines = src.split(/\n/);
    const bad = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!/#\[\s*tauri::command/.test(lines[i].trim())) continue;
      let j = i + 1;
      while (j < lines.length && !/^\s*(pub\s+)?(async\s+)?fn\s/.test(lines[j])) j += 1;
      if (j >= lines.length) continue;
      const { text } = blockFrom(lines, j);
      for (const h of outboundKeyHits(text)) bad.push(h);
    }
    return bad;
  }
  return [];
}

if (selfTest) {
  let failed = 0;
  for (const fx of FIXTURES) {
    const got = fx.probe === "none"
      ? [...runProbeOn("A", fx.src), ...runProbeOn("B", fx.src), ...runProbeOn("C", fx.src, fx.rel)]
      : runProbeOn(fx.probe, fx.src, fx.rel);
    const want = fx.probe === "none" ? 0 : 1;
    const ok = want === 0 ? got.length === 0 : got.length > 0;
    console.log(`${ok ? "✓" : "✗"} [${fx.probe === "none" ? "反例" : fx.probe}] ${fx.name} → ${got.length} 处`);
    if (!ok) failed += 1;
  }
  if (failed) {
    console.error(`✗ 夹具 ${failed} 条不符合预期 —— 判据抓不住它声称抓住的东西`);
    process.exit(1);
  }
  console.log(`✓ 私钥边界判据自证：${FIXTURES.length} 条夹具全部符合预期`
    + `（其中 ${FIXTURES.filter((f) => f.probe === "none").length} 条是"不许误伤"的反例）`);
  process.exit(0);
}

const files = walk(SRC);
const a = scanSerializable(files);
const b = scanCommands(files);
const c = [];
for (const f of files) {
  const rel = path.relative(SRC, f).split(path.sep).join("/");
  c.push(...scanFieldBoundary(rel, readFileSync(f, "utf8")));
}
const reg = registeredCommands();

const problems = [];
if (reg === null) {
  problems.push("lib.rs 里找不到 generate_handler! 注册表 —— 判据 B 的覆盖面无法自证，按红处理");
} else {
  const missing = reg.filter((n) => !b.found.has(n));
  if (missing.length) {
    problems.push(`注册表里有 ${missing.length} 条命令没被 B 扫到（漏扫=判据覆盖面自己造假）：${missing.slice(0, 8).join(", ")}`);
  }
  if (missing.length === 0 && b.found.size !== new Set(reg).size) {
    console.log(`  · 命令体扫描 ${b.found.size} 个函数（注册表 ${new Set(reg).size} 条，差额为未注册的 #[tauri::command]）`);
  }
}
problems.push(...c.map((x) => `[C] ${x}`));
problems.push(...a.bad.map((x) => `[A] ${x.where} ${x.msg}`));
problems.push(...b.bad.map((x) => `[B] ${x.where} ${x.msg}`));

if (problems.length) {
  console.error(`✗ 私钥边界：${problems.length} 处不成立`);
  for (const p of problems) console.error(`  · ${p}`);
  console.error("\n  私钥一旦能被序列化或被命令读出来，E2EE 就整体失效，且用户侧无任何症状。");
  console.error("  确实需要的例外（例如把**公钥**暴露出去）不该用密钥类型/密钥命名，");
  console.error("  并在 docs/protocol-invariants.md 的 INV-P18 一节写清楚边界在哪。");
  process.exit(1);
}

console.log(`✓ 私钥边界：${a.seenTypes} 个可序列化类型无密钥字段（判据 A）`
  + ` · ${b.found.size} 条命令体无密钥触碰且与注册表逐条对上（判据 B）`
  + ` · X25519/Ed25519 私钥字段、两个导出器与「签名能力」的落点在 crypto.rs（判据 C）`);
