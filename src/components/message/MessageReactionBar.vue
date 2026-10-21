<script setup lang="ts">
/**
 * 气泡下方的表情回应条（飞书/微信同款位置）。
 *
 * 为什么单独成条而不是把回应做成"一条消息"：回应是**状态**不是内容 —— 它挂在被回应的
 * 那条下面，且同一个人反复点只应看到最终结果。协议层它确实是一条条独立事件消息
 * （见 utils/reactions.ts 的说明），但**渲染层必须折叠**，否则群里回三个赞就多三条消息。
 *
 * 添加回应的入口不在本组件：飞书式入口（悬停消息 → 气泡外侧笑脸按钮 → 完整表情选择器）
 * 在 `MessageItem` 的消息行里 —— 入口必须挂在 `.group/msg` **之内**才能被悬停揭示，
 * 而本条是它的兄弟节点（用户 2026-09-21 报「表情回应在哪儿？没看见」）。
 *
 * ## 「谁点的」名单怎么露（用户 2026-09-29 需求汇总三）
 * 同一个表情多人点 ⇒ **聚合成一枚胶囊 + 数字**（不是一人一枚），名单按**追加先后**排，
 * 超过 `ROSTER_VISIBLE` 人折成「+N」。揭示方式按端给，两条都必须存在：
 * - **PC**：悬停 / 键盘聚焦（`hover: hover` 才启用，触屏上 mouseenter 是"点完才来"的假事件，
 *   用它当唯一出口就会在移动端变成"点一下既切了回应又弹名单"）；
 * - **移动端**：能点的时候点就是切回应（这是最高频动作，不能让位），所以名单走**长按**；
 *   不可点的那一侧点 = 直接看名单。
 *   ⚠️ 这一支今天真实存在，但**不再是"1:1"**：入口开关由调用方 `ChatWindow.vue` 的
 *   `canReact = 群聊 || (是对端好友 && 不是自聊)` 决定 —— 不可点的只剩「自聊」和「不是好友的对端」。
 *   （旧注释写的是"现在只有 1:1"，那是 2026-09-24 之前的口径，已经不对了。）
 * 名单不抢戏：不显示头像、不常驻、只有一行文字，因为这条的第一信息是"有几个、我点没点"。
 *
 * ## 胶囊的长相（用户 2026-09-29：「表情回应样式参考图片样式做」）
 * 贴飞书那一种：**没有阴影**、别人点的用一层墨迹淡底（`--gosslan-hover`）而不是一圈边框，
 * 只有"我自己也点了"那一枚描主色边 + 主色淡底。两态**都带 border**（别人那枚是透明边），
 * 否则我点一下会让胶囊宽窄跳 2px。表情比数字大一档，让表情本身是主角。
 */
import { computed, onUnmounted, ref } from "vue";
import { t } from "@/i18n";
import { emojiUrl } from "@/utils/emoji";
import { summarizeActors, ROSTER_VISIBLE, type ReactionChip } from "@/utils/reactions";
import { canHover } from "@/utils/platform";
import { useChatStore } from "@/stores/useChatStore";
import { HoverCardContent, HoverCardPortal, HoverCardRoot, HoverCardTrigger } from "reka-ui";

const props = defineProps<{
  chips: ReactionChip[];
  /** 自己的消息：回应条靠右对齐（与气泡的朝向一致） */
  mine: boolean;
  /** 是否允许我添加/取消（不可点的那一支见上面「谁点的」名单那节；自己的消息也允许自嘲式回应） */
  interactive: boolean;
}>();
const emit = defineEmits<{
  (e: "toggle", emoji: string): void;
}>();

const chat = useChatStore();
/** 名字一律走 store 那一个家：它现在**永不**返回裸 device_id（查不到就是「未知成员 + id 后四位」），
 *  所以这里不再补 `|| id` —— 补了就是把第二条兜底写在第二个家里。 */
function nameOf(id: string): string {
  return chat.nicknameOf(id);
}

/** 一行最多列几人，其余折成 +N（同一份判据也用于悬停 title，两处不能各写一个数）。 */
const visible = (c: ReactionChip) => summarizeActors(c.actors, nameOf, ROSTER_VISIBLE);

/**
 * 名单里**列出来**的那几人。上限必须和 `visible()` 是同一个数 ——
 * `summarizeActors` 内部取 `cap = max(1, limit)`，这里跟着取同一条，
 * 否则"列几个人"和"说还剩几个人"会各算各的（曾经就是各算各的：
 * 名单 `v-for` 全量 actor，末行又挂一个「等 N 人」⇒ 4 个名字 + "还有 1 人"）。
 */
const rosterIds = (c: ReactionChip) => c.actors.slice(0, Math.max(1, ROSTER_VISIBLE));

/** 胶囊上的原生 tooltip：数量 + 前几人 + 「+N」（PC 悬停的第一层，零成本、不占布局）。 */
function chipTitle(c: ReactionChip): string {
  const { shown, hidden } = visible(c);
  const who = shown.join("、");
  const rest = hidden > 0 ? ` ${t("msg.reactionPlus", { n: hidden })}` : "";
  return `${t("msg.reactionWho", { n: c.count })}：${who}${rest}`;
}

/**
 * 名单浮层由 Reka `HoverCard` 托管：每个胶囊一棵 Root（锚点必须是**这颗**胶囊），
 * Portal 到 body，定位/翻转/越界/外点/Esc/悬停宽限都由 floating-ui + DismissableLayer 接管。
 * 这里只保留业务语义：同一时刻只开一颗、移动端长按才开、以及内容宽度按名字伸缩。
 * `align` 仍按"胶囊在视口哪半边"给一个起始方向；真正的夹边由库做。
 *
 * ⚠️ "开着的那颗"**只从库回写的状态派生**（悬停一支 / 触屏一支），组件自己不另记一份：
 * 上一版在 mouseenter 那一拍就点亮它，而库要等 `open-delay` 才真的展开 —— 指针在
 * 120ms 内进出时名单从未出现过，`aria-expanded` 与 `data-open-emoji` 却停在 true。
 */
/** 悬停能力走 common layer 的 `canHover`（触屏上 mouseenter 是"点完才来"的假事件）。
 *  ⚠️ 组件里不裸写 matchMedia —— roadmap N11 的口径，由 designGuards ㉟ 守着（本处原先就是那份唯一的裸写）。 */
const hoverOpenEmoji = ref<string | null>(null);
const touchOpenEmoji = ref<string | null>(null);
/** 同时只开一份名单：一条消息上三个表情全展开会把气泡区糊住。 */
const openEmoji = computed(() => (canHover ? hoverOpenEmoji.value : touchOpenEmoji.value));
const align = ref<"start" | "end">("start");

function onRootOpenChange(emoji: string, open: boolean) {
  if (!canHover) {
    // 触屏：忽略 focus/pointerenter 触发的自动开启，只认长按或"不可点胶囊"的点击（走 reveal）。
    if (open || touchOpenEmoji.value !== emoji) return;
    touchOpenEmoji.value = null;
    return;
  }
  if (open) hoverOpenEmoji.value = emoji;
  else if (hoverOpenEmoji.value === emoji) hoverOpenEmoji.value = null;
}

/** 模板里传的是 `$event.currentTarget`，它的静态类型是 EventTarget ⇒ 只在这一处收窄。 */
function asEl(x: EventTarget | null | undefined): HTMLElement | null {
  return x instanceof HTMLElement ? x : null;
}

/**
 * 展开名单。桌面只在这里算朝向（开与关由库到点回写 `hoverOpenEmoji`）；
 * 触屏这里就是唯一的开启入口。
 */
function reveal(emoji: string, chipEl?: EventTarget | null) {
  const el = asEl(chipEl);
  if (el) {
    const r = el.getBoundingClientRect();
    align.value = (r.left + r.right) / 2 >= window.innerWidth / 2 ? "end" : "start";
  }
  if (!canHover) touchOpenEmoji.value = emoji;
}

function dismiss() {
  hoverOpenEmoji.value = null;
  touchOpenEmoji.value = null;
}

function togglePanel(emoji: string, chipEl?: EventTarget | null) {
  if (openEmoji.value === emoji) dismiss();
  else reveal(emoji, chipEl);
}

/**
 * 长按揭示（移动端）。刻意不借 `utils/longPress.ts`：那两个函数判的是"消息行的长按菜单
 * 要不要吞掉松手"，与这里的"胶囊长按看名单"不是同一个开关 —— 共用会把两条链路绑成
 * 一条（长按胶囊会同时弹消息菜单和名单）。
 */
const LONG_PRESS_MS = 450;
let pressTimer: ReturnType<typeof setTimeout> | null = null;
/** 长按已触发 ⇒ 紧接着的那次 click 必须吃掉，否则"看个名单"会把回应点掉。 */
let heldEmoji: string | null = null;

function onPressStart(emoji: string, chipEl?: EventTarget | null) {
  if (!props.interactive || canHover) return;
  clearPress();
  const el = asEl(chipEl);
  pressTimer = setTimeout(() => {
    pressTimer = null;
    heldEmoji = emoji;
    reveal(emoji, el);
  }, LONG_PRESS_MS);
}
function clearPress() {
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}
function onClick(c: ReactionChip, chipEl?: EventTarget | null) {
  clearPress();
  if (heldEmoji === c.emoji) {
    heldEmoji = null;
    return;
  }
  if (!props.interactive) {
    togglePanel(c.emoji, chipEl);
    return;
  }
  emit("toggle", c.emoji);
}

onUnmounted(clearPress);
</script>

<template>
  <!-- 没有任何回应且不可交互时整条不渲染，避免给每条消息都留一行空白 -->
  <!-- 与气泡**左/右边缘对齐**（用户 2026-10-07：「左右两条表情回复边缘都与上面气泡对齐」）。
       本条是消息行的**兄弟节点**，所以要从容器左/右缘让出「消息行的 px-4(16) + 头像 w-9(36)
       + 行 gap-2(8)」= **60px**，胶囊的那条边才正好落在气泡那条边上。
       ⚠️ 为什么是一个 60 而不是"px-4 再加头像"：Tailwind 里 `pl-*` 与 `px-*` 同属性、按顺序覆盖
       （实测证据：旧写法 `pr-1` + `pr-12` 同时挂在这一颗元素上，生效的只有 48px 那一档），
       拆成两档写就会静默少掉一层 —— 旧值 48 正是这么来的：注释按"头像 40 + 间距 8"算，
       而头像其实是 36，还整个漏掉了行的 16px 内边距，两边各差 12px。
       ⚠️ 这个 60 由 `scripts/check-ui-runtime.mjs` 的 roster 段在**真浏览器里**量着（|差| <= 1px），
       所以头像尺寸或行内边距哪天变了，红的是那条判据，不是这段注释。 -->
  <div
    v-if="chips.length > 0 || interactive"
    data-reaction-bar
    :data-open-emoji="String(openEmoji)"
    class="flex flex-wrap items-center gap-1"
    :class="mine ? 'justify-end pr-[60px]' : 'pl-[60px]'"
  >
    <span v-for="c in chips" :key="c.emoji" class="relative inline-flex">
      <HoverCardRoot
        :open="openEmoji === c.emoji"
        :open-delay="120"
        :close-delay="100"
        @update:open="onRootOpenChange(c.emoji, $event)"
      >
        <HoverCardTrigger as-child>
          <button
            data-reaction-chip
            :data-reaction-emoji="c.emoji"
            :data-hover-capable="String(canHover)"
            class="tap-safe flex h-7 items-center gap-1 rounded-full border px-1.5 text-meta leading-none transition"
            :class="c.mine
              ? 'border-[var(--gosslan-primary)] bg-[var(--gosslan-primary-light)] text-[var(--gosslan-primary)]'
              : 'border-transparent bg-[var(--gosslan-hover)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-border)] hover:text-[var(--gosslan-text)]'"
            :title="chipTitle(c)"
            :aria-label="t('msg.reactionToggle', { emoji: c.emoji })"
            :aria-expanded="openEmoji === c.emoji"
            :disabled="!interactive"
            @click="onClick(c, $event.currentTarget)"
            @pointerdown="onPressStart(c.emoji, $event.currentTarget)"
            @pointerup="clearPress"
            @pointercancel="clearPress"
            @pointerleave="clearPress"
            @mouseenter="canHover && reveal(c.emoji, $event.currentTarget)"
            @focus="canHover && reveal(c.emoji, $event.currentTarget)"
          >
            <img
              loading="lazy" decoding="async"
              v-if="emojiUrl(c.emoji)"
              :src="emojiUrl(c.emoji) ?? undefined"
              alt=""
              class="h-[18px] w-[18px] shrink-0"
            />
            <span v-else class="text-emphasis leading-none">{{ c.emoji }}</span>
            <span class="tabular-nums font-medium">{{ c.count }}</span>
          </button>
        </HoverCardTrigger>
        <HoverCardPortal>
          <!-- 名单内容：宽度按名字长短撑开、上限 256px，超出交给行内 truncate。
               顺序是**追加先后**（先点的在上、后点的在下），不再单独标"最新"
               （用户 2026-10-07：「最新的那个标签去掉」）。 -->
          <HoverCardContent
            v-if="c.actors.length > 0"
            data-reaction-roster
            role="tooltip"
            side="top"
            :align="align"
            :side-offset="6"
            :collision-padding="8"
            class="gosslan-popover-in z-[80] w-max max-w-[256px] rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] px-2.5 py-1.5 text-caption leading-relaxed text-[var(--gosslan-text-2)] shadow-md"
            @click.stop
          >
            <span
              v-for="id in rosterIds(c)"
              :key="id"
              data-roster-row
              class="block truncate"
              :title="nameOf(id)"
            >
              {{ nameOf(id) }}
            </span>
            <span v-if="visible(c).hidden > 0" class="block">{{
              t("msg.reactionPlus", { n: visible(c).hidden })
            }}</span>
          </HoverCardContent>
        </HoverCardPortal>
      </HoverCardRoot>
    </span>
  </div>
</template>
