<script setup lang="ts">
import { t } from "@/i18n";
import Spinner from "@/components/ui/Spinner.vue";
import { computed } from "vue";
import { useChatStore } from "@/stores/useChatStore";
import { useExclusivePopup } from "@/composables/useExclusivePopup";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { avatarSeedFor } from "@/utils/avatarSeed";
import type { SendState } from "@/composables/useMessageDisplay";
import type { GroupDeliverySummary } from "@/types";
import { CheckCheck, HelpCircle } from "lucide-vue-next";
import { AlertCircle, Check } from "@/components/ui/icons";

const props = defineProps<{
  state: SendState;
  title: string;
  /** 群聊：显示实际已读成员头像；单聊显示单个状态图标。 */
  isGroup?: boolean;
  /** 已读该消息的成员 ID（由父组件按消息时间计算）。 */
  readerIds?: string[];
  /** 消息唯一键：作为全局展开互斥的键。 */
  msgKey?: string | number;
  /**
   * 这一格**是否真的能把这条重新发出去**（决定图标是按钮还是静态指示）。
   *
   * 判据不在这里、也不在 `MessageItem` 里各自猜：唯一那份在 `utils/resendChannel`
   * （它按 kind × 是否群 × 本机还有没有附件 决定通道）。缺省 = `undefined` 一律**不可点**，
   * 因为"默认就能点"正是 10-22 审计 R-27/D-2 那格的成因：按钮对所有 kind 都渲染、
   * 而 `retrySend` 只对部分 kind 有出口 ⇒ 点了静默无反应 = 界面在撒谎。
   * 图标本身不删 —— 它是这条消息失败/被取消的唯一可见指示；只是不再假装可点。
   */
  retryable?: boolean;
  /**
   * 群消息的成员级投递摘要（**只来自后端台账**，`get_group_delivery_summaries`）。
   *
   * 为什么不能自己从 `readerIds` / 群成员数推：那份「已读」与「已收到」是两件事
   * （收到 ≠ 读过），而台账才是投递的事实。全送达的消息后端已即时清墓碑 ⇒ 这里是 null。
   */
  delivery?: GroupDeliverySummary | null;
}>();
const emit = defineEmits<{ (e: "retry"): void }>();

/**
 * 「失败」「已取消」「部分送达后被取消」三格都可以长出这颗重发（负责人 2026-10-23：
 * 取消掉的也想再发一次；2026-10-25：群消息部分送达后也要能按成员补发），
 * 但都必须先有真通道。其余状态（sending/sent/delivered/read）本来就没有重试可言。
 */
const canRetry = computed(
  () =>
    (props.state === "failed" ||
      props.state === "cancelled" ||
      props.state === "partial_cancelled") &&
    props.retryable === true,
);

const chat = useChatStore();
const readerIds = computed(() => props.readerIds ?? []);
const visibleReaders = computed(() => readerIds.value.slice(0, 3));
const extraReaders = computed(() => readerIds.value.slice(3));

/**
 * 群消息的「谁收到」摘要 —— 计数原文来自台账，这里只做**呈现**（不重算、不推断）。
 *
 * 优先级是语义：还有人没收到（pending）就是说进度；都收尾了才说失败/取消。
 * 全部送达时后端已经把墓碑清掉 ⇒ `delivery` 为 null，这一格什么都不显示
 * （正常消息旁边不该永远挂一串「5/5」）。
 */
const deliveryTotal = computed(() => {
  const d = props.delivery;
  return d ? d.delivered + d.pending + d.cancelled + d.failed : 0;
});
const deliveryText = computed(() => {
  const d = props.delivery;
  if (!d || deliveryTotal.value === 0) return "";
  if (d.pending > 0) return t("msg.delivery.pending", { delivered: d.delivered, total: deliveryTotal.value });
  if (d.failed > 0) return t("msg.delivery.failed", { failed: d.failed });
  if (d.cancelled > 0) {
    return d.delivered > 0
      ? t("msg.delivery.cancelled", { delivered: d.delivered, cancelled: d.cancelled })
      : t("msg.delivery.allCancelled", { cancelled: d.cancelled });
  }
  // 只剩 delivered 行：这不是"正常全部送达"（那台账已被清空），而是
  // 「已取消/已判失败，但对方后来其实收到了」——那条迟到 Ack 留下的证据必须看得见。
  if (d.delivered > 0) return t("msg.delivery.deliveredOnly", { delivered: d.delivered });
  return "";
});
const deliveryTitle = computed(() => {
  const d = props.delivery;
  if (!d) return "";
  return t("msg.delivery.detail", {
    delivered: d.delivered,
    pending: d.pending,
    cancelled: d.cancelled,
    failed: d.failed,
  });
});

/**
 * 「已读成员」弹层：接入全局浮层互斥（同一时刻只允许一个弹层展开）。
 * 点另一条消息的已读头像会自动收起上一条，虚拟列表回收行时也不会残留；
 * 与右键菜单/表情面板同属一套机制，互相之间也会自动收起。
 * 模板里用到 `readersOpen`，故解构出来（模板不会自动解包嵌套在对象里的 ref）。
 */
const {
  isActive: readersOpen,
  claim: claimReaders,
  release: releaseReaders,
} = useExclusivePopup(`readers:${props.msgKey ?? ""}`);

/**
 * Reka Popover 的受控开关：定位/翻转/外点/Esc 由 floating-ui + DismissableLayer 接管。
 * `readersOpen` 仍是全局浮层互斥的唯一状态 —— 别的浮层抢占时它变 false，Popover 随之收起。
 */
function onReadersOpenChange(open: boolean) {
  if (open) claimReaders();
  else releaseReaders();
}

function readerName(id: string) {
  return chat.nicknameOf(id);
}
function readerAvatar(id: string): string | null {
  const friend = chat.friends.find((item) => item.device_id === id);
  if (friend?.avatar) return friend.avatar;
  return chat.peers.find((item) => item.device_id === id)?.avatar ?? null;
}
</script>

<template>
  <!-- 群聊：状态指示（失败/取消/部分送达/未知） + 已读成员头像 + 展开完整列表 -->
  <div v-if="isGroup" class="relative flex shrink-0 items-center gap-1 pb-1.5">
    <!-- 成员级投递摘要（台账口径）：还有人没收到时说进度；失败/取消说结论。
         全部送达时后端已清墓碑 ⇒ 这里为空，正常消息旁边不挂常驻数字。 -->
    <span
      v-if="deliveryText"
      data-delivery
      class="whitespace-nowrap text-caption leading-none tabular-nums text-[var(--gosslan-text-2)]"
      :title="deliveryTitle"
    >{{ deliveryText }}</span>
    <!-- 群消息没有 1:1 那套单勾/双勾，但失败、取消、部分送达、未知都是真实状态，
         此前这一格**什么都不显示**（只渲染已读头像）⇒ 群里的失败消息看起来像已发出。
         2026-10-25 用户口径：失败/停止用**红色圆形感叹号**（AlertCircle），一眼就是
         "没发出去、已经停了"；不会自动重试，只有点这一下才会重新发送。 -->
    <button
      v-if="(state === 'failed' || state === 'cancelled' || state === 'partial_cancelled') && canRetry"
      class="tap-safe flex h-5 w-5 items-center justify-center rounded-[var(--gosslan-radius-xs)] transition hover:bg-[var(--gosslan-hover)]"
      :class="state === 'partial_cancelled' ? 'text-[var(--gosslan-warning-ink)]' : 'text-[var(--gosslan-danger-ink)]'"
      :title="t('msg.resend')" :aria-label="t('msg.resend')"
      @click="emit('retry')"
    >
      <AlertCircle class="h-4 w-4" stroke-width="2.5" />
    </button>
    <span
      v-else-if="state === 'failed'"
      class="flex h-5 w-5 items-center justify-center text-[var(--gosslan-danger-ink)]"
      role="img" :title="title" :aria-label="title"
    >
      <AlertCircle class="h-4 w-4" stroke-width="2.5" />
    </span>
    <span
      v-else-if="state === 'partial_cancelled'"
      class="flex h-5 w-5 items-center justify-center text-[var(--gosslan-warning-ink)]"
      role="img" :title="title" :aria-label="title"
    >
      <AlertCircle class="h-4 w-4" stroke-width="2.5" />
    </span>
    <span
      v-else-if="state === 'cancelled'"
      class="flex h-5 w-5 items-center justify-center text-[var(--gosslan-danger-ink)]"
      role="img" :title="title" :aria-label="title"
    >
      <AlertCircle class="h-4 w-4" stroke-width="2.5" />
    </span>
    <span
      v-else-if="state === 'unknown'"
      class="flex h-5 w-5 items-center justify-center text-[var(--gosslan-text-2)]"
      role="img" :title="title" :aria-label="title"
    >
      <HelpCircle class="h-4 w-4" stroke-width="2.5" />
    </span>
    <PopoverRoot v-if="readerIds.length > 0" :open="readersOpen" @update:open="onReadersOpenChange">
      <PopoverTrigger as-child>
        <button
          class="tap-safe -space-x-1 flex items-center rounded-full p-0.5 transition hover:bg-[var(--gosslan-hover)]"
          :title="t('msg.readBy', { n: readerIds.length })"
          :aria-label="t('msg.readByView', { n: readerIds.length })"
        >
          <span
            v-for="id in visibleReaders"
            :key="id"
            class="gosslan-avatar-box flex h-4 w-4 items-center justify-center overflow-hidden rounded-full border border-[var(--gosslan-panel)] text-caption text-white"
            :style="{ backgroundColor: avatarSeedFor(id)?.bg }"
          >
            <img loading="lazy" decoding="async" alt="" v-if="readerAvatar(id)" :src="readerAvatar(id) ?? undefined" class="h-full w-full object-cover" />
            <span v-else class="gosslan-avatar-emoji" aria-hidden="true">{{ avatarSeedFor(id)?.emoji }}</span>
          </span>
          <span
            v-if="extraReaders.length > 0"
            class="ml-1 rounded-full bg-[var(--gosslan-hover)] px-1 text-caption text-[var(--gosslan-text-2)]"
          >
            +{{ extraReaders.length }}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          side="bottom"
          align="end"
          :side-offset="6"
          :collision-padding="8"
          hide-when-detached
          class="gosslan-popover-in z-[80] border-0 bg-transparent p-0 shadow-none"
        >
          <div
            data-readers-popover
            class="frost max-h-60 overflow-y-auto rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] p-1.5 text-xs shadow-lg"
          >
            <div class="px-2 py-1 text-[var(--gosslan-text-2)]">{{ t("msg.readMembers", { n: readerIds.length }) }}</div>
            <div
              v-for="id in readerIds"
              :key="id"
              class="flex items-center gap-2 rounded-[var(--gosslan-radius-xs)] px-2 py-1 hover:bg-[var(--gosslan-hover)]"
            >
              <span
                class="gosslan-avatar-box flex h-5 w-5 items-center justify-center overflow-hidden rounded-full text-caption text-white"
                :style="{ backgroundColor: avatarSeedFor(id)?.bg }"
              >
                <img loading="lazy" decoding="async" alt="" v-if="readerAvatar(id)" :src="readerAvatar(id) ?? undefined" class="h-full w-full object-cover" />
                <span v-else class="gosslan-avatar-emoji" aria-hidden="true">{{ avatarSeedFor(id)?.emoji }}</span>
              </span>
              <span class="max-w-28 truncate" :title="readerName(id)">{{ readerName(id) }}</span>
            </div>
          </div>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </div>
  <!-- 单聊：回执图标固定在气泡左侧（视觉上贴近对话人头像方向）。
       ♿ 回执是**纯图标**状态（转圈/空心圆/绿勾/红叉），读屏下原本什么也读不到 ——
       发送中 / 已送达 / 已读 是聊天最核心的状态，必须给可访问名。
       ⚠️ `role="img"` 只能加在**只包静态图标**的元素上：ARIA 的 `img` 会应用
       *Children Presentational*，把后代的角色/名字/动作**从无障碍树里抹掉**。
       此前它套在含「重发」按钮的外层 ⇒ 读屏用户**点不到重发**（失败消息无法重发）。
       现在：按钮是兄弟节点，`role="img"` 只包状态图标。 -->
  <!-- 单聊回执图标：借鉴 Telegram 的状态视觉语言
       （单勾=已发到链路、双勾=对方已收到、双勾变主题色=对方已读）。
       ♿ 回执是纯图标状态，aria-label 提供语义。 -->
  <span v-else class="flex shrink-0 items-center pb-1.5">
    <!-- 失败：红色圆形感叹号（用户 2026-10-25：比红叉更像"这条没发出去并且已经停了"）。
         语义不变：不会自动重试，只有主动点这一下才会重新发送；不操作就永远停在失败态。 -->
    <button
      v-if="state === 'failed' && canRetry"
      class="tap-safe flex h-5 w-5 items-center justify-center rounded-[var(--gosslan-radius-xs)] text-[var(--gosslan-danger-ink)] transition hover:bg-[var(--gosslan-danger-soft)]"
      :title="t('msg.resend')" :aria-label="t('msg.resend')"
      @click="emit('retry')"
    >
      <AlertCircle class="h-4 w-4" stroke-width="2.5" />
    </button>
    <!-- 没有真通道的失败：同一颗红色感叹号退化成**纯指示**，读屏仍能报出"发送失败"。 -->
    <span
      v-else-if="state === 'failed'"
      class="flex h-5 w-5 items-center justify-center text-[var(--gosslan-danger-ink)]"
      role="img"
      :title="title"
      :aria-label="title"
    >
      <AlertCircle class="h-4 w-4" stroke-width="2.5" />
    </span>
    <!-- 已取消：自己按下的取消也是"停在这里"的状态，按同一套视觉给红色感叹号；
         能算出真通道时同样可以再发一次（判据在 `utils/resendChannel`）。 -->
    <button
      v-else-if="canRetry"
      class="tap-safe flex h-5 w-5 items-center justify-center rounded-[var(--gosslan-radius-xs)] transition hover:bg-[var(--gosslan-hover)]"
      :class="state === 'partial_cancelled' ? 'text-[var(--gosslan-warning-ink)]' : 'text-[var(--gosslan-danger-ink)]'"
      :title="t('msg.resend')" :aria-label="t('msg.resend')"
      @click="emit('retry')"
    >
      <AlertCircle class="h-4 w-4" stroke-width="2.5" />
    </button>
    <span
      v-else-if="state === 'cancelled'"
      class="flex h-5 w-5 items-center justify-center text-[var(--gosslan-danger-ink)]"
      role="img"
      :title="title"
      :aria-label="title"
    >
      <AlertCircle class="h-4 w-4" stroke-width="2.5" />
    </span>
    <span
      v-else-if="state === 'partial_cancelled'"
      class="flex h-5 w-5 items-center justify-center text-[var(--gosslan-warning-ink)]"
      role="img"
      :title="title"
      :aria-label="title"
    >
      <AlertCircle class="h-4 w-4" stroke-width="2.5" />
    </span>
    <!-- 状态未知：兜底可见性。以前这份映射不认识的取值会走 default 空串 ⇒ 图标位全空，
         读屏也读不到；用户只能猜"是不是发出去了"。 -->
    <span
      v-else-if="state === 'unknown'"
      class="flex h-5 w-5 items-center justify-center text-[var(--gosslan-text-2)]"
      role="img"
      :title="title"
      :aria-label="title"
    >
      <HelpCircle class="h-4 w-4" stroke-width="2.5" />
    </span>
    <span v-else class="relative flex items-center" role="img" :title="title" :aria-label="title">
      <!-- 状态切换给一次短促的弹入：单勾→双勾→主题色双勾是聊天里最常盯的一处，
           硬切会让人怀疑"到底有没有送到"。 -->
      <Transition name="receipt-swap" mode="out-in">
        <span :key="state" class="relative flex items-center">
          <!-- sending：单勾右下角叠一个小 spinner —— 表达"已经在发但还没到位"。
               TG 用的是纯 spinner，但纯 spinner 在气泡上很不显眼（小 + 灰）；
               加一个勾让用户一眼就知道这不是空状态。 -->
          <template v-if="state === 'sending'">
            <Check class="h-3.5 w-3.5 text-[var(--gosslan-text-2)]" />
            <Spinner class="absolute -right-1 -bottom-0.5 text-[var(--gosslan-text-2)]" size-class="h-2.5 w-2.5" decorative />
          </template>
          <!-- sent：单勾（灰色）—— 已经发出但还没到对方设备。我们 P2P 链路下 sent 到 delivered
               之间几乎没有停留（写出去 = 对方收到），所以这状态通常一闪而过。 -->
          <Check v-else-if="state === 'sent'" class="h-3.5 w-3.5 text-[var(--gosslan-text-2)]" />
          <!-- delivered：双勾灰色 —— 对方设备已收到但还没打开看。 -->
          <CheckCheck v-else-if="state === 'delivered'" class="h-4 w-4 text-[var(--gosslan-text-2)]" />
          <!-- read：双勾主题色 —— 对方已读（TG 是蓝色，我们用 app 主题色）。
               用 primary 而不是 success：绿色在深色模式下容易跟"在线"状态混淆；
               TG 选蓝色就是为了跟"送达灰色"形成明确对比。 -->
          <CheckCheck v-else-if="state === 'read'" class="h-4 w-4 text-[var(--gosslan-primary)]" />
        </span>
      </Transition>
    </span>
  </span>
</template>
