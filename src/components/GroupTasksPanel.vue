<script setup lang="ts">
/**
 * 群任务面板（用户 2026-09-16：「群里需要能够支持列一些任务列表，每个任务可以给一个或多个人，
 * 任务要能区分出进行中、延期、完成等这些状态」）。
 *
 * **数据来源**：`foldTodos(该群会话的已加载消息)`。任务与群公告同属 `Card` kind ——
 * 不进消息时间线，只在这里折叠展示（时间线里出现一张任务卡会与聊天内容混在一起）。
 * ⚠️ 因此它只统计**已加载的消息页**（进群时自动拉 10 页 × 100 条），更早的任务要往上翻历史
 * 才会出现在这里 —— 这是既有架构的口径（公告面板同样如此），不是本面板特有的取舍。
 *
 * **权限**：与后端 `commands::may_update_todo` 一致（`utils/todos.ts` 的 `canUpdateTodo`
 * 是显示用的镜像）—— 改状态 = 创建者或被指派人；改标题/指派人/删除 = 创建者或群主。
 * 界面只是"不给按钮"，真正的拦截在后端命令里。
 */
import { computed, ref, watch } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { useMemberProfile } from "@/composables/useMemberProfile";
import BaseModal from "@/components/BaseModal.vue";
import {
  TODO_STATUSES,
  TODO_STATUS_LABEL_KEY,
  canUpdateTodo,
  foldTodos,
  type TodoItem,
  type TodoStatus,
} from "@/utils/todos";
import { t } from "@/i18n";
import { Check, ChevronDown, Pencil, Plus, Trash2, X } from "lucide-vue-next";

const props = defineProps<{ open: boolean; groupId: string | null }>();
const emit = defineEmits<{ (e: "close"): void }>();

const app = useAppStore();
const chat = useChatStore();
const { memberProfile, myId } = useMemberProfile();

const convId = computed(() => (props.groupId ? `group:${props.groupId}` : ""));
const group = computed(() => chat.groups.find((g) => g.id === props.groupId) ?? null);

/** 折叠出全部任务（按创建版本从新到旧），再按状态分组。 */
const todos = computed(() => foldTodos(chat.messages[convId.value] ?? []));
const grouped = computed(() =>
  TODO_STATUSES.map((status) => ({ status, items: todos.value.filter((x) => x.status === status) })).filter(
    (g) => g.items.length > 0,
  ),
);
const doneCount = computed(() => todos.value.filter((x) => x.status === "done").length);

/** 状态徽标 / 圆点配色：与应用的「胶囊徽标」同一套（soft 底 + ink 字），
 *  不自己写色值（§3.1 / §3.2）。doing 用主题色的 14% 浅底（`color-mix` 派生，跟随用户改色）。 */
const STATUS_PILL: Record<TodoStatus, string> = {
  todo: "bg-[var(--gosslan-hover)] text-[var(--gosslan-text-2)]",
  doing: "bg-[color-mix(in_srgb,var(--gosslan-primary)_14%,transparent)] text-[var(--gosslan-accent-ink)]",
  overdue: "bg-[var(--gosslan-warning-soft)] text-[var(--gosslan-warning-ink)]",
  done: "bg-[var(--gosslan-success-soft)] text-[var(--gosslan-success-ink)]",
};
const STATUS_DOT: Record<TodoStatus, string> = {
  todo: "bg-[var(--gosslan-text-2)]",
  doing: "bg-[var(--gosslan-primary)]",
  overdue: "bg-[var(--gosslan-warning)]",
  done: "bg-[var(--gosslan-success)]",
};
function statusText(s: TodoStatus): string {
  return t(TODO_STATUS_LABEL_KEY[s]);
}

// ---------------- 状态切换：胶囊徽标点开的小菜单（替代原生 select） ----------------
const statusMenuId = ref<string | null>(null);
function toggleStatusMenu(todoId: string) {
  statusMenuId.value = statusMenuId.value === todoId ? null : todoId;
}
function closeStatusMenu() {
  statusMenuId.value = null;
}

function canChangeStatus(x: TodoItem): boolean {
  return canUpdateTodo(x, myId.value, group.value?.creator ?? "", false);
}
function canEditStructure(x: TodoItem): boolean {
  return canUpdateTodo(x, myId.value, group.value?.creator ?? "", true);
}

// ---------------- 新建 / 编辑（面板内联表单，不开第二层弹窗） ----------------
const draft = ref<{ todoId: string | null; title: string; assignees: string[] } | null>(null);
const saving = ref(false);

function startCreate() {
  draft.value = { todoId: null, title: "", assignees: myId.value ? [myId.value] : [] };
}
function startEdit(x: TodoItem) {
  draft.value = { todoId: x.todoId, title: x.title, assignees: [...x.assignees] };
}
function toggleAssignee(id: string) {
  const d = draft.value;
  if (!d) return;
  d.assignees = d.assignees.includes(id) ? d.assignees.filter((a) => a !== id) : [...d.assignees, id];
}

async function saveDraft() {
  const d = draft.value;
  if (!d || !props.groupId) return;
  const title = d.title.trim();
  if (!title) {
    app.toast(t("todo.needTitle"), "error");
    return;
  }
  if (d.assignees.length === 0) {
    app.toast(t("todo.needAssignee"), "error");
    return;
  }
  saving.value = true;
  try {
    if (d.todoId) {
      const cur = todos.value.find((x) => x.todoId === d.todoId);
      if (cur) await chat.updateTodo(props.groupId, cur, { title, assignees: d.assignees });
      app.toast(t("todo.updateDone"), "success");
    } else {
      await chat.createTodo(props.groupId, title, d.assignees);
      app.toast(t("todo.createDone"), "success");
    }
    draft.value = null;
  } catch (e) {
    app.toastError(e, t(d.todoId ? "todo.updateFail" : "todo.createFail"));
  } finally {
    saving.value = false;
  }
}

async function setStatus(x: TodoItem, status: string) {
  if (!props.groupId) return;
  try {
    await chat.updateTodo(props.groupId, x, { status });
  } catch (e) {
    app.toastError(e, t("todo.updateFail"));
  }
}

// ---------------- 删除（破坏性且广播给全群 ⇒ 二次确认） ----------------
const pendingDelete = ref<TodoItem | null>(null);

async function confirmDelete() {
  const x = pendingDelete.value;
  pendingDelete.value = null;
  if (!x || !props.groupId) return;
  try {
    await chat.updateTodo(props.groupId, x, { deleted: true });
    app.toast(t("todo.removeDone"), "success");
  } catch (e) {
    app.toastError(e, t("todo.removeFail"));
  }
}

// 关闭面板时丢掉未保存的草稿/确认态：下次打开是一张干净的面板
watch(
  () => props.open,
  (v) => {
    if (!v) {
      draft.value = null;
      pendingDelete.value = null;
      statusMenuId.value = null;
    }
  },
);
</script>

<template>
  <BaseModal
    :open="open"
    :title="todos.length ? t('todo.title') + ` (${todos.length})` : t('todo.title')"
    width="max-w-lg"
    @close="emit('close')"
  >
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <div v-if="todos.length" class="text-xs text-[var(--gosslan-text-2)]">
          {{ t("todo.doneCount", { n: doneCount, total: todos.length }) }}
        </div>
        <div v-else></div>
        <!-- 新建：任意成员都可（权限由后端再判一次） -->
        <button
          v-if="!draft"
          class="tap-safe flex shrink-0 items-center gap-1 rounded-[var(--gosslan-radius-md)] px-2.5 py-1.5 text-[13px] text-[var(--gosslan-accent-ink)] transition hover:bg-[var(--gosslan-hover)]"
          @click="startCreate"
        >
          <Plus class="h-4 w-4" />
          {{ t("todo.create") }}
        </button>
      </div>

      <!-- 新建 / 编辑：内联表单（标题 + 成员多选）。指派人是**权限依据**，所以至少一人。 -->
      <div
        v-if="draft"
        class="space-y-2.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-card)] p-3"
      >
        <div>
          <div class="mb-1.5 text-xs text-[var(--gosslan-text-2)]">{{ t("todo.titleLabel") }}</div>
          <input
            v-model="draft.title"
            maxlength="200"
            class="w-full rounded-[var(--gosslan-radius-md)] border border-transparent bg-[var(--gosslan-bg)] px-3 py-2 text-sm outline-none transition focus:border-transparent"
            :placeholder="t('todo.titlePlaceholder')"
            @keydown.enter.prevent="saveDraft"
          />
        </div>
        <div>
          <div class="mb-1.5 text-xs text-[var(--gosslan-text-2)]">{{ t("todo.pickMembers") }}</div>
          <div class="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            <button
              v-for="id in group?.members ?? []"
              :key="id"
              type="button"
              class="flex items-center gap-1.5 rounded-[var(--gosslan-radius-md)] border px-2 py-1 text-[12px] transition"
              :class="
                draft.assignees.includes(id)
                  ? 'border-[var(--gosslan-primary)] text-[var(--gosslan-accent-ink)]'
                  : 'border-[var(--gosslan-border)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'
              "
              :aria-pressed="draft.assignees.includes(id)"
              @click="toggleAssignee(id)"
            >
              <Check v-if="draft.assignees.includes(id)" class="h-3.5 w-3.5" />
              {{ memberProfile(id).name }}
            </button>
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-0.5">
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] px-3 py-1.5 text-[13px] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            @click="draft = null"
          >
            {{ t("common.cancel") }}
          </button>
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary)] px-3 py-1.5 text-[13px] text-white transition hover:opacity-90 disabled:opacity-50"
            :disabled="saving"
            @click="saveDraft"
          >
            {{ t("todo.save") }}
          </button>
        </div>
      </div>

      <div v-if="todos.length === 0 && !draft" class="py-8 text-center text-sm text-[var(--gosslan-text-2)]">
        {{ t("todo.empty") }}
      </div>

      <!-- 按状态分组：待办 / 进行中 / 延期 / 完成（空组不占位） -->
      <div v-for="g in grouped" :key="g.status" class="space-y-1.5">
        <!-- 分组头：状态圆点 + 名称 + 计数（胶囊徽标同源，不写色值） -->
        <div class="flex items-center gap-1.5 px-0.5">
          <span class="h-1.5 w-1.5 rounded-full" :class="STATUS_DOT[g.status]" />
          <span class="text-[11px] font-medium text-[var(--gosslan-text)]">{{ statusText(g.status) }}</span>
          <span class="rounded-full bg-[var(--gosslan-hover)] px-1.5 text-[11px] text-[var(--gosslan-text-2)]">
            {{ g.items.length }}
          </span>
        </div>

        <div
          v-for="x in g.items"
          :key="x.todoId"
          class="rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-card-line)] bg-[var(--gosslan-card)] p-2.5 transition hover:border-[var(--gosslan-border)]"
        >
          <!-- 标题 + 操作（编辑 / 删除）：触屏用 .hover-reveal 常显，桌面悬停显现 -->
          <div class="flex items-start gap-2">
            <div
              class="min-w-0 flex-1 break-words text-[13px]"
              :class="g.status === 'done' ? 'text-[var(--gosslan-text-2)] line-through' : ''"
            >
              {{ x.title }}
            </div>
            <template v-if="canEditStructure(x)">
              <button
                class="tap-safe hover-reveal flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
                :title="t('todo.edit')"
                :aria-label="t('todo.edit')"
                @click="startEdit(x)"
              >
                <Pencil class="h-3.5 w-3.5" />
              </button>
              <button
                class="tap-safe hover-reveal flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--gosslan-radius-sm)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-danger-soft)] hover:text-[var(--gosslan-danger-ink)]"
                :title="t('todo.remove')"
                :aria-label="t('todo.remove')"
                @click="pendingDelete = x"
              >
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </template>
          </div>

          <!-- 页脚：指派成员（胶囊 chip）+ 状态（可改时是胶囊按钮，点开小菜单） -->
          <div class="mt-2 flex items-center justify-between gap-2">
            <div class="flex min-w-0 flex-wrap items-center gap-1">
              <span
                v-for="a in x.assignees"
                :key="a"
                class="truncate rounded-full bg-[var(--gosslan-hover)] px-1.5 py-0.5 text-[11px] text-[var(--gosslan-text-2)]"
                :title="memberProfile(a).name"
              >
                {{ memberProfile(a).name }}
              </span>
              <span v-if="x.assignees.length === 0" class="text-[11px] text-[var(--gosslan-text-2)]">
                {{ t("todo.assigneesEmpty") }}
              </span>
            </div>

            <div class="relative shrink-0">
              <button
                v-if="canChangeStatus(x)"
                type="button"
                class="tap-safe flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition hover:opacity-80"
                :class="STATUS_PILL[x.status]"
                :title="t('todo.statusLabel')"
                :aria-label="t('todo.statusLabel')"
                :aria-expanded="statusMenuId === x.todoId"
                @click="toggleStatusMenu(x.todoId)"
              >
                {{ statusText(x.status) }}
                <ChevronDown class="h-3 w-3" />
              </button>
              <span
                v-else
                class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                :class="STATUS_PILL[x.status]"
              >
                {{ statusText(x.status) }}
              </span>

              <!-- 状态切换小菜单（替代原生 select；只展开一个，见 useExclusivePopup 同口径） -->
              <template v-if="canChangeStatus(x) && statusMenuId === x.todoId">
                <button
                  type="button"
                  class="fixed inset-0 z-40 cursor-default"
                  :aria-label="t('todo.closeMenu')"
                  @click="closeStatusMenu"
                />
                <div
                  class="absolute right-0 top-full z-50 mt-1 w-32 overflow-hidden rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] py-1 shadow-lg"
                >
                  <button
                    v-for="s in TODO_STATUSES"
                    :key="s"
                    type="button"
                    class="flex w-full items-center gap-2 px-2.5 py-1.5 text-[13px] transition hover:bg-[var(--gosslan-hover)]"
                    :class="s === x.status ? 'text-[var(--gosslan-accent-ink)] font-medium' : 'text-[var(--gosslan-text)]'"
                    @click="setStatus(x, s); closeStatusMenu()"
                  >
                    <span class="h-1.5 w-1.5 rounded-full" :class="STATUS_DOT[s]" />
                    {{ statusText(s) }}
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除二次确认：会广播给全群、不可撤销 -->
    <template v-if="pendingDelete">
      <div class="mt-4 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-danger-soft)] p-3">
        <p class="text-sm leading-relaxed text-[var(--gosslan-text)]">
          {{ t("todo.removeConfirm", { title: pendingDelete.title }) }}
        </p>
        <div class="mt-3 flex justify-end gap-2">
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] px-4 py-2 text-sm text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
            @click="pendingDelete = null"
          >
            <X class="mr-1 inline h-3.5 w-3.5" />{{ t("common.cancel") }}
          </button>
          <button
            class="tap-safe rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-danger)] px-4 py-2 text-sm text-white transition hover:opacity-90"
            @click="confirmDelete"
          >
            {{ t("common.delete") }}
          </button>
        </div>
      </div>
    </template>
  </BaseModal>
</template>
