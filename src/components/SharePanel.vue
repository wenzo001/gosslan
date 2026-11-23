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
import OverlayScroll from "@/components/ui/OverlayScroll.vue";
import AvatarBox from "@/components/ui/AvatarBox.vue";
import GroupAvatar from "@/components/ui/GroupAvatar.vue";
import { useMemberProfile } from "@/composables/useMemberProfile";
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
import type { Conversation } from "@/types";
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
// 头像与左栏会话列表**同源**（用户 2026-11-23：「用户头像还有群头像应该跟消息列表同步」）：
// 单聊走 AvatarBox(conv.avatar)，群聊走 GroupAvatar 的成员簇；成员资料解析统一走
// useMemberProfile（本机/好友/节点，离线好友照常显示）——与 ConversationListItem 逐字同款。
const { memberProfile } = useMemberProfile();
function groupMembersOf(c: Conversation): { id: string; avatar: string | null }[] {
  if (c.kind !== "group") return [];
  const groupId = c.id.replace(/^group:/, "");
  const memberIds = chat.groups.find((g) => g.id === groupId)?.members ?? [];
  return memberIds.map((id) => ({ id, avatar: memberProfile(id).avatar }));
}
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
//
// 定向分享（RP 给了 `to`）：**预勾**那个目标 —— 但**不代替用户点发送**。
// 用户仍要点「发送」才真的发出去（裁决 2026-11-15：不能静默往聊天框塞东西）。
const preselectTarget = ref<string | null>(null);
watch(
  () => store.pending?.shareId,
  (id) => {
    if (!id) return;
    draft.value = store.pending ? composeShareText(store.pending.payload) : "";
    selected.value = [];
    query.value = "";
    preselectTarget.value = store.pending?.payload.to ?? null;
  },
  { immediate: true },
);

const originHost = computed(() =>
  store.pending ? shareOriginHost(store.pending.payload) : null,
);
const targets = computed(() =>
  sortShareTargets(chat.conversations.filter((c) => matchShareTarget(c, query.value))),
);
// 目标会话出现在列表里之后才勾它：会话是异步加载的，
// 列表还没出来就勾 ⇒ 勾了一个列表里不存在的 id（发送会失败）。
watch(targets, (list) => {
  const t = preselectTarget.value;
  if (!t) return;
  if (!list.some((c) => c.id === t)) return;
  selected.value = [t];
  preselectTarget.value = null;
});
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

  // 回执（可选）：告诉 RP 到底发出去了几条。
  // 后端自己从队列里取回执地址（前端不传地址 ⇒ 前端无法把回执发去别处），
  // 没提供端点时后端回 false，不算错误。
  // ⚠️ 必须 await（2026-11-20 审计修）：过去 fire-and-forget 与下面的 dismiss 竞争同一队列项，
  // dismiss 先删条目 ⇒ reportReceipt 取不到端点 ⇒ 全成功路径的回执必丢。回执失败内部已吞错，
  // await 只会稍等一拍、不会给用户弹错。
  await reportReceipt(ids.length - failed.length, failed.length, failed.length ? "partial" : "sent");

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

/** 上报回执；失败只记日志不上屏（回执是给 RP 的附带信息，用户已经看到结果了）。 */
async function reportReceipt(sent: number, failed: number, status: string) {
  const id = store.pending?.shareId;
  if (!id) return;
  try {
    await api.shareReportReceipt(id, status, sent, failed);
  } catch (e) {
    console.warn("[share] 回执上报失败", e);
  }
}

async function onClose() {
  if (sending.value) return;
  // 取消也要给 RP 一条回执（用户 2026-11-23：三方页面还在等 Gosslan 回执）——
  // 静默关面板 = 对端要干等到条目 TTL（10 分钟）才超时。status="cancelled"、
  // sent/failed 都是 0；Idempotency-Key 仍是 share_id（已报过发送回执的这条，
  // RP 侧按幂等键合并，不会出现两条）。
  // ⚠️ 必须**先报再 dismiss**：dismiss 清掉队列项后端点就取不到了（与 onSend 的
  // 2026-11-20 竞争修复同一形状）。
  await reportReceipt(0, 0, "cancelled");
  await store.dismiss();
}
</script>

<template>
  <BaseModal
    :open="store.visible"
    :title="t('shareToChat.title')"
    :fullscreen="app.isMobile"
    :width="app.isMobile ? undefined : 'max-w-2xl'"
    @close="onClose"
  >
    <!-- ⚠️ **定高根**（用户 2026-11-23 重设计）：桌面 `h-[min(560px,calc(100vh-200px))]`
         —— 弹窗自己给高度，不靠祖先链推导；200px 预留给「标题行 + 底栏 + 卡片内边距」，
        保证整张卡片恒 ≤ 视口 ⇒ **外层永远没有滚动条**。移动端整屏（h-full）。
         内部：上部信息全 `shrink-0`（紧凑、固定），列表 `flex-1 min-h-0` **独占滚动**。 -->
    <div
      class="flex min-h-0 flex-col gap-2 px-1"
      :class="app.isMobile ? 'h-full' : 'h-[min(560px,calc(100vh-200px))]'"
    >
      <!-- 顶部第 1 行（固定、单行）：来源 + 链接 + 字数。原来链接独占一行、编辑提示独占
           一行、计数独占一行 —— 三行压缩成一行，信息一条不少、高度省两行。 -->
      <div class="flex shrink-0 items-center gap-1.5 text-caption text-[var(--gosslan-text-2)]">
        <Icon name="link2" class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span class="shrink-0">
          {{ originHost ? t("shareToChat.from", { host: originHost }) : t("shareToChat.fromUnknown") }}
        </span>
        <a
          v-if="store.pending?.payload.url"
          :href="store.pending.payload.url"
          target="_blank"
          rel="noreferrer noopener"
          class="min-w-0 flex-1 truncate text-[var(--gosslan-accent-ink)] underline decoration-dotted"
          :title="store.pending.payload.url"
        >{{ store.pending.payload.url }}</a>
        <span
          v-else
          class="min-w-0 flex-1"
        ></span>
        <span
          class="shrink-0 tabular-nums"
          :class="textError === 'tooLong' ? 'text-[var(--gosslan-danger-ink)]' : ''"
        >{{ used }}/{{ MAX_SHARE_TEXT_CHARS }}</span>
      </div>

      <!-- 编辑器（固定，紧凑 5 行）：内容可改；编辑提示降级为 aria-label，不再占一行。 -->
      <textarea
        v-model="draft"
        class="h-20 w-full shrink-0 resize-none rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-app-bg)] p-2.5 text-sm text-[var(--gosslan-text)] focus:border-[var(--gosslan-primary)] focus:outline-none"
        :aria-label="t('shareToChat.editHint')"
        :maxlength="MAX_SHARE_TEXT_CHARS + 1"
      ></textarea>

      <p v-if="textError === 'tooLong'" class="shrink-0 text-caption text-[var(--gosslan-danger-ink)]">
        {{ t("shareToChat.tooLong", { max: MAX_SHARE_TEXT_CHARS }) }}
      </p>

      <!-- 搜索（固定，紧凑 h-9） -->
      <div class="relative shrink-0">
        <Icon
          name="search"
          class="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-[var(--gosslan-text-2)]"
          aria-hidden="true"
        />
        <input
          v-model="query"
          type="search"
          class="h-9 w-full rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-field-border)] bg-[var(--gosslan-app-bg)] pl-8 pr-2.5 text-sm text-[var(--gosslan-text)] focus:border-[var(--gosslan-primary)] focus:outline-none"
          :placeholder="t('shareToChat.searchPlaceholder')"
          :aria-label="t('shareToChat.searchPlaceholder')"
        />
      </div>

      <!-- 会话列表：**唯一的滚动区**，吃满剩余高度。选中态：左侧方形勾选 + 底色 + 加粗，
           一眼能看出"要发给谁"（用户 2026-11-23：最重要的是分享列表的选择）。 -->
      <OverlayScroll
        role="group"
        :aria-label="t('shareToChat.pickHint')"
        class="min-h-0 flex-1 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-divider)]"
      >
        <p v-if="!targets.length" class="px-3 py-4 text-center text-caption text-[var(--gosslan-text-2)]">
          {{ t("shareToChat.noTargets") }}
        </p>
        <button
          v-for="c in targets"
          :key="c.id"
          type="button"
          role="checkbox"
          :aria-checked="selected.includes(c.id)"
          class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-[var(--gosslan-hover)]"
          :class="selected.includes(c.id) ? 'bg-[var(--gosslan-list-active)]' : ''"
          @click="toggleTarget(c.id)"
        >
          <span
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-xs)] border"
            :class="selected.includes(c.id)
              ? 'border-[var(--gosslan-primary)] bg-[var(--gosslan-primary)] text-[var(--gosslan-on-primary)]'
              : 'border-[var(--gosslan-field-border)]'"
            aria-hidden="true"
          >
            <Icon v-if="selected.includes(c.id)" name="check" class="h-3 w-3" />
          </span>
          <!-- 头像与左栏列表同源：群聊=成员簇（GroupAvatar），单聊=会话头像（AvatarBox）。 -->
          <GroupAvatar
            v-if="c.kind === 'group' && groupMembersOf(c).length"
            :members="groupMembersOf(c)"
            class="shrink-0"
          />
          <AvatarBox
            v-else
            class="h-7 w-7 shrink-0"
            :id="c.id"
            :src="c.avatar"
          />
          <span
            class="min-w-0 flex-1 truncate text-sm text-[var(--gosslan-text)]"
            :class="selected.includes(c.id) ? 'font-medium' : ''"
            :title="c.name"
          >{{ c.name }}</span>
        </button>
      </OverlayScroll>
    </div>

    <!-- 操作按钮走 BaseModal 的 **footer 插槽**：它在内容滚动区**之外**，
         所以永远钉在弹窗底部（用户 2026-11-20：「发送和取消应该固定在弹窗底部」）。 -->
    <template #footer>
      <div class="flex items-center justify-end gap-2">
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
    </template>
  </BaseModal>
</template>
