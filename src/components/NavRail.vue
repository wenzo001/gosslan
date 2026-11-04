<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "reka-ui";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { useExclusivePopup } from "@/composables/useExclusivePopup";
import { MoreHorizontal, Moon, ScrollText, Settings, Sun, Download } from "lucide-vue-next";
import UnreadBadge from "@/components/UnreadBadge.vue";
import NavIcon from "@/components/ui/NavIcon.vue";
import SelfAvatar from "@/components/SelfAvatar.vue";
import { t } from "@/i18n";
import { updater } from "@/updater/instance";
import { storageSet } from "@/utils/safeStorage";

const NAV_STATES = ["chats", "contacts", "links", "favorites", "me"] as const;
type NavState = (typeof NAV_STATES)[number];

/** 桌面 rail 的四个按钮顺序（模板里也是这个顺序）：药丸下标按它算。 */
const RAIL_ORDER: NavState[] = ["chats", "contacts", "favorites", "links"];
/** 相邻两项的步距 = 按钮 `h-11`(44px) + 列 `gap-2`(8px)。两处一致，别只改一边。 */
const RAIL_ITEM_STRIDE = 52;

const props = defineProps<{
  /** 当前导航状态——**单一数据源**，所有按钮互斥高亮由这一个值决定。
   * 取代之前分散的 `view` + `favoritesOpen` 两个独立 ref（那两者会同时为真导致"多选"）。 */
  navState: NavState;
  /** 正在打开独立窗口时的忙碌态（单飞/防抖状态在 `useWindowLauncher` 里，见该文件）。 */
  settingsOpening?: boolean;
  logsOpening?: boolean;
}>();
const emit = defineEmits<{
  (e: "update:navState", v: NavState): void;
  (e: "open-settings"): void;
  (e: "open-logs"): void;
}>();

const app = useAppStore();
const chat = useChatStore();

/**
 * 药丸要落到的行下标（`me` 这类不在 rail 上的状态 = -1 ⇒ 药丸隐藏）。
 * 用**一个常驻节点 + transform**，而不是 motion-v 共享布局：共享布局 `v-if` 换节点时
 * 每次位移都跑一整段弹簧（~250ms），而左列内容早就切完了 ⇒ 用户看到"指示条慢半拍"。
 * CSS transition 在快速连点时会**从当前计算值就地改目标**，不排队补播中间项。
 */
const pillIndex = computed(() => RAIL_ORDER.indexOf(props.navState));

// ---------------- 二级菜单（设置 / 运行日志 收进这里，用户 2026-09-17） ----------------
// 惯用法与 ConversationList 的「+」菜单完全一致（useExclusivePopup 互斥）；键盘/焦点/外点交给 Reka。
const morePopup = useExclusivePopup("rail-more");
const moreOpen = ref(false);

/** 主窗口启动时已做过一次后台检查；有可升级版本时在侧栏底部提示。 */
const updateInfo = computed(() => {
  const state = updater.state;
  if (state.phase !== "available" && state.phase !== "ready") return null;
  if (!state.info || state.dismissedVersion === state.info.version) return null;
  return state.info;
});

function openUpdate() {
  storageSet("gosslan:settings-section", "about");
  emit("open-settings");
}

watch(morePopup.isActive, (mine) => {
  if (!mine && moreOpen.value) moreOpen.value = false;
});

function onMoreOpen(open: boolean) {
  moreOpen.value = open;
  if (open) morePopup.claim();
  else morePopup.release();
}
</script>

<template>
  <!-- 微信式窄导航栏：顶部本人头像 + 中部导航图标 + 底部偏好；
       选中项仅图标变色（主题色），不改底色，与微信一致 -->
  <aside
    class="glass-1 hidden shrink-0 select-none flex-col items-center py-3 desktop:md:flex"
    :style="{ width: 'var(--gosslan-rail-w)' }"
  >
    <!-- 顶部：本人头像（点开设置/我）；在线点放在 overflow-hidden 按钮外层，避免被裁切 -->
    <div class="relative shrink-0">
      <button
        class="block transition hover:opacity-90"
        :class="settingsOpening ? 'opacity-60' : ''"
        :aria-busy="settingsOpening"
        :title="app.present ? t('nav.me.online') : t('nav.me.offline')"
        :aria-label="t('nav.me.openSettings', { status: app.present ? t('nav.me.online') : t('nav.me.offline') })"
        @click="emit('open-settings')"
      >
        <SelfAvatar class="h-10 w-10 rounded-[var(--gosslan-avatar-radius)]" />
      </button>
      <!-- 本人在线状态点 -->
      <span
        class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--gosslan-rail)]"
        :class="app.present ? 'bg-[var(--gosslan-success)]' : 'bg-[var(--gosslan-status-offline)]'"
      ></span>
    </div>

    <!-- 中部：聊天 / 通讯录 / 收藏 / 链接（用户 2026-10-22 裁决统一图标库）：
         四枚全部来自 `lucide-vue-next`（映射在 `components/ui/navIcons.ts`），不再自绘；
         选中态 = 描边加粗 + 药丸底 + 主题色，样式唯一出口是 `style.css` 的 `.nav-glyph*`。
         药丸是**一个常驻节点**（不随选中项重建），位置用 transform 表达 ⇒ 与左列内容
         共用同一组时长/缓动（`--gosslan-nav-switch-*`），不会再"内容切完、药丸才滑到"。 -->
    <div class="relative mt-5 flex flex-col items-center gap-2">
      <span
        aria-hidden="true"
        data-rail-pill
        class="rail-active-pill pointer-events-none absolute inset-x-0 top-0 h-11 rounded-[var(--gosslan-radius-lg)] bg-[color-mix(in_srgb,var(--gosslan-primary)_13%,transparent)]"
        :style="{
          transform: `translateY(${pillIndex * RAIL_ITEM_STRIDE}px)`,
          opacity: pillIndex >= 0 ? 1 : 0,
        }"
      />
      <button
        class="nav-glyph-btn relative flex h-11 w-11 items-center justify-center rounded-[var(--gosslan-radius-lg)] transition"
        :class="navState === 'chats'
          ? 'text-[var(--gosslan-rail-text-active)]'
          : 'text-[var(--gosslan-rail-text)] hover:bg-[var(--gosslan-rail-hover)]'"
        :data-active="navState === 'chats'"
        :title="t('nav.chats')"
        :aria-label="chat.totalUnread > 0 ? t('nav.chats.unread', { n: chat.totalUnread }) : t('nav.chats')"
        @click="emit('update:navState', 'chats')"
      >
        <NavIcon name="chats" :active="navState === 'chats'" />
        <UnreadBadge
          v-if="chat.totalUnread > 0"
          :count="chat.totalUnread"
          class="absolute -right-0.5 -top-0.5"
        />
      </button>
      <button
        class="nav-glyph-btn relative flex h-11 w-11 items-center justify-center rounded-[var(--gosslan-radius-lg)] transition"
        :class="navState === 'contacts'
          ? 'text-[var(--gosslan-rail-text-active)]'
          : 'text-[var(--gosslan-rail-text)] hover:bg-[var(--gosslan-rail-hover)]'"
        :data-active="navState === 'contacts'"
        :title="t('nav.contacts')"
        :aria-label="chat.pendingRequests.length ? t('nav.contacts.pending', { n: chat.pendingRequests.length }) : t('nav.contacts')"
        @click="emit('update:navState', 'contacts')"
      >
        <NavIcon name="contacts" :active="navState === 'contacts'" />
        <UnreadBadge
          v-if="chat.pendingRequests.length"
          :count="chat.pendingRequests.length"
          class="absolute -right-0.5 -top-0.5"
        />
      </button>
      <!-- 收藏（微信最左侧栏就是这个位置）。 -->
      <button
        class="nav-glyph-btn relative flex h-11 w-11 items-center justify-center rounded-[var(--gosslan-radius-lg)] transition"
        :class="navState === 'favorites'
          ? 'text-[var(--gosslan-rail-text-active)]'
          : 'text-[var(--gosslan-rail-text)] hover:bg-[var(--gosslan-rail-hover)]'"
        :data-active="navState === 'favorites'"
        :title="t('nav.favorites')"
        :aria-label="t('nav.favorites')"
        @click="emit('update:navState', navState === 'favorites' ? 'chats' : 'favorites')"
      >
        <NavIcon name="favorites" :active="navState === 'favorites'" />
      </button>
      <!-- 外部链接：点开把左列切成「链接」列表（用户 2026-09-17）。图标用**指南针**造型
           （用户指定：链接入口要有"探索/发现"的指向感，而不是一条链子）。 -->
      <button
        class="nav-glyph-btn relative flex h-11 w-11 items-center justify-center rounded-[var(--gosslan-radius-lg)] transition"
        :class="navState === 'links'
          ? 'text-[var(--gosslan-rail-text-active)]'
          : 'text-[var(--gosslan-rail-text)] hover:bg-[var(--gosslan-rail-hover)]'"
        :data-active="navState === 'links'"
        :title="t('nav.links')"
        :aria-label="t('nav.links')"
        @click="emit('update:navState', 'links')"
      >
        <!-- 指南针：链接入口要"探索/发现"的指向感（用户 2026-09-17 指定）。 -->
        <NavIcon name="links" :active="navState === 'links'" />
      </button>
    </div>

    <!-- 底部：深浅色切换 + 更多（设置/运行日志收进**二级菜单**，用户 2026-09-17） -->
    <div class="mt-auto flex flex-col items-center gap-2">
      <button
        v-if="updateInfo"
        class="relative flex h-11 w-11 items-center justify-center rounded-[var(--gosslan-radius-lg)] text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-rail-hover)]"
        :title="t('nav.updateAvailable', { version: updateInfo.version })"
        :aria-label="t('nav.updateAvailable', { version: updateInfo.version })"
        @click="openUpdate"
      >
        <Download class="h-5 w-5" />
        <span class="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[var(--gosslan-primary)]"></span>
      </button>
      <button
        class="flex h-11 w-11 items-center justify-center rounded-[var(--gosslan-radius-lg)] text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-rail-hover)]"
        :title="app.dark ? t('nav.lightMode') : t('nav.darkMode')" :aria-label="app.dark ? t('nav.lightMode') : t('nav.darkMode')"
        @click="app.toggleDark()"
      >
        <Sun v-if="app.dark" class="h-5 w-5" />
        <Moon v-else class="h-5 w-5" />
      </button>
      <div class="relative">
        <DropdownMenuRoot :open="moreOpen" :modal="false" @update:open="onMoreOpen">
          <DropdownMenuTrigger as-child>
            <button
              class="flex h-11 w-11 items-center justify-center rounded-[var(--gosslan-radius-lg)] text-[var(--gosslan-rail-text)] transition hover:bg-[var(--gosslan-rail-hover)]"
              :title="t('nav.more')" :aria-label="t('nav.more')"
              @click.stop
            >
              <MoreHorizontal class="h-5 w-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <!-- 二级菜单：向右弹出（rail 只有 64px 宽，向下会顶出屏幕） -->
            <DropdownMenuContent
              side="right"
              align="end"
              :side-offset="8"
              :collision-padding="8"
              class="frost gosslan-menu z-[80]"
            >
              <DropdownMenuItem
                class="gosslan-menu-item"
                :aria-busy="settingsOpening"
                @select="emit('open-settings')"
              >
                <Settings class="h-4 w-4" />
                {{ t("nav.settings") }}
              </DropdownMenuItem>
              <DropdownMenuItem
                class="gosslan-menu-item"
                :aria-busy="logsOpening"
                @select="emit('open-logs')"
              >
                <ScrollText class="h-4 w-4" />
                {{ t("nav.logs") }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
      </div>
    </div>
  </aside>
</template>
