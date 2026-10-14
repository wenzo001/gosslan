/**
 * `resolveMemberName` 的行为判据（用户 2026-10-14：「操作记录名字同步，有时候还会显示设备名，会变」）。
 *
 * 每条都只换一个输入，成对交付：
 *  · 「查不到 ⇒ 未知成员」与「查得到 ⇒ 不出现未知成员」是一对；
 *  · 「备注优先」与「没有备注才轮到自报」是一对；
 *  · 「自己用昵称」与「自己没昵称才写『我』」是一对。
 * 单独一条正例只能证明"它返回了点什么"，证明不了"顺序/兜底"这两件真正会错的事。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { memberIdTail, resolveMemberName, MEMBER_ID_TAIL_LEN } from "./memberName.ts";

const TEXT = { me: "我", unknownMember: "未知成员" };
const SELF = "gosslan-aaaaaaaaaaaa1111";
const OTHER = "gosslan-bbbbbbbbbbbb2222";

test("查不到任何人：显示「未知成员 + id 后四位」，绝不出现裸 id 全串", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF }, TEXT);
  assert.equal(name, `未知成员 ${memberIdTail(OTHER)}`);
  assert.ok(!name.includes(OTHER), "兜底里不许出现整串 device_id —— 用户看到的「设备名」就是它");
  assert.equal(memberIdTail(OTHER).length, MEMBER_ID_TAIL_LEN, "尾巴位数是钉死的呈现口径");
});

test("尾巴位数：短 id 原样返回（不许把 'ab' 截成 'ab'以外的形状）", () => {
  assert.equal(memberIdTail("ab"), "ab");
  assert.equal(memberIdTail("abcdefg"), "defg");
});

test("好友备注优先于对方自报的昵称", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, friendNickname: "老王", peerNickname: "Wang-PC" }, TEXT);
  assert.equal(name, "老王");
});

test("没有备注时才轮到在线自报（只换 friendNickname 这一个输入）", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, peerNickname: "Wang-PC" }, TEXT);
  assert.equal(name, "Wang-PC");
});

test("空白值不算「有名字」：自报一个空格昵称必须落到未知成员那一支", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, peerNickname: "   " }, TEXT);
  assert.ok(name.startsWith(TEXT.unknownMember), `空白昵称该被当没有，实际得到 ${JSON.stringify(name)}`);
});

test("本机自己：有昵称用昵称", () => {
  const name = resolveMemberName(SELF, { selfId: SELF, selfNickname: "我的笔记本" }, TEXT);
  assert.equal(name, "我的笔记本");
});

test("本机自己：没昵称写「我」，不写 id（只换 selfNickname 这一个输入）", () => {
  const name = resolveMemberName(SELF, { selfId: SELF, selfNickname: "  " }, TEXT);
  assert.equal(name, TEXT.me);
});

test("空 id 返回空串（调用方靠这一点区分「没有发送者」）", () => {
  assert.equal(resolveMemberName("", { selfId: SELF }, TEXT), "");
});

test("同一个人两次问同一个来源 ⇒ 同一个答案（一处家的那一半证明）", () => {
  const src = { selfId: SELF, friendNickname: "老王" };
  assert.equal(resolveMemberName(OTHER, src, TEXT), resolveMemberName(OTHER, src, TEXT));
});

// ↓ 这三条是一组：只换 `snapshotNickname` 这一个输入，钉的是「重启/离线后名字别变回去」。
test("人不在线但本机上次见过 ⇒ 用上次那个名字（用户报的「会变」那一半）", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, snapshotNickname: "Wang-PC" }, TEXT);
  assert.equal(name, "Wang-PC");
});

test("上次也没见过 ⇒ 才落到未知成员（只换 snapshotNickname 这一个输入）", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, snapshotNickname: "" }, TEXT);
  assert.ok(name.startsWith(TEXT.unknownMember), `空快照不该算"见过"，实际得到 ${JSON.stringify(name)}`);
});

test("本机备注压过上次见到的名字（备注是我起的，不该被缓存顶掉）", () => {
  const name = resolveMemberName(OTHER, { selfId: SELF, friendNickname: "老王", snapshotNickname: "Wang-PC" }, TEXT);
  assert.equal(name, "老王");
});
