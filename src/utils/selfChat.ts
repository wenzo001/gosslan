/**
 * 「和自己聊天」（自聊）的**判据**（纯函数，便于单测）。
 *
 * 自聊的会话 id / 发送者 / 接收者**都是本机 device_id**（见后端 `insert_self_message`），
 * 所以判据只有一条：id 是否等于自己。之所以单独抽出来，是因为界面上有四处要按它分支
 * （列表行不显示在线状态、气泡不挂回执、输入框不给附件入口、发送要求纯文本），
 * 各处各写一遍 `=== device_id` 迟早会漏一处（漏了就会出现"自聊消息永远转圈"这类现象）。
 */
import type { Conversation, MessageRecord } from "@/types";

/** 这个会话是不是「和自己聊天」。 */
export function isSelfConversation(
  conv: Pick<Conversation, "id"> | null | undefined,
  myDeviceId: string | undefined,
): boolean {
  return !!conv && !!myDeviceId && conv.id === myDeviceId;
}

/**
 * 这条消息是不是自聊消息（发送者与接收者都是本机）。
 *
 * 用"收发双方相同"判断而不是"会话 id == 自己"：`MessageItem` 只拿得到消息本身
 * （自聊里两侧都是"我"，但普通单聊里自己发的消息 receiver 是对方 ⇒ 不会误判）。
 */
export function isSelfMessage(msg: Pick<MessageRecord, "sender_id" | "receiver_id">): boolean {
  return !!msg.sender_id && msg.sender_id === msg.receiver_id;
}

/** 自聊里能发的内容类型（用户 2026-09-16：先只支持文本）。 */
export const SELF_CHAT_KINDS: readonly string[] = ["text", "code"];

export function selfChatSupports(kind: string): boolean {
  return SELF_CHAT_KINDS.includes(kind);
}
