import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  transferListEqual,
  contentListEqual,
  opsListEqual,
  messageListEqual,
  TRANSFER_FIELDS,
  CONTENT_FIELDS,
  OP_FIELDS,
  MESSAGE_FIELDS,
} from "./transferSnapshot.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("比较函数：内容相同（新引用）判等，任一字段变化判不等", () => {
  const t = { id: "t1", peer_id: "p", name: "a.zip", size: 10, direction: "send", status: "active", path: null, progress: 0.5, blocked_reason: null, created_at: 1 };
  const t2 = { ...t };
  assert.equal(transferListEqual([t], [t2]), true, "同内容新引用必须判等——这就是抖动修复的核心");
  assert.equal(transferListEqual([t], [{ ...t, progress: 0.6 }]), false, "进度变了必须不等");
  assert.equal(transferListEqual([t], [{ ...t, status: "done" }]), false);
  assert.equal(transferListEqual([], []), true);
  assert.equal(transferListEqual([t], []), false, "行数不同直接不等");
  const op = { msg_id: "m1", kind: "text", peer_id: "p", group_id: null, waiting_for: 1, created_at: 2, preview: "x", peer_offline: false };
  assert.equal(opsListEqual([op], [{ ...op, peer_offline: true }]), false, "peer_offline 翻转必须不等");
  const c = { cid: "c1", peerId: "p", groupId: null, name: "n", size: 1, direction: "receive", status: "incomplete", received: 5, attempts: 1, nextAttemptAt: 9, lastError: null, path: null };
  assert.equal(contentListEqual([c], [{ ...c, received: 6 }]), false);
});

test("NaN 进度两侧视为相等（防御性口径）", () => {
  const t = { id: "t1", peer_id: "p", name: "a.zip", size: 10, direction: "send", status: "active", path: null, progress: Number.NaN, blocked_reason: null, created_at: 1 };
  assert.equal(transferListEqual([t], [{ ...t }]), true);
});

// ── 形状守卫：字段清单必须与 types.ts 的接口字段一一对应 ─────────────────────────
// 背景（2026-11-21 Windows 抖动修复）：比较漏掉一个字段 = 那个字段的变化不触发渲染
// ⇒ 界面停在旧值。宁可这里多一条判据，不许「新增字段忘了登记」静默腐烂。

function interfaceFields(name: string): string[] {
  const src = readFileSync(join(ROOT, "types.ts"), "utf8");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.includes(`export interface ${name}`));
  assert.ok(start >= 0, `types.ts 里找不到 interface ${name}`);
  // 接口体 = 从 { 行到首个 "}" 行；只认「两空格 + 标识符 + 冒号」的真字段行，
  // JSDoc 注释行（* 开头）与嵌套块都不算。
  const fields: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^}/.test(line)) break;
    const m = line.match(/^  ([A-Za-z_][A-Za-z0-9_]*)\??:/);
    if (m) fields.push(m[1]);
  }
  assert.ok(fields.length > 0, `interface ${name} 一个字段都没解析出来 ⇒ 解析器坏了`);
  return fields;
}

test("TRANSFER_FIELDS 与 types.ts 的 TransferInfo 字段一一对应", () => {
  const want = interfaceFields("TransferInfo");
  assert.deepEqual(
    [...TRANSFER_FIELDS].sort(),
    [...want].sort(),
    "transferSnapshot 的字段清单与 TransferInfo 对不上：类型加了字段没登记 ⇒ 那个字段的变化不再触发渲染；类型删了字段没清 ⇒ 空转",
  );
});

test("CONTENT_FIELDS 与 types.ts 的 ContentTransfer 字段一一对应", () => {
  const want = interfaceFields("ContentTransfer");
  assert.deepEqual([...CONTENT_FIELDS].sort(), [...want].sort());
});

test("OP_FIELDS 与 types.ts 的 PendingMessageOp 字段一一对应", () => {
  const want = interfaceFields("PendingMessageOp");
  assert.deepEqual([...OP_FIELDS].sort(), [...want].sort());
});

// ── 消息列表：切会话时「快照没变就别换引用」（2026-11-26）──────────────────────
// 背景：`loadMessages` 每次拿到的新快照里每条都是新对象，整表替换会让虚拟列表
// 那 18 行 `MessageItem` 全部 patch。用户实测那一段白花 229ms。

const row = (over: Record<string, unknown> = {}) => ({
  id: 1,
  msg_id: "m1",
  local_id: null,
  conv_id: "c1",
  sender_id: "p",
  receiver_id: "c1",
  kind: "text" as const,
  content: "hi",
  ts: 1000,
  seq: 1,
  status: "delivered",
  fail_code: null,
  mention_ids: null,
  mention_targets: null,
  ...over,
});

test("messageListEqual：同内容新引用判等（切会话不重渲染的前提）", () => {
  const a = [row(), row({ msg_id: "m2", seq: 2, ts: 2000 })];
  const b = [row(), row({ msg_id: "m2", seq: 2, ts: 2000 })];
  assert.equal(messageListEqual(a, b), true, "逐条同内容的新数组必须判等");
  assert.equal(messageListEqual([], []), true);
  assert.equal(messageListEqual(a, a), true);
});

test("messageListEqual：任何可见字段变化都必须判不等", () => {
  const base = [row()];
  for (const [field, value] of [
    ["status", "sending"],
    ["content", "hi2"],
    ["ts", 1001],
    ["seq", 2],
    ["kind", "image"],
    ["fail_code", "NET"],
    ["local_id", "tmp-1"],
    ["mention_ids", ["p"]],
    ["mention_targets", [{ id: "p", name: "P", n: 1 }]],
  ] as const) {
    assert.equal(
      messageListEqual(base, [row({ [field]: value })]),
      false,
      `${field} 变了必须判不等（否则界面停在旧值）`,
    );
  }
  assert.equal(messageListEqual(base, []), false, "行数不同直接不等");
  assert.equal(messageListEqual(base, [row({ msg_id: "m9" })]), false, "换了消息必须不等");
});

test("messageListEqual：mention_targets 逐格比较（对象是新引用但内容相同）", () => {
  const a = [row({ mention_targets: [{ id: "p", name: "P", n: 1 }] })];
  const b = [row({ mention_targets: [{ id: "p", name: "P", n: 1 }] })];
  assert.equal(messageListEqual(a, b), true, "结构体内容相同要判等（否则每条 @ 消息恒重渲染）");
  assert.equal(
    messageListEqual(a, [row({ mention_targets: [{ id: "p", name: "P", n: 2 }] })]),
    false,
    "n（第几次出现）不同必须不等",
  );
});

test("MESSAGE_FIELDS 覆盖 MessageRecord 的全部字段（含两个数组列）", () => {
  const want = interfaceFields("MessageRecord");
  assert.deepEqual(
    [...MESSAGE_FIELDS, "mention_ids", "mention_targets"].sort(),
    [...want].sort(),
    "字段清单与 MessageRecord 对不上：类型加了列没登记 ⇒ 那个列的变化不再触发渲染",
  );
});

test("接线判据：loadMessages 必须用 messageListEqual 包住赋值（不许退回无条件整表覆盖）", () => {
  const src = readFileSync(join(ROOT, "stores/chat/conversations.ts"), "utf8");
  assert.ok(
    src.includes("if (!(prev && messageListEqual(next, prev))) messages.value[convId] = next;"),
    "loadMessages 的赋值必须被 messageListEqual 守卫 —— 少了它，切回已缓存会话会白渲染一次",
  );
});
