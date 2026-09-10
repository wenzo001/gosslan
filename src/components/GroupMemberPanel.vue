<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import BaseModal from "@/components/BaseModal.vue";
import { useMemberProfile } from "@/composables/useMemberProfile";
import { avatarInitial, nameToColor } from "@/utils/color";
import { ArrowRightLeft, Crown, LogOut, Plus, UserMinus, X } from "lucide-vue-next";
import type { Friend } from "@/types";

const props = defineProps<{ open: boolean; groupId: string | null }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();
const chat = useChatStore();
const { memberProfile, myId } = useMemberProfile();
const group = computed(() => chat.groups.find((g) => g.id === props.groupId) ?? null);
/** 当前用户是否为群主（可见「添加/移除成员」操作） */
const isOwner = computed(() => !!group.value && group.value.creator === myId.value);
/** 展示「添加成员」面板 */
const showAdd = ref(false);

watch(
  () => props.open,
  (v) => {
    if (v) {
      showAdd.value = false;
      if (props.groupId) void chat.refreshGroups();
    }
  },
);

function initials(n: string) {
  return avatarInitial(n);
}

/** 成员资料解析统一走 useMemberProfile（本机/好友表/在线节点），此处不再重复实现。 */

/** 可用于加入该群的好友 = 好友 - 已是成员 - 自己 */
const addableFriends = computed(() => {
  const members = group.value?.members ?? [];
  return chat.friends.filter((f) => !members.includes(f.device_id) && f.device_id !== myId.value);
});

async function addMember(f: Friend) {
  if (!props.groupId) return;
  try {
    await chat.addGroupMember(props.groupId, f.device_id);
    app.toast(`已将 ${f.nickname} 加入群聊`, "success");
  } catch (e) {
    app.toast(String(e), "error");
  }
}

async function removeMember(id: string) {
  if (!props.groupId) return;
  const p = memberProfile(id);
  try {
    await chat.removeGroupMember(props.groupId, id);
    app.toast(`已将 ${p.name} 移出群聊`, "success");
  } catch (e) {
    app.toast(String(e), "error");
  }
}

/** 转让群主（仅当前群主）：把管理权交给指定成员，避免换机后群无法管理。 */
async function transferOwner(id: string) {
  if (!props.groupId) return;
  const p = memberProfile(id);
  const ok = window.confirm(
    `确定把群主转让给 ${p.name} 吗？\n\n转让后你将失去改名、添加与移除成员的权限。`,
  );
  if (!ok) return;
  try {
    await chat.transferGroupCreator(props.groupId, id);
    app.toast(`已将群主转让给 ${p.name}`, "success");
  } catch (e) {
    app.toast(String(e), "error");
  }
}

/** 退出群聊（群主须先转让，后端会拒绝并给出提示）。 */
async function leaveGroup() {
  if (!props.groupId) return;
  const name = group.value?.name ?? "该群聊";
  const ok = window.confirm(
    `确定退出「${name}」吗？\n\n本机将删除该群的聊天记录，需要重新被拉入才能恢复。`,
  );
  if (!ok) return;
  try {
    await chat.leaveGroup(props.groupId);
    app.toast("已退出群聊", "success");
    emit("close");
  } catch (e) {
    app.toast(String(e), "error");
  }
}
</script>

<template>
  <BaseModal :open="open" :title="group ? `群成员（${group.members.length}）` : '群成员'" @close="emit('close')">
    <div v-if="group" class="space-y-3">
      <!-- 当前成员 -->
      <div class="max-h-56 overflow-y-auto">
        <div
          v-for="id in group.members"
          :key="id"
          class="flex items-center gap-2.5 rounded-lg px-2 py-2"
        >
          <div class="relative shrink-0">
            <div
              class="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] text-white"
              :class="!memberProfile(id).online ? 'grayscale opacity-70' : ''"
              :style="{ backgroundColor: nameToColor(memberProfile(id).name) }"
            >
              <img v-if="memberProfile(id).avatar" :src="memberProfile(id).avatar ?? undefined" class="h-full w-full object-cover" />
              <span v-else class="text-xs font-semibold">{{ initials(memberProfile(id).name) }}</span>
            </div>
            <span
              class="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[var(--gosslan-panel)]"
              :class="memberProfile(id).online ? 'bg-emerald-500' : 'bg-neutral-400'"
            ></span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-sm font-medium">{{ memberProfile(id).name }}</span>
              <Crown v-if="group.creator === id" class="h-3.5 w-3.5 shrink-0 text-amber-500" title="群主" />
              <span v-if="id === myId" class="shrink-0 text-[11px] text-[var(--gosslan-text-2)]">（我）</span>
            </div>
            <div class="text-xs text-[var(--gosslan-text-2)]">
              {{ memberProfile(id).online ? "在线" : "离线" }}
            </div>
          </div>
          <!-- 群主操作：转让群主 / 移除成员（不能操作自己/创建者本人） -->
          <button
            v-if="isOwner && id !== myId"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--gosslan-text-2)] transition hover:bg-amber-500/10 hover:text-amber-500"
            :title="`把群主转让给 ${memberProfile(id).name}`"
            @click="transferOwner(id)"
          >
            <ArrowRightLeft class="h-4 w-4" />
          </button>
          <button
            v-if="isOwner && id !== myId"
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--gosslan-text-2)] transition hover:bg-red-500/10 hover:text-red-500"
            :title="`将 ${memberProfile(id).name} 移出群聊`"
            @click="removeMember(id)"
          >
            <UserMinus class="h-4 w-4" />
          </button>
        </div>
        <div v-if="group.members.length === 0" class="py-6 text-center text-sm text-[var(--gosslan-text-2)]">
          暂无成员
        </div>
      </div>

      <!-- 添加成员（仅群主）：切换出一列可选好友 -->
      <template v-if="isOwner">
        <button
          v-if="!showAdd"
          class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--gosslan-border)] py-2 text-sm text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
          @click="showAdd = true"
        >
          <Plus class="h-4 w-4" />
          添加成员
        </button>
        <div v-else class="rounded-xl border border-[var(--gosslan-border)] p-2">
          <div class="mb-1 flex items-center justify-between px-1">
            <span class="text-xs font-medium text-[var(--gosslan-text-2)]">选择好友加入</span>
            <button
              class="flex items-center justify-center rounded p-1 text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
              title="收起"
              @click="showAdd = false"
            >
              <X class="h-3.5 w-3.5" />
            </button>
          </div>
          <div class="max-h-40 overflow-y-auto">
            <div
              v-for="f in addableFriends"
              :key="f.device_id"
              class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-[var(--gosslan-hover)]"
              @click="addMember(f)"
            >
              <div
                class="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] text-white"
                :style="{ backgroundColor: nameToColor(f.nickname) }"
              >
                <img v-if="f.avatar" :src="f.avatar" class="h-full w-full object-cover" />
                <span v-else class="text-[11px] font-semibold">{{ initials(f.nickname) }}</span>
              </div>
              <span class="min-w-0 flex-1 truncate text-sm">{{ f.nickname }}</span>
              <Plus class="h-3.5 w-3.5 shrink-0 text-[var(--gosslan-text-2)]" />
            </div>
            <div v-if="addableFriends.length === 0" class="py-3 text-center text-xs text-[var(--gosslan-text-2)]">
              所有好友都已在群中
            </div>
          </div>
        </div>
      </template>

      <!-- 退出群聊：群主须先转让后再退出（后端会拒绝群主直接退群） -->
      <button
        v-if="!isOwner"
        class="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--gosslan-border)] py-2 text-sm text-red-500 transition hover:bg-red-500/10"
        @click="leaveGroup"
      >
        <LogOut class="h-4 w-4" />
        退出群聊
      </button>
      <p v-if="!isOwner" class="text-[11px] text-[var(--gosslan-text-2)]">
        仅群创建者可管理成员（添加 / 移除 / 转让群主）。
      </p>
      <p v-else class="text-[11px] text-[var(--gosslan-text-2)]">
        群主如需退出群聊，请先把群主转让给其他成员。
      </p>
    </div>
  </BaseModal>
</template>
