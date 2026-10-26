import { test } from "node:test";
import assert from "node:assert/strict";
import { isSelfConversation, isSelfMessage, selfFriendOf } from "./selfChat.ts";
// `import type` 会被 Node 的类型剥离整句删掉 ⇒ 别名 "@/types" 不需要运行时解析。
import type { DeviceInfo } from "@/types";

const ME = "gosslan-aaa";

test("isSelfConversation：只有 id == 自己 才算自聊", () => {
  assert.ok(isSelfConversation({ id: ME }, ME));
  assert.equal(isSelfConversation({ id: "gosslan-bbb" }, ME), false);
  assert.equal(isSelfConversation({ id: "group:g1" }, ME), false);
  assert.equal(isSelfConversation(null, ME), false);
  assert.equal(isSelfConversation({ id: ME }, undefined), false, "device_id 还没拿到时不能误判");
});

test("isSelfMessage：收发双方相同（普通单聊里自己发的消息不会被误判）", () => {
  assert.ok(isSelfMessage({ sender_id: ME, receiver_id: ME }));
  assert.equal(isSelfMessage({ sender_id: ME, receiver_id: "gosslan-bbb" }), false, "自己发给好友 ≠ 自聊");
  assert.equal(isSelfMessage({ sender_id: "gosslan-bbb", receiver_id: ME }), false);
  assert.equal(isSelfMessage({ sender_id: "", receiver_id: "" }), false, "空 id 不算");
});

/**
 * 「我自己」那行/那份资料页的唯一构造点（从 `ConversationList` 收上来的）。
 * 钉的是两处最容易各写一遍各漏一遍的地方：没有 device_id 时**不给一条假的朋友**，
 * 以及 `online` 由调用方传（通讯录用 `app.present`，不是设备表里那个恒 true 的自身在线位）。
 */
test("selfFriendOf：设备信息 → 一条可按好友路径渲染的『自己』", () => {
  const device = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
    device_id: ME,
    nickname: "我",
    avatar: null,
    device_type: "desktop",
    tcp_port: 17777,
    online: true,
    x25519_pubkey: "x",
    ed25519_pubkey: "e",
    ...over,
  });

  assert.equal(selfFriendOf(null, true), null, "设备信息还没拿到 ⇒ 不给一行假的『自己』");
  assert.equal(selfFriendOf(undefined, true), null);
  assert.equal(selfFriendOf(device({ device_id: "" }), true), null, "没有 device_id 就不是自聊行");

  const me = selfFriendOf(device({ avatar: "data:image/svg+xml;base64,aaa" }), false);
  assert.ok(me);
  assert.equal(me!.device_id, ME, "id 必须就是那条伪会话的 id（四处判据靠它）");
  assert.equal(me!.nickname, "我");
  assert.equal(me!.device_type, "desktop");
  assert.equal(me!.avatar, "data:image/svg+xml;base64,aaa");
  assert.equal(me!.online, false, "在线状态由调用方给，不能抄设备表里那个恒 true 的自身在线位");
  assert.equal(selfFriendOf(device(), true)!.online, true);
});
