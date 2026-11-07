<script setup lang="ts">
import Icon from "@/components/ui/Icon.vue";
import { t } from "@/i18n";
import BubbleTail from "@/components/message/BubbleTail.vue";
import { computed, ref } from "vue";
import CodeBlock from "@/components/CodeBlock.vue";
import { CODE_CLAMP_HEIGHT, CODE_SURFACE, codePreviewRemainingLines } from "@/utils/previewMetrics";
import { DropdownMenuItem } from "reka-ui";
import ContextMenu from "@/components/ContextMenu.vue";

const props = defineProps<{
  /** inline code 消息取消息正文，代码附件取本地读到的文本。 */
  code: string;
  clamped: boolean;
  copied: boolean;
  dark: boolean;
  /** 自己的消息气泡尖角朝右、对方朝左，指向头像。 */
  mine: boolean;
  /** 单聊显示气泡尾巴；群聊不显示（2026-10-23：群聊改为无尾巴的整体气泡）。 */
  tail?: boolean;
  /** 显式语言（围栏/发送前选择/发送后切换）；缺省自动识别。 */
  language?: string | null;
  /** 只有发送方能在发送后切换语言；非发送方只读。 */
  canSwitchLang?: boolean;
  /** 切换请求进行中：头部保留旧语言，只转圈。 */
  switching?: boolean;
  /** 全文弹窗是否打开：驱动展开按钮的 `aria-expanded`（折叠态恒为 false）。 */
  expanded?: boolean;
}>();
const emit = defineEmits<{
  (e: "expand", code: string): void;
  (e: "copy", code: string): void;
  (e: "switch-lang", value: string | null): void;
}>();

/**
 * 代码卡片底色（亮/暗）。截断容器 / 操作条 / 尖角三处必须同色：
 * 截断容器若透明，CodeBlock 实际高度不足 CODE_CLAMP_HEIGHT 时，容器底部会露出一条画布色亮缝。
 */
const surface = computed(() => (props.dark ? CODE_SURFACE.dark : CODE_SURFACE.light));
/** 操作条与 CodeBlock 代码区同底色（分隔线颜色仍取同款描边色）。 */
const actionsStyle = computed(() => ({
  background: surface.value,
  borderColor: "var(--gosslan-border)",
}));
/** 尖角取代码卡片底色（代码气泡不走 bubbleStyle，得自己给 --bubble-bg 赋值）。 */
const tailBg = computed(() => surface.value);

/** 折叠态被截掉的逻辑行数：操作条上给出「还有 N 行」的可发现信号（短块为 0）。 */
const hiddenLines = computed(() => (props.clamped ? codePreviewRemainingLines(props.code) : 0));

/** 右键菜单坐标（N6-1：代码块右键 →「复制」，与底栏按钮走同一个 emit）。 */
const ctx = ref<{ x: number; y: number } | null>(null);
function onContextMenu(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  // 键盘唤起（Shift+F10 / 菜单键）时 clientX/Y 会一起是 0 ⇒ 用块自己的矩形定位，
  // 否则菜单会跑到窗口左上角（与 FriendListItem 同款处理）。
  if (e.clientX === 0 && e.clientY === 0) {
    const rect = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
    if (rect) {
      ctx.value = { x: rect.left + 24, y: rect.top + 24 };
      return;
    }
  }
  ctx.value = { x: e.clientX, y: e.clientY };
}
function copyFromMenu() {
  const code = props.code;
  ctx.value = null;
  emit("copy", code);
}
</script>

<template>
  <!-- 代码卡片没有四边描边 ⇒ 尾巴的描边必须显式取卡片线 token（否则 `currentColor`
       会退到正文色：尾巴是一条深色字色的线，气泡却是无边的浅卡片）。与 `--bubble-tail-fill`
       同源，两者一起保证"尾巴 = 卡片自己那条线 + 卡片底色"。 -->
  <div
    class="relative min-w-0 flex-1"
    :style="{ '--bubble-bg': tailBg, '--bubble-line': 'var(--gosslan-card-line)' }"
    @contextmenu="onContextMenu"
  >
    <ContextMenu v-if="ctx" :x="ctx.x" :y="ctx.y" @close="ctx = null">
      <DropdownMenuItem class="gosslan-menu-item" @select="copyFromMenu">
        <Icon name="copy" class="h-3.5 w-3.5" />
        {{ t("common.copy") }}
      </DropdownMenuItem>
    </ContextMenu>
    <!-- 截断容器固定 CODE_CLAMP_HEIGHT（与 VirtualList 的估算常量同源）。
         若容器透明，CodeBlock 实际渲染高度不足该值时，底部会空出一条画布色亮缝
         （卡片与操作条之间「露出聊天背景」）；故容器自身填卡片底色兜底。
         同时卡片不画下边框，分隔线统一由操作条上边框绘制，避免叠出双线。 -->
    <!-- 折叠态（用户 2026-11-06：「代码在消息列表不需要滚动，只展示固定几行，余下截断，
         展开滚动展示」）：父层锁死 CODE_CLAMP_HEIGHT，CodeBlock 撑满但**不是滚动容器**
         （`clipped` ⇒ pre 是 overflow:hidden）⇒ 滚轮/触控事件冒泡给外层消息列表。
         底部再压一层同色渐隐 + 操作条上的「还有 N 行」，让"被截断"可发现。 -->
    <div
      v-if="clamped"
      data-code-fold="clamped"
      class="relative overflow-hidden rounded-t-[var(--gosslan-radius-sm)]"
      :style="{ height: `${CODE_CLAMP_HEIGHT}px`, background: surface }"
    >
      <CodeBlock
        :code="code"
        :language="language"
        :can-switch-lang="canSwitchLang"
        :switching="switching"
        attached
        fill
        clipped
        @switch-language="emit('switch-lang', $event)"
      />
      <div
        v-if="hiddenLines > 0"
        class="code-clip-fade pointer-events-none absolute inset-x-0 bottom-0 h-4"
        aria-hidden="true"
        :style="{ background: `linear-gradient(to bottom, transparent, ${surface})` }"
      />
    </div>
    <CodeBlock
      v-else
      :code="code"
      :language="language"
      :can-switch-lang="canSwitchLang"
      :switching="switching"
      attached
      @switch-language="emit('switch-lang', $event)"
    />
    <!-- 操作条＝代码卡片的底栏：总高恒为 previewMetrics.CODE_ACTION_BAR(28px)，改样式不要动高度 -->
    <div class="code-actions" :style="actionsStyle">
      <button
        v-if="clamped"
        class="tap-safe preview-action"
        data-code-fold-expand
        aria-haspopup="dialog"
        :aria-expanded="expanded ? 'true' : 'false'"
        @click="emit('expand', code)"
      >{{ t("common.expand") }}</button>
      <!-- 截断的可发现信号：明确告诉用户「还有 N 行」没显示（不是滚动条不见了）。 -->
      <span
        v-if="hiddenLines > 0"
        class="min-w-0 truncate text-caption opacity-60"
        :title="t('code.moreLines', { n: hiddenLines })"
        data-code-more
      >{{ t("code.moreLines", { n: hiddenLines }) }}</span>
      <button
        class="tap-safe preview-action"
        :class="copied ? 'opacity-100' : 'opacity-70 hover:opacity-100'"
        @click="emit('copy', code)"
      >
        <Icon name="check" v-if="copied" class="h-3 w-3" />
        <Icon name="copy" v-else class="h-3 w-3" />
        {{ copied ? t("common.copied") : t("common.copy") }}
      </button>
    </div>
    <BubbleTail v-if="tail" :mine="mine" />
  </div>
</template>

<style scoped>
/* 代码气泡尖角：位置跟全局 `.bubble-tail`（左下角贴底边），这里只补颜色。
   2026-10-24：尾巴落在卡片底栏（`actionsStyle` 与代码区同底色 `surface`），
   所以直接取 `--bubble-bg`（= 同一个 surface）即可 —— 不再混黑/混白。
   旧版混 4%/5% 是为了让尖角在 toolbar 上「看得见」，那会在浅灰卡片上露出一块深灰尾巴，
   正是用户截图里「尾巴颜色跟卡片对不上」的来源。
   位置只有全局那一个家，别在这里再钉一份。 */
.bubble-tail.tail-mine,
.bubble-tail.tail-other {
  --bubble-tail-fill: var(--bubble-bg);
}
/* 代码卡片底栏：与上面的 CodeBlock 共用同款底色，衔接成一张完整卡片。
   高度锁死 28px（border-box）= previewMetrics.CODE_ACTION_BAR，不要动。
   卡片已无描边，这里也只画「上分隔线」——代码区与底栏同色，没有这条线会糊成一片；
   四边描边则会让气泡重新出现一圈外描边（正是本次要去掉的东西）。 */
.code-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 28px;
  padding: 0 4px;
  border-style: solid;
  border-width: 1px 0 0;
  border-radius: 0 0 var(--gosslan-radius-md) var(--gosslan-radius-md);
}
</style>
