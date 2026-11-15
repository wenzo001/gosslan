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
