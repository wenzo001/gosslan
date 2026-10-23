/**
 * 「和自己聊天」（自聊）的**判据**（纯函数，便于单测）。
 *
 * 自聊的会话 id / 发送者 / 接收者**都是本机 device_id**（见后端 `insert_self_message`），
 * 所以判据只有一条：id 是否等于自己。之所以单独抽出来，是因为界面上有四处要按它分支
 * （列表行不显示在线状态、气泡不挂回执、输入框不给附件入口、发送要求纯文本），
 * 各处各写一遍 `=== device_id` 迟早会漏一处（漏了就会出现"自聊消息永远转圈"这类现象）。
 */
import type { Conversation, DeviceInfo, Friend, MessageRecord } from "@/types";

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

/**
 * 「我自己」当作一条 `Friend` 来渲染：通讯录那行「自己」与自己的资料页走的是好友同一条路径
 * （用户 2026-09-17），深链 `/contacts/<自己的 device_id>` 也要能还原出这一条。
 *
 * 之所以住在这个家：这行的 `device_id` 就是那条伪会话的 id，"是不是自己"的判据只许有一处。
 * `online` 由调用方给（通讯录读 `app.present`，不是设备表里那个恒 true 的自身在线位）。
 */
export function selfFriendOf(
  device: DeviceInfo | null | undefined,
  online: boolean,
): Friend | null {
  if (!device?.device_id) return null;
  return {
    device_id: device.device_id,
    nickname: device.nickname,
    avatar: device.avatar ?? null,
    device_type: device.device_type ?? "",
    online,
  };
}

export function selfChatSupports(kind: string): boolean {
  return SELF_CHAT_KINDS.includes(kind);
}
