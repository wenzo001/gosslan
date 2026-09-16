import { test } from "node:test";
import assert from "node:assert/strict";
import { SELF_CHAT_KINDS, isSelfConversation, isSelfMessage, selfChatSupports } from "./selfChat.ts";

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

test("自聊支持的内容类型：只文本与代码（图片/文件不走这条链路）", () => {
  assert.deepEqual([...SELF_CHAT_KINDS], ["text", "code"]);
  assert.ok(selfChatSupports("text") && selfChatSupports("code"));
  for (const k of ["image", "file", "system", "todo"]) {
    assert.equal(selfChatSupports(k), false, `${k} 不该被判成自聊可发`);
  }
});
