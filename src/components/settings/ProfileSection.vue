<script setup lang="ts">
import { ref, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";

const props = defineProps<{ active: boolean; reloadToken?: number }>();

const app = useAppStore();
const chat = useChatStore();

const nickname = ref("");
const avatar = ref<string | null>(null);
const avatarInput = ref<HTMLInputElement | null>(null);

function syncFromDevice() {
  nickname.value = app.device?.nickname ?? "";
  avatar.value = app.device?.avatar ?? null;
}
watch(() => [props.active, props.reloadToken], () => {
  if (props.active) syncFromDevice();
}, { immediate: true });

/** 昵称：失焦或回车即保存（即点即存，无「保存」按钮）。 */
async function saveProfileNow() {
  const name = nickname.value.trim();
  if (!name) {
    app.toast("昵称不能为空", "error");
    nickname.value = app.device?.nickname ?? "";
    return;
  }
  if (name === app.device?.nickname && avatar.value === app.device?.avatar) return;
  await app.updateProfile(name, avatar.value);
  await chat.refreshFriends();
  app.toast("资料已保存并同步", "success");
}

function onNicknameKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    (e.target as HTMLInputElement).blur();
  }
}

async function onAvatarChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = async () => {
    avatar.value = r.result as string;
    await saveProfileNow();
  };
  r.readAsDataURL(f);
}
</script>

<template>
  <section>
    <h3 class="mb-3 text-[13px] font-semibold text-[var(--gosslan-text)]">个人资料</h3>
    <div class="flex items-center gap-4">
      <div class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[var(--gosslan-avatar-radius)] brand-surface text-white">
        <img v-if="avatar" :src="avatar" class="h-full w-full object-cover" />
        <span v-else class="text-2xl font-semibold">{{ nickname.slice(0, 1) || "我" }}</span>
      </div>
      <div class="min-w-0 flex-1">
        <input
          v-model="nickname"
          maxlength="30"
          class="mb-2 w-full rounded-lg bg-[var(--gosslan-bg)] px-3 py-2 text-sm outline-none"
          placeholder="昵称（修改后自动保存）"
          @blur="saveProfileNow"
          @keydown="onNicknameKeydown"
        />
        <button
          class="rounded-lg border border-[var(--gosslan-border)] px-3 py-1.5 text-xs transition hover:bg-[var(--gosslan-hover)]"
          @click="avatarInput?.click()"
        >
          更换头像
        </button>
        <input ref="avatarInput" type="file" accept="image/*" class="hidden" @change="onAvatarChange" />
        <!-- 本人在线状态（从原右上角拓扑栏移入，明确标识是「我」的状态） -->
        <div class="mt-2.5 flex items-center gap-1.5 text-xs">
          <span class="h-2 w-2 rounded-full" :class="app.online ? 'bg-emerald-500' : 'bg-neutral-400'"></span>
          <span :class="app.online ? 'text-emerald-600' : 'text-[var(--gosslan-text-2)]'">
            {{ app.online ? "我在线 · 局域网已连接" : "我离线 · 局域网未连接" }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>
