import { computed } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";

export interface MemberProfile {
  name: string;
  avatar: string | null;
  online: boolean;
}

/**
 * 群成员/对端资料解析的统一入口。
 *
 * 优先级：本机自己（不在好友表里，昵称/头像取本机资料，在线取局域网连接态）
 * → 好友表 → 在线节点表 → 兜底（store 的 nicknameOf + 离线）。
 * 所有需要显示"某 device_id 是谁"的地方都走这里，禁止各自重复解析。
 */
export function useMemberProfile() {
  const app = useAppStore();
  const chat = useChatStore();
  const myId = computed(() => app.device?.device_id ?? "");

  function memberProfile(id: string): MemberProfile {
    if (id === myId.value) {
      return {
        name: app.device?.nickname || "我",
        avatar: app.device?.avatar ?? null,
        online: app.online,
      };
    }
    const friend = chat.friends.find((f) => f.device_id === id);
    if (friend) return { name: friend.nickname, avatar: friend.avatar, online: friend.online };
    const peer = chat.peers.find((p) => p.device_id === id);
    if (peer) return { name: peer.nickname, avatar: peer.avatar ?? null, online: true };
    return { name: chat.nicknameOf(id), avatar: null, online: false };
  }

  return { memberProfile, myId };
}
