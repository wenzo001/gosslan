/**
 * 系统分享目标（落地区）的**接线判据**：协议 → 读取端 → 队列 → 面板 → 触发时机。
 *
 * 为什么需要它：这条链横跨「平台扩展写文件」与「本应用读文件」两侧，中间没有任何编译错误
 * 能保证对得上 —— 扩展按 v1 写、主应用按 v2 读，两边都能编译，运行时才发现收不到分享。
 * 判据把最容易漂的四处钉住：目录基准、字段名、校验口径、触发时机。
 *
 * 只看源码形状，不执行 UI，也不碰真实落地区。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const RUST_PROTOCOL = "src-tauri/src/incoming_share.rs";
const RUST_SHARE = "src-tauri/src/share.rs";
const RUST_CMD = "src-tauri/src/commands/external_share.rs";

test("协议：目录基准是本地数据目录，不是漫游目录", () => {
  const proto = read(RUST_PROTOCOL);
  const cmd = read(RUST_CMD);
  assert.match(
    cmd,
    /app\.path\(\)\.app_local_data_dir\(\)/,
    "落地区挂在漫游目录 ⇒ 分享会跟着账号跑到别的机器上",
  );
  assert.match(
    proto,
    /pub fn incoming_dir\([^)]*\) -> std::path::PathBuf/,
    "落地区目录解析没有单一事实源",
  );
  assert.match(proto, /INCOMING_DIR_NAME/, "目录名没有常量化");
});

test("协议：文件名规则严格（目录穿越在这一层堵死）", () => {
  const proto = read(RUST_PROTOCOL);
  assert.match(proto, /pub fn is_valid_file_name\(/, "没有文件名校验函数");
  // 必须是「严格前缀 + 严格后缀 + 定长十六进制」，不能是「大概像就行」。
  assert.match(proto, /FILE_PREFIX: &str = "incoming-"/);
  assert.match(proto, /FILE_SUFFIX: &str = "\.json"/);
  assert.match(proto, /FILE_ID_HEX_LEN: usize = 32/);
  assert.match(proto, /is_ascii_digit\(\) \|\| \(b'a'\.\.=b'f'\)/, "文件名没有限定为小写十六进制");
});

test("校验口径：落地区与深链共用同一个内容构造入口", () => {
  const proto = read(RUST_PROTOCOL);
  const share = read(RUST_SHARE);
  assert.match(
    proto,
    /payload_from_fields\(/,
    "落地区没有走 share.rs 的内容校验 ⇒ 落地区会漏掉深链拦得住的东西",
  );
  assert.match(
    share,
    /pub fn payload_from_fields\(/,
    "payload_from_fields 不是公开入口 ⇒ 落地区只能复制一份校验逻辑",
  );
  // 深链那条路也必须调它（否则「共用」是假的）。
  assert.match(
    share,
    /fn payload_from_query\([\s\S]*?payload_from_fields\(/,
    "深链入口没有走 payload_from_fields ⇒ 两处校验会漂",
  );
});

test("读取端：先入队、后删文件（反了会在崩溃时丢分享）", () => {
  const cmd = read(RUST_CMD);
  const admitAt = cmd.indexOf("sh::admit(");
  const removeAt = cmd.indexOf("std::fs::remove_file");
  assert.ok(admitAt > 0 && removeAt > 0, "入队与删文件两处都要在");
  // 注意：文件里还有「过期/无效」分支上的提前 remove_file，所以不能简单比下标；
  // 判据是「入队成功后那一处 remove_file」在 admit 之后。
  const afterAdmit = cmd.slice(admitAt);
  assert.match(
    afterAdmit,
    /Ok\(p\) => \{[\s\S]*?std::fs::remove_file/,
    "入队成功后没有删文件 ⇒ 同一份分享会被反复扫到",
  );
});

test("读取端：不合规的文件丢掉但不拖垮分享主路", () => {
  const cmd = read(RUST_CMD);
  assert.match(cmd, /EXTERNAL_SHARE_INCOMING_INVALID/, "不合规文件没有具名错误码 ⇒ 排障查不到");
  assert.match(cmd, /EXTERNAL_SHARE_INCOMING_UNREADABLE/, "读不了落地区没有具名错误码");
  // 落地区不存在是常态（没装扩展）⇒ 不能当错误抛出去。
  // 判据钉在协议模块（`scan_dir` 才是真正读盘的那一层），命令层只负责短路。
  const proto = read(RUST_PROTOCOL);
  assert.match(
    proto,
    /let Ok\(entries\) = std::fs::read_dir\(dir\) else \{\s*return Vec::new\(\);\s*\}/,
    "落地区不存在时不是安静返回 ⇒ 没装扩展的用户会看到报错",
  );
  assert.match(
    cmd,
    /if candidates\.is_empty\(\) \{\s*return Vec::new\(\);\s*\}/,
    "命令层没有对「扫不到东西」短路",
  );
});

test("触发：启动与窗口聚焦都会补扫一次", () => {
  const panel = read("src/components/SharePanel.vue");
  assert.match(panel, /void store\.load\(\)/, "冷启动没有补拉 ⇒ 启动前到的分享看不到");
  assert.match(
    panel,
    /addEventListener\("focus"/,
    "没有窗口聚焦触发 ⇒ 用户切回应用时看不到刚分享的内容",
  );
  // 监听必须能摘掉（仓库有整类「注册了却摘不掉」的缺陷）。
  assert.match(panel, /removeEventListener\("focus"/, "focus 监听没有卸载路径");
});

// ---------------- 三端协议一致性：写入端（Swift / C#）↔ 读取端（Rust） ----------------
//
// 背景（2026-11-16）：Windows 写入端的 `Payload` 类用 PascalCase 属性
// （Url/Title/Text），`JsonSerializer.Serialize` 默认就输出 PascalCase，
// 而 Rust 读取端 `IncomingPayload` 带 `#[serde(rename_all = "camelCase")]` ⇒
// **两边字段名对不上**，文件会被当成「三个字段都缺」拒收。
// 两边各自都能编译/通过判据，只有把三端放在一起比才抓得到 ⇒ 这就是这一节的价值。

test("三端一致：payload 字段名必须是小写 url/title/text", () => {
  const swift = read("platform/macos-share-extension/ShareViewController.swift");
  const cs = read("platform/windows-share-target/ShareTarget.cs");
  const rust = read(RUST_PROTOCOL);

  // ① 读取端（真源）：camelCase + 三个字段。
  assert.match(
    rust,
    /#\[serde\(rename_all = "camelCase"\)\][\s\S]{0,200}pub struct IncomingPayload/,
    "读取端不再用 camelCase ⇒ 下面两端的小写字段名就不再正确（要一起改）",
  );
  for (const key of ["url", "title", "text"]) {
    assert.match(rust, new RegExp(`pub ${key}: Option<String>`), `读取端字段 ${key} 不见了`);
  }

  // ② macOS 写入端：手写字面量，必须是小写键。
  for (const key of ["url", "title", "text"]) {
    assert.match(
      swift,
      new RegExp(`"${key}"\\s*:`),
      `Swift 写入端没有小写键 "${key}"（会跟读取端对不上）`,
    );
  }

  // ③ Windows 写入端：属性是 PascalCase ⇒ 必须靠 JsonPropertyName 显式钉成小写。
  //    只断言存在三个 JsonPropertyName 还不够（名字写错也会过）⇒逐个核对。
  for (const key of ["url", "title", "text"]) {
    assert.match(
      cs,
      new RegExp(`\\[JsonPropertyName\\("${key}"\\)\\]`),
      `C# 写入端没有 [JsonPropertyName("${key}")] ⇒ System.Text.Json 会输出 PascalCase，读取端不认`,
    );
  }
  assert.match(
    cs,
    /using System\.Text\.Json\.Serialization;/,
    "C# 写入端没导入 JsonPropertyName 所在的命名空间",
  );
});

test("三端一致：落地区目录名与文件名前缀/后缀必须是 incoming-shares / incoming-*.json", () => {
  const swift = read("platform/macos-share-extension/ShareViewController.swift");
  const cs = read("platform/windows-share-target/ShareTarget.cs");
  const rust = read(RUST_PROTOCOL);
  // 读取端是真源
  assert.match(rust, /INCOMING_DIR_NAME:\s*&str\s*=\s*"incoming-shares"/);
  assert.match(rust, /FILE_PREFIX:\s*&str\s*=\s*"incoming-"/);
  assert.match(rust, /FILE_SUFFIX:\s*&str\s*=\s*"\.json"/);
  // 写入端必须逐字对齐
  assert.match(swift, /dropFolderName\s*=\s*"incoming-shares"/, "Swift 落地区目录名不一致");
  assert.match(swift, /"incoming-\\\(identifier\)\.json"/, "Swift 文件名形状不一致");
  assert.match(cs, /DropFolderName\s*=\s*"incoming-shares"/, "C# 落地区目录名不一致");
  assert.match(cs, /\$"incoming-\{id\}\.json"/, "C# 文件名形状不一致");
});

test("三端一致：格式版本 v=1 与 id 必须与文件名同源", () => {
  const swift = read("platform/macos-share-extension/ShareViewController.swift");
  const cs = read("platform/windows-share-target/ShareTarget.cs");
  const rust = read(RUST_PROTOCOL);
  assert.match(rust, /FORMAT_VERSION:\s*u32\s*=\s*1/);
  assert.match(swift, /"v":\s*1/, "Swift 写的格式版本不是 1");
  assert.match(cs, /\bv\s*=\s*1\b/, "C# 写的格式版本不是 1");
  // id：文件名里的那段就是内容里的 id（两端都要同一个变量）
  // 两端都得先生成一个 id 变量，内容 id 与文件名 id 都引用同一个变量（不写死两遍）。
  assert.match(swift, /let identifier = UUID\(\)\.uuidString/, "Swift 没有生成 id");
  assert.match(swift, /"id":\s*identifier/, "Swift 内容里的 id 不是那个变量");
  assert.match(swift, /incoming-\\\(identifier\)\.json/, "Swift 文件名里的 id 不是那个变量");
  assert.match(cs, /var id = Guid\.NewGuid\(\)\.ToString\("N"\)/, "C# 没有生成 id");
  assert.match(cs, /\bid,\s*$/m, "C# 内容里的 id 不是那个变量");
  assert.match(cs, /incoming-\{id\}\.json/, "C# 文件名里的 id 不是那个变量");
});

test("面板：取消必须先报 cancelled 回执再 dismiss（RP 页面在等，静默关 = 对端干等到 TTL）", () => {
  const panel = read("src/components/SharePanel.vue");
  // onClose 内：reportReceipt(..., "cancelled") 必须存在，且排在 store.dismiss 之前
  const onCloseIdx = panel.indexOf("async function onClose()");
  assert.ok(onCloseIdx > 0, "onClose 不见了 ⇒ 判据锚点要跟着改");
  const body = panel.slice(onCloseIdx, panel.indexOf("}</script>", onCloseIdx));
  assert.match(
    body,
    /reportReceipt\(0, 0, "cancelled"\)/,
    "取消没有回执 ⇒ RP 页面干等到 TTL（用户 2026-11-23）",
  );
  const receiptIdx = body.indexOf("reportReceipt");
  const dismissIdx = body.indexOf("store.dismiss()");
  assert.ok(
    receiptIdx > -1 && dismissIdx > -1 && receiptIdx < dismissIdx,
    "回执必须先于 dismiss——dismiss 清掉队列项后端点就取不到（2026-11-20 竞争修复同形状）",
  );
});

test("面板：滚动域走 flex 分配，不依赖百分比高度（列表在自己那一格滚）", () => {
  const panel = read("src/components/SharePanel.vue");
  assert.match(
    panel,
    /class="flex min-h-0 flex-1 flex-col gap-3 px-1"/,
    "内容区根节点必须是 flex-1 min-h-0（h-full 百分比在 auto+max-h 卡片里解析失败 ⇒ 列表失去上界、整页滚）",
  );
  assert.ok(
    !/class="flex h-full min-h-0 flex-col/.test(panel),
    "内容区不许再用 h-full——百分比高度在 BaseModal 的 auto+max-h 卡片里不可解析",
  );
});
