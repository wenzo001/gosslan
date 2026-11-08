<script setup lang="ts">
/**
 * 任务详情的**字段区**（描述 / 图片 / 属性 / 操作记录）。
 *
 * 详情现在有两个宿主（用户 2026-11-08：群任务窗口改「左列表 + 右详情常驻」）：
 * 应用内仍是 `TodoDetailDialog` 弹窗，独立窗口是 `GroupTasksBoard` 右栏。
 * 两个宿主共用这一份字段渲染 ⇒ 属性顺序、权限门控、@ 渲染都只有一处，
 * 不会出现「窗口里改了、弹窗里没改」的第二份实现。
 *
 * 纯展示 + 意图上抛：真正的改状态/归档/编辑/删除都在 `GroupTasksBoard`。
 */
import Icon from "@/components/ui/Icon.vue";
import { computed } from "vue";
import { useImagePreviewStore } from "@/stores/useImagePreview";
import MentionText from "@/components/message/MentionText.vue";
import TodoImageThumb from "@/components/TodoImageThumb.vue";
import TodoPickField from "@/components/TodoPickField.vue";
import TodoIconPicker from "@/components/TodoIconPicker.vue";
import TodoAttrDateField from "@/components/TodoAttrDateField.vue";
import TodoAttrTypeField from "@/components/TodoAttrTypeField.vue";
import TodoAttrTagsField from "@/components/TodoAttrTagsField.vue";
import {
  TODO_CATEGORIES,
  TODO_CATEGORY_LABEL_KEY,
  TODO_CATEGORY_PILL,
  TODO_PRIORITIES,
  TODO_PRIORITY_LABEL_KEY,
  TODO_PRIORITY_PILL,
  TODO_STATUSES,
  TODO_STATUS_LABEL_KEY,
  TODO_STATUS_PILL,
  TODO_CUSTOM_ICON_DEFAULT,
  type TodoCategory,
  type TodoCustomIcon,
  type TodoHistoryChange,
  type TodoHistoryEntry,
  type TodoItem,
  type TodoPriority,
  type TodoStatus,
} from "@/utils/todos";
import type { TodoTagCandidate } from "@/api";
import { fmtTodoTime } from "@/utils/time";
import { t } from "@/i18n";

const props = defineProps<{
  item: TodoItem;
  canChangeStatus: boolean;
  canEditAttributes: boolean;
  canClaim: boolean;
  tagCandidates?: TodoTagCandidate[];
  nameOf: (id: string) => string;
  mentionNames?: string[];
  selfMention?: { name: string; label: string } | null;
  history?: TodoHistoryEntry[];
  /**
   * 这份相册属于哪条任务（`task:<todoId>`）。由宿主给：应用内弹窗要按来源收掉预览，
   * 右栏点击切换任务时也要按同一个 key 收，两处必须同一个来源口径。
   */
  sourceKey: string | null;
}>();

const emit = defineEmits<{
  (e: "status", status: TodoStatus): void;
  (e: "priority", priority: TodoPriority): void;
  (e: "relatedOn", value: string): void;
  (e: "tags", tags: string[]): void;
  (e: "category", category: TodoCategory, customName?: string): void;
  (e: "icon", icon: TodoCustomIcon): void;
  (e: "claim"): void;
}>();

const assignees = computed(() =>
  (props.item.assignees ?? []).map((id) => props.nameOf(id)).join(t("common.sep.list")),
);
const creator = computed(() => (props.item.creator ? props.nameOf(props.item.creator) : ""));

function statusText(s: TodoStatus): string {
  return t(TODO_STATUS_LABEL_KEY[s]);
}

/**
 * 三格（状态 / 优先级 / 类型）的候选表。
 *
 * 文案走 i18n ⇒ 必须是 computed：写成模块级常量的话，用户在设置里切语言之后
 * 菜单里还是旧文案（这类"只有切换后才露出来"的破绽最难被查）。
 */
const statusOptions = computed(() => TODO_STATUSES.map((s) => ({ value: s, label: statusText(s) })));
const priorityOptions = computed(() =>
  TODO_PRIORITIES.map((p) => ({ value: p, label: t(TODO_PRIORITY_LABEL_KEY[p]) })),
);
const categoryOptions = computed(() =>
  TODO_CATEGORIES.map((c) => ({ value: c, label: t(TODO_CATEGORY_LABEL_KEY[c]) })),
);

/**
 * 类型胶囊当前文案：custom 档显示用户输入的名字，其余档走 i18n。
 * 自定义名的输入缓冲已经收进 `TodoAttrTypeField` 的面板里（同一块弹出面板），
 * 这里不再持有一份 draft —— 两处各存一份就会出现"面板里改了、胶囊上还是旧名"。
 */
const categoryCurrent = computed(() => {
  const x = props.item;
  if (x.category === "custom") {
    return x.customCategory || t(TODO_CATEGORY_LABEL_KEY.custom);
  }
  return t(TODO_CATEGORY_LABEL_KEY[x.category]);
});

// ---------------- 操作记录（纯展示；diff 在 utils/todos.ts 的 buildTodoHistory） ----------------
const historyEntries = computed<TodoHistoryEntry[]>(() => props.history ?? []);
/** 一条改动的人类文案（i18n 现算，切语言后弹窗里直接跟着变）。 */
function changeText(c: TodoHistoryChange): string {
  const nameOf = props.nameOf;
  const statusName = (s?: string) => (s ? t(TODO_STATUS_LABEL_KEY[s as TodoStatus] ?? `?${s}`) : "");
  const priorityName = (s?: string) =>
    s ? t(TODO_PRIORITY_LABEL_KEY[s as TodoPriority] ?? `?${s}`) : "";
  const categoryName = (s: string | undefined, custom: string | undefined): string => {
    if (!s) return "";
    if (s === "custom") return custom || t(TODO_CATEGORY_LABEL_KEY.custom);
    return t(TODO_CATEGORY_LABEL_KEY[s as TodoCategory] ?? `?${s}`);
  };
  switch (c.kind) {
    case "created": return t("todo.history.created");
    case "title": return t("todo.history.changeTitle");
    case "description": return t("todo.history.description");
    case "status":
      return t("todo.history.status", { from: statusName(c.from), to: statusName(c.to) });
    case "priority":
      return t("todo.history.priority", { from: priorityName(c.from), to: priorityName(c.to) });
    case "category":
      return t("todo.history.category", {
        from: categoryName(c.from, c.fromCustom),
        to: categoryName(c.to, c.toCustom),
      });
    case "assignees_add":
      return t("todo.history.assigneesAdd", {
        names: (c.ids ?? []).map(nameOf).join(t("common.sep.list")),
      });
    case "assignees_remove":
      return t("todo.history.assigneesRemove", {
        names: (c.ids ?? []).map(nameOf).join(t("common.sep.list")),
      });
    case "archived": return t("todo.history.archived");
    case "restored": return t("todo.history.restored");
    case "deleted": return t("todo.history.deleted");
    default: return "";
  }
}

/**
 * 图片点开大图（用户 2026-09-21：「任务详情里图片不能点击预览」）。
 *
 * 渲染用的是**全局那一份**预览实例（用户 2026-09-24 #40：看图是一个公共能力，
 * 不再是每个面板各挂一个 `ImageLightbox`），本组件只给数组 + 宿主给的来源标记。
 * 相册条目按 **cid** 而不是 `msg_id` 解析 —— 待办描述图片的载荷里只有 sha256（= content store cid）。
 */
const gallery = computed(() => props.item.images.map((im) => ({ cid: im.sha256, name: im.name })));
const preview = useImagePreviewStore();
function openAt(i: number) {
  preview.openGallery(gallery.value, i, props.sourceKey);
}
</script>

<template>
  <div class="space-y-4">
    <!-- 优先级三档（默认「常规」）。可用的人 = 发起人 / 关联人 / 群主：
         与「改状态」同一档，所以复用同一个 `canChangeStatus` 入参，不另起一套判权。
         状态与优先级共用 `TodoPickField` —— 观感与键盘行为只有一份，
         也修掉了原生 select 在暗夜模式下的"浅底 + 近白字"（见该组件头部注释）。 -->
    <TodoPickField
      :label="t('todo.priorityLabel')"
      :hint="t('todo.priorityHint')"
      :model-value="item.priority ?? 'normal'"
      :current="t(TODO_PRIORITY_LABEL_KEY[item.priority ?? 'normal'])"
      :current-class="TODO_PRIORITY_PILL[item.priority ?? 'normal']"
      :options="priorityOptions"
      :disabled="!canChangeStatus"
      @update:model-value="(v: string) => emit('priority', v as TodoPriority)"
    />
    <!-- 关联时间 / 类型 / 标签：三者共用 `TodoAttrField` 外壳（同标签排布、同高度、同圆角、
         同一块 280px 弹出面板）。⚠️ 判权是 `canEditAttributes`（群成员皆可），
         **不再要求进编辑态** —— 用户 2026-11-05 明确纠正过这一条。 -->
    <TodoAttrDateField
      :label="t('todo.relatedOnLabel')"
      :hint="t('todo.relatedOnHint')"
      :model-value="item.relatedOn ?? ''"
      :disabled="!canEditAttributes"
      @update:model-value="(v: string) => emit('relatedOn', v)"
    />
    <TodoAttrTypeField
      :label="t('todo.categoryLabel')"
      :hint="t('todo.categoryHint')"
      :model-value="item.category ?? 'task'"
      :current="categoryCurrent"
      :current-class="TODO_CATEGORY_PILL[item.category ?? 'task']"
      :options="categoryOptions"
      :custom-value="item.customCategory ?? ''"
      :disabled="!canEditAttributes"
      @update:model-value="(v: string, name?: string) => emit('category', v as TodoCategory, name)"
    />
    <!-- 图标那一格与自定义名同档展开。这一份与看板草稿共用 `TodoIconPicker`：
         两个编辑器各写一排按钮就会开始不一致（同一判据两个家）。 -->
    <div v-if="canEditAttributes && item.category === 'custom'" class="-mt-2">
      <TodoIconPicker
        :model-value="item.customIcon ?? TODO_CUSTOM_ICON_DEFAULT"
        @update:model-value="(v: TodoCustomIcon) => emit('icon', v)"
      />
    </div>
    <TodoAttrTagsField
      :label="t('todo.tagsLabel')"
      :hint="t('todo.tagsHintInline')"
      :model-value="item.tags"
      :candidates="tagCandidates ?? []"
      :disabled="!canEditAttributes"
      @update:model-value="(v: string[]) => emit('tags', v)"
    />
    <!-- 认领：只在这一格出现 —— 需求 + 自己还不在名单里（+ 本群成员，由 canClaim 判）。
         按下之后走的是"改指派人"那条既有命令，不新增接口，也不新增一次同步。 -->
    <div v-if="canClaim" class="flex items-center justify-between gap-2">
      <span class="text-xs text-[var(--gosslan-text-2)]">{{ t("todo.claimHint") }}</span>
      <button
        type="button"
        class="tap-safe inline-flex h-7 items-center gap-1 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-primary)] px-2.5 text-meta text-[var(--gosslan-accent-ink)] transition hover:opacity-80"
        :aria-label="t('todo.claim')"
        @click="emit('claim')"
      >
        <Icon name="user-plus" class="h-3.5 w-3.5" aria-hidden="true" />
        {{ t("todo.claim") }}
      </button>
    </div>
    <!-- 状态：**显式两步**（用户 2026-09-17：「一不小心就把状态改了」）。
         此前是一排 4 个分段按钮、一点即写库，而且与看板顶部的**筛选**分段控件长得一样，
         用户当成"切视图"就顺手点了。现在当前状态是一个胶囊（看清现状），改动要点开菜单再选，
         当前项置灰不可点 —— 误触代价从"改错状态"变成"多看一眼"。
         菜单形状与优先级 / 类型 两格同一份（`TodoPickField`）。 -->
    <TodoPickField
      :label="t('todo.statusLabel')"
      :hint="t('todo.statusChange')"
      :model-value="item.status"
      :current="statusText(item.status)"
      :current-class="TODO_STATUS_PILL[item.status]"
      :options="statusOptions"
      :disabled="!canChangeStatus"
      @update:model-value="(v: string) => emit('status', v as TodoStatus)"
    />
    <!-- 元信息：创建时间 / 创建人 / 指派 / 完成时间（用户 2026-09-17：时间要回显） -->
    <div class="gosslan-selectable space-y-1 text-meta text-[var(--gosslan-text-2)]">
      <div v-if="item.createdAt">{{ t("todo.createdAt", { time: fmtTodoTime(item.createdAt) }) }}</div>
      <div v-if="creator">{{ t("todo.creator", { name: creator }) }}</div>
      <div v-if="assignees" :title="assignees">{{ t("todo.assigneesInline", { names: assignees }) }}</div>
      <!-- 关联时间不在这里回显：它已经是上方可编辑属性（`TodoAttrDateField`），
           再抄一行只读文本会出现"同一条信息两个家"。 -->
      <!-- 终态时间：完成显示「完成时间」，做不了显示「标记时间」（同一个后端权威时间戳 done_at）。 -->
      <div v-if="item.doneAt && item.status === 'done'">{{ t("todo.doneAt", { time: fmtTodoTime(item.doneAt) }) }}</div>
      <div v-else-if="item.doneAt && item.status === 'impossible'">{{ t("todo.impossibleAt", { time: fmtTodoTime(item.doneAt) }) }}</div>
    </div>

    <!-- 描述（全文，不截断） -->
    <div>
      <div class="mb-1.5 text-xs text-[var(--gosslan-text-2)]">{{ t("todo.description") }}</div>
      <p
        v-if="item.description"
        class="gosslan-selectable whitespace-pre-wrap break-words text-meta leading-relaxed text-[var(--gosslan-text)]"
      >
        <!-- 与聊天里的同一条 @ 走同一份渲染件（§9）：判定单源在 utils/linkify。 -->
        <MentionText
          :text="item.description"
          :mention-names="mentionNames"
          :self-mention="selfMention"
        />
      </p>
      <p v-else class="text-meta text-[var(--gosslan-text-2)]">{{ t("todo.noDescription") }}</p>
    </div>

    <!-- 图片：点缩略图看大图（交给全局那一份预览实例，见 script 里的说明） -->
    <div v-if="item.images.length">
      <div class="mb-1.5 text-xs text-[var(--gosslan-text-2)]">{{ t("todo.imagesLabel") }}</div>
      <div class="flex flex-wrap gap-1.5">
        <TodoImageThumb
          v-for="(img, i) in item.images"
          :key="img.sha256"
          :image="img"
          clickable
          @open="openAt(i)"
        />
      </div>
    </div>

    <!-- 全员操作记录：这条任务从创建到当前的全部改动流水（diff 来自事件日志，见 buildTodoHistory）。
         ⚠️ 这里**不写** `max-h-*` + `overflow-y-auto`（用户 2026-10-14：「操作记录不要在内置滚动条」）：
         这块滚动交给宿主自己的滚动区，再套一条就成"外层一条、里面一条"。 -->
    <div v-if="historyEntries.length" class="border-t border-[var(--gosslan-divider)] pt-3">
      <div class="mb-1.5 text-xs text-[var(--gosslan-text-2)]">{{ t("todo.history.sectionTitle") }}</div>
      <ul class="gosslan-selectable space-y-1">
        <li
          v-for="(entry, i) in [...historyEntries].reverse()"
          :key="entry.msgId + ':' + i"
          class="flex items-baseline gap-2 text-meta leading-relaxed"
        >
          <span class="shrink-0 tabular-nums text-[var(--gosslan-text-2)]">{{ fmtTodoTime(entry.ts) }}</span>
          <span class="shrink-0 font-medium text-[var(--gosslan-text)]">{{ nameOf(entry.actor) }}</span>
          <span class="min-w-0 flex-1 text-[var(--gosslan-text-2)]">
            <span v-for="(c, j) in entry.changes" :key="c.kind + j">
              <span v-if="j > 0" class="mx-0.5 text-[var(--gosslan-text-2)]">·</span>{{ changeText(c) }}
            </span>
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>
