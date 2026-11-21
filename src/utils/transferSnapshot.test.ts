import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  transferListEqual,
  contentListEqual,
  opsListEqual,
  TRANSFER_FIELDS,
  CONTENT_FIELDS,
  OP_FIELDS,
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
