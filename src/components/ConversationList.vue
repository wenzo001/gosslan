<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
import { currentLocale, t } from "@/i18n";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useEventListener } from "@vueuse/core";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "reka-ui";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { useSearchKeyword } from "@/composables/useSearchKeyword";
import { useExclusivePopup } from "@/composables/useExclusivePopup";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";
import { version } from "../../package.json";
import ConversationListItem from "@/components/conversation/ConversationListItem.vue";
import FriendListItem from "@/components/conversation/FriendListItem.vue";
import FriendContextMenu from "@/components/conversation/FriendContextMenu.vue";
import ConversationContextMenu from "@/components/conversation/ConversationContextMenu.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import StateBlock from "@/components/ui/StateBlock.vue";
import UnreadBadge from "@/components/UnreadBadge.vue";
import SelfAvatar from "@/components/SelfAvatar.vue";
import appMark from "@/assets/app-mark.png";
import { APP_ACTION, onAction } from "@/api";
import { groupByInitial } from "@/utils/nameGroup";
import { isSelfConversation, selfFriendOf } from "@/utils/selfChat";
import { MAX_SEARCH_KEYWORD_CHARS } from "@/utils/validation";
import { createInitScope } from "@/utils/initScope";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { isMac } from "@/utils/platform";
import { dropPointToCss } from "@/utils/dropPoint";
import { useDropSend, type DropTarget } from "@/composables/useDropSend";
import DropSendConfirm from "@/components/chat/DropSendConfirm.vue";
import type { Conversation, Friend } from "@/types";

const props = defineProps<{
  view: "chats" | "contacts";
  /** 正在查看资料的好友 ID：通讯录里对应好友高亮 */
  activeFriendId?: string | null;
  /** 「新的朋友」页是否在右侧打开（列表项高亮） */
  requestsActive?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:view", v: "chats" | "contacts"): void;
  (e: "open-add-friend"): void;
  (e: "open-group"): void;
  (e: "open-friend", f: Friend): void;
  (e: "open-requests"): void;
  /** 在搜索框里按回车 → 打开「搜索聊天记录」结果页（微信式分工：输入即过滤，回车进结果页） */
  (e: "search-history", keyword: string): void;
  /** 移动端顶栏本人头像 → 打开资料页（桌面端该入口在标题栏）。 */
  (e: "open-profile"): void;
}>();

const app = useAppStore();
const router = useRouter();
const chat = useChatStore();

/**
 * 「一次都没读到 且 有失败记录」⇒ 错误档（INV-P36：读失败不许画成空态）。
 * 成功过就不算错误档 —— 与 `utils/todos.ts` 的 `todoRowsLoadState` 同一条口径，
 * 免得同一类状态在两个组件里各判一遍、日后互相说反话。
 */
const friendsLoadFailed = computed(
  () => chat.friends.length === 0 && !chat.friendsLoaded && Boolean(chat.friendsError),
);

/**
 * 左栏也接拖拽发送（负责人 2026-10-29）：拖着文件停在**某一行**上就高亮那一行，
 * 松手弹同一个确认框，确认后发给**那一行**的会话（不是当前打开的会话）。
 *
 * 用 Tauri 的原生拖拽事件：HTML5 drag 在 WebView 里拿不到真实路径。
 * 与 ChatWindow 各订阅一份互不干扰 —— 两处命中区几何上不相交（左栏 / 右侧面板），
 * 每处只判自己的矩形（群任务表单那套 `boardDropActive` 的让位逻辑也不用改）。
 */
const listRoot = ref<HTMLElement | null>(null);
const dropRowId = ref<string | null>(null);
const drop = useDropSend();
/** 模板只解包**顶层** ref ⇒ 解构出来（`drop.body` 在模板里会拿到 ComputedRef）。 */
const dropPending = drop.pending;
const dropBody = drop.body;
const dropItems = drop.items;
const dropScope = createInitScope();

/** 这一行能不能接文件：好友单聊 / 群聊（与聊天面板同一口径；自聊不收附件）。 */
function canDropOnConv(convId: string): boolean {
  return convId.startsWith("group:") || friendById.value.has(convId);
}

/**
 * 事件里的位置 → 命中的会话行（不认识就返回 null）。
 * 量纲换算只在 `utils/dropPoint` 一处（macOS 的点不除 DPR，Windows 的物理像素要除）。
 */
function convRowAt(pos: { x: number; y: number }): string | null {
  const el = listRoot.value;
  if (!el) return null;
  const { x, y } = dropPointToCss(pos, { mac: isMac, dpr: window.devicePixelRatio || 1 });
  for (const row of el.querySelectorAll<HTMLElement>("[data-conv-row]")) {
    const r = row.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      const id = row.dataset.convRow ?? "";
      return id && canDropOnConv(id) ? id : null;
    }
  }
  return null;
}

/** 确认框正文：发到这一行；群聊说清楚有多少成员。 */
function dropTargetFor(convId: string): DropTarget {
  if (convId.startsWith("group:")) {
    const gid = convId.slice("group:".length);
    const n = chat.groups.find((g) => g.id === gid)?.members.length ?? 0;
    const name = chat.conversations.find((c) => c.id === convId)?.name ?? "";
    return { convId, body: t("chat.dropConfirmGroup", { name, n }) };
  }
  const name = chat.conversations.find((c) => c.id === convId)?.name ?? "";
  return { convId, body: t("chat.dropConfirmPeer", { name }) };
}

onMounted(() => {
  if (app.isMobile) return; // 拖拽是桌面端行为
  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter" || p.type === "over") {
        dropRowId.value = convRowAt(p.position);
        return;
      }
      if (p.type === "drop") {
        const id = dropRowId.value;
        dropRowId.value = null;
        if (!id || p.paths.length === 0) return;
        void drop.stage(p.paths, dropTargetFor(id));
        return;
      }
      dropRowId.value = null; // leave
    })
    .then((un) => dropScope.onDispose(un));
});
/** 页脚任务入口上的未完成数：与面板同一份读模型（`chat.operations`），不另算。 */
const taskCount = computed(() => chat.operations.length);
/** 回车打开搜索页之前的输入法守卫（见 composable 注释） */
const ime = useImeEnterGuard();

// 输入框只当"搜索入口"：打字**不改列表**、不查消息（用户 2026-09-12 明确要求），
// 回车才打开「搜索聊天记录」弹窗。`query` 是延迟镜像，给联系人页做姓名过滤用。
const { keyword, query } = useSearchKeyword();
/**
 * 会话列表**恒为全量**（不再随输入变化）。
 *
 * 这一行就是用户那条要求本身：「在上面输入，列表就不要有变化了」——
 * 把它抽成命名 computed 而不是内联，是为了让护栏能一眼钉住"这里没有过滤"。
 */
const listConversations = computed(() => chat.conversations);

/**
 * 通讯录里的「自己」（用户 2026-09-17）：与好友**同一条渲染路径** —— 进同一个首字母分组
 * （一起排序，不再"钉在最上面混在通讯录里"）、可被搜索、点击看**自己的资料页**（与好友一致，
 * 发消息由资料页按钮触发）。此前是钉在「新的朋友」下面的一行特殊入口，既不排序、
 * 又像永远选中，还有一份独立的"点开直接聊"逻辑。
 */
const selfFriend = computed<Friend | null>(() => selfFriendOf(app.device, app.present));

/**
 * 「这一行是不是我自己」（用户 2026-09-24 #31：通讯录里那行自己要标「（我）」）。
 * 判据复用 `isSelfConversation`（`Friend` 的 `device_id` 就是那条伪会话的 id，
 * 与本文件 `onlineOf` 的用法一致），不再写第四份 `=== device_id`。
 */
function isSelfRow(id: string): boolean {
  return isSelfConversation({ id }, app.device?.device_id);
}

/**
 * device_id → 当前链路类型（取自节点表 `chat.peers` 的 `link` 字段）。
 * 好友记录本身不带链路，连接图标要靠这张表关联 —— 与聊天头、资料页、添加好友页**同源**
 * （都读后端 `Peer.link`，再经 `peerConnectionInfo` 的唯一判据出图标/文案）。
 * 「自己」不在节点表里 ⇒ 关联不到 ⇒ 不画图标（合理：自己没有"到自己的链路"）。
 */
const peerLinkById = computed(() => {
  const m = new Map<string, string | null>();
  for (const p of chat.peers) m.set(p.device_id, p.link ?? null);
  return m;
});
/** 好友表按 id 索引：`v-memo` 依赖里每行都会求值，O(1) 查表替代 O(F) 扫描。 */
const friendById = computed(() => {
  const m = new Map<string, Friend>();
  for (const f of chat.friends) m.set(f.device_id, f);
  return m;
});
function linkOf(id: string): string | null {
  return peerLinkById.value.get(id) ?? null;
}

const filteredFriends = computed(() => {
  const all = selfFriend.value ? [selfFriend.value, ...chat.friends] : chat.friends;
  const kw = query.value.trim().toLowerCase();
  if (!kw) return all;
  return all.filter((f) => f.nickname.toLowerCase().includes(kw));
});

/**
 * 通讯录按首字母分组（用户需求 2026-09-12 第 17 条）：
 * 「以他们的这个字母名字母的首字母，和用一套规则首字母或用户的拼音的首字母去排列
 *  顺序然后去分组，然后这个头像可以小一些……离线、在线的这个还是要有的。
 *  就是它跟那个消息列表可以区别一下。」
 *
 * 首字母来源见 `utils/nameGroup`（内置生成表，跨端一致，不依赖平台 ICU）。
 * 搜索时不做分组：此时用户在找**某个人**，分组只会把结果切碎。
 */
const friendGroups = computed(() =>
  query.value.trim() ? [] : groupByInitial(filteredFriends.value, (f) => f.nickname),
);

/**
 * 加号下拉菜单展开态：点击外部自动收起；并参与全局浮层互斥
 * ——右键消息菜单 / 已读弹层展开时会自动收起它（右键不触发 click，靠点击关闭会漏）。
 * 菜单的开关（点外部/Esc/选中）、焦点移入与归还交给 Reka DropdownMenu；这里只保留互斥注册。
 */
const plusPopup = useExclusivePopup("plus-menu");
const plusOpen = ref(false);

watch(plusPopup.isActive, (mine) => {
  if (!mine && plusOpen.value) plusOpen.value = false;
});
watch(() => props.view, () => {
  plusOpen.value = false;
  plusPopup.release();
});

/**
 * 桌面左列内容切换的淡入（2026-11-04 用户：内容已经切过去、左侧药丸才滞后滑过去）。
 *
 * 内容本身是 `v-if` 硬换的；这次淡入**只动 opacity**，用的是 rail 药丸同一组
 * `--gosslan-nav-switch-*` ⇒ 两边同一帧开始、同一时长结束，中途既不会"内容已完全到位、
 * 药丸还在路上"，也不会重播整块位移。
 * 移动端不做：那里由整页 push/pop（`page-slide`）负责，叠一层淡入只会多一段不同步的动画。
 * 两个类名轮流挂：快速连点时 `animation-name` 一变就重起一段（就地收敛，不排队）。
 */
const viewFadeStep = ref(-1);
const viewFadeClass = computed(() =>
  viewFadeStep.value < 0 ? "" : viewFadeStep.value % 2 === 0 ? "conv-view-fade-a" : "conv-view-fade-b",
);
watch(() => props.view, () => {
  if (app.isMobile) return;
  viewFadeStep.value += 1;
});

function onPlusOpen(open: boolean) {
  plusOpen.value = open;
  if (open) plusPopup.claim();
  else plusPopup.release();
}

// 聚焦搜索框（⌘F / Ctrl+F 与 macOS 菜单「会话 → 搜索」共用同一动作）
const searchInput = ref<HTMLInputElement | null>(null);
function focusSearch() {
  searchInput.value?.focus();
  searchInput.value?.select();
}
/**
 * 回车：用当前关键词打开「搜索聊天记录」结果页。
 * 关键词为空时不动作（没有可搜的内容，弹一个空结果页只会让人困惑）。
 */
function onSearchEnter(e: KeyboardEvent) {
  // ⚠️ 先让输入法走：拼音/日文候选里按回车是"选字"，不是"搜索"
  // （macOS WKWebView 上 compositionend 先于 keydown，只看 isComposing 会误判）
  if (ime.isIme(e)) return;
  // 只在「消息」页生效：通讯录页的搜索是为了找人，回车弹"聊天记录"结果页会让人困惑
  if (props.view !== "chats") return;
  const kw = keyword.value.trim();
  if (kw) emit("search-history", kw);
}

// 本组件在桌面端切到「链接」视图时会被 `v-else` 拆掉重挂 ⇒ 订阅必须成对，交给 initScope
const actionScope = createInitScope();
actionScope.onDispose(onAction(APP_ACTION.focusSearch, focusSearch));
onUnmounted(() => {
  actionScope.dispose();
  dropScope.dispose();
});

/** 对端在线状态：群聊返回 null（无在线概念）；单聊查好友表。 */
function isOnline(id: string): boolean | null {
  if (id.startsWith("group:")) return null;
  // 「和自己聊天」：自己不是一个"在线/离线"的对端 —— 传 null 才不显示状态点、
  // 也不会把头像按离线灰掉（`ConversationListItem` 把 null 定义为"不显示状态点"）。
  if (isSelfConversation({ id }, app.device?.device_id)) return null;
  return friendById.value.get(id)?.online ?? false;
}

/**
 * 打开会话。
 *
 * 列表里已不存在"列表自身的搜索结果态"（搜索全在「搜索聊天记录」弹窗里做，
 * 见 `useSearchKeyword` 注释）——所以这里就是纯粹地打开会话；
 * 从搜索结果跳转那一步由弹窗自己带着 msgId 调 `chat.locateMessageInConv`。
 */
async function openConv(conv: Conversation) {
  if (app.isMobile) app.mobileView = "chat";
  // 先同步写 activeConv（openConversation 第一行），再落路由：路由 watcher 看到已打开就跳过，
  // 不会重复拉一次消息；点下去那一帧面板已经开始平移。
  const opening = chat.openConversation(conv.id);
  void router.push({ name: "conversation", params: { convId: conv.id } });
  void opening;
}
/** 通讯录点击好友 → 打开资料页（发消息由资料页按钮触发，不再直接开会话） */
function openFriend(f: Friend) {
  emit("open-friend", f);
  if (app.isMobile) app.mobileView = "chat";
}

/**
 * 联系人右键菜单的「发起聊天」（用户需求 2026-09-12 晚 #12）。
 * 直接打开与该好友的会话并切到会话视图 —— 与微信「发消息」一致：
 * 不要求先有历史会话（`openConversation` 会以 device_id 为会话 id 打开/新建）。
 */
function startChatWithFriend() {
  const f = friendMenu.value?.friend;
  closeFriendMenu();
  if (!f) return;
  const opening = chat.openConversation(f.device_id);
  void router.push({ name: "conversation", params: { convId: f.device_id } });
  void opening;
  if (app.isMobile) app.mobileView = "chat";
}

// ---------------- 右键菜单：删除好友 ----------------
// 参与全局浮层互斥：右键消息、或打开「已读成员」弹层时，本菜单会自动收起
// （右键只触发 contextmenu 不触发 click，仅靠 document click 关闭会漏）。
const friendMenuPopup = useExclusivePopup("friend-menu");
const friendMenu = ref<{ x: number; y: number; friend: Friend } | null>(null);

watch(friendMenuPopup.isActive, (mine) => {
  if (!mine && friendMenu.value) friendMenu.value = null;
});

/**
 * 右键（桌面）/ 长按（移动端）触发。
 *
 * 坐标**原样交给外壳**：`ContextMenu.vue` 用的是 Reka 的零尺寸虚拟锚点，量尺寸、翻转、贴边内收
 * 都由它的 popper wrapper 做（外壳注释里写明了这件事）。原来这里自己按 `mw=150 / mh=90` 两个
 * **猜出来的菜单尺寸**向内收了一遍 —— 那是迁移到 Reka 之前的手算残留，和同文件里
 * `onConvContext`（直接把 x,y 传下去）不一致，而且菜单条目增减时那两个数就漂了
 * （漂了不报错，只是菜单弹开的落点偏离用户点的位置）。
 */
function onFriendContext(f: Friend, x: number, y: number) {
  // 「自己」不弹好友右键菜单：那些动作（删除好友/改备注）对自己无意义；
  // 看资料 = 直接点这一行（与好友一致）。
  if (f.device_id && f.device_id === app.device?.device_id) return;
  friendMenu.value = { x, y, friend: f };
  friendMenuPopup.claim();
}

/** 删除好友：保留聊天记录；对方仍出现在扫描列表，可重新添加。乐观移除，失败回滚。
 *
 *  ⚠️ 必须二次确认：右键菜单此前**单击即删**，而「删除聊天记录」和资料页的「删除好友」
 *  都有确认弹窗——同一类破坏性操作三种行为不一致，右键菜单那条最容易误触。
 *  这里刻意**不做"撤销"**：删除好友在后端不是可本地回滚的操作（对方可能已同步移除，
 *  重新建立关系要走一次好友申请），给一个假的"撤销"比不给更糟。 */
const pendingRemoveFriend = ref<Friend | null>(null);

function onAskDeleteFriend() {
  pendingRemoveFriend.value = friendMenu.value?.friend ?? null;
  closeFriendMenu();
}

async function confirmDeleteFriend() {
  const f = pendingRemoveFriend.value;
  pendingRemoveFriend.value = null;
  if (!f) return;
  try {
    await chat.removeFriend(f.device_id);
    app.toast(t("conv.toast.friendRemoved", { name: f.nickname }), "info");
  } catch (e) {
    app.toastError(e, t("common.deleteFail"));
  }
}

// ---------------- 删除聊天记录（仅本地，二次确认） ----------------
const pendingDelete = ref<Conversation | null>(null);

/**
 * 会话行右键 / 长按 → 弹统一菜单（用户 2026-09-12 晚 #3：
 * 「取消叉叉，改为统一的右键删除操作」）。菜单里再点「删除」才进入二次确认 ——
 * 与微信一致：右键只是入口，破坏性动作仍要确认。
 */
const convMenuPopup = useExclusivePopup("conv-menu");
const convMenu = ref<{ x: number; y: number; conv: Conversation } | null>(null);

watch(convMenuPopup.isActive, (mine) => {
  if (!mine && convMenu.value) convMenu.value = null;
});

function onConvContext(conv: Conversation, x: number, y: number) {
  pendingDelete.value = null;
  convMenu.value = { x, y, conv };
  convMenuPopup.claim();
}

function closeConvMenu() {
  convMenuPopup.release();
  convMenu.value = null;
}

/** 菜单里的「删除」：关菜单 → 进二次确认（确认文案沿用既有弹窗）。 */
function onAskDeleteConvFromMenu() {
  const c = convMenu.value?.conv;
  closeConvMenu();
  if (!c) return;
  pendingDelete.value = c;
}

/** 菜单里的「置顶/取消置顶」：可直接执行（可逆、非破坏性，无需二次确认）。 */
async function onTogglePinConv() {
  const c = convMenu.value?.conv;
  closeConvMenu();
  if (!c) return;
  const next = !c.pinned;
  try {
    await chat.setConversationPinned(c.id, next);
  } catch (e) {
    app.toastError(e, next ? t("conv.pinFail") : t("conv.unpinFail"));
  }
}

async function confirmDeleteConv() {
  const c = pendingDelete.value;
  pendingDelete.value = null;
  if (!c) return;
  try {
    await chat.deleteConversation(c.id);
    app.toast(t("conv.toast.historyDeleted", { name: c.name }), "success");
  } catch (e) {
    app.toastError(e, t("common.deleteFail"));
  }
}

function closeFriendMenu() {
  friendMenuPopup.release();
  friendMenu.value = null;
}
useEventListener(document, "click", closeFriendMenu);
</script>

<template>
  <div ref="listRoot" class="ambient-canvas-child flex h-full flex-col bg-[var(--gosslan-list)]">
    <!-- 列表头：桌面为「标题行 + 搜索行」（画板 DesktopChats v2.2），移动端为顶栏 + 搜索行。
         2026-11-06 对稿：此前桌面把标题与搜索合并成一条 52px、与右栏 ChatHeader 对齐成一条
         连续横线，结果画板里那条「消息 / 通讯录」标题整个缺失。按画板恢复两行后，左栏比右栏
         头部高；两栏之间仍由 `.list` 的右边框保持竖向连续分隔线。 -->
    <!-- 移动端一级页顶栏（画板 v2.2，52px）：本人头像 + 页面标题 + 新建。
         与标题栏/设置页共用 `SelfAvatar`；桌面端不走这一块（rail + 标题栏已有各自入口）。 -->
    <div
      v-if="app.isMobile"
      class="flex shrink-0 items-center gap-2.5 border-b border-[var(--gosslan-divider)] pl-3 pr-1.5"
      :style="{ height: 'var(--gosslan-mobile-header-h)' }"
    >
      <button
        type="button"
        class="relative flex h-9 w-9 shrink-0 items-center justify-center"
        :aria-label="t('nav.me.openSettings', { status: app.present ? t('nav.me.online') : t('nav.me.offline') })"
        @click="emit('open-profile')"
      >
        <SelfAvatar class="h-[30px] w-[30px] rounded-full" />
        <span
          class="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full shadow-[0_0_0_2px_var(--gosslan-list)]"
          :class="app.present ? 'bg-[var(--gosslan-success)]' : 'bg-[var(--gosslan-status-offline)]'"
        ></span>
      </button>
      <h1
        class="min-w-0 flex-1 truncate text-page font-semibold leading-[23px] text-[var(--gosslan-text)]"
        :title="view === 'chats' ? t('nav.chats') : t('nav.contacts')"
      >
        {{ view === "chats" ? t("nav.chats") : t("nav.contacts") }}
      </h1>
      <div class="relative flex shrink-0 items-center">
        <DropdownMenuRoot :open="plusOpen" :modal="false" @update:open="onPlusOpen">
          <DropdownMenuTrigger as-child>
            <button
              class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary-active)] text-[var(--gosslan-on-primary)] shadow-[0_4px_12px_color-mix(in_srgb,var(--gosslan-primary)_28%,transparent)] transition hover:bg-[var(--gosslan-primary-hover)]"
              :title="t('conv.addTitle')" :aria-label="t('conv.addTitle')"
              @click.stop
            >
              <Icon name="plus" class="h-[19px] w-[19px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent align="end" :side-offset="0" :collision-padding="8" class="frost gosslan-menu z-[80]">
              <DropdownMenuItem class="gosslan-menu-item" @select="emit('open-add-friend')">
                <Icon name="user-plus" />
                {{ t("common.addFriend") }}
              </DropdownMenuItem>
              <DropdownMenuItem class="gosslan-menu-item" @select="emit('open-group')">
                <Icon name="users-round" />
                {{ t("common.createGroup") }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
    </div>

    <!-- 桌面列表头（画板 DesktopChats v2.2）：50px 标题行（17px 标题 + 32px 新建按钮）
         + 42px 搜索行。此前这里把标题和搜索合并成一条 52px，和右栏 ChatHeader 对齐成一条
         连续分隔线；但画板的左栏就是**两行**（标题行和搜索行分开），标题「消息」不能省。
         左栏因此比右栏头部高，两栏的分隔线仍是竖向连续的一条（`.list` 右边框）。 -->
    <div
      v-if="!app.isMobile"
      class="flex h-[50px] shrink-0 items-center pl-4 pr-3.5"
    >
      <h2
        class="min-w-0 flex-1 truncate text-heading font-semibold leading-[22px] text-[var(--gosslan-text)]"
        :title="view === 'chats' ? t('nav.chats') : t('nav.contacts')"
      >
        {{ view === "chats" ? t("nav.chats") : t("nav.contacts") }}
      </h2>
      <div class="relative flex shrink-0 items-center">
        <!-- 微信式：单个加号，点开下拉（添加好友 / 创建群聊）。
             开关/键盘/点外部由 Reka DropdownMenu 承担；互斥仍走全局 plusPopup。 -->
        <DropdownMenuRoot :open="plusOpen" :modal="false" @update:open="onPlusOpen">
          <DropdownMenuTrigger as-child>
            <!-- 画板：新建入口是主题色实底方块（32×32），不再是灰色图标。 -->
            <button
              class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary-active)] text-[var(--gosslan-on-primary)] shadow-[0_4px_12px_color-mix(in_srgb,var(--gosslan-primary)_28%,transparent)] transition hover:bg-[var(--gosslan-primary-hover)]"
              :title="t('conv.addTitle')" :aria-label="t('conv.addTitle')"
              @click.stop
            >
              <Icon name="plus" class="h-[19px] w-[19px]" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <!-- 右上角「+」下拉（用户 2026-09-12 晚 #9：「消息页右上角加号的弹出的下拉弹窗，
                 参考微信这边只是暗色模式；亮色就是配色的话，按现有的配色，但是样式参考微信」）
                 ⇒ 结构与外观统一走 `.gosslan-menu*`（与右键菜单同一套）。 -->
            <DropdownMenuContent
              align="end"
              :side-offset="0"
              :collision-padding="8"
              class="frost gosslan-menu z-[80]"
            >
              <DropdownMenuItem class="gosslan-menu-item" @select="emit('open-add-friend')">
                <Icon name="user-plus" />
                {{ t("common.addFriend") }}
              </DropdownMenuItem>
              <DropdownMenuItem class="gosslan-menu-item" @select="emit('open-group')">
                <Icon name="users-round" />
                {{ t("common.createGroup") }}
              </DropdownMenuItem>
              <!-- 「和自己聊天」入口已从 + 菜单移除（用户 2026-09-17）：通讯录里已有「自己」
                   （与好友同一条渲染路径、点击看自己的资料页），两个入口重复了。 -->
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
    </div>

    <!-- 搜索行（桌面 42px：搜索壳 36px + 4px 下留白，画板 searchWrap `0 12px 4px`）。
         搜索壳高度按既有判据固定 h-9（36px），画板标注 34px —— 差 2px 是判据妥协，
         不为这 2px 去动 composerInteraction.test.ts 的 36/40 白名单。 -->
    <div
      class="flex shrink-0 items-center px-3"
      :class="app.isMobile ? 'py-1.5' : 'h-10 pb-1'"
    >
      <!-- 搜索框底色必须用 --gosslan-field 而不是 panel：
           暗色下 panel(#1e293b) 与本栏 list(#1e293b) 是同一个值，输入框会"消失"；
           field 在两套主题里都与所在栏拉开一档。 -->
      <div
        class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-field)] px-2.5 transition"
      >
        <Icon name="search" class="h-[15px] w-[15px] shrink-0 text-[var(--gosslan-text-2)]" />
        <input
          ref="searchInput"
          v-model="keyword"
          :maxlength="MAX_SEARCH_KEYWORD_CHARS"
          enterkeyhint="search"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          class="w-full bg-transparent text-small placeholder:text-[var(--gosslan-placeholder)] outline-none focus:border-transparent"
          :placeholder="
            view === 'chats'
              ? app.isMobile ? t('conv.searchLong') : t('common.search')
              : t('common.searchContacts')
          "
          @keydown.enter.prevent="onSearchEnter"
          @compositionstart="ime.onStart"
          @compositionend="ime.onEnd"
        />
      </div>
    </div>

    <!-- 底部内边距：移动端底部导航是 `fixed bottom-0`，不给列表留位就会永久盖住最后一行，
         而且滚到底也露不出来（聊天区早有同样的补偿，这里此前漏了）。
         键盘弹出时导航收起，补偿随之换成键盘补量（由外层容器负责）。
         ⚠️ 条高读 `--gosslan-mobile-tabbar-h`（家 = `src/style.css`），与 `ResponsiveLayout` 主内容区
         那份占位同源 —— 这里再抄一个字面量，改一处就会让另一处的最后一行被压住（判据 ㊻）。 -->
    <div
      class="scrollbar-both flex-1 select-none overflow-y-auto"
      :class="[
        viewFadeClass,
        app.isMobile && !app.keyboardOpen ? 'pb-[calc(var(--gosslan-mobile-tabbar-h)+env(safe-area-inset-bottom))]' : '',
      ]"
    >
      <template v-if="view === 'chats'">
        <ConversationListItem
          v-for="c in listConversations"
          :key="c.id"
          v-memo="[c.last_ts, c.last_msg, c.unread, c.avatar, c.name, chat.activeConv === c.id, isOnline(c.id), chat.friends.length, chat.groups.length, dropRowId === c.id, currentLocale()]"
          :conv="c"
          :active="chat.activeConv === c.id"
          :online="isOnline(c.id)"
          :drop-active="dropRowId === c.id"
          @open="openConv"
          @context="onConvContext"
        />
        <!-- 空态（用户需求 #7）：「兜底的界面，也不一定是要加好友。如果有好友的情况下，
             就会有一个『发起聊天』，然后去选好友。如果一个好友都没有的话，就是发现好友。」
             ⇒ 有好友时主行动 = 发起聊天（切到通讯录选人），另有次行动 = 发现好友；
                一个好友都没有时主行动 = 发现好友（去搜索添加）。
             搜索无结果时不给这些（那是"换个词"的场景，不是"没人"）。 -->
        <!-- 移动端首启空态（画板 MobileEmpty）：整屏，品牌底盘 + 说明 + 主/次动作 + 发现设备卡 + 三条特性。 -->
        <div
          v-if="app.isMobile && listConversations.length === 0 && !query.trim()"
          class="flex min-h-full flex-col items-center justify-center px-9 pb-10 text-center"
        >
          <div
            class="mb-4 flex h-[68px] w-[68px] items-center justify-center rounded-[var(--gosslan-radius-xl)] bg-[var(--gosslan-panel)] shadow-[inset_0_0_0_1px_var(--gosslan-border)]"
          >
            <img :src="appMark" class="h-14 w-14" alt="" aria-hidden="true" draggable="false" />
          </div>
          <h2 class="text-title-lg font-semibold leading-[26px] text-[var(--gosslan-text)]">{{ t("conv.noConversation") }}</h2>
          <p class="mt-2 text-fine leading-[19px] text-[var(--gosslan-text-2)]">
            {{ t("conv.mobileEmptyHint") }}<br />
            <b class="font-medium text-[var(--gosslan-text)]">{{ t("layout.emptySubtitle") }}</b>
          </p>
          <div class="mt-5 w-full max-w-[300px]">
            <PrimaryBtn v-if="chat.friends.length" size="large" class="w-full" @click="emit('update:view', 'contacts')">
              {{ t("conv.startChat") }}
            </PrimaryBtn>
            <PrimaryBtn v-else size="large" class="w-full" @click="emit('open-add-friend')">
              <Icon name="plus" class="h-4 w-4" />
              {{ t("common.addFriend") }}
            </PrimaryBtn>
            <button
              type="button"
              class="mt-1 h-9 w-full text-small font-medium text-[var(--gosslan-primary)]"
              @click="emit('open-group')"
            >
              {{ t("common.createGroup") }}
            </button>
          </div>
          <div
            class="mt-4 flex w-full max-w-[300px] items-center gap-2.5 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-panel)] px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--gosslan-border)]"
          >
            <span
              class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--gosslan-success)_14%,transparent)] text-[var(--gosslan-success)]"
            >
              <Icon name="radar" class="h-4 w-4" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-small font-medium text-[var(--gosslan-text)]" :title="t('conv.discovering')">{{ t("conv.discovering") }}</span>
              <span class="mt-0.5 flex items-center gap-1 text-caption text-[var(--gosslan-text-2)]">
                <span class="h-1 w-1 rounded-full bg-[var(--gosslan-success)]" aria-hidden="true"></span>
                {{ t("layout.chipDevices", { n: chat.peers.length }) }}
              </span>
            </span>
          </div>
          <div class="mt-5 flex items-center gap-2.5 text-caption text-[var(--gosslan-text-2)]">
            <span>{{ t("layout.chipPureP2p") }}</span>
            <span class="h-2 w-px bg-[var(--gosslan-border)]" aria-hidden="true"></span>
            <span>{{ t("layout.chipE2ee") }}</span>
            <span class="h-2 w-px bg-[var(--gosslan-border)]" aria-hidden="true"></span>
            <span>{{ t("layout.chipServerless") }}</span>
          </div>
        </div>

        <StateBlock
          v-if="listConversations.length === 0 && !(app.isMobile && !query.trim())"
          kind="empty"
          :title="t('conv.noConversation')"
        >
          <!-- 空态下一步（用户 2026-09-12 晚）：**有好友 → 发起聊天**；**一个好友都没有 →
               只有「添加好友」**（原先还并列一个「发现好友」，与本条冲突，已去掉）。
               两个入口都带一句说明文字：空态只陈述"没有会话"会让人不知所措。 -->
          <!-- C3（2026-11-06 裁决）：左栏与中央是同一套 CTA 规格，只是容器不同：
               左栏 narrow 用 PrimaryBtn size=xs，中央用 size=large；文案与层级一致，入口一个不删。 -->
          <template v-if="!query.trim()">
            <PrimaryBtn v-if="chat.friends.length" size="xs" @click="emit('update:view', 'contacts')">
              {{ t("conv.startChat") }}
            </PrimaryBtn>
            <PrimaryBtn v-else size="xs" @click="emit('open-add-friend')">
              {{ t("common.addFriend") }}
            </PrimaryBtn>
            <!-- 好友读取失败时这里不再复述同一句诊断：中央空态已经讲一次（同屏一个状态只出现一次）。 -->
            <span v-if="!chat.friendsError" class="max-w-[220px] text-caption leading-relaxed">
              {{
                chat.friends.length
                  ? t("conv.emptyHintHasFriends")
                  : t("conv.emptyHintNoFriends")
              }}
            </span>
          </template>
        </StateBlock>
      </template>

      <template v-else>
        <!-- 通讯录固定首项：新的朋友（好友申请入口，微信式），点击在右侧打开申请页 -->
        <button
          class="flex h-[56px] w-full cursor-pointer items-center gap-3 px-3 transition-colors"
          :class="props.requestsActive ? 'bg-[var(--gosslan-list-active)]' : 'hover:bg-[var(--gosslan-list-hover)]'"
          @click="emit('open-requests')"
        >
          <span class="relative shrink-0">
            <span class="flex h-10 w-10 items-center justify-center rounded-[var(--gosslan-avatar-radius)] brand-surface text-white">
              <Icon name="user-plus" class="h-5 w-5" />
            </span>
            <UnreadBadge
              v-if="chat.pendingRequests.length"
              :count="chat.pendingRequests.length"
              class="absolute -right-1 -top-1"
            />
          </span>
          <span class="min-w-0 flex-1 text-left">
            <span class="block truncate text-body leading-5 text-[var(--gosslan-text)]" :title="t('conv.newFriends')">{{ t("conv.newFriends") }}</span>
            <span class="block truncate text-meta leading-5 text-[var(--gosslan-text-2)]" :title="chat.pendingRequests.length ? t('conv.pendingRequests', { n: chat.pendingRequests.length }) : t('friend.request.empty')">
              {{ chat.pendingRequests.length ? t("conv.pendingRequests", { n: chat.pendingRequests.length }) : t("friend.request.empty") }}
            </span>
          </span>
        </button>
        <!-- 自己（用户 2026-09-17）：不再做成钉在「新的朋友」下面的特殊行 ——
             它作为一条**伪好友**进 `filteredFriends` / `friendGroups`，与好友同一套
             渲染/排序/搜索/点击看资料的路径（见脚本里的 `selfFriend`）。 -->
        <!-- 搜索：平铺（用户正在找某个人，分组会把结果切碎） -->
        <template v-if="query.trim()">
          <FriendListItem
            v-for="f in filteredFriends"
            :key="f.device_id"
            v-memo="[f.nickname, f.avatar, f.online, linkOf(f.device_id), props.activeFriendId === f.device_id]"
            :friend="f"
            :link="linkOf(f.device_id)"
            :is-self="isSelfRow(f.device_id)"
            :active="props.activeFriendId === f.device_id"
            compact
            @open="openFriend"
            @context="onFriendContext"
          />
        </template>
        <!-- 浏览：按首字母分组，组头 + 小头像行 -->
        <template v-else>
          <template v-for="g in friendGroups" :key="g.letter">
            <div
              class="gosslan-sticky-veil sticky top-0 z-10 px-3 py-1 text-caption font-medium text-[var(--gosslan-text-2)]"
            >
              {{ g.letter }}
            </div>
            <FriendListItem
              v-for="f in g.items"
              :key="f.device_id"
              v-memo="[f.nickname, f.avatar, f.online, linkOf(f.device_id), props.activeFriendId === f.device_id]"
              :friend="f"
              :link="linkOf(f.device_id)"
              :is-self="isSelfRow(f.device_id)"
              :active="props.activeFriendId === f.device_id"
              compact
              @open="openFriend"
              @context="onFriendContext"
            />
          </template>
        </template>
        <!-- A 档（INV-P36）：读失败与"真的没有好友"是两个值。成功过就以数据为准，
             只有"一次都没读到 + 有失败记录"才画错误档（同 `todoRowsLoadState` 的三态口径）。 -->
        <StateBlock
          v-if="friendsLoadFailed"
          kind="error"
          :title="t('conv.contactsLoadFailed')"
          :detail="t('conv.contactsLoadFailedHint')"
          :retry-label="t('common.retry')"
          @retry="chat.refreshFriends()"
        />
        <StateBlock
          v-else-if="filteredFriends.length === 0"
          kind="empty"
          :title="query.trim() ? t('conv.noMatchContact') : t('conv.noFriends')"
        >
          <PrimaryBtn v-if="!query.trim()" size="xs" @click="emit('open-add-friend')">
            {{ t("common.addFriend") }}
          </PrimaryBtn>
        </StateBlock>
      </template>
    </div>

    <!-- 页脚任务入口（用户 2026-10-25：药丸总挡界面，入口收进列表页脚）。
         放在滚动容器**之外**（不随列表滚走），只在会话/联系人列表这一栏出现。
         移动端 TabBar 是 `fixed bottom-0`，页脚必须整体上抬到它之上，否则会被盖住。 -->
    <div
      class="conv-footer-safe shrink-0 select-none border-t border-[var(--gosslan-divider)] text-caption text-[var(--gosslan-text-2)]"
    >
      <!-- 页脚 = 整行任务入口（画板 listFoot 40px）：图标 + 名称 + 未完成数 + 版本 + chevron。
           版本号仍留在这一行（判据要求页脚可见 vX.Y.Z，设置「关于」是第二处）。 -->
      <button
        type="button"
        data-task-entry
        class="tap-safe flex h-10 w-full items-center gap-2 px-3 text-left transition hover:bg-[var(--gosslan-list-hover)]"
        :aria-label="taskCount > 0 ? t('task.open', { n: taskCount }) : t('task.title')"
        :title="taskCount > 0 ? t('task.open', { n: taskCount }) : t('task.title')"
        @click="app.openTaskCenter"
      >
        <Icon name="list-checks" class="h-4 w-4 shrink-0" />
        <span class="shrink-0 font-medium">{{ t("task.center") }}</span>
        <span
          v-if="taskCount > 0"
          data-task-count
          class="rounded-full bg-[var(--gosslan-hover)] px-1.5 text-caption font-semibold leading-4 tabular-nums text-[var(--gosslan-text)]"
        >
          {{ taskCount }}
        </span>
        <span class="flex-1"></span>
        <span class="shrink-0 tabular-nums opacity-50" :title="`v${version}`">v{{ version }}</span>
        <Icon name="chevron-right" class="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
    </div>


    <ConversationContextMenu
      v-if="convMenu"
      :x="convMenu.x"
      :y="convMenu.y"
      :pinned="convMenu.conv.pinned"
      @close="closeConvMenu"
      @toggle-pin="onTogglePinConv"
      @delete="onAskDeleteConvFromMenu"
    />

    <FriendContextMenu
      v-if="friendMenu"
      :x="friendMenu.x"
      :y="friendMenu.y"
      @chat="startChatWithFriend"
      @close="closeFriendMenu"
      @confirm="onAskDeleteFriend"
    />

    <!-- 二次确认：删除好友（保留聊天记录，可重新添加） -->
    <ConfirmDialog
      :open="pendingRemoveFriend !== null"
      :title="t('common.deleteFriend')"
      :confirm-label="t('common.deleteFriend')"
      @cancel="pendingRemoveFriend = null"
      @confirm="confirmDeleteFriend"
    >
      <p class="text-sm text-[var(--gosslan-text)]">
        {{ t("conv.removeFriend.bodyPrefix") }}<span class="font-medium text-[var(--gosslan-danger-ink)]">{{ pendingRemoveFriend?.nickname }}</span>{{ t("conv.removeFriend.bodySuffix") }}
      </p>
      <ul class="space-y-1 text-xs text-[var(--gosslan-text-2)]">
        <li>· {{ t("conv.removeFriend.item1") }}</li>
        <li>· {{ t("conv.removeFriend.item2") }}</li>
        <li>· {{ t("conv.removeFriend.item3") }}</li>
      </ul>
    </ConfirmDialog>

    <!-- 二次确认：删除聊天记录（仅本地清理，不影响对方） -->
    <ConfirmDialog
      :open="pendingDelete !== null"
      :title="t('conv.delete')"
      :confirm-label="t('common.delete')"
      @cancel="pendingDelete = null"
      @confirm="confirmDeleteConv"
    >
      <p class="text-sm text-[var(--gosslan-text)]">
        {{ t("conv.delete.bodyPrefix") }}<span class="font-medium text-[var(--gosslan-danger-ink)]">{{ pendingDelete?.name }}</span>{{ t("conv.delete.bodySuffix") }}
      </p>
      <ul class="space-y-1 text-xs text-[var(--gosslan-text-2)]">
        <li>· {{ t("conv.delete.item1") }}</li>
        <li>· {{ t("conv.delete.item2") }}</li>
        <li>· {{ t("conv.delete.item3") }}</li>
      </ul>
    </ConfirmDialog>
  

    <!-- 拖拽发送的二次确认（左栏落点；与聊天面板共用同一个组件与状态机） -->
    <DropSendConfirm
      :open="!!dropPending"
      :body="dropBody"
      :items="dropItems"
      @cancel="drop.cancel"
      @confirm="drop.confirm"
    />
  </div>
</template>
