<script setup lang="ts">
/**
 * 任务详情**弹窗**（应用内形态）。
 *
 * 字段与操作条分别收在 `TodoDetailFields` / `TodoDetailActions`：独立窗口右栏用同一份，
 * 两个宿主不会各长一套（用户 2026-11-08：群任务窗口改「左列表 + 右详情常驻」）。
 * 本文件只保留弹窗外壳（标题、遮罩关闭、预览归属判定）。
 */
import { computed, watch } from "vue";
import BaseModal from "@/components/BaseModal.vue";
import TodoDetailActions from "@/components/TodoDetailActions.vue";
import TodoDetailFields from "@/components/TodoDetailFields.vue";
import { useImagePreviewStore } from "@/stores/useImagePreview";
import {
  todoCode,
  type TodoCategory,
  type TodoCustomIcon,
  type TodoHistoryEntry,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "@/utils/todos";
import type { TodoTagCandidate } from "@/api";
import { t } from "@/i18n";

const props = defineProps<{
  open: boolean;
  item: TodoItem | null;
  /** 该任务当前是否实际处于归档态（显式归档 或 完成满 7 天）。 */
  archived: boolean;
  canChangeStatus: boolean;
  /**
   * 能否**只动归档位**（群成员皆可，用户 2026-09-24 #37）。
   * 与 `canChangeStatus` 是两件事：改状态 / 恢复仍归创建者、群主、被指派人。
   */
  canArchive: boolean;
  /**
   * 能否**还原**（把「完成」退回「待办」，一并退出归档）。与归档同一条成员窄档
   * （用户 2026-09-24 追加：还原也开放给全体群成员）。
   */
  canRestore: boolean;
  canEditStructure: boolean;
  /**
   * 能否删除这条任务。与 `canEditStructure` 不是同一件事：
   * **已归档**的任务按用户 2026-10-27 的裁定对全体群成员开放删除（见后端 `delete_archived_change`），
   * 而未归档任务的删除仍是创建者/群主的结构改动。
   */
  canDelete: boolean;
  /** 能否改指派人（创建者/群主/当前被指派人）—— 被指派人也能通过编辑改指派人。 */
  canEditAssignees: boolean;
  /**
   * 能否改**属性**（关联时间 / 类型 / 标签）。
   *
   * 用户 2026-11-05 的口径：**全体群成员**都可以加/改这三格，**不需要进编辑态**
   * （与状态下拉、关联时间同一行为）。后端对应 `MemberLane::attributes_only` 那一条窄档，
   * 这里只是"给不给控件"，拦截仍在命令层。⚠️ 不要把它做成"仅编辑态可改"的只读门控。
   */
  canEditAttributes: boolean;
  /** 历史标签候选（由看板从 `list_group_todo_tags` 读来，已排序）。 */
  tagCandidates?: TodoTagCandidate[];
  /**
   * 能否**认领**这条需求（群成员皆可，但只限「需求」且自己还不在名单里）。
   * 后端那条窄档是 `commands::claim_only_change`；这里只是"给不给按钮"，拦截在命令层。
   */
  canClaim: boolean;
  /** 名字解析（id → 昵称）；由看板注入 `memberProfile`，避免这里再依赖成员数据源。 */
  nameOf: (id: string) => string;
  /**
   * @ 渲染的判定输入（与聊天正文同一份推导）。同 `nameOf` 一样由看板注入 ——
   * 本弹窗刻意不直接依赖成员数据源。
   */
  mentionNames?: string[];
  selfMention?: { name: string; label: string } | null;
  /**
   * 全员操作流水（由看板从该任务的全部 todo/todo_update 事件 diff 得到，旧的在前）。
   * 默认空数组：没有操作记录时整段不渲染。
   */
  history?: TodoHistoryEntry[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "status", status: TodoStatus): void;
  (e: "priority", priority: TodoPriority): void;
  /** 关联时间（`YYYY-MM-DD`；`""` = 明确清空）—— 全体群成员随时可改，不走编辑态。 */
  (e: "relatedOn", value: string): void;
  /** 任务标签（多选）—— 同样是成员随时可改；移除只解除关联，不动历史候选池。 */
  (e: "tags", tags: string[]): void;
  /** 切类型；custom 档第二个参数带用户输入的名字。 */
  (e: "category", category: TodoCategory, customName?: string): void;
  /** 换自定义类型的图标（用户 2026-10-14 同一条需求的另一格）：单字段发出去，其余由后端沿用。 */
  (e: "icon", icon: TodoCustomIcon): void;
  /** 认领 = "把自己追加进 assignees"这一步（不新增字段，权限跟着 assignees 走）。 */
  (e: "claim"): void;
  (e: "archive"): void;
  (e: "restore"): void;
  (e: "edit"): void;
  (e: "remove"): void;
}>();

const preview = useImagePreviewStore();
/** 这份相册属于"哪条任务的详情"（关闭时按来源收，见 `onDialogClose`）。 */
const sourceKey = computed(() => (props.item ? `task:${props.item.todoId}` : null));
const previewIsMine = computed(
  () => preview.open && sourceKey.value !== null && preview.source === sourceKey.value,
);

/**
 * 弹窗要求关闭（点遮罩 / Esc）。
 *
 * 预览开着时**只收预览、不关详情**：详情之外的点击会落到遮罩上，而预览在桌面端是
 * **独立窗口**、移动端是 Teleport 到 body 的覆盖层 —— 两种宿主都排在面板外面。
 * 不挡一下的话，在预览里点「保存 / 关闭」会顺带把任务详情一起关掉。
 */
function onDialogClose() {
  if (previewIsMine.value) {
    preview.close();
    return;
  }
  emit("close");
}

// 关掉详情时收起菜单（下次打开是干净的；预览由上面的 onDialogClose 收）
watch(
  () => props.open,
  (v) => {
    if (!v) {
      // 详情被别处关掉（改状态/归档/完成后 closeDetail）时，按来源收掉这份相册
      if (sourceKey.value) preview.closeIfFrom(sourceKey.value);
    }
  },
);
/**
 * 标题前缀那串编号：详情**不是**紧凑界面，所以永远给完整编号（用户 2026-09-30 规则 7）。
 * 卡片与看板那一格超过 4 位只显后四位，这一格就是用户核对全码的出口；
 * 没有号（旧版本对端建的）整个前缀不出现，与那两格同一口径。
 */
const fullCode = computed(() =>
  props.item ? todoCode(props.item.category, props.item.number)?.full ?? "" : "",
);
</script>

<template>
  <BaseModal
    :open="open"
    :title="(fullCode ? fullCode + ' ' : '') + (item?.title ?? t('todo.title'))"
    width="max-w-lg"
    title-selectable
    @close="onDialogClose"
  >
    <TodoDetailFields
      v-if="item"
      :item="item"
      :can-change-status="canChangeStatus"
      :can-edit-attributes="canEditAttributes"
      :can-claim="canClaim"
      :tag-candidates="tagCandidates"
      :name-of="nameOf"
      :mention-names="mentionNames"
      :self-mention="selfMention"
      :history="history"
      :source-key="sourceKey"
      @status="(s: TodoStatus) => emit('status', s)"
      @priority="(p: TodoPriority) => emit('priority', p)"
      @category="(c: TodoCategory, name?: string) => emit('category', c, name)"
      @icon="(i: TodoCustomIcon) => emit('icon', i)"
      @related-on="(v: string) => emit('relatedOn', v)"
      @tags="(tags: string[]) => emit('tags', tags)"
      @claim="emit('claim')"
    />

    <!-- 操作条走 footer 插槽 ⇒ 它在滚动区**之外**，永不随内容滚走（2026-10-12 用户要求）。 -->
    <template #footer>
      <div
        v-if="item"
        class="border-t border-[var(--gosslan-divider)] pt-3"
      >
        <TodoDetailActions
          :item="item"
          :archived="archived"
          :can-archive="canArchive"
          :can-restore="canRestore"
          :can-edit-structure="canEditStructure"
          :can-edit-assignees="canEditAssignees"
          :can-delete="canDelete"
          @archive="emit('archive')"
          @restore="emit('restore')"
          @edit="emit('edit')"
          @remove="emit('remove')"
        />
      </div>
    </template>
  </BaseModal>
</template>
