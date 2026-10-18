/**
 * 表单与 IPC 边界校验的判据。
 *
 * 这里同时钉两件事：schema 本身在边界上的行为（含 emoji 的码点口径），
 * 以及“真实入口确实用了它”——否则库装上了、字段还在手写 if。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  chatSearchGroupSchema,
  groupFileEntrySchema,
  groupNameSchema,
  nicknameSchema,
  parseIpcList,
  shareEntrySchema,
} from "./validation.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("群名/昵称：trim 后非空，长度按 Unicode 码点算（emoji 算 1 个）", () => {
  assert.equal(groupNameSchema.parse("  团队  "), "团队");
  assert.equal(groupNameSchema.safeParse("   ").success, false);
  assert.equal(groupNameSchema.safeParse("字".repeat(40)).success, true);
  assert.equal(groupNameSchema.safeParse("字".repeat(41)).success, false);
  assert.equal(groupNameSchema.safeParse("🐱".repeat(40)).success, true, "40 个 emoji 应算 40 个字符");
  assert.equal(groupNameSchema.safeParse("🐱".repeat(41)).success, false);

  assert.equal(nicknameSchema.parse(" 小布 "), "小布");
  assert.equal(nicknameSchema.safeParse("").success, false);
  assert.equal(nicknameSchema.safeParse("字".repeat(41)).success, false);
});

test("群文件 IPC 行：合法形状通过，未知 local_state / 缺字段 / 负 size 都拒绝", () => {
  const ok = {
    transfer_id: "t1",
    name: "a.bin",
    size: 1,
    sender_id: "p1",
    created_at: 0,
    local_state: "local",
    local_path: null,
    delivered: 0,
    total: 1,
  };
  assert.equal(groupFileEntrySchema.safeParse(ok).success, true);
  assert.equal(groupFileEntrySchema.safeParse({ ...ok, local_state: "done" }).success, false);
  assert.equal(groupFileEntrySchema.safeParse({ ...ok, local_path: undefined }).success, false);
  assert.equal(groupFileEntrySchema.safeParse({ ...ok, size: -1 }).success, false);
});

test("共享目录 IPC 行：is_dir 必须是布尔，size 必须是非负整数", () => {
  assert.equal(shareEntrySchema.safeParse({ name: "a", path: "/a", is_dir: false, size: 1 }).success, true);
  assert.equal(shareEntrySchema.safeParse({ name: "a", path: "/a", is_dir: "no", size: 1 }).success, false);
  assert.equal(shareEntrySchema.safeParse({ name: "a", path: "/a", is_dir: true, size: 1.5 }).success, false);
});

test("搜索命中 IPC 行：嵌套消息也校验；未知 kind 必须放行（对端可能比本机新）", () => {
  const msg = { msg_id: "m1", sender_id: "p1", sender_name: "小布", kind: "text", content: "命中", ts: 1 };
  const group = {
    conv_id: "c1", name: "会话", kind: "group", avatar: null,
    total: 1, latest_ts: 1, messages: [msg],
  };
  assert.equal(chatSearchGroupSchema.safeParse(group).success, true);
  assert.equal(chatSearchGroupSchema.safeParse({ ...group, avatar: "https://x/a.png" }).success, true);
  // 前向兼容：不认识的 kind 是合法数据，不能被校验层判死
  assert.equal(
    chatSearchGroupSchema.safeParse({ ...group, messages: [{ ...msg, kind: "future-kind" }] }).success,
    true,
  );
  assert.equal(chatSearchGroupSchema.safeParse({ ...group, total: -1 }).success, false);
  assert.equal(
    chatSearchGroupSchema.safeParse({ ...group, messages: [{ ...msg, sender_name: undefined }] }).success,
    false,
  );
  assert.throws(
    () => parseIpcList(chatSearchGroupSchema, [{ ...group, messages: [{ ...msg, ts: "1" }] }], "search_chat_history"),
    /search_chat_history 返回了非法数据 @ 0\.messages\.0\.ts/,
  );
});

test("parseIpcList：坏行抛错并带命令名与字段路径，不把坏数据放行", () => {
  assert.deepEqual(parseIpcList(shareEntrySchema, [], "request_share_tree"), []);
  assert.throws(
    () => parseIpcList(shareEntrySchema, [{ name: "a", path: "/a", is_dir: 1, size: 0 }], "request_share_tree"),
    /request_share_tree 返回了非法数据 @ 0\.is_dir/,
  );
  assert.throws(
    () => parseIpcList(shareEntrySchema, { not: "an array" }, "request_share_tree"),
    /request_share_tree 返回了非法数据/,
  );
});

test("接线判据：四个真实入口必须使用 schema，而不是另写一份手校验", () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  assert.match(read("components/GroupCreateModal.vue"), /groupNameSchema\.safeParse\(/);
  assert.match(read("components/settings/ProfileSection.vue"), /nicknameSchema\.safeParse\(/);
  const api = read("api/index.ts");
  assert.match(api, /parseIpcList\(groupFileEntrySchema, v, "list_group_files"\)/);
  assert.match(api, /parseIpcList\(shareEntrySchema, v, "request_share_tree"\)/);
  assert.match(api, /parseIpcList\(chatSearchGroupSchema, v, "search_chat_history"\)/);
  assert.match(read("utils/externalLinks.ts"), /linkInputSchema\.safeParse\(/);
});
