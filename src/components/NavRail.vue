<script setup lang="ts">
import { ref, watch } from "vue";
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
import { MoreHorizontal, Moon, ScrollText, Settings, Sun } from "lucide-vue-next";
import { motion, useReducedMotion } from "@/utils/motion";
import UnreadBadge from "@/components/UnreadBadge.vue";
import NavIcon from "@/components/ui/NavIcon.vue";
import SelfAvatar from "@/components/SelfAvatar.vue";
import { t } from "@/i18n";

const NAV_STATES = ["chats", "contacts", "links", "favorites", "me"] as const;
type NavState = (typeof NAV_STATES)[number];

defineProps<{
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
const reducedMotion = useReducedMotion();

// ---------------- 二级菜单（设置 / 运行日志 收进这里，用户 2026-09-17） ----------------
// 惯用法与 ConversationList 的「+」菜单完全一致（useExclusivePopup 互斥）；键盘/焦点/外点交给 Reka。
const morePopup = useExclusivePopup("rail-more");
const moreOpen = ref(false);

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
    class="hidden shrink-0 select-none flex-col items-center bg-[var(--gosslan-rail)] py-3 desktop:md:flex"
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

    <!-- 中部：聊天 / 通讯录（用户 2026-09-12 晚反馈：
         「整体参考图就是微信最左侧栏里的图标风格。选中态是实心的，而不是框框变颜色。
           现在上面的『聊天』和『通讯录』这两个图标不好看，参考微信。」）
         ⇒ 两点改动：
         ① **选中态改为实心**（图标本身 fill=currentColor + 主题色），不再用底色块；
         ② 「聊天」「通讯录」改为**自绘 SVG**（微信式造型 + 统一 1.9 线宽 / 22px 视觉盒）：
            · 聊天 = 带左下小尾巴的圆角气泡；
            · 通讯录 = 圆角卡片内镂空一个人像。
            造型数据与"这四枚为什么必须自绘"只有一个家：`components/ui/navIconPaths.ts`。 -->
    <div class="mt-5 flex flex-col items-center gap-2">
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
        <motion.span
          v-if="navState === 'chats'"
          layout-id="rail-active"
          class="pointer-events-none absolute inset-0 rounded-[var(--gosslan-radius-lg)] bg-[color-mix(in_srgb,var(--gosslan-primary)_13%,transparent)]"
          :transition="reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 480, damping: 36, mass: 0.7 }"
        />
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
        <motion.span
          v-if="navState === 'contacts'"
          layout-id="rail-active"
          class="pointer-events-none absolute inset-0 rounded-[var(--gosslan-radius-lg)] bg-[color-mix(in_srgb,var(--gosslan-primary)_13%,transparent)]"
          :transition="reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 480, damping: 36, mass: 0.7 }"
        />
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
        <motion.span
          v-if="navState === 'favorites'"
          layout-id="rail-active"
          class="pointer-events-none absolute inset-0 rounded-[var(--gosslan-radius-lg)] bg-[color-mix(in_srgb,var(--gosslan-primary)_13%,transparent)]"
          :transition="reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 480, damping: 36, mass: 0.7 }"
        />
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
        <motion.span
          v-if="navState === 'links'"
          layout-id="rail-active"
          class="pointer-events-none absolute inset-0 rounded-[var(--gosslan-radius-lg)] bg-[color-mix(in_srgb,var(--gosslan-primary)_13%,transparent)]"
          :transition="reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 480, damping: 36, mass: 0.7 }"
        />
        <NavIcon name="links" :active="navState === 'links'" />
      </button>
    </div>

    <!-- 底部：深浅色切换 + 更多（设置/运行日志收进**二级菜单**，用户 2026-09-17） -->
    <div class="mt-auto flex flex-col items-center gap-2">
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
