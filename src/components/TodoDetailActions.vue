<script setup lang="ts">
/**
 * 任务详情的**操作条**（归档 / 恢复 / 编辑 / 删除）。
 *
 * 与 `TodoDetailFields` 同一拆分理由：应用内弹窗与独立窗口右栏共用一份，
 * 权限门控与按钮语义只写一次。宿主负责把 `emit` 接回看板里已有的动作。
 */
import Icon from "@/components/ui/Icon.vue";
import { computed } from "vue";
import { isTodoTerminalStatus, type TodoItem } from "@/utils/todos";
import { t } from "@/i18n";

const props = defineProps<{
  item: TodoItem;
  /** 该任务当前是否实际处于归档态（显式归档 或 完成满 7 天）。 */
  archived: boolean;
  canArchive: boolean;
  canRestore: boolean;
  canEditStructure: boolean;
  canEditAssignees: boolean;
  canDelete: boolean;
}>();

const emit = defineEmits<{
  (e: "archive"): void;
  (e: "restore"): void;
  (e: "edit"): void;
  (e: "remove"): void;
}>();

const canShowEdit = computed(() => props.canEditStructure || props.canEditAssignees);
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <!-- 底部不再放「完成」按钮（用户 2026-11-04：展开任务后那个一键完成太容易误点）：
         改状态统一由字段区的状态胶囊下拉主动选择，那里已经带权限判断。 -->
    <!-- 进入终态（完成/做不了）之后**手动**归档。
         归档那一档由 `canArchive` 决定 —— 它对**全体群成员**开放（用户 2026-09-24 #37），
         比"改状态"宽；但只在终态给按钮（后端拒绝归档非终态任务）。
         「恢复」仍然要 `canRestore`：它是把状态改回待办，不是"取消归档"。 -->
    <!-- 「归档」不是删除（用户 2026-11-04 #7）：按钮下面挂一句副文案说明可从「已归档」找回。 -->
    <div
      v-if="canArchive && isTodoTerminalStatus(item.status) && !archived"
      class="flex flex-col items-start gap-0.5"
    >
      <button
        type="button"
        class="tap-safe flex items-center gap-1 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] px-3 py-1.5 text-body text-[var(--gosslan-text-2)] transition hover:text-[var(--gosslan-text)]"
        @click="emit('archive')"
      >
        <Icon name="archive" class="h-3.5 w-3.5" />{{ t("todo.archive") }}
      </button>
      <span class="text-caption text-[var(--gosslan-text-2)]">{{ t("todo.archiveHint") }}</span>
    </div>
    <button
      v-if="archived && canRestore"
      type="button"
      class="tap-safe flex items-center gap-1 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] px-3 py-1.5 text-body text-[var(--gosslan-text-2)] transition hover:text-[var(--gosslan-text)]"
      @click="emit('restore')"
    >
      <Icon name="rotate-ccw" class="h-3.5 w-3.5" />{{ t("todo.restore") }}
    </button>

    <span class="flex-1"></span>

    <button
      v-if="canShowEdit"
      type="button"
      class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
      :title="t('todo.edit')"
      :aria-label="t('todo.edit')"
      @click="emit('edit')"
    >
      <Icon name="pencil" class="h-4 w-4" />
    </button>
    <button
      v-if="canDelete"
      type="button"
      class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-danger-soft)] hover:text-[var(--gosslan-danger-ink)]"
      :title="t('todo.remove')"
      :aria-label="t('todo.remove')"
      @click="emit('remove')"
    >
      <Icon name="trash2" class="h-4 w-4" />
    </button>
  </div>
</template>
