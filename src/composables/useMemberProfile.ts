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
 * ⚠️ **名字不在这里判**：一律取 `chat.nicknameOf(id)`（判据在 `utils/memberName.ts` 那一个家）。
 * 这里曾经自己写过一遍「自己 → 好友表 → 在线节点表 → 兜底」，兜底还与 store 不同
 * （那边返回裸 device_id、这边对自己返回「我」）⇒ 同一个人、同一屏两处可以不同形，
 * 而"操作记录里的名字和聊天里的名字不一样 / 有时显示设备名"就是这么来的（用户 2026-10-14）。
 * 本函数现在只补 `nicknameOf` 不管的两件事实：头像、在线。
 */
export function useMemberProfile() {
  const app = useAppStore();
  const chat = useChatStore();
  const myId = computed(() => app.device?.device_id ?? "");

  function memberProfile(id: string): MemberProfile {
    const name = chat.nicknameOf(id);
    if (id === myId.value) {
      return { name, avatar: app.device?.avatar ?? null, online: app.online };
    }
    const friend = chat.friends.find((f) => f.device_id === id);
    if (friend) return { name, avatar: friend.avatar, online: friend.online };
    const peer = chat.peers.find((p) => p.device_id === id);
    if (peer) return { name, avatar: peer.avatar ?? null, online: true };
    return { name, avatar: null, online: false };
  }

  return { memberProfile, myId };
}
