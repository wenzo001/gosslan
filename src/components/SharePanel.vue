<script setup lang="ts">
/**
 * 外部分享到会话的面板：外部网页/应用经深链把一条内容递进来，用户在这里**确认内容、
 * 选会话（可多选）、显式点发送**。
 *
 * 为什么必须是这样（活契约 §6 / §D 的红线）：
 * - 分享入口**任何网页都能触发**（`gosslan://share?...` 就是个链接）。自动发送等于给网页
 *   一个静默发消息的通道，所以这里恒需一次用户手势，关闭面板 = 什么都不发。
 * - 不预选会话：预选 + 回车就是"一路点确定"，用户很可能没看清发给谁。
 * - 多选是**逐个显式勾**（设计稿验收矩阵要求「多选、逐项可辨认」），不是"发给最近的人"；
 *   按钮上带目标数，点之前就能看见这次要发给几个会话。
 * - 部分失败不整笔回滚：已发出去的消息收不回来，能做的只有「留住面板 + 只保留失败的那几个勾选
 *   + 草稿不动」，让用户直接再点一次。
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
const selected = ref<string[]>([]);
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
  // 系统分享目标（平台扩展写进「落地区」的文件）：用户切回本应用时补扫一次。
  //
  // 触发点选「窗口重新获得焦点」而不是「定时轮询」：分享是低频动作，
  // 给一个常驻托盘的客户端挂一条永不停歇的 IPC 轮询不划算；而用户从别的应用
  // 分享完切回来的那一刻，正是最该捡起这条分享的时刻。
  const onWindowFocus = () => {
    void store.load();
  };
  window.addEventListener("focus", onWindowFocus);
  scope.onDispose(() => window.removeEventListener("focus", onWindowFocus));
});
onUnmounted(() => scope.dispose());

// 换了一条（或第一次打开）：草稿与选中都重置，别把上一条的编辑内容带过去。
watch(
  () => store.pending?.shareId,
  (id) => {
    if (!id) return;
    draft.value = store.pending ? composeShareText(store.pending.payload) : "";
    selected.value = [];
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
const canSend = computed(() => !textError.value && selected.value.length > 0 && !sending.value);

/** 会话名只用于提示文案；查不到就退回空串（提示里会退化成「已发送」而不是露出 id）。 */
function nameOf(id: string): string {
  return chat.conversations.find((c) => c.id === id)?.name ?? "";
}

/** 点一下切换勾选；勾选顺序即发送顺序，用户能预期「先发给谁」。 */
function toggleTarget(id: string) {
  const i = selected.value.indexOf(id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(id);
}

async function onSend() {
  const ids = [...selected.value];
  if (!ids.length || textError.value || sending.value) return;
  sending.value = true;
  const body = draft.value.trim();
  const failed: string[] = [];
  let firstError: unknown = null;
  let ok = 0;
  try {
    for (const id of ids) {
      try {
        // 每个会话都走既有的统一发送路径（乐观上屏 / 台账 / 失败态全在那一层），
        // 不另开一条发送通道，也不批量吞异常：一个会话失败不该挡住后面的。
        await chat.send(id, body, "text");
        ok += 1;
      } catch (e) {
        failed.push(id);
        firstError ??= e;
      }
    }
  } finally {
    sending.value = false;
  }

  if (!failed.length) {
    app.toast(
      ids.length === 1
        ? t("shareToChat.sent", { name: nameOf(ids[0]) })
        : t("shareToChat.sentMany", { count: ids.length }),
      "success",
    );
    await store.dismiss();
    return;
  }

  // 部分/全部失败：**保留面板与草稿**，只把失败的那几个留在勾选里 —— 已发出去的消息收不回来，
  // 所以这里的"重试"只能是"把没发成的再发一次"，不能重发全部（会重复）。
  selected.value = failed;
  // 一个都没成 ⇒ 用「分享发送失败」；部分成 ⇒ 报清成功/失败数（用户要知道哪些已经发出去了）。
  app.toastError(
    firstError,
    ok === 0
      ? t("shareToChat.sendFail")
      : t("shareToChat.sendPartial", { ok, fail: failed.length }),
  );
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

      <!-- 会话列表：逐项勾选（可多选），必须显式点；不预选（预选 + 回车就是一路点确定）。 -->
      <div
        role="group"
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
          role="checkbox"
          :aria-checked="selected.includes(c.id)"
          class="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-[var(--gosslan-hover)]"
          :class="selected.includes(c.id) ? 'bg-[var(--gosslan-list-active)]' : ''"
          @click="toggleTarget(c.id)"
        >
          <Icon
            :name="c.kind === 'group' ? 'users' : 'user-round'"
            class="h-4 w-4 shrink-0 text-[var(--gosslan-text-2)]"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate text-sm text-[var(--gosslan-text)]" :title="c.name">{{ c.name }}</span>
          <Icon
            v-if="selected.includes(c.id)"
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
          <!-- 多选时把目标数写进按钮：点之前就能看见这次要发给几个会话。 -->
          <template v-if="sending">{{ t("shareToChat.sending") }}</template>
          <template v-else-if="selected.length > 1">
            {{ t("shareToChat.sendToCount", { count: selected.length }) }}
          </template>
          <template v-else>{{ t("shareToChat.send") }}</template>
        </PrimaryBtn>
      </div>
    </div>
  </BaseModal>
</template>
