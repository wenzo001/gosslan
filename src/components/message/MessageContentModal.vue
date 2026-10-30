<script setup lang="ts">
import { t } from "@/i18n";
import { computed } from "vue";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "@/stores/useAppStore";
import BaseModal from "@/components/BaseModal.vue";
import CodeBlock from "@/components/CodeBlock.vue";
import { useMessageSegments } from "@/composables/useMessageSegments";
import MessageLinkText from "@/components/message/MessageLinkText.vue";
import { mentionHighlightBg, mentionHighlightColor } from "@/utils/chatStyle";
import { Copy } from "lucide-vue-next";
import { Check } from "@/components/ui/icons";

const props = defineProps<{
  open: boolean;
  kind: "text" | "code";
  content: string;
  copied: boolean;
  /** 群成员名列表：与气泡共用同一套 @ 高亮，避免"气泡里高亮、全文里是纯文本"。 */
  mentionNames?: string[];
  /** 查看者自己是谁：@到自己 那一段渲染成「@你」并加重（与 MessageTextBubble 同一份判据）。 */
  selfMention?: { name: string; label: string; id?: string } | null;
  /** @ 的落点（#122）：传了才按身份判「这一段属于谁」，不传按昵称兜底。 */
  mentionTargets?: { id: string; name: string; n: number }[] | null;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "copy", content: string): void;
}>();

const app = useAppStore();
// 切段循环单源在 `composables/useMessageSegments`（与气泡、任务详情同一份，DUP-06）。
// `code` 那一档没有段：给它空正文，家自然就返回空数组。
const segments = useMessageSegments(
  () => (props.kind === "text" ? props.content : ""),
  () => props,
);

/** @提及配色：以弹窗面板底色为对比基准（气泡那套是按气泡底色算的，这里不能复用）。
 *  从 CSS 变量读真实面板色，避免将来改了主题 token 这里忘记同步。 */
const mentionFg = computed(() => {
  const panel = getComputedStyle(document.documentElement).getPropertyValue("--gosslan-panel").trim();
  return mentionHighlightColor(app.themeColor, app.dark, panel);
});

/** @提及 淡背景：与气泡**同一个家**（`utils/chatStyle.ts::mentionHighlightBg`）。
 *  ⚠️ 必须显式给：不给就落到 style.css 里 12% 的兜底值，同一句话在气泡与全文里
 *  色块深浅会不一致。两处前景色的来源不同（气泡按气泡底色、这里按面板底色算对比度），
 *  但"已知前景色之后怎么调出底色"只有这一份。 */
const mentionBg = computed(() => mentionHighlightBg(mentionFg.value));

async function openLink(href: string) {
  try {
    await openUrl(href);
  } catch (e) {
    app.toastError(e, t("msg.openLinkFail"));
  }
}
</script>

<template>
  <!-- 全文弹窗：文本 / 代码共用，内容可滚动、可复制；关闭后消息布局不变 -->
  <BaseModal
    :open="open"
    :title="kind === 'code' ? t('msg.codePreview') : t('msg.fullText')"
    width="max-w-4xl"
    @close="emit('close')"
  >
    <div class="max-h-[70vh] overflow-y-auto">
      <CodeBlock v-if="kind === 'code'" :code="content" />
      <div
        v-else
        class="gosslan-selectable whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--gosslan-text)]"
        :style="{ wordBreak: 'break-word' }"
      >
        <template v-for="(seg, i) in segments" :key="i">
          <MessageLinkText
            v-if="seg.kind === 'link'"
            class="text-[var(--gosslan-primary)]"
            :href="seg.href"
            :label="seg.value"
            @open="openLink"
          />
          <img
            loading="lazy" decoding="async"
            v-else-if="seg.kind === 'emoji'"
            :src="seg.url"
            :alt="seg.value"
            :title="seg.value"
            class="emoji-img"
          />
          <span
            v-else-if="seg.kind === 'mention' || seg.kind === 'mention-self'"
            class="mention-token"
            :class="{ 'mention-token--self': seg.kind === 'mention-self' }"
            :style="{ color: mentionFg || undefined, background: mentionBg || undefined }"
          >{{ seg.value }}</span>
          <span v-else>{{ seg.value }}</span>
        </template>
      </div>
    </div>
    <div class="mt-3 flex justify-end">
      <button
        class="tap-safe preview-action"
        :class="copied ? 'text-[var(--gosslan-primary)]' : ''"
        @click="emit('copy', content)"
      >
        <Check v-if="copied" class="h-3 w-3" />
        <Copy v-else class="h-3 w-3" />
        {{ copied ? t("common.copied") : t("common.copy") }}
      </button>
    </div>
  </BaseModal>
</template>
