<script setup lang="ts">
import { t } from "@/i18n";
import { ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import BaseModal from "@/components/BaseModal.vue";
import { avatarSeedFor } from "@/utils/avatarSeed";
import { Check } from "@/components/ui/icons";
import { useSubmitGuard } from "@/composables/useSubmitGuard";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";
import { groupNameSchema, MAX_GROUP_NAME_CHARS } from "@/utils/validation";
import CharCounter from "@/components/ui/CharCounter.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();
const router = useRouter();
const chat = useChatStore();
const name = ref("");
const selected = ref<string[]>([]);
/** 建群是在途提交只放行一次：双击不会建出两个群。 */
const { busy: creating, run: runCreate } = useSubmitGuard();
const ime = useImeEnterGuard();

watch(
  () => props.open,
  (v) => {
    if (v) {
      name.value = "";
      selected.value = [];
      chat.refreshFriends();
    }
  },
);

function toggle(id: string) {
  const i = selected.value.indexOf(id);
  if (i >= 0) selected.value.splice(i, 1);
  else selected.value.push(id);
}

async function create() {
  const parsed = groupNameSchema.safeParse(name.value);
  if (!parsed.success) {
    // 报**实际违反的那条**：超长过去也被说成"请输入群名称"（原因说错了）。
    const issue = parsed.error.issues[0];
    app.toast(t(issue ? issue.message : "group.toast.nameEmpty", { max: MAX_GROUP_NAME_CHARS }), "error");
    return;
  }
  if (selected.value.length === 0) {
    app.toast(t("group.toast.noMember"), "error");
    return;
  }
  // 双击/重复点击只会发一次 createGroup（校验在拿到提交权之前做，不占着 busy）。
  await runCreate(async () => {
    try {
      const g = await chat.createGroup(parsed.data, selected.value);
      app.toast(t("group.toast.created", { name: g.name }), "success");
      // 「打开会话」的入口一律是两步：store + 路由（`navState` 由路由现算，只写 store 的话
      // 站在收藏/联系人那一屏就看不见换屏）。与 TaskCenter / ConversationList 同一口径。
      chat.openConversation(`group:${g.id}`);
      try {
        // ⚠️ 关弹窗必须排在导航落地之后：`BaseModal` 默认那层返回键在释放时会 `history.back()`，
        //   而 Vue 的 watcher 早于 vue-router 写历史条目 ⇒ 先关会把刚进来的群聊页原路退回
        //   （负责人 2026-10-26 在任务中心实报的那格，同一族；修见 `TaskCenter.openConversation`）。
        await router.push({ name: "conversation", params: { convId: `group:${g.id}` } });
      } finally {
        emit("close");
      }
    } catch (e) {
      app.toastError(e, t("group.toast.createFail"));
    }
  });
}
</script>

<template>
  <BaseModal :open="open" :title="t('group.create.title')" @close="emit('close')">
    <div class="mb-4">
      <div class="mb-1.5 flex items-baseline justify-between gap-2">
        <span class="text-sm">{{ t("group.name") }}</span>
        <CharCounter :text="name" :max="MAX_GROUP_NAME_CHARS" />
      </div>
      <input
        v-model="name"
        class="w-full rounded-[var(--gosslan-radius-md)] border border-transparent bg-[var(--gosslan-bg)] px-3 py-2 text-sm outline-none transition focus:border-transparent"
        :placeholder="t('group.namePlaceholder')"
        :maxlength="MAX_GROUP_NAME_CHARS"
        enterkeyhint="done"
        @keydown.enter="ime.enter(create, $event)"
        @compositionstart="ime.onStart"
        @compositionend="ime.onEnd"
      />
    </div>

    <div class="mb-1.5 text-sm">{{ t("group.selectMembers") }}</div>
    <div class="max-h-56 overflow-y-auto">
      <!-- 选择行必须是**真按钮**：`div @click` 触屏/鼠标能用，键盘 Tab 不到、回车没反应，
           读屏也只会念成一段普通文本。`aria-pressed` 表达"选中/未选中"开关语义。 -->
      <button
        v-for="f in chat.friends"
        :key="f.device_id"
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 rounded-[var(--gosslan-radius-md)] px-2 py-2 text-left transition hover:bg-[var(--gosslan-hover)]"
        :aria-pressed="selected.includes(f.device_id)"
        @click="toggle(f.device_id)"
      >
        <div
          class="flex h-4 w-4 items-center justify-center rounded-[var(--gosslan-radius-xs)] border"
          :class="selected.includes(f.device_id) ? 'border-primary bg-[var(--gosslan-primary-active)]' : 'border-[var(--gosslan-border)]'"
        >
          <Check v-if="selected.includes(f.device_id)" class="h-3 w-3 text-[var(--gosslan-on-primary)]" />
        </div>
        <div
          class="gosslan-avatar-box flex h-8 w-8 items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] text-white"
          :style="{ backgroundColor: avatarSeedFor(f.device_id)?.bg }"
        >
          <img alt="" v-if="f.avatar" :src="f.avatar" class="h-full w-full object-cover" />
          <span v-else class="gosslan-avatar-emoji" aria-hidden="true">{{ avatarSeedFor(f.device_id)?.emoji }}</span>
        </div>
        <span class="flex-1 text-sm">{{ f.nickname }}</span>
        <span class="text-xs text-[var(--gosslan-text-2)]">{{ f.online ? t("common.online") : t("common.offline") }}</span>
      </button>
      <div v-if="chat.friends.length === 0" class="py-6 text-center text-sm text-[var(--gosslan-text-2)]">
        {{ t("group.noFriends") }}
      </div>
    </div>

    <PrimaryBtn size="dense" class="mt-4 w-full" :disabled="selected.length === 0 || !name.trim() || creating" @click="create">
      {{ t("common.createGroup") }}
    </PrimaryBtn>
  </BaseModal>
</template>
