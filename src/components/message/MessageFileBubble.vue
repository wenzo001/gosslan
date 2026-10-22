<script setup lang="ts">
import { t } from "@/i18n";
import Spinner from "@/components/ui/Spinner.vue";
import { computed, type CSSProperties } from "vue";
import type { FileMeta } from "@/types";
import { rgba } from "@/utils/color";
import { formatBytes } from "@/utils/format";
import { FILE_KIND_COLORS, FILE_KIND_ICONS, extBadgeLabel, fileKindOf } from "@/utils/fileKind";
import { useAppStore } from "@/stores/useAppStore";
import { Download, RotateCw } from "lucide-vue-next";
import { X } from "@/components/ui/icons";
import type { TransferStatusTone } from "@/utils/transferState";

const props = defineProps<{
  meta: FileMeta;
  bubbleStyle: CSSProperties;
  /** 0~1；null 表示不显示进度条（历史消息 / 已完成）。 */
  progress: number | null;
  statusText: string | null;
  /** 状态行的视觉档位（D-4）；不传按普通说明处理。 */
  statusTone?: TransferStatusTone;
  failed: boolean;
  note: string | null;
  /** 群文件（gfile-）专用：按成员聚合的投递状态（单聊为 null 不显示）。 */
  delivery?: { completed: number; failed: number; waiting: number } | null;
  /** 自己的消息气泡尖角朝右、对方朝左，指向头像。 */
  mine: boolean;
  /** 文件已就绪（本地路径可用）**且文件确实还在**：整卡可点击打开（微信式：下载完成后点消息即打开）。 */
  ready: boolean;
  /** 是否允许"点一下打开/另存"。Android 上自己发的文件为 false：点击应无任何响应，
   *  但长按气泡弹出的菜单不受影响（仍可另存/复制）。缺省 true（旧调用点行为不变）。 */
  tappable?: boolean;
  /** 本地文件已被「存储清理」删除。此时不提供"下载"入口——重新获取需要对方重发，
   *  而不是等对方上线自动补传（那个入口的文案会误导）。 */
  missing?: boolean;
  /** 统一内容状态为「未完成 / 校验失败」：按钮改成「重新获取」（按 cid 拉一份）。 */
  contentRetry?: boolean;
}>();
const emit = defineEmits<{
  (e: "open"): void;
  (e: "save"): void;
  /** 尚未就绪时点「下载」：接收是自动的，父组件负责解释（提示等待上线）。 */
  (e: "download"): void;
  /** 未完成 / 校验失败：按 cid 向对端重新拉取（ADR-0019）。 */
  (e: "refetch"): void;
  /**
   * 活动传输期间的常驻取消（10-22 审计 D-13）。
   * 父组件交回**同一个** `doCancelSend`，这里不另立第二条取消路径。
   */
  (e: "cancel"): void;
}>();
const app = useAppStore();

const kind = computed(() => fileKindOf(props.meta.name));
const icon = computed(() => FILE_KIND_ICONS[kind.value]);
/** 强调色：失败态统一走红，其余按类型取明/暗档。 */
const accent = computed(() => {
  const c = props.failed ? FILE_KIND_COLORS.pdf : FILE_KIND_COLORS[kind.value];
  return app.dark ? c.dark : c.light;
});

/**
 * 状态行的视觉档位（10-22 审计 D-4）。原来「网络停滞」「发送失败」「已取消」
 * 全是同一种 `opacity-70` 灰色小字，扫一眼分不出"还在但慢"与"已经坏了"。
 * ⚠️ 颜色只是**加强**，语义仍在文字里（§14.3：不许只靠颜色表达状态）。
 */
const statusToneClass = computed(() => {
  switch (props.statusTone) {
    case "error":
      return "text-[var(--gosslan-danger-ink)]";
    case "warn":
      return "text-[var(--gosslan-warning-ink)]";
    default:
      return "opacity-70";
  }
});
/** 图标井：底色＝强调色 12% 的超淡调，图标＝强调色实色（lucide 取 currentColor）。 */
const iconWellStyle = computed(() => ({
  backgroundColor: rgba(accent.value, 0.12),
  color: accent.value,
}));
const extLabel = computed(() => extBadgeLabel(props.meta.name, t("common.file")));
/** 传输中按钮上的百分比（微信下载按钮同款：下载中显示进度数字）。 */
const pct = computed(() => Math.round((props.progress ?? 0) * 100));
/** 整卡是否可点：就绪 + 允许点。Android 自己发的文件 tappable=false ⇒ 鼠标手型/title/键盘都不给。 */
const canOpen = computed(() => props.ready && props.tappable !== false);
</script>

<template>
  <div
    class="flex min-w-0 w-[264px] max-w-full flex-col gap-2 rounded-[var(--gosslan-bubble-radius)] px-3 py-2.5"
    :class="canOpen ? 'cursor-pointer' : ''"
    :style="bubbleStyle"
    :title="canOpen ? t('msg.clickToOpen') : undefined"
    :role="canOpen ? 'button' : undefined"
    :tabindex="canOpen ? 0 : undefined"
    @click="canOpen && emit('open')"
    @keydown.enter.prevent="canOpen && emit('open')"
    @keydown.space.prevent="canOpen && emit('open')"
  >
    <div class="flex items-center gap-2.5">
      <div
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-md)]"
        :style="iconWellStyle"
      >
        <component :is="icon" v-if="!failed" class="h-5 w-5" />
        <X v-else class="h-5 w-5" />
      </div>
      <div class="min-w-0 flex-1">
        <div class="line-clamp-2 break-all text-body font-medium leading-snug">{{ meta.name }}</div>
        <div v-if="failed" class="mt-0.5 text-caption text-[var(--gosslan-danger-ink)]">{{ t("msg.sendFailed") }}</div>
        <div v-else class="mt-0.5 flex items-center gap-1 text-caption opacity-70">
          <span>{{ extLabel }}</span>
          <span>·</span>
          <span>{{ formatBytes(meta.size) }}</span>
          <template v-if="note">
            <span>·</span>
            <span class="truncate" :title="note">{{ note }}</span>
          </template>
        </div>
      </div>
      <!-- 微信式按钮逻辑：未就绪才显示——接收中＝转圈+百分比；等待传输＝下载按钮。
           就绪后整卡可点打开，另存/转发/复制走右键菜单，不再放常驻按钮。
           已被清理时不显示下载入口：文件不会"等对方上线"自己回来。 -->
      <div v-if="!failed && !ready && !missing" class="flex shrink-0 items-center">
        <span
          v-if="progress !== null"
          class="flex h-7 items-center gap-1 text-caption tabular-nums opacity-70"
          :title="t('msg.receiving')"
        >
          <Spinner size-class="h-3.5 w-3.5" decorative />
          {{ pct }}%
        </span>
        <!-- 进度在跑就常驻一个取消入口（10-22 审计 D-13）：取消此前只在右键/长按菜单里，
             而"进度停住了 / 传得太慢"恰恰是最想立刻停、又最容易找不到按钮的时刻。
             `@click.stop` 是必须的：整卡在就绪时是可点的（打开文件），不能因为点取消顺带打开。 -->
        <!-- 取消只属于**发送方**：接收方的传输由对端驱动，这里给一个「取消发送」
             按钮既是错文案、也会走到 `doCancelSend` 去取消一条自己没在发的记录。
             接收方保留上面的转圈与百分比即可。 -->
        <button
          v-if="progress !== null && mine"
          type="button"
          class="tap-safe ml-1 flex h-7 w-7 items-center justify-center rounded-[var(--gosslan-radius-sm)] transition hover:bg-[var(--gosslan-hover)]"
          :title="t('msg.cancelSend')"
          :aria-label="t('msg.cancelSend')"
          @click.stop="emit('cancel')"
        >
          <X class="h-3.5 w-3.5" />
        </button>
        <button
          v-else
          class="tap-safe flex h-7 w-7 items-center justify-center rounded-[var(--gosslan-radius-sm)] transition hover:bg-[var(--gosslan-hover)]"
          :title="t(contentRetry ? 'msg.imageReRequest' : 'msg.downloadFile')"
          :aria-label="t(contentRetry ? 'msg.imageReRequest' : 'msg.downloadFile')"
          @click="contentRetry ? emit('refetch') : emit('download')"
        >
          <RotateCw v-if="contentRetry" class="h-3.5 w-3.5" />
          <Download v-else class="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
    <!-- 群文件成员投递状态：独立成底栏，用一条极淡分隔线与文件信息区隔开（微信式卡片层次） -->
    <div
      v-if="delivery"
      class="flex items-center gap-1.5 border-t border-current/10 pt-1.5 text-caption opacity-70"
    >
      <span>{{ t("msg.sentTo", { n: delivery.completed }) }}</span>
      <span v-if="delivery.waiting > 0">· {{ t("msg.waitingOnline", { n: delivery.waiting }) }}</span>
      <span v-if="delivery.failed > 0" class="text-[var(--gosslan-danger-ink)]">· {{ t("msg.failedCount", { n: delivery.failed }) }}</span>
    </div>
    <!-- 进度条只在活动传输时出现；状态文案独立一行 —— 进度停下来之后那句话还得说得出失败/取消 -->
    <template v-if="progress !== null">
      <div
        class="h-1 overflow-hidden rounded-full bg-[var(--gosslan-divider)]"
        role="progressbar"
        :aria-valuemin="0"
        :aria-valuemax="100"
        :aria-valuenow="Math.round(Math.min(1, Math.max(0, progress)) * 100)"
        :aria-label="statusText || t('msg.receiving')"
      >
        <!-- 用 scaleX 而不是 width：进度更新只触发合成层，不参与布局（长列表里尤其重要）。 -->
        <div
          class="h-full origin-left rounded-full bg-[var(--gosslan-primary)] transition-transform duration-300 ease-[var(--gosslan-ease)]"
          :style="{ transform: `scaleX(${Math.min(1, Math.max(0, progress ?? 0))})` }"
        ></div>
      </div>
    </template>
    <!-- 状态行必须是一条**常驻** live region（10-22 审计 D-25 / R-32）：
         「接收中 62%」→「网络停滞」→「已取消」这几下切换此前对读屏完全不可见 ——
         进度条本身没有 `role=progressbar`，文案换了也没人播报。
         外层不能 v-if：ARIA 的 live region 要在内容变化**之前**就存在于 DOM 里才可靠，
         所以让它一直在、空的时候用 `empty:hidden` 收掉高度（Vue 的 v-if 假分支留的是注释节点，
         不算 :empty 的子节点 ⇒ 收起成立）。 -->
    <div class="empty:hidden" aria-live="polite">
      <div v-if="statusText" class="text-caption" :class="statusToneClass">{{ statusText }}</div>
    </div>
    <span aria-hidden="true" class="bubble-tail" :class="mine ? 'tail-mine' : 'tail-other'"></span>
  </div>
</template>
