/**
 * 定向分享（`to` / `to_kind`）与分享回执的接线判据。
 *
 * 钉住四件最容易悄悄坏掉的事：
 * ① **预填不等于直发** —— 目标只是被预勾，用户仍要点「发送」；
 * ② **目标存在性由后端查库判定** —— 前端不自己判断「有没有这个人」；
 * ③ **回执地址不由前端给** —— 后端从队列里取，前端只报「发了几条」；
 * ④ **回执不含内容** —— 只含状态与条数。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PANEL = "src/components/SharePanel.vue";
const API = "src/api/index.ts";
const TYPES = "src/types.ts";
const RUST_SHARE = "src-tauri/src/share.rs";
const RUST_CMD = "src-tauri/src/commands/external_share.rs";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("后端：定向目标的形状与种类规则", () => {
  const rust = read(RUST_SHARE);
  assert.match(rust, /pub fn normalize_target\(/, "没有目标规范化函数");
  assert.match(rust, /MAX_TARGET_CHARS/, "没有目标长度上限");
  // 种类只有 peer / group：写死两个，不留「以后再说」的第三种。
  assert.match(rust, /kind != "peer" && kind != "group"/, "目标种类没有限制成 peer/group");
  // 回执地址：HTTPS + 与来源同源。
  assert.match(rust, /回执地址必须是 HTTPS/, "回执地址没有强制 HTTPS");
  assert.match(rust, /回执地址必须与来源同源/, "回执地址没有要求与来源同源");
});

test("后端：目标存在性 fail-closed（只认好友与已知群）", () => {
  const cmd = read(RUST_CMD);
  assert.match(cmd, /fn target_is_known\(/, "没有目标判定函数");
  // 判定逻辑：peer 走好友表、group 走群表，其余一律 false。
  assert.match(
    cmd,
    /"peer" => friend_ids\.iter\(\)\.any\(\|id\| id == to\)/,
    "peer 判定没有走好友列表",
  );
  assert.match(
    cmd,
    /"group" => \{[\s\S]{0,120}strip_prefix\("group:"\)[\s\S]{0,120}group_ids\.iter\(\)/,
    "group 判定没有剥掉 group: 前缀后比群列表",
  );
  // 不认识的 ⇒ 拒（绝不新建会话、绝不猜）。
  assert.match(cmd, /_ => false/, "未知种类没有一律拒");
  // 命中好友但还没聊过 ⇒ 建一个空会话（否则面板列不出来，没法一键发）。
  assert.match(cmd, /ensure_conversation\(/, "目标好友没有会话时没有准备会话");
});

test("前端：目标是预填，不是直发（用户仍要点发送）", () => {
  const panel = read(PANEL);
  // 预勾来自 payload.to。
  assert.match(
    panel,
    /preselectTarget\.value = store\.pending\?\.payload\.to \?\? null/,
    "面板没有读取 payload.to 作为预填目标",
  );
  // 会话列表就绪后才勾（列表是异步加载的）。
  assert.match(panel, /watch\(targets, \(list\) => \{/, "没有在目标列表就绪后处理预勾");
  assert.match(
    panel,
    /if \(!list\.some\(\(c\) => c\.id === t\)\) return;/,
    "目标不在列表里时也勾了（会勾出一个不存在的会话）",
  );
  assert.match(panel, /selected\.value = \[t\];/, "预勾没有把目标勾上");
  // 但发送仍然必须由用户点：发送按钮的禁用条件里必须有 selected。
  assert.match(
    panel,
    /const canSend = computed\(\(\) => !textError\.value && selected\.value\.length > 0 && !sending\.value\)/,
    "发送条件变了（可能变成自动直发）",
  );
});

test("前端：回执只报状态与条数，地址由后端取", () => {
  const api = read(API);
  assert.match(
    api,
    /shareReportReceipt: \(shareId: string, status: string, sent: number, failed: number\) =>/,
    "门面上报回执的签名不对（不该带地址参数）",
  );
  assert.ok(
    !/shareReportReceipt:[^)]*url|shareReportReceipt:[^)]*endpoint/i.test(api),
    "回执调用里出现了地址参数 —— 地址必须由后端从队列取",
  );

  const panel = read(PANEL);
  assert.match(
    panel,
    /api\.shareReportReceipt\(id, status, sent, failed\)/,
    "面板没有上报回执",
  );
  // 面板不碰 payload.receiptEndpoint（它压根不该知道地址）。
  assert.ok(
    !panel.includes("receiptEndpoint"),
    "面板引用了回执地址 —— 地址应由后端持有",
  );
});

test("前端类型：载荷带目标字段", () => {
  const types = read(TYPES);
  assert.match(types, /to: string \| null;/, "SharePayload 没有 to 字段");
  assert.match(types, /toKind: string \| null;/, "SharePayload 没有 toKind 字段");
});
