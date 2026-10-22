<script setup lang="ts">
import Spinner from "@/components/ui/Spinner.vue";
/**
 * 「搜索聊天记录」结果页（用户需求 2026-09-12 晚）：
 * 「搜索并点击回车后，弹出一个框。样式参考微信，但配色/圆角按本项目的约束标准。」
 *
 * 布局对齐微信 macOS 的「搜索聊天记录」窗口：
 *   · 顶部：关键词输入框（带清除）+「发送人 / 日期」两个筛选入口；
 *   · 左栏：命中的会话（头像 / 名称 / 最新命中时间 / 命中片段 / 共 N 条相关聊天记录）；
 *   · 右栏：选中会话的命中消息 + 顶部「共 N 条与"关键词"的聊天记录」+「进入聊天 >」。
 *
 * 与「会话列表搜索框」的分工：列表里那点输入是**即时过滤**（联系人 + 内容命中的会话摘要，
 * 每会话一条），回车才进这里 —— 这里是**逐条命中**的结果页，可以一直往下看、可以筛选、
 * 可以跳到那一条。微信也是这个分工（输入即提示，回车进结果页）。
 *
 * 配色/圆角/间距一律用项目 token（`--gosslan-*`）与 `.gosslan-menu*`/`SettingsGroup` 同族样式，
 * 不引入微信的具体色值 —— 这是用户明确要求「按本项目约束标准」的部分。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { useDebounceFn } from "@vueuse/core";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "reka-ui";
import { ChevronRight, Search } from "lucide-vue-next";
import { X } from "@/components/ui/icons";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";
import { currentLocale, t } from "@/i18n";
import BaseModal from "@/components/BaseModal.vue";
import MessageAvatar from "@/components/message/MessageAvatar.vue";
import { highlightText } from "@/utils/highlight";
import { fmtTimeDivider } from "@/utils/time";
import {
  SEARCH_DATE_PRESETS,
  dateRangeFor,
  hitSnippet,
  senderOptionsFrom,
  totalHits,
  type SearchDatePreset,
  type SenderOption,
} from "@/utils/chatSearch";
import { chatSearchQueryOptions, type ChatSearchParams } from "@/utils/chatSearchQuery";
import { MAX_SEARCH_KEYWORD_CHARS } from "@/utils/validation";
import StateBlock from "@/components/ui/StateBlock.vue";
import { errorText } from "@/composables/useErrorText";
import type { ChatSearchGroup, ChatSearchMessage } from "@/types";
import { previewBody } from "@/utils/messages";

const props = defineProps<{ open: boolean; initialKeyword?: string }>();
const emit = defineEmits<{
  (e: "close"): void;
  /** 跳到命中的那一条（父组件负责开会话 + 定位） */
  (e: "open-conversation", payload: { convId: string; msgId: string }): void;
}>();

/**
 * 搜索结果里一行显示的文本（INV-P24 第 2 条）。
 *
 * ⚠️ 这里**绝不能**直接铺 `content`：SQL 检索的是载荷原文，而图片 / 文件 / 合并转发 /
 * 任务 / 投票 / 公告这六种 kind 的载荷就是 JSON —— 以前只把"本机不认识的 kind"换成了
 * 占位文案（887477e），认识的那六种照样把 `{"title":"…","sha256":"…"}` 摆给用户看
 * （用户 2026-10-09：「搜索列表显示的都是 json」）。
 * 现在与气泡、会话列表、系统通知共用 `previewBody` 那唯一一份「kind → 人话」。
 *
 * 第三个参数传 0 = **不截断**：会话列表要截 30 字，而这里要在正文里定位关键词
 * （`hitSnippet` 与 `highlightText` 都按关键词找），截了就没得定位了。
 */
function cellText(m?: ChatSearchMessage): string {
  if (!m) return "";
  return previewBody(m.kind, m.content, 0);
}

const app = useAppStore();
/** 输入法守卫：拼音候选里按回车是选字，不该被当成"重新搜索"（与发送键同一套判定） */
const ime = useImeEnterGuard();

const keyword = ref("");
/**
 * 防抖后的关键词 —— 它才是 query key 的一部分：
 * 输入连打时不会每个字符都扫一遍库，回车 / 打开弹窗则直接跳到当前值（不经过防抖）。
 */
const debouncedKeyword = ref("");
const activeConvId = ref<string | null>(null);

/** 筛选条件。筛选项与日期都走后端（命中总数必须按当前筛选算，不能只筛已加载的那几条）。 */
const senderFilter = ref<string | null>(null);
const datePreset = ref<SearchDatePreset>("all");
const senderMenuOpen = ref(false);
const dateMenuOpen = ref(false);

/**
 * 发送人候选：**始终取自"不带发送人筛选"的那次结果**。
 * 否则一旦选了某个人，候选里就只剩他自己，用户无法切换（这是设计，不是漏考虑）。
 */
const senderOptions = ref<SenderOption[]>([]);

/** 「发送人」按钮上的文字：未筛选显示"发送人"，已筛选显示那个人的名字。 */
const senderName = computed(
  () => senderOptions.value.find((o) => o.id === senderFilter.value)?.name ?? null,
);

/**
 * 检索结果交给 TanStack Query（旧实现手写 `seq` + `searching` + `searchError` + 防抖）：
 * · 关键词 / 发送人 / 日期三件都在 key 里 ⇒ 旧响应只会写回它自己的键，连打时不可能覆盖新结果；
 * · `enabled` 跟 open + 非空关键词 ⇒ 关着或不搜时不打 IPC；
 * · 换筛选时旧结果继续显示（keepPreviousData），失败有 error 状态可渲染。
 */
const searchParams = computed<ChatSearchParams>(() => ({
  keyword: debouncedKeyword.value,
  senderId: senderFilter.value,
  preset: datePreset.value,
}));

const searchQuery = useQuery(
  computed(() => ({
    ...chatSearchQueryOptions(searchParams.value, (p) => {
      const range = dateRangeFor(p.preset);
      return api.searchChatHistory({
        keyword: p.keyword,
        senderId: p.senderId,
        sinceMs: range.sinceMs,
        untilMs: range.untilMs,
      });
    }),
    enabled: props.open && debouncedKeyword.value.length > 0,
  })),
);

/** 渲染用的结果：关着 / 关键词空 / 检索失败都不铺旧数据（旧实现失败时会清空 groups）。 */
const groups = computed<ChatSearchGroup[]>(() => {
  if (!props.open || !keyword.value.trim() || !debouncedKeyword.value) return [];
  if (searchQuery.isError.value) return [];
  return searchQuery.data.value ?? [];
});

/** 搜索中提示：首轮（isPending）和"换条件重拉"（isFetching）都要显示。 */
const searching = computed(
  () =>
    props.open &&
    !!debouncedKeyword.value &&
    (searchQuery.isPending.value || searchQuery.isFetching.value),
);

/** 检索失败的可见出口；有结果时保持结果，空屏时换成错误+重试。 */
const searchError = computed(() =>
  searchQuery.isError.value
    ? errorText(searchQuery.error.value, t("search.fail"))
    : "",
);

const activeGroup = computed(
  () => groups.value.find((g) => g.conv_id === activeConvId.value) ?? groups.value[0] ?? null,
);

/**
 * 键盘选结果（原生感走查 N2）。Esc / 点遮罩关闭是 `BaseModal` 用的 Reka `Dialog` 自带的，
 * 这里不重复实现。`activeIdx` 是当前高亮的那一条命中；回车打开它 —— 关键词还没搜过时
 * 回车仍是"立刻重搜"（保留原语义：输入时 150ms 防抖，回车是"我确定现在就查"）。
 */
const activeIdx = ref(0);
/** 已出结果的那个关键词（trim 后）；与输入框当前值不等 ⇒ 回车=立刻重搜。 */
const searched = ref("");
const listRef = ref<HTMLDivElement | null>(null);

function stepHit(d: number) {
  const n = activeGroup.value?.messages.length ?? 0;
  if (!n) return;
  activeIdx.value = Math.max(0, Math.min(n - 1, activeIdx.value + d));
  listRef.value
    ?.querySelector(`[data-hit="${activeIdx.value}"]`)
    ?.scrollIntoView({ block: "nearest" });
}
const total = computed(() => totalHits(groups.value));
const inputRef = ref<HTMLInputElement | null>(null);

/** 正在做打开时的状态复位：这期间 keyword watcher 不该再排防抖。 */
const opening = ref(false);

/**
 * 每次成功拿到**当前键**的结果时同步交互状态。
 * 占位数据（上一个键的结果）不算：否则选完发送人再切回"全部"时，
 * 会把筛选后的结果误记成发送人候选来源。
 */
watch(
  () => [searchQuery.data.value, searchQuery.isPlaceholderData.value, searchQuery.status.value] as const,
  ([data, isPlaceholder, status]) => {
    if (!props.open || !debouncedKeyword.value) return;
    if (status !== "success" || isPlaceholder || !data) return;
    // `searched` 记的是**这份数据对应的**关键词：用户继续打字后回车应当重新检索，
    // 而不是打开上一轮的高亮项。
    searched.value = debouncedKeyword.value;
    activeIdx.value = 0;
    // 选中态：保持当前选中；若它已不在结果里，落到第一条
    if (!data.some((g) => g.conv_id === activeConvId.value)) {
      activeConvId.value = data[0]?.conv_id ?? null;
    }
    if (senderFilter.value === null) senderOptions.value = senderOptionsFrom(data);
  },
  { immediate: true },
);

/** 立即检索（回车 / 重试）：已出结果的关键词也要重扫一次（原语义保留）。 */
function forceSearch() {
  const kw = keyword.value.trim();
  if (!kw) return;
  pushKeyword.cancel();
  if (debouncedKeyword.value !== kw) {
    debouncedKeyword.value = kw; // key 一变，Query 自己发请求
    return;
  }
  void searchQuery.refetch();
}

/** 回车：关键词已经落成结果 ⇒ 打开高亮那一条；还没搜过 ⇒ 立刻重搜。 */
function onEnter(e: KeyboardEvent) {
  if (ime.isIme(e)) return;
  const kw = keyword.value.trim();
  if (searched.value === kw && activeGroup.value?.messages.length) {
    openHit(activeIdx.value);
    return;
  }
  forceSearch();
}

function openHit(idx: number) {
  const g = activeGroup.value;
  const msg = g?.messages[Math.max(0, Math.min((g?.messages.length ?? 1) - 1, idx))];
  if (!g) return;
  emit("open-conversation", { convId: g.conv_id, msgId: msg?.msg_id ?? "" });
  emit("close");
}

/** 失败出口上的重试：当前键重拉（与旧 `runSearch()` 同一语义）。 */
function retrySearch() {
  void searchQuery.refetch();
}

/** 关键词防抖：输入即搜（微信也是输入就出结果），150ms 足够合并连打又不觉得延迟。 */
const pushKeyword = useDebounceFn((kw: string) => {
  // 到点时复查一次：这 150ms 里弹窗可能已经被关掉（关窗会清空关键词）
  if (props.open) debouncedKeyword.value = kw;
}, 150);

watch(keyword, () => {
  pushKeyword.cancel();
  if (!props.open || opening.value) return;
  const kw = keyword.value.trim();
  if (!kw) {
    // 清空关键词：结果与选中立即清掉，筛选条件保留（用户只是想换个词）
    debouncedKeyword.value = "";
    searched.value = "";
    activeConvId.value = null;
    activeIdx.value = 0;
    return;
  }
  pushKeyword(kw);
});

onBeforeUnmount(() => pushKeyword.cancel());

/** 打开时：带入关键词并立即检索一次（回车进来应马上看到结果）。 */
watch(
  () => props.open,
  async (open) => {
    if (!open) {
      // 关闭即清空：下次打开是干净的一次（也顺带避免残留关键词/筛选影响判断）
      keyword.value = "";
      debouncedKeyword.value = "";
      senderFilter.value = null;
      datePreset.value = "all";
      senderOptions.value = [];
      activeConvId.value = null;
      activeIdx.value = 0;
      searched.value = "";
      senderMenuOpen.value = false;
      dateMenuOpen.value = false;
      pushKeyword.cancel();
      return;
    }
    // 复位这几个值会触发 keyword watcher。打开时的检索由下面这一次 `debouncedKeyword`
    // 赋值负责，复位期间先挂起 watcher，否则每次打开都白排一次防抖、多打一次全表扫描。
    opening.value = true;
    try {
      keyword.value = (props.initialKeyword ?? "").trim();
      senderFilter.value = null;
      datePreset.value = "all";
      debouncedKeyword.value = keyword.value;
      senderOptions.value = [];
      activeConvId.value = null;
      activeIdx.value = 0;
      searched.value = "";
      await nextTick();
    } finally {
      opening.value = false;
    }
    inputRef.value?.focus();
  },
);

function chooseSender(id: string | null) {
  senderMenuOpen.value = false;
  senderFilter.value = id;
}

function choosePreset(p: SearchDatePreset) {
  dateMenuOpen.value = false;
  datePreset.value = p;
}

/** 两个筛选菜单互斥：打开一个就收起另一个（旧实现是在按钮的 @click 里手写）。 */
function onSenderOpen(open: boolean) {
  senderMenuOpen.value = open;
  if (open) dateMenuOpen.value = false;
}
function onDateOpen(open: boolean) {
  dateMenuOpen.value = open;
  if (open) senderMenuOpen.value = false;
}

function enterChat() {
  // 与键盘同一条路：打开**高亮那一条**（以前固定 `messages[0]` ⇒ 鼠标点的和回车跳的可能不是同一条）
  openHit(activeIdx.value);
}

/** 单聊不重复显示发送者名字（微信同款）；群聊才显示"谁说的"。 */
function showSender(group: ChatSearchGroup): boolean {
  return group.kind === "group";
}
</script>

<template>
  <!-- 移动端用 `fullscreen`（整页、带安全区与返回键），桌面用卡片弹窗 —— **body 只写一份**，
       外壳差异交给 BaseModal（见其 `fullscreen` 注释）。 -->
  <BaseModal
    :open="open"
    :title="t('search.title')"
    :fullscreen="app.isMobile"
    width="max-w-3xl"
    @close="emit('close')"
  >
    <!-- 搜索框 + 筛选 -->
    <div class="flex shrink-0 items-center gap-2">
      <div
        class="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-field)] px-3 transition"
      >
        <Search class="h-4 w-4 shrink-0 text-[var(--gosslan-text-2)]" />
        <input
          ref="inputRef"
          v-model="keyword"
          :maxlength="MAX_SEARCH_KEYWORD_CHARS"
          enterkeyhint="search"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          spellcheck="false"
          :placeholder="t('search.placeholder')"
          :aria-label="t('search.placeholder')"
          class="w-full bg-transparent text-body placeholder:text-[var(--gosslan-text-2)] outline-none focus:border-transparent"
          @keydown.enter.prevent="onEnter"
          @keydown.down.prevent="stepHit(1)"
          @keydown.up.prevent="stepHit(-1)"
          @compositionstart="ime.onStart"
          @compositionend="ime.onEnd"
        />
        <button
          v-if="keyword"
          class="tap-safe flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--gosslan-border)] text-[var(--gosslan-panel)]"
          :title="t('search.clear')" :aria-label="t('search.clear')"
          @click="keyword = ''"
        >
          <X class="h-3 w-3" />
        </button>
      </div>

      <!-- 发送人 / 日期：与微信同位置、同语义（点开一个小菜单选，不做日历控件）。
           菜单的开关/键盘/点外部由 Reka DropdownMenu 承担；两个筛选互斥，靠 onSenderOpen/onDateOpen。 -->
      <DropdownMenuRoot :open="senderMenuOpen" :modal="false" @update:open="onSenderOpen">
        <DropdownMenuTrigger as-child>
          <button
            class="gosslan-filter-chip"
            :class="senderFilter ? 'gosslan-filter-chip--on' : ''"
          >
            {{ senderName ?? t("search.sender") }}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="end"
            :side-offset="0"
            :collision-padding="8"
            class="frost gosslan-menu z-[80] max-h-64 overflow-y-auto"
          >
            <DropdownMenuItem class="gosslan-menu-item" @select="chooseSender(null)">
              {{ t("search.sender.all") }}
            </DropdownMenuItem>
            <DropdownMenuItem
              v-for="o in senderOptions"
              :key="o.id"
              class="gosslan-menu-item"
              @select="chooseSender(o.id)"
            >
              <span class="min-w-0 flex-1 truncate" :title="o.name">{{ o.name }}</span>
              <span class="text-[var(--gosslan-text-2)]">{{ o.count }}</span>
            </DropdownMenuItem>
            <div v-if="!senderOptions.length" class="gosslan-menu-hint">{{ t("search.sender.empty") }}</div>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>

      <DropdownMenuRoot :open="dateMenuOpen" :modal="false" @update:open="onDateOpen">
        <DropdownMenuTrigger as-child>
          <button
            class="gosslan-filter-chip"
            :class="datePreset !== 'all' ? 'gosslan-filter-chip--on' : ''"
          >
            {{ datePreset === "all" ? t("search.date") : t(`search.date.${datePreset}`) }}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuPortal>
          <DropdownMenuContent
            align="end"
            :side-offset="0"
            :collision-padding="8"
            class="frost gosslan-menu z-[80]"
          >
            <DropdownMenuItem
              v-for="p in SEARCH_DATE_PRESETS"
              :key="p"
              class="gosslan-menu-item"
              @select="choosePreset(p)"
            >
              {{ t(`search.date.${p}`) }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuPortal>
      </DropdownMenuRoot>
    </div>

    <!-- 结果：左会话 / 右命中消息（微信同款两栏） -->
    <div class="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--gosslan-radius-lg)] border border-[var(--gosslan-divider)] desktop:md:h-[52vh] desktop:md:flex-none desktop:md:flex-row">
      <!-- 左栏 -->
      <div class="flex max-h-[38%] w-full shrink-0 flex-col overflow-y-auto border-b border-[var(--gosslan-divider)] bg-[var(--gosslan-list)] desktop:md:max-h-none desktop:md:w-[240px] desktop:md:border-b-0 desktop:md:border-r">
        <p v-if="!keyword.trim()" class="px-3 py-6 text-center text-xs text-[var(--gosslan-text-2)]">
          {{ t("search.hint") }}
        </p>
        <!-- 搜索中：用户反馈「感觉显示得比较慢、当前状态没有提示」——
             以前只有"有没有结果"两种静态文案，请求在途时界面看起来像卡住了。 -->
        <p v-else-if="searching" class="flex items-center justify-center gap-2 px-3 py-6 text-center text-xs text-[var(--gosslan-text-2)]">
          <Spinner size-class="h-3 w-3" decorative />
          {{ t("search.searching") }}
        </p>
        <StateBlock
          v-else-if="searchError"
          kind="error"
          :title="t('search.fail')"
          :detail="searchError"
          :retry-label="t('common.retry')"
          @retry="retrySearch"
        />
        <p v-else-if="!groups.length" class="px-3 py-6 text-center text-xs text-[var(--gosslan-text-2)]">
          {{ t("search.empty") }}
        </p>
        <button
          v-for="g in groups"
          :key="g.conv_id"
          class="flex items-start gap-2.5 px-3 py-2.5 text-left transition"
          :class="activeGroup?.conv_id === g.conv_id
            ? 'bg-[var(--gosslan-list-active)]'
            : 'hover:bg-[var(--gosslan-list-hover)]'"
          @click="activeConvId = g.conv_id"
        >
          <MessageAvatar :id="g.conv_id" :name="g.name" :avatar="g.avatar" />
          <span class="min-w-0 flex-1">
            <span class="flex items-baseline gap-2">
              <span class="min-w-0 flex-1 truncate text-body font-medium text-[var(--gosslan-text)]" :title="g.name">{{ g.name }}</span>
              <span class="shrink-0 text-caption text-[var(--gosslan-text-2)]">{{ fmtTimeDivider(g.latest_ts, t, currentLocale()) }}</span>
            </span>
            <span
              class="mt-0.5 block truncate text-xs text-[var(--gosslan-text-2)]"
              :title="cellText(g.messages[0])"
              v-html="highlightText(hitSnippet(cellText(g.messages[0]), keyword), keyword)"
            ></span>
            <span class="mt-0.5 block text-caption text-[var(--gosslan-text-2)]">
              {{ t("search.groupCount", { n: g.total }) }}
            </span>
          </span>
        </button>
      </div>

      <!-- 右栏 -->
      <div class="flex min-w-0 flex-1 flex-col bg-[var(--gosslan-chat)]">
        <div class="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--gosslan-divider)] px-4">
          <span
            class="min-w-0 flex-1 truncate text-body text-[var(--gosslan-text)]"
            :title="keyword.trim() ? t('search.header', { n: total, kw: keyword.trim() }) : t('search.hint')"
          >
            {{ keyword.trim() ? t("search.header", { n: total, kw: keyword.trim() }) : t("search.hint") }}
          </span>
          <button
            v-if="activeGroup"
            class="tap-safe flex shrink-0 items-center gap-1 text-body text-[var(--gosslan-primary)] transition hover:opacity-80"
            @click="enterChat"
          >
            {{ t("search.enterChat") }}
            <ChevronRight class="h-3.5 w-3.5" />
          </button>
        </div>
        <div ref="listRef" class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div
            v-for="(m, hi) in activeGroup?.messages ?? []"
            :key="m.msg_id"
            :data-hit="hi"
            :aria-current="hi === activeIdx ? 'true' : undefined"
            class="flex gap-2.5 rounded-[var(--gosslan-radius-md)] px-2 py-2.5"
            :class="hi === activeIdx ? 'bg-[var(--gosslan-hover)]' : ''"
          >
            <MessageAvatar :id="m.sender_id" :name="m.sender_name" />
            <div class="min-w-0 flex-1">
              <div class="flex items-baseline gap-2">
                <span
                  v-if="activeGroup && showSender(activeGroup)"
                  class="min-w-0 truncate text-xs text-[var(--gosslan-text-2)]"
                  :title="m.sender_name"
                >
                  {{ m.sender_name }}
                </span>
                <span class="ml-auto shrink-0 text-caption text-[var(--gosslan-text-2)]">{{ fmtTimeDivider(m.ts, t, currentLocale()) }}</span>
              </div>
              <div
                class="mt-0.5 gosslan-selectable whitespace-pre-wrap break-words text-body leading-relaxed text-[var(--gosslan-text)]"
                v-html="highlightText(cellText(m), keyword)"
              ></div>
            </div>
          </div>
          <p
            v-if="activeGroup && activeGroup.total > activeGroup.messages.length"
            class="py-3 text-center text-caption text-[var(--gosslan-text-2)]"
          >
            {{ t("search.more", { n: activeGroup.total - activeGroup.messages.length }) }}
          </p>
        </div>
      </div>
    </div>
  </BaseModal>
</template>
