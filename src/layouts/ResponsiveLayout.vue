<script setup lang="ts">
import { t } from "@/i18n";
import { computed, ref, onMounted, onUnmounted, watch, watchEffect } from "vue";
import { useRoute, useRouter, type RouteLocationRaw } from "vue-router";
import { navigationDirection } from "@/router/main";
import { useEventListener } from "@vueuse/core";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { api, APP_ACTION, bindMenuEvents, NAVIGATE_TO_CONTACTS, onAction } from "@/api";
import { launchAuxWindow, useWindowOpening } from "@/composables/useWindowLauncher";
import { useShortcuts } from "@/composables/useShortcuts";
import { createInitScope } from "@/utils/initScope";
import NavRail from "@/components/NavRail.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SelfAvatar from "@/components/SelfAvatar.vue";
import TitleBar from "@/components/TitleBar.vue";
import ConversationList from "@/components/ConversationList.vue";
import ChatWindow from "@/components/ChatWindow.vue";
import UnreadBadge from "@/components/UnreadBadge.vue";
import FriendProfile from "@/components/FriendProfile.vue";
import FriendRequestList from "@/components/conversation/FriendRequestList.vue";
import SettingsPanel from "@/components/SettingsPanel.vue";
import NavIcon from "@/components/ui/NavIcon.vue";
import AddFriendModal from "@/components/AddFriendModal.vue";
import ChatSearchDialog from "@/components/search/ChatSearchDialog.vue";
import GroupCreateModal from "@/components/GroupCreateModal.vue";
import ShareDirectory from "@/components/ShareDirectory.vue";
import LogViewer from "@/components/LogViewer.vue";
import FavoritePanel from "@/components/FavoritePanel.vue";
import ToastHud from "@/components/ToastHud.vue";
import ImageLightbox from "@/components/message/ImageLightbox.vue";
import { useImagePreviewStore } from "@/stores/useImagePreview";
import LinksList from "@/components/LinksList.vue";
import MobilePageFrame from "@/components/MobilePageFrame.vue";
import ProfileSection from "@/components/settings/ProfileSection.vue";
import { ScrollText, Settings, UserCircle } from "lucide-vue-next";
import type { ExternalLink, Friend, PendingRequest } from "@/types";
import { storageGet, storageSet } from "../utils/safeStorage.ts";
const app = useAppStore();
const chat = useChatStore();
/** 全局图片预览的宿主（实例只有一个，见模板末尾那处 `<ImageLightbox>`）。 */
const preview = useImagePreviewStore();
// 本布局就是那份覆盖层的宿主 ⇒ 告诉预览 store「投递被拒时退回我这里，是有东西可看的」。
// 独立群任务窗口不渲染 ResponsiveLayout，那个文档里这个标记一直是 false ⇒ 同一场失败会
// 被明确报出来并收起状态，而不是留着 open=true 把任务详情锁成「点遮罩关不掉」
// （为什么不能靠"是不是主窗口"来推，见 useImagePreview.ts 里 overlayMounted 那段说明）。
preview.overlayMounted = true;

/**
 * 导航状态——**单一数据源**，替代之前分散的 `view` + `favoritesOpen`。
 *
 * 之前的问题：`view = "chats"` 和 `favoritesOpen = true` 可以**同时为真**，
 * 导致 NavRail 聊天按钮和收藏按钮一起高亮（用户反馈 2026-09-20「多选了侧边栏的按钮」）。
 * 现在四个枚举值互斥，NavRail 只读这一个值决定高亮，不会再出现双选中。
 *
 * 收藏关闭后（如用户点其他 rail 按钮 / 打开会话）自动回到 `chats`，
 * 确保左中右三列始终同步。
 */
type NavState = "chats" | "contacts" | "links" | "favorites" | "me";

/**
 * 导航状态 = **路由的派生态**（单一真相源从组件内 ref 移到 URL）。
 *
 * `lastNav` / `lastPane` 只服务整页覆盖层：设置、日志、资料、搜索盖上来时不改变
 * 底层 tab 与面板，返回时回到进入前那一页（用户 2026-09-12 晚 #1 的硬要求）。
 */
const route = useRoute();
const router = useRouter();
const lastNav = ref<NavState>("chats");
const lastPane = ref<"list" | "chat">("list");

function navOfRoute(): NavState {
  const name = String(route.name ?? "");
  if (name === "contacts" || name === "friend" || name === "requests") return "contacts";
  if (name === "favorites" || name === "favorite") return "favorites";
  if (name === "links") return "links";
  if (
    name === "me" ||
    name === "profile" ||
    name === "settings" ||
    name === "settings-section" ||
    name === "logs"
  )
    return "me";
  return "chats";
}

const navState = computed<NavState>(() =>
  route.meta.overlay ? lastNav.value : navOfRoute(),
);
watch(navState, (v) => (lastNav.value = v), { immediate: true });

/** 移动端面板：详情路由 = chat，列表路由 = list；覆盖层沿用底层。 */
const mobileView = computed<"list" | "chat">(() =>
  route.meta.overlay ? lastPane.value : route.meta.pane === "detail" ? "chat" : "list",
);
watch(
  mobileView,
  (v) => {
    lastPane.value = v;
    app.mobileView = v;
  },
  { immediate: true },
);

/** 喂给 `ConversationList` 的视图：它只认 chats / contacts。 */
const listView = computed<"chats" | "contacts">(() =>
  navState.value === "contacts" ? "contacts" : "chats",
);
/** 收藏打开时左列隐藏（整页态），links 时换成 LinksList。 */
const favoritesOpen = computed(
  () => route.name === "favorites" || route.name === "favorite",
);
const isLinksView = computed(() => route.name === "links");

/** 有历史条目才 back（否则深链进来会退出应用）；没有就走 fallback。 */
function canGoBack(): boolean {
  const state = window.history.state as { back?: string | null } | null;
  return Boolean(state && state.back);
}
function goBack(fallback: string) {
  if (canGoBack()) router.back();
  else void router.push(fallback);
}

/** 一级 tab 的目标路由。桌面「聊天」保留当前会话，移动端回列表。 */
function routeForTab(nav: NavState): RouteLocationRaw {
  if (nav === "chats") {
    return !app.isMobile && chat.activeConv
      ? { name: "conversation", params: { convId: chat.activeConv } }
      : { name: "chats" };
  }
  if (nav === "contacts") return { name: "contacts" };
  if (nav === "links") return { name: "links" };
  if (nav === "favorites") return { name: "favorites" };
  return { name: "me" };
}

/**
 * 移动端「列表 ↔ 详情」平移动画开关。
 *
 * ⚠️ 只在**同一个 tab 内** list↔detail（点会话 / 点好友进详情、再返回）时平移；
 * **底部 tab 切换必须瞬时切换、不做转场**（用户 2026-09-20：「tab 切换不要转场啊，
 * 我要的是从列表点进详情的这种」——上一版按 `mobileView` 无脑动画，切「我的 / 收藏」
 * 也整屏滑，是错的）。
 *
 * 实现：所有 **tab 选择**都走 `selectMobileTab`（它会先在**本帧**关掉 transform 过渡、
 * 让面板瞬时到位，下一帧再恢复）；其余 `mobileView` 改动（`openConversation` /
 * `openFriendProfile` / `openRequests` / 各类返回）直接赋值，于是照常平移。
 */
const paneAnimate = ref(true);

/**
 * 移动端 tab 选择：瞬时切换面板，不做 list↔detail 平移。
 * 双 `requestAnimationFrame` 保证「无过渡」的那一帧真的被绘制过 ——
 * 单 rAF 可能与本次 DOM 改动合并到同一帧，过渡仍会被触发。
 */
function selectMobileTab(nav: NavState, mv: "list" | "chat") {
  paneAnimate.value = false;
  // 先写 store：底栏/主面板本帧就到位，路由随后落库（用户 2026-09-24 #29「切换要瞬间响应」）。
  app.mobileView = mv;
  void router.push(routeForTab(nav)).finally(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => (paneAnimate.value = true)));
  });
}
/** 正在查看资料的好友（通讯录点击好友 → 展示资料页，而非直接开会话） */
const profileFriend = ref<Friend | null>(null);
/** 桌面端独立设置窗口开不出来时的应用内回退。 */
const settingsFallbackOpen = ref(false);
const settingsOpen = computed(
  () =>
    settingsFallbackOpen.value ||
    (app.isMobile &&
      (route.name === "settings" || route.name === "settings-section")),
);
/** 移动端资料页（可编辑资料，复用 ProfileSection）。桌面端无独立资料窗口，回落到设置。 */
const profileOpen = computed(() => app.isMobile && route.name === "profile");
const profileReloadToken = ref(0);
const addFriendOpen = ref(false);
const groupOpen = ref(false);
const shareOpen = ref(false);
const logsOpen = computed(() => app.isMobile && route.name === "logs");

/**
 * 移动端底部 TabBar 是否显示 —— **单一事实来源**，模板里的 TabBar `v-if`
 * 与主内容区那条「底部占位」padding 都读它（两处各写一份就会漂移：
 * 一边隐藏、另一边还留着内边距 → 底部空一大截，用户 2026-09-19）。
 * ⚠️ 占位的**高度**另有单一事实来源 = `--gosslan-mobile-tabbar-h`（定义在 `src/style.css`），
 * 条件与尺寸是两件事，别把其中一个的收敛当成另一个也收敛了。
 *
 * 只在**四个一级 tab** 上显示：聊天 / 通讯录列表（`mobileView === 'list'`）、收藏、我的。
 * 进 Chat 详情、设置、日志、链接 等二级页时整个隐藏。收藏必须保留（用户 2026-09-20）。
 */
const showMobileTabBar = computed(
  () =>
    app.isMobile &&
    !app.keyboardOpen &&
    !app.multiSelectActive &&
    (mobileView.value === "list" || favoritesOpen.value || navState.value === "me") &&
    !settingsOpen.value &&
    !logsOpen.value,
);

/** 关闭收藏页。**回到 chats 而不是任意之前的值**——收藏是临时整页，
 * 微信关闭收藏后默认回到聊天列表，不猜用户之前在哪个 tab。 */
function closeFavorites() {
  // 收藏是 tab，关闭走 tab 选择：瞬时切回聊天列表，不做平移（见 `selectMobileTab`）。
  if (app.isMobile) selectMobileTab("chats", "list");
  else void router.push({ name: "chats" });
}

/** NavRail 切换：写入路由（一级 tab 的唯一出口）。 */
function onUpdateNavState(v: NavState) {
  if (app.isMobile) {
    selectMobileTab(v, v === "links" || v === "favorites" ? "chat" : "list");
    return;
  }
  // 桌面点「聊天」保留当前会话；点「通讯录」回到列表（修 D-B：不再停在旧资料页）。
  void router.push(routeForTab(v));
}

/**
 * 打开设置。
 * 桌面端：**独立窗口**（用户 2026-09-12 反馈：「PC 端的设置页面可以按照这种布局，
 * 弹一个单独的窗口」——参考图是左侧窄导航 + 右侧内容的设置窗口，不是盖在聊天上的弹窗）。
 * 移动端：整页设置（`SettingsPanel` 的全屏分支，iOS 标准）。
 * 独立窗口不可用时**回退到应用内弹窗**，保证「设置」在任何环境下都打得开。
 */
function openSettings() {
  if (app.isMobile) {
    // 覆盖层路由：不改变底层 tab / 面板（见 `navState` / `mobileView` 的 overlay 分支）。
    void router.push({ name: "settings" });
    return;
  }
  // 独立窗口：单飞 + 连点防抖（`useWindowLauncher`）。窗口实例唯一性由后端保证。
  void launchAuxWindow("settings", () => api.openSettingsWindow()).catch(() => {
    // 独立窗口开不出来（能力缺失 / 创建失败）时回退到应用内设置页：
    // 「设置」在任何环境下都必须打得开，宁可退化成弹窗也不能点了没反应。
    settingsFallbackOpen.value = true;
  });
}

function closeSettings() {
  if (settingsFallbackOpen.value) {
    settingsFallbackOpen.value = false;
    return;
  }
  goBack("/me");
}

/** 打开运行日志：桌面端开独立窗口，移动端跳全屏页面（带返回）。 */
function openLogs() {
  if (app.isMobile) {
    void router.push({ name: "logs" });
    return;
  }
  void launchAuxWindow("logs", () => api.openLogWindow()).catch((e) =>
    app.toastError(e, t("common.operationFail")),
  );
}

function closeLogs() {
  goBack("/me");
}

/**
 * 打开资料页。
 * 移动端：整页可编辑资料（头像 / 昵称 / 状态），复用 `ProfileSection`，从「我的」下钻进来。
 * 桌面端没有独立的资料窗口——资料就是设置第一项（通用 → 资料），直接进设置即可。
 */
function openProfile() {
  if (app.isMobile) {
    void router.push({ name: "profile" });
    return;
  }
  openSettings();
}

function closeProfile() {
  goBack("/me");
}

/** 移动端链接页返回：链接是从「我的」下钻进来的，返回即回到「我的」页。 */
function onLinksBack() {
  goBack("/me");
}

/**
 * 在独立窗口里打开一条外部链接（桌面端）。
 *
 * ⚠️ 链接窗口加载的是**远端页面**、且刻意不在 capabilities 里（远端拿不到任何命令权限，
 * 见 Rust `open_link_window`/`link_window_is_not_capability_covered`）。这里只负责触发；
 * 同一窗口再次打开会 `navigate` 到新网址（不会越开越多）。
 */
function openLink(link: ExternalLink) {
  void launchAuxWindow("link", () => api.openLinkWindow(link.url, link.name)).catch((e) =>
    app.toastError(e, t("links.openFail")),
  );
}

/** 按钮 pending 反馈：正在打开时按钮显示忙碌态（冷启动那一下用户能立刻看到"点到了"）。 */
const settingsOpening = useWindowOpening("settings");
const logsOpening = useWindowOpening("logs");
const linksOpening = useWindowOpening("link");

/** 搜索聊天记录结果页：路由承载关键词，关闭即回到进入前那一页。 */
const searchOpen = computed(() => route.name === "search");
const searchSeed = computed(() => (typeof route.query.q === "string" ? route.query.q : ""));

function openSearchHistory(keyword: string) {
  void router.push({ name: "search", query: { q: keyword } });
}

function closeSearch() {
  goBack("/chats");
}

/**
 * 从结果页「进入聊天」：打开该会话并**跳到命中那一条**。
 * 跳转复用 `locateMessageInConv`（它会翻页直到找到那条消息），失败时提示而不是静默
 * —— 用户点"进入聊天"就是想看那条，没跳到会以为功能坏了。
 */
async function onOpenSearchHit(payload: { convId: string; msgId: string }) {
  if (app.isMobile) app.mobileView = "chat";
  // 先同步打开会话（activeConv 立刻写），路由 watcher 看到已打开就不会重复拉一次。
  const opening = chat.openConversation(payload.convId);
  await router.replace({ name: "conversation", params: { convId: payload.convId } });
  await opening;
  const r = await chat.locateMessageInConv(payload.convId, payload.msgId);
  if (r !== "found") app.toast(t("search.locateFail"), "error");
}

function openFriendProfile(f: Friend) {
  profileFriend.value = f;
  if (app.isMobile) app.mobileView = "chat";
  void router.push({ name: "friend", params: { friendId: f.device_id } });
}

/** 「新的朋友」页：右侧主区展示好友申请列表（微信式） */
const showRequests = computed(() => route.name === "requests");

function openRequests() {
  profileFriend.value = null;
  // ⚠️ 移动端：申请页渲染在**右侧主面板**里，而移动端靠 `mobileView` 平移切换面板 ——
  // 不切过去的话用户还停在会话列表上，表现就是「点了『新的朋友』没反应」
  // （用户 2026-09-12 安卓实测）。与 `openFriendProfile` / `openSearchHistory` 同一处理。
  if (app.isMobile) app.mobileView = "chat";
  void router.push({ name: "requests" });
}

/** 收起「新的朋友」页：有会话在聊时切回「聊天」tab，
 *  否则会出现右侧在聊、左侧还停在通讯录的错位。 */
function closeRequests() {
  // 移动端返回会话列表（iOS push/pop 语义：申请页是从列表推进去的一层）
  if (app.isMobile) app.mobileView = "list";
  if (app.isMobile) {
    goBack("/chats");
    return;
  }
  if (chat.activeConv) void router.push({ name: "conversation", params: { convId: chat.activeConv } });
  else void router.push({ name: "contacts" });
}

async function acceptRequest(r: PendingRequest) {
  try {
    await chat.respondRequest(r.from, true);
    app.toast(t("layout.toast.accepted", { name: r.from_nickname }), "success");
  } catch (e) {
    app.toastError(e, t("common.operationFail"));
  }
}
async function rejectRequest(r: PendingRequest) {
  try {
    await chat.respondRequest(r.from, false);
    app.toast(t("layout.toast.rejected"), "info");
  } catch (e) {
    app.toastError(e, t("common.operationFail"));
  }
}

/** 资料页「发消息」：回到消息视图并打开与该好友的会话 */
async function sendMessageTo(id: string) {
  profileFriend.value = null;
  // ⚠️ 视图切换排在一切 await 之前（用户 2026-09-24 #29「切换会话要瞬间响应，数据后台异步加载」）。
  // `openConversation` 第一行就同步写下 `activeConv`，其后才是骨架 + 异步拉消息；
  // 把 `mobileView` 写在 await 之后 ⇒ 移动端点「发消息」要等完两轮 IPC 才翻页，
  // 点下去那一下毫无反应。与 `ConversationList.openConv` 同一顺序。
  if (app.isMobile) app.mobileView = "chat";
  // 「自己」的会话行可能还不存在：先 ensure（后端有 self 分支，会用本机昵称/头像命名），
  // 否则列表里会显示成一串 gosslan-xxxx。
  if (id === app.device?.device_id) await api.ensureConversation(id);
  // 先同步写 activeConv，再落路由：路由 watcher 看到已打开就不会重复拉一次，
  // 同时地址栏/返回链立刻正确。
  const opening = chat.openConversation(id);
  void router.push({ name: "conversation", params: { convId: id } });
  await opening;
}

async function removeFriend(f: Friend) {
  profileFriend.value = null;
  try {
    await chat.removeFriend(f.device_id);
    app.toast(t("conv.toast.friendRemoved", { name: f.nickname }), "info");
    // 人已经从好友表删掉：留在 /contacts/:id 会是一张空资料页。
    void router.push({ name: "contacts" });
  } catch (e) {
    app.toastError(e, t("common.deleteFail"));
  }
}

/** 启动时自动打开最近会话：用 replace 落路由，避免返回键多退一次到空列表。 */
const autoOpenRecent = ref(false);
watch(
  () => chat.activeConv,
  (convId) => {
    profileFriend.value = null;
    // 切到 links/favorites 时**不要**被强制拉回 chats——发现页是独立导航目标，
    // 即使有活跃会话也应该让用户继续看发现内容。
    if (convId && navState.value !== "links" && navState.value !== "favorites") {
      const current = route.name === "conversation" ? String(route.params.convId ?? "") : "";
      if (current !== convId) {
        const target = { name: "conversation", params: { convId } } as const;
        if (autoOpenRecent.value && route.name === "chats") void router.replace(target);
        else void router.push(target);
      }
    }
    autoOpenRecent.value = false;
  },
);

/**
 * 导航切换 —— 只决定渲染，不碰子状态值。
 *
 * 每个 navState 自带"记忆"：
 *   chats     → activeConv （当前会话）
 *   contacts  → profileFriend + showRequests （上次点开的好友/申请页）
 *   links     → 独立面板，无子状态
 *   favorites → 独立整页，无子状态
 *
 * 导航切换只改变 navState 这个枚举，右侧内容块的 `v-if/v-else-if` 守卫
 * （已经全部加了 `navState === 'xxx' &&` 前缀）会自动决定显不显示。
 * 值不清除 = 下次切回来自动恢复。
 *
 * 示例流程：
 *   1. 在 chats，activeConv = group:abc → 右侧 ChatWindow
 *   2. 切到 contacts，profileFriend = null → 右侧空态好友列表
 *   3. 点好友张三 → profileFriend = 张三 → 右侧 FriendProfile
 *   4. 切回 chats → activeConv 还在 → 右侧 ChatWindow 恢复
 *   5. 再切到 contacts → profileFriend 还在 → 右侧 FriendProfile 张三
 */

// 桌面端默认选中：启动后会话列表就绪且当前无选中会话时，自动打开最近的一个会话，
// 右侧直接进入聊天（对齐微信桌面版行为）；移动端保持列表优先，不自动跳转。
watch(
  () => chat.conversations,
  (convs) => {
    if (app.isMobile) return;
    if (!chat.activeConv && convs.length > 0) {
      autoOpenRecent.value = true;
      void chat.openConversation(convs[0].id);
    }
  },
  { immediate: true },
);

// 通知点击跳转：好友申请通知 → 切换到联系人视图
function onNavigateToContacts() {
  if (app.isMobile) app.mobileView = "list";
  void router.push({ name: "contacts" });
}

// ---------------- 应用级动作：原生菜单与键盘快捷键共用 ----------------
// macOS 的菜单栏（src-tauri/src/menu.rs）与下面的快捷键都只"发出意图"，
// 真正的动作在这里执行 —— 保证两条路径行为完全一致。
function onAddFriendAction() {
  addFriendOpen.value = true;
  if (app.isMobile) app.mobileView = "list";
}
useShortcuts();

/**
 * 路由 → 会话/资料状态。
 *
 * 页面级层级现在由路由的历史条目承载（聊天页、我的页、资料页不再各压一条 `useBackLayer`），
 * 所以系统返回键先退路由；只有浮层（弹窗/菜单/灯箱）仍走 `useBackLayer` 的手工栈。
 * 深链进入 `/chats/:id` 时没有「点会话」那一下，这里负责补上打开动作。
 */
watch(
  () => [
    route.name,
    route.params.convId,
    route.params.friendId,
    route.query.msgId,
    chat.friends.length,
  ],
  async () => {
    if (route.name === "conversation") {
      const convId = String(route.params.convId ?? "");
      if (convId && chat.activeConv !== convId) await chat.openConversation(convId);
      const msgId = typeof route.query.msgId === "string" ? route.query.msgId : "";
      if (convId && msgId) {
        const r = await chat.locateMessageInConv(convId, msgId);
        if (r !== "found") app.toast(t("search.locateFail"), "error");
      }
    } else if (route.name === "friend") {
      const id = String(route.params.friendId ?? "");
      const f = chat.friends.find((x) => x.device_id === id);
      if (f) profileFriend.value = f;
    } else if (route.name === "contacts") {
      // 通讯录一级列表 = 没有打开任何资料页（修 D-B：点 rail「通讯录」不再停在上一个好友）。
      profileFriend.value = null;
    }
  },
  { immediate: true },
);

// 桌面没有「我的」页 / 资料页 / 全屏日志页（各自有独立窗口或设置入口）：
// 深链落进来时回落到聊天，避免渲染一条桌面不可达的分支（修 D-E）。
watch(
  () => [app.isMobile, route.name] as const,
  ([mobile, name]) => {
    if (mobile) return;
    if (name === "me" || name === "profile" || name === "logs") {
      void router.replace({ name: "chats" });
    } else if (name === "settings" || name === "settings-section") {
      settingsFallbackOpen.value = true;
      void router.replace({ name: "chats" });
    }
  },
  { immediate: true },
);

/**
 * 返回快捷键（桌面）：Esc / ⌘[ / Ctrl+[ / Alt+←。
 * 有弹层时让弹层先处理（Reka 自己听 Esc），这里不抢。
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}
function onBackKey(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (document.querySelector("[role='dialog'][data-state='open'], [role='menu'][data-state='open'], [data-reka-popper-content-wrapper]")) return;
  const mod = e.metaKey || e.ctrlKey;
  const isBackKey = e.key === "Escape" || (mod && e.key === "[") || (e.altKey && e.key === "ArrowLeft");
  if (!isBackKey) return;
  if (e.key === "Escape" && isTypingTarget(e.target)) return;
  const root = ["chats", "contacts", "favorites", "links", "me"].includes(String(route.name ?? ""));
  if (root) return;
  e.preventDefault();
  goBack("/chats");
}
useEventListener(window, "keydown", onBackKey);

const appActionScope = createInitScope();

// 这些"整页内容"里的任何一个盖上来，聊天就不再可见 ⇒ 同步给 store（判已读/发回执要用）。
// 为什么放在这里、且必须是 watchEffect：它立即执行一次，所以**必须**在所有浮层 ref 声明之后
// （放在前面会撞上 const 的 TDZ）。只有布局层知道这些浮层开没开，store 只保留一个布尔。
watchEffect(() => {
    app.setMobileChatObscured(
      app.isMobile &&
        (settingsOpen.value ||
          logsOpen.value ||
          profileOpen.value ||
          showRequests.value ||
          profileFriend.value !== null ||
          shareOpen.value),
    );
});

onMounted(() => {
  // mitt 不自动清理，而菜单那 4 条 `listen()` 要等一次 IPC 往返 ⇒ 两半都登记进 initScope。
  // 手写句柄漏的是后半：往返回来时本轮已拆，`unlistenMenu` 还停在 null ⇒ 4 条监听永久挂着。
  appActionScope.onDispose(onAction(NAVIGATE_TO_CONTACTS, onNavigateToContacts));
  appActionScope.onDispose(onAction(APP_ACTION.openSettings, openSettings));
  appActionScope.onDispose(onAction(APP_ACTION.addFriend, onAddFriendAction));
  appActionScope.onDispose(onAction(APP_ACTION.openLogs, openLogs));
  // 原生菜单（仅 macOS）；非 macOS 平台该 Promise 仍会 resolve，只是收不到事件
  void bindMenuEvents().then((fns) => {
    for (const fn of fns) appActionScope.onDispose(fn);
  });
});
onUnmounted(() => appActionScope.dispose());

// ---------------- 桌面端：列表栏宽度拖拽（rail 64px 固定，列表 200~420px，持久化） ----------------
const RAIL_W = 64;
const LIST_W_MIN = 200;
const LIST_W_MAX = 420;
// 键名要具名：散在调用里的裸字面量没有任何判据能看到它（appearance.test.ts 只
// 交叉核对首屏脚本与 `*_KEY` 常量两边），改名/打错会静默丢掉用户的栏宽偏好。
const LIST_W_KEY = "gosslan-list-w";
const listW = ref(
  Math.min(LIST_W_MAX, Math.max(LIST_W_MIN, Number(storageGet(LIST_W_KEY)) || 250)),
);
const resizing = ref(false);

function onResizeStart(e: PointerEvent) {
  // 只认鼠标左键：中键/右键拖拽不该改变列表宽度（右键还会弹系统菜单）
  if (e.button !== 0) return;
  resizing.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}
function onResizeMove(e: PointerEvent) {
  if (!resizing.value) return;
  listW.value = Math.min(LIST_W_MAX, Math.max(LIST_W_MIN, e.clientX - RAIL_W));
}
/**
 * 结束拖拽。除了正常抬手，还要覆盖：指针被系统抢走（`lostpointercapture`）、
 * 指针移出窗口后在其他窗口抬起（收不到 pointerup）——那样 `body` 会残留
 * `col-resize` 与全局 `user-select: none`，用户会以为"界面卡住/选不中字了"。
 */
function onResizeEnd() {
  if (!resizing.value) return;
  resizing.value = false;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  storageSet(LIST_W_KEY, String(listW.value));
}
</script>

<template>
    <!-- ⚠️ 根容器**不要**加圆角（曾经是 rounded-[var(--gosslan-radius-lg)]）：
        窗口形状由系统负责——Windows 由 DWM（`shadow:true`，Win11 自动圆角，**最大化时不再圆角**）、
        macOS 由系统窗口圆角。应用再画一层圆角就会与系统边界错位：容器圆角之外那圈露出 body 底色
        （亮色 #edf1f6 ≈ 白），表现为「窗口角上有一道白缝」，关闭键 hover 成红色后尤其刺眼，
        最大化时四角全会出现。圆角交给系统 = 曲线唯一、严丝合缝。 -->
    <div
    class="flex w-full flex-col overflow-hidden bg-[var(--gosslan-caption)] font-gosslan text-[var(--gosslan-text)]"
    :class="app.isMobile
      ? 'h-dvh'
      : 'h-screen ring-1 ring-inset ring-[var(--gosslan-window-ring)]'"
  >
    <!-- 移动端顶部安全区：大圆角/刘海屏下为状态栏留出空间，避免搜索框顶到屏幕外框 -->
    <div v-if="app.isMobile" class="safe-top shrink-0"></div>

    <!-- 顶部 caption：横贯整个窗口（盖在 rail + list + chat 三列之上），微信 4.0 顶部是整条浅灰拖拽条 -->
    <TitleBar :is-mobile="app.isMobile" />

    <!-- 桌面：rail（左）| 列表（中）| 聊天（右）三列；移动端按 mobileView 抽屉切换。
         把可拖拽的列表宽 `listW` 暴露成 CSS 变量：会话列表用内联 width，
         收藏页的左列在 `FavoritePanel` 里（拿不到这个 ref），靠 `var(--gosslan-list-w)` 共享同一宽度
         （`style.css` 里已有同名 token，默认 250px 兜底）。 -->
    <div class="relative flex min-h-0 flex-1 overflow-hidden" :style="{ '--gosslan-list-w': `${listW}px` }">
    <!-- 左侧导航栏：顶格到 caption 之下，浅灰与 caption 一体 -->
    <NavRail
      :nav-state="navState"
      :settings-opening="settingsOpening"
      :logs-opening="logsOpening"
      @update:nav-state="onUpdateNavState"
      @open-settings="openSettings"
      @open-logs="openLogs"
    />

    <!-- 会话列表：桌面宽度可拖拽调（默认250px，持久化）；移动端整屏抽屉。
         收藏是**整页**（参考 PC 微信：点收藏后左侧不再显示聊天/通讯录列表），
         所以桌面端收藏打开时把这一列整个收起，主区（收藏页）顶到 rail 右边。
         ⚠️ 移动端 translate 与下方 main 镜像对称（同用「'list' 且非收藏」作为列表态判据）。
         收藏打开时 aside 必须滑走，否则会盖住 main 上的 FavoritePanel 看不见
         （用户 2026-09-19 Android 实测）—— 本分支把 z 序**反过来**（main z-20 在 aside z-10 之上），
         收藏/详情永远盖住列表，所以只滑 30% 做视差即可、不必整列滑出。
         —— 列表 ↔ 详情用 iOS push/pop：两个面板**一起平移**（列表左移、详情从右滑入），
         而**不是** `hidden` 硬切 —— 硬切在滑动窗口里会露出根节点底色，且只有单边在动，
         观感像"网页换页"（用户 2026-09-20「会话列表点进聊天没转场、好友点资料也没有」）。
         离屏面板用 `inert` 摘掉焦点与交互（键盘 Tab 不进不可见面板）。 -->
    <aside
      v-if="app.isMobile || !favoritesOpen"
      class="h-full shrink-0 overflow-hidden bg-[var(--gosslan-list)]"
      :class="app.isMobile
        ? 'absolute inset-y-0 left-0 z-10 w-full ' +
          (paneAnimate ? 'transition-transform duration-[var(--gosslan-duration)] ease-[var(--gosslan-ease)] ' : '') +
          (mobileView === 'list' && !favoritesOpen ? 'translate-x-0' : '-translate-x-[30%]')
        : ''"
      :inert="app.isMobile && mobileView === 'chat'"
      :style="app.isMobile ? undefined : { width: `${listW}px` }"
    >
      <!-- 「链接」视图（仅桌面 rail 能切到）：整列换成链接列表；其余视图仍是会话列表。 -->
      <LinksList v-if="!app.isMobile && isLinksView" :opening="linksOpening" @open="openLink" />
      <ConversationList
        v-else
        :view="listView"
        :active-friend-id="profileFriend?.device_id ?? null"
        :requests-active="showRequests"
        @update:view="onUpdateNavState($event)"
        @open-add-friend="addFriendOpen = true"
        @open-group="groupOpen = true"
        @open-friend="openFriendProfile"
        @open-requests="openRequests"
        @search-history="openSearchHistory"
      />
    </aside>

    <!-- 拖拽分隔条：悬浮叠在列表/聊天交界上（负外边距抵消布局宽度），不留缝；
         平时透明，悬停/拖拽时高亮。收藏打开时这一列已收起，这条跟着消失
         （收藏页另有下面那条，见下）。 -->
    <div
      v-if="!app.isMobile && !favoritesOpen"
      class="relative z-10 hidden w-2 cursor-col-resize transition-colors hover:bg-[var(--gosslan-divider)] desktop:md:block"
      :class="resizing ? '-mx-1 bg-[var(--gosslan-divider)]' : '-mx-1'"
      @pointerdown="onResizeStart"
      @pointermove="onResizeMove"
      @pointerup="onResizeEnd"
      @pointercancel="onResizeEnd"
      @lostpointercapture="onResizeEnd"
    ></div>

    <!-- 收藏页（整页态）的拖拽条：它的左列渲染在 `FavoritePanel` 里（不是上面的 `<aside>`），
         所以要单独挂一条 —— 绝对定位到「rail + listW」处（main 的左缘就是 rail 右缘），
         复用同一份 `listW` 与拖拽逻辑。这样收藏页的左列宽度与会话列表完全一致、且同样可拖
         （用户 2026-09-20：「宽度和其他页面不一样，而且不能拖动调整」）。 -->
    <div
      v-if="!app.isMobile && favoritesOpen"
      class="absolute inset-y-0 z-10 w-2 cursor-col-resize transition-colors hover:bg-[var(--gosslan-divider)]"
      :class="resizing ? 'bg-[var(--gosslan-divider)]' : ''"
      :style="{ left: `${RAIL_W + listW - 4}px` }"
      @pointerdown="onResizeStart"
      @pointermove="onResizeMove"
      @pointerup="onResizeEnd"
      @pointercancel="onResizeEnd"
      @lostpointercapture="onResizeEnd"
    ></div>

    <!-- 右侧聊天区：面板色差替代分割线；移动端聊天区与列表**一起**平移（iOS push/pop 观感），
         用 transform 而非 hidden。详情在上层（z-20）：列表→详情时从右滑入、列表在下层左移 30%；
         详情→列表时反向。这样滑动窗口里始终有内容，不会露出根节点底色。
         离屏时用 `inert` 摘掉焦点与交互（键盘用户 Tab 不进不可见面板）。
         ⚠️ 主区**一律直角**，不加 `rounded-tl`（用户 2026-09-20：「最右边栏的左上角都有个圆角」）——
         之前主区在非整页态带 `rounded-tl`，会在每个页面主区左上角留一个缺角。 -->
    <main
      class="flex h-full min-w-0 flex-1 flex-col bg-[var(--gosslan-chat)]"
      :class="[
        app.isMobile
          ? 'absolute inset-y-0 left-0 z-20 w-full ' +
            (paneAnimate ? 'transition-transform duration-[var(--gosslan-duration)] ease-[var(--gosslan-ease)] ' : '') +
            (mobileView === 'chat' || favoritesOpen ? 'translate-x-0' : 'translate-x-full')
          : '',
      ]"
      :inert="app.isMobile && mobileView === 'list' && !favoritesOpen"
    >
      <!-- 这条底部 padding 是给 fixed 定位的 TabBar 留的占位，只有 TabBar 真正**显示**时才需要。
           ⚠️ 这里与下面 TabBar 的 v-if **共用同一个 `showMobileTabBar`**（不要再各写一份条件）：
           两边一旦不一致，TabBar 已隐藏时 pb 还白留着 → 底部空一大截（用户 2026-09-19）。
           ⚠️ 条高读 `--gosslan-mobile-tabbar-h`，**不许在这里手写字面量**：`ConversationList` 的列表占位读同一个令牌，
           两处各抄一份就会漂移（改一处、最后一行被压住），判据 ㊻ 守着这一条。 -->
      <div
        class="min-h-0 flex flex-1 flex-col desktop:md:pb-0"
        :class="showMobileTabBar ? 'pb-[calc(var(--gosslan-mobile-tabbar-h)+env(safe-area-inset-bottom))]' : ''"
        :style="app.isMobile && app.keyboardInset > 0
          ? { paddingBottom: `${app.keyboardInset + 8}px` }
          : undefined"
      >
        <!-- 发现页（navState='discover'）：纯内容，无额外头部。
             切换入口藏在内容右上角（FavoritePanel 里点 Compass 切链接，反之亦然）。 -->
        <!-- 我的页面（navState='me'） -->
        <template v-if="navState === 'me'">
          <!-- 与聊天/通讯录列表**同族**：列表底 `--gosslan-list`、行悬停 `--gosslan-list-hover`、
               行间内缩分隔线。此前是白底 + `--gosslan-hover` + 无分隔线，和别的列表对不上
               （用户 2026-09-20：「我的也是一样的问题」）。 -->
          <div class="flex h-full flex-col overflow-y-auto bg-[var(--gosslan-list)]">
            <!-- 头部：头像 + 昵称（点进去编辑资料） -->
            <button
              class="flex w-full shrink-0 items-center gap-3 border-b border-[var(--gosslan-divider)] px-4 py-4 text-left transition hover:bg-[var(--gosslan-list-hover)]"
              :aria-label="t('nav.profile')"
              @click="openProfile()"
            >
              <!-- 没上传头像时同样是那套 emoji 小动物（用户 2026-10-07：「它是一个蓝色的
                   一个图标，跟那个头像没有同步」）。原来这里画的是 lucide 的 `UserCircle`
                   ⇒ 同一个账号在导航栏是 emoji、在「我的」页是个蓝灰人形。 -->
              <SelfAvatar class="h-14 w-14 shrink-0 rounded-full" />
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-base font-medium" :title="app.device?.nickname || app.device?.device_id || t('nav.me')">{{ app.device?.nickname || app.device?.device_id || t("nav.me") }}</span>
                <span class="truncate text-xs text-[var(--gosslan-text-2)]" :title="app.device?.device_id">{{ app.device?.device_id || "" }}</span>
              </div>
            </button>
            <!-- 菜单列表。不再重复放「资料」：上方头像本身已是资料入口（用户 2026-09-20）。
                 顺序：设置 → 链接 → 日志（链接在日志上面，用户 2026-09-20）。
                 图标与桌面 NavRail 一致用 lucide 线性图标，不再用 📋 emoji（用户 2026-09-20「日志图标好奇怪」）。 -->
            <div class="flex flex-col">
              <button class="flex items-center gap-3 px-4 py-3.5 text-left transition hover:bg-[var(--gosslan-list-hover)]" @click="openSettings()">
                <Settings class="h-5 w-5 text-[var(--gosslan-text-2)]" />
                <span class="flex-1 text-sm">{{ t("nav.settings") }}</span>
              </button>
              <!-- 行间内缩分隔线（从文本列起 = px-4 + 20 图标 + gap-3 = 48px ⇒ ml-12），
                   与聊天/通讯录列表同款；末行不加。
                   ⚠️ 放成**兄弟节点**而不是塞进 `<button>` 里：`<div>` 不是 phrasing content，
                   塞进 button 是非法 HTML。 -->
              <div class="ml-12 h-px shrink-0 bg-[var(--gosslan-divider)]"></div>
              <button class="flex items-center gap-3 px-4 py-3.5 text-left transition hover:bg-[var(--gosslan-list-hover)]" @click="selectMobileTab('links', 'chat')">
                <NavIcon name="links" size-class="h-5 w-5" class="text-[var(--gosslan-text-2)]" />
                <span class="flex-1 text-sm">{{ t("nav.links") }}</span>
              </button>
              <div class="ml-12 h-px shrink-0 bg-[var(--gosslan-divider)]"></div>
              <button class="flex items-center gap-3 px-4 py-3.5 text-left transition hover:bg-[var(--gosslan-list-hover)]" @click="openLogs()">
                <ScrollText class="h-5 w-5 text-[var(--gosslan-text-2)]" />
                <span class="flex-1 text-sm">{{ t("nav.logs") }}</span>
              </button>
            </div>
          </div>
        </template>
        <!-- 收藏页：桌面端在右栏整页渲染（左列表 + 右详情两栏）；
             移动端作为普通底部 tab（保留 tab 栏），点具体收藏才在 FavoritePanel 内部新开详情页。
             ⚠️ 这里必须是 `v-else-if`（接到上面「我的」那条 `v-if="navState === 'me'"`），
             否则「我的」页会和链尾的兜底空态（「选择一个会话开始聊天」）**同时渲染**——
             两条互不相干的条件链各自命中，用户会看到「我的」下面还挂着一个空会话页（用户 2026-09-20）。 -->
        <FavoritePanel v-else-if="favoritesOpen && !app.isMobile" @close="closeFavorites" />
        <FavoritePanel v-else-if="app.isMobile && navState === 'favorites'" />
        <div
          v-else-if="!app.isMobile && isLinksView"
          class="flex h-full select-none flex-col items-center justify-center gap-3 text-[var(--gosslan-text-2)]"
        >
          <NavIcon name="links" size-class="h-16 w-16 opacity-25" />
          <div class="text-base">{{ t("layout.linksTitle") }}</div>
          <div class="max-w-[280px] text-center text-xs leading-relaxed opacity-70">
            {{ t("layout.linksHint") }}
          </div>
        </div>
        <!-- 新的朋友页：右侧展示好友申请列表（微信式） -->
        <div v-else-if="navState === 'contacts' && showRequests" class="flex h-full flex-col">
          <div class="flex shrink-0 items-center border-b border-[var(--gosslan-divider)] bg-[var(--gosslan-chat)] px-4" :style="{ height: 'var(--gosslan-header-h)' }">
            <span class="text-title font-medium">{{ t("conv.newFriends") }}</span>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto bg-[var(--gosslan-chat)] p-2">
            <FriendRequestList
              :requests="chat.pendingRequests"
              :open="true"
              @close="closeRequests"
              @accept="acceptRequest"
              @reject="rejectRequest"
            />
            <div v-if="chat.pendingRequests.length === 0" class="mt-20 text-center text-sm text-[var(--gosslan-text-2)]">
              {{ t("friend.request.empty") }}
            </div>
          </div>
        </div>
        <FriendProfile
          v-else-if="navState === 'contacts' && profileFriend !== null"
          :friend="profileFriend"
          @send-message="sendMessageTo"
          @remove="removeFriend"
        />
        <ChatWindow
          v-else-if="navState === 'chats' && chat.activeConv"
          @open-share="shareOpen = true"
        />
        <div
          v-else
          class="flex h-full select-none flex-col items-center justify-center gap-3 text-[var(--gosslan-text-2)]"
        >
          <NavIcon v-if="navState === 'contacts'" name="contacts" size-class="h-16 w-16 opacity-25" />
          <NavIcon v-else name="chats" size-class="h-16 w-16 opacity-25" />
          <div class="text-base">
            {{ navState === "contacts" ? t("layout.selectContact") : t("layout.selectConversation") }}
          </div>
          <div class="text-xs opacity-70">{{ t("layout.tagline") }}</div>
          <!-- 空态要给**下一步**，不只陈述状态（HIG：empty state should guide）。
               用户 2026-09-12 晚 #13：「聊天界面如果没有聊天信息的话，这一块左右两边有点割裂。
               他们的样式能不能统一一点？主要的功能是：1. 如果你有好友，就有一个『发起聊天』；
               2. 如果你没有好友列表，就只有一个『添加好友』的按钮。这个按钮在会话框页面和
               聊天列表页面，你可以做一个文字说明兜底，或者在样式上做一个空状态就行了。」
               ⇒ 与左侧会话列表**同一口径**：有好友 → 发起聊天（跳通讯录选人）；
                 无好友 → 添加好友；两种情况都配同一句说明文字。
               ⚠️ 通讯录页不能用「发起聊天」：那里 `navState` 已经是 contacts，
                 点它等于把同一个值再赋一次，按钮看起来活着、实际什么都不发生。
                 通讯录的空态给「添加好友」，这是这一页真正可执行的下一步。 -->
          <template v-if="navState === 'contacts'">
            <PrimaryBtn size="large" class="mt-1" @click="addFriendOpen = true">
              {{ t("common.addFriend") }}
            </PrimaryBtn>
            <div class="text-xs opacity-70">{{ t("layout.contactHint") }}</div>
          </template>
          <template v-else>
            <PrimaryBtn
              v-if="chat.friends.length"
              size="large"
              class="mt-1"
              @click="onUpdateNavState('contacts')"
            >
              {{ t("conv.startChat") }}
            </PrimaryBtn>
            <PrimaryBtn v-else size="large" class="mt-1" @click="addFriendOpen = true">
              {{ t("common.addFriend") }}
            </PrimaryBtn>
            <div class="text-xs opacity-70">
              {{ chat.friends.length ? t("conv.emptyHintHasFriends") : t("conv.emptyHintNoFriends") }}
            </div>
          </template>
        </div>
      </div>
    </main>
    </div>

    <!-- 移动端底部导航：4 按钮（聊天 / 通讯录 / 收藏 / 我的）；软键盘弹出时收起（避免浮在键盘上方遮挡输入）。
         显示条件**统一走 `showMobileTabBar`**（与上面内容区的 pb 占位同源，不要再各写一份）：
         只在**四个一级 tab** 上显示 —— 聊天/通讯录列表（`mobileView === 'list'`）、收藏、我的；
         进 Chat 详情 / 设置 / 日志 / 链接 等二级页时整个隐藏（二级页不该有一级页的 TabBar）。
         ⚠️ 收藏 tab 必须**保留** TabBar（用户 2026-09-20 明确要求，「收藏 tab 不要新开页面」）。 -->
    <nav
      v-if="showMobileTabBar"
      class="safe-bottom fixed bottom-0 left-0 right-0 z-40 flex items-center justify-around border-t border-[var(--gosslan-border)] bg-[var(--gosslan-panel)]"
    >
      <button
        class="relative flex flex-1 flex-col items-center gap-0.5 py-2.5"
        :class="navState === 'chats' ? 'text-[var(--gosslan-primary)]' : 'text-[var(--gosslan-text-2)]'"
        @click="selectMobileTab('chats', 'list')"
      >
        <span class="nav-glyph-pill relative" :data-active="navState === 'chats'">
          <NavIcon name="chats" :active="navState === 'chats'" size-class="h-5 w-5" />
          <UnreadBadge
            v-if="chat.totalUnread > 0"
            :count="chat.totalUnread"
            class="absolute -right-2.5 -top-1"
          />
        </span>
        <span class="text-caption">{{ t("nav.chats") }}</span>
      </button>
      <button
        class="relative flex flex-1 flex-col items-center gap-0.5 py-2.5"
        :class="navState === 'contacts' ? 'text-[var(--gosslan-primary)]' : 'text-[var(--gosslan-text-2)]'"
        @click="selectMobileTab('contacts', 'list')"
      >
        <span class="nav-glyph-pill relative" :data-active="navState === 'contacts'">
          <NavIcon name="contacts" :active="navState === 'contacts'" size-class="h-5 w-5" />
          <UnreadBadge
            v-if="chat.pendingRequests.length"
            :count="chat.pendingRequests.length"
            class="absolute -right-2.5 -top-1"
          />
        </span>
        <span class="text-caption">{{ t("nav.contacts") }}</span>
      </button>
      <!-- 收藏：移动端 rail hidden desktop:md:flex（看不到），TabBar 保留入口。
           桌面端 NavRail 也有星标按钮，风格一致。 -->
      <button
        class="relative flex flex-1 flex-col items-center gap-0.5 py-2.5"
        :class="navState === 'favorites' ? 'text-[var(--gosslan-primary)]' : 'text-[var(--gosslan-text-2)]'"
        @click="selectMobileTab('favorites', 'chat')"
      >
        <span class="nav-glyph-pill relative" :data-active="navState === 'favorites'">
          <NavIcon name="favorites" :active="navState === 'favorites'" size-class="h-5 w-5" />
        </span>
        <span class="text-caption">{{ t("nav.favorites") }}</span>
      </button>
      <!-- 我的：设置 / 链接 / 运行日志收进「我的」页的菜单（TabBar 最多 4 项）。
           本分支用「我的」tab 取代了旧的「更多」弹出 sheet（用户 2026-09-20 的改版：
           设置/链接/日志都进「我的」，不再需要二级 sheet）。 -->
      <button
        class="relative flex flex-1 flex-col items-center gap-0.5 py-2.5"
        :class="navState === 'me' ? 'text-[var(--gosslan-primary)]' : 'text-[var(--gosslan-text-2)]'"
        @click="selectMobileTab('me', 'chat')"
      >
        <span class="nav-glyph-pill relative" :data-active="navState === 'me'">
          <UserCircle class="nav-glyph h-5 w-5" :stroke-width="navState === 'me' ? 2.35 : 1.9" />
        </span>
        <span class="text-caption">{{ t("nav.me") }}</span>
      </button>
    </nav>

    <!-- 弹窗 -->
    <SettingsPanel :open="settingsOpen" @close="closeSettings" />
    <!-- 搜索聊天记录结果页（会话列表搜索框回车打开） -->
    <ChatSearchDialog
      :open="searchOpen"
      :initial-keyword="searchSeed"
      @close="closeSearch"
      @open-conversation="onOpenSearchHit"
    />

    <AddFriendModal :open="addFriendOpen" @close="addFriendOpen = false" />
    <GroupCreateModal :open="groupOpen" @close="groupOpen = false" />
    <ShareDirectory :open="shareOpen" @close="shareOpen = false" />

    <!-- 移动端运行日志页：全屏覆盖、带返回（桌面端走独立窗口，见 open_log_window） -->
    <Transition :name="navigationDirection === 'back' ? 'page-slide-back' : 'page-slide'">
      <LogViewer v-if="app.isMobile && logsOpen" @back="closeLogs" />
    </Transition>

    <!-- 移动端链接页：从「我的」下钻进来的全屏覆盖层（桌面端在左列渲染） -->
    <Transition :name="navigationDirection === 'back' ? 'page-slide-back' : 'page-slide'">
      <LinksList v-if="app.isMobile && isLinksView" :opening="linksOpening" @open="openLink" @back="onLinksBack" />
    </Transition>

    <!-- 移动端资料页：可编辑资料，从「我的」下钻进来（桌面端回落到设置） -->
    <Transition :name="navigationDirection === 'back' ? 'page-slide-back' : 'page-slide'">
      <MobilePageFrame
        v-if="app.isMobile && profileOpen"
        mode="overlay"
        :title="t('nav.profile')"
        @back="closeProfile"
      >
        <ProfileSection :active="profileOpen" :reload-token="profileReloadToken" />
      </MobilePageFrame>
    </Transition>

    <!-- 全局图片预览：**整个应用只有这一个实例**（用户 2026-09-24 #40）。
         状态在 `useImagePreviewStore`，任何功能都按 `{items, startIndex, source}` 调它，
         不再各自挂一份 `<ImageLightbox>` 各抄一遍数组。 -->
    <ImageLightbox
      :images="preview.images"
      v-model:index="preview.index"
      :open="preview.open && !preview.inWindow"
      @close="preview.close()"
    />

    <!-- Toast：主窗口与独立窗口共用的 HUD（见 `ToastHud.vue` 的说明）。 -->
    <ToastHud />
  </div>
</template>
