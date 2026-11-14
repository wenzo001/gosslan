<script setup lang="ts">
/**
 * 外部分享到会话的面板：外部网页/应用经深链把一条内容递进来，用户在这里**确认内容、
 * 选一个会话、显式点发送**。
 *
 * 为什么必须是这样（活契约 §6 / §D 的红线）：
 * - 分享入口**任何网页都能触发**（`gosslan://share?...` 就是个链接）。自动发送等于给网页
 *   一个静默发消息的通道，所以这里恒需一次用户手势，关闭面板 = 什么都不发。
 * - 不预选会话：预选 + 回车就是"一路点确定"，用户很可能没看清发给谁。
 * - 不抓取网页预览：预览要把 URL 交给本机去请求（SSRF / 跟踪像素 / 内网探测），
 *   本期只显示调用方**自己给的**标题与正文，来源只作为线索展示、不参与任何信任判断。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import BaseModal from "@/components/BaseModal.vue";
import Icon from "@/components/ui/Icon.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import { api } from "@/api";
import { useShareStore } from "@/stores/useShareStore";
import { useChatStore } from "@/stores/useChatStore";
import { useAppStore } from "@/stores/useAppStore";
import { createInitScope } from "@/utils/initScope";
import { charCount } from "@/utils/text";
import {
  MAX_SHARE_TEXT_CHARS,
  composeShareText,
  matchShareTarget,
  shareOriginHost,
  shareTextError,
  sortShareTargets,
} from "@/utils/share";
import { t } from "@/i18n";

const store = useShareStore();
const chat = useChatStore();
const app = useAppStore();

const scope = createInitScope();
const query = ref("");
const draft = ref("");
const selected = ref<string | null>(null);
const sending = ref(false);

onMounted(() => {
  void api
    .onShareRequest((p) => store.setPending(p))
    .then((un) => scope.onDispose(un));
  // 链接解析失败也让用户知道：那是"点了链接什么都没发生"，不给提示只会反复点。
  // 提示本身节流（3 秒一次），否则一个坏网页反复触发就是一串一样的 toast。
  void api
    .onShareError((err) => {
      if (store.shouldToastNow()) app.toastError(err, t("shareToChat.openFail"));
    })
    .then((un) => scope.onDispose(un));
  void api.onDataCleared(() => store.clear()).then((un) => scope.onDispose(un));
  // 冷启动：事件发在窗口加载之前，靠这一条补拉回来。
  void store.load();
});
onUnmounted(() => scope.dispose());

// 换了一条（或第一次打开）：草稿与选中都重置，别把上一条的编辑内容带过去。
watch(
  () => store.pending?.shareId,
  (id) => {
    if (!id) return;
    draft.value = store.pending ? composeShareText(store.pending.payload) : "";
    selected.value = null;
    query.value = "";
  },
  { immediate: true },
);

const originHost = computed(() =>
  store.pending ? shareOriginHost(store.pending.payload) : null,
);
const targets = computed(() =>
  sortShareTargets(chat.conversations.filter((c) => matchShareTarget(c, query.value))),
);
const textError = computed(() => shareTextError(draft.value));
const used = computed(() => charCount(draft.value));
const selectedName = computed(
  () => chat.conversations.find((c) => c.id === selected.value)?.name ?? "",
);
const canSend = computed(() => !textError.value && !!selected.value && !sending.value);

async function onSend() {
  const convId = selected.value;
  if (!convId || textError.value || sending.value) return;
  sending.value = true;
  try {
    // 走既有的统一发送路径（乐观上屏 / 台账 / 失败态全在那一层），不另开一条发送通道。
    await chat.send(convId, draft.value.trim(), "text");
    app.toast(t("shareToChat.sent", { name: selectedName.value }), "success");
    await store.dismiss();
  } catch (e) {
    // 失败**保留面板与草稿**：重试要能直接点第二次，而不是回浏览器重新点一遍链接。
    app.toastError(e, t("shareToChat.sendFail"));
  } finally {
    sending.value = false;
  }
}

async function onClose() {
  if (sending.value) return;
  await store.dismiss();
}
</script>

<template>
  <BaseModal
    :open="store.visible"
    :title="t('shareToChat.title')"
    :fullscreen="app.isMobile"
    :width="app.isMobile ? undefined : 'max-w-lg'"
    @close="onClose"
  >
    <div class="flex min-h-0 flex-1 flex-col gap-3 px-1">
      <!-- 来源线索：调用方自称的站点，只用于让用户判断"这是不是我以为的那一页"。 -->
      <div class="flex items-center gap-1.5 text-xs text-[var(--gosslan-text-2)]">
        <Icon name="link2" class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span class="truncate" :title="originHost ?? t('shareToChat.fromUnknown')">
          {{ originHost ? t("shareToChat.from", { host: originHost }) : t("shareToChat.fromUnknown") }}
        </span>
      </div>

      <!-- 链接（只读）：用户可以在这里确认分享的到底是哪一页。 -->
      <a
        v-if="store.pending?.payload.url"
        :href="store.pending.payload.url"
        target="_blank"
        rel="noreferrer noopener"
        class="block truncate rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-panel)] px-2.5 py-2 text-xs text-[var(--gosslan-primary)] underline decoration-dotted"
        :title="store.pending.payload.url"
      >
        {{ store.pending.payload.url }}
      </a>

      <!-- 要发送的内容：可编辑（很多站点给的原文带一堆尾巴，用户得能删）。 -->
      <label class="flex min-h-0 flex-col gap-1">
        <span class="text-xs text-[var(--gosslan-text-2)]">{{ t("shareToChat.editHint") }}</span>
        <textarea
          v-model="draft"
          class="h-28 w-full resize-none rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-divider)] bg-[var(--gosslan-app-bg)] p-2.5 text-sm text-[var(--gosslan-text)] focus:border-[var(--gosslan-primary)] focus:outline-none"
          :aria-label="t('shareToChat.editHint')"
          :maxlength="MAX_SHARE_TEXT_CHARS + 1"
        ></textarea>
        <span
          class="self-end text-caption"
          :class="textError === 'tooLong' ? 'text-[var(--gosslan-danger-ink)]' : 'text-[var(--gosslan-text-2)]'"
        >
          {{ used }}/{{ MAX_SHARE_TEXT_CHARS }}
        </span>
      </label>

      <!-- 会话检索：几十个会话时直接打字比滚动快。 -->
      <div class="relative">
        <Icon
          name="search"
          class="pointer-events-none absolute left-2.5 top-3 h-4 w-4 text-[var(--gosslan-text-2)]"
          aria-hidden="true"
        />
        <input
          v-model="query"
          type="search"
          class="h-10 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-divider)] bg-[var(--gosslan-app-bg)] pl-8 pr-2.5 text-sm text-[var(--gosslan-text)] focus:border-[var(--gosslan-primary)] focus:outline-none"
          :placeholder="t('shareToChat.searchPlaceholder')"
          :aria-label="t('shareToChat.searchPlaceholder')"
        />
      </div>

      <!-- 会话列表：单选，必须显式点一下；不预选（预选 + 回车就是一路点确定）。 -->
      <div
        role="radiogroup"
        :aria-label="t('shareToChat.pickHint')"
        class="min-h-0 flex-1 overflow-y-auto rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-divider)]"
      >
        <p v-if="!targets.length" class="px-3 py-4 text-center text-xs text-[var(--gosslan-text-2)]">
          {{ t("shareToChat.noTargets") }}
        </p>
        <button
          v-for="c in targets"
          :key="c.id"
          type="button"
          role="radio"
          :aria-checked="selected === c.id"
          class="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-[var(--gosslan-hover)]"
          :class="selected === c.id ? 'bg-[var(--gosslan-list-active)]' : ''"
          @click="selected = c.id"
        >
          <Icon
            :name="c.kind === 'group' ? 'users' : 'user-round'"
            class="h-4 w-4 shrink-0 text-[var(--gosslan-text-2)]"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate text-sm text-[var(--gosslan-text)]" :title="c.name">{{ c.name }}</span>
          <Icon
            v-if="selected === c.id"
            name="check"
            class="h-4 w-4 shrink-0 text-[var(--gosslan-primary)]"
            aria-hidden="true"
          />
        </button>
      </div>

      <p v-if="textError === 'tooLong'" class="text-xs text-[var(--gosslan-danger-ink)]">
        {{ t("shareToChat.tooLong", { max: MAX_SHARE_TEXT_CHARS }) }}
      </p>

      <div class="flex items-center justify-end gap-2 pt-1">
        <SecondaryBtn :disabled="sending" @click="onClose">
          {{ t("common.cancel") }}
        </SecondaryBtn>
        <PrimaryBtn :disabled="!canSend" @click="onSend">
          {{ sending ? t("shareToChat.sending") : t("shareToChat.send") }}
        </PrimaryBtn>
      </div>
    </div>
  </BaseModal>
</template>
