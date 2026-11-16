/**
 * 「打开某个人的资料」——**全应用只有这一个入口**。
 *
 * ## 为什么抽成 composable
 *
 * 原来这条逻辑住在 `ChatWindow.vue` 的 `openSenderProfile` 里，其它地方要用只能
 * 一层一层 `emit("open-profile")` 往上传 ⇒ 很多人员列表点了没反应
 * （用户 2026-11-16：「有很多地方点击用户的头像或者名字，应该跳转到那个人的详情。
 * 就是现在好多地方都没做，就是现在只有聊天框，还有那个通讯录」）。
 *
 * 抽出来之后：谁要跳详情，**自己调** `openProfile(id)` 就行，不必接事件。
 *
 * ## 三种落点
 *
 * - **自己** ⇒ 自己的资料页（移动端下钻路由，桌面端进设置第一项）；
 * - **好友** ⇒ 好友资料页 `/contacts/:friendId`（与通讯录点进去是同一页）；
 * - **不是好友** ⇒ 没有好友资料页可看：交回调用方的兜底
 *   （群里 ⇒ 打开群成员面板；单聊里 ⇒ 如实说一句「没有可看的资料」，**不假装点了没反应**）。
 */
import { useRouter } from "vue-router";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { t } from "@/i18n";

export interface OpenProfileOptions {
  /** 对方不是好友时的兜底（例如在群里：打开群成员面板）。 */
  onUnknown?: (deviceId: string) => void;
}

export function useOpenProfile(opts: OpenProfileOptions = {}) {
  const app = useAppStore();
  const chat = useChatStore();
  const router = useRouter();

  /** 打开某个人的资料；返回 true = 真的打开了，false = 走了兜底。 */
  function openProfile(deviceId: string): boolean {
    const id = (deviceId ?? "").trim();
    if (!id) return false;
    if (id === app.device?.device_id) {
      void router.push({ name: app.isMobile ? "profile" : "settings" });
      return true;
    }
    if (!chat.friends.some((f) => f.device_id === id)) {
      if (opts.onUnknown) {
        opts.onUnknown(id);
        return true;
      }
      app.toast(t("chat.header.profileUnavailable"), "info");
      return false;
    }
    if (app.isMobile) app.mobileView = "chat";
    void router.push({ name: "friend", params: { friendId: id } });
    return true;
  }

  return { openProfile };
}
