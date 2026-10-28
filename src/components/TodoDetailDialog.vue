<script setup lang="ts">
/**
 * 任务详情（用户 2026-09-17：列表改成「微信式极简」—— 行内只留固定编号/标题/状态/元信息，
 * **描述与图片、以及所有状态与编辑操作都收进这里**，点行打开）。
 *
 * 纯展示 + 意图上抛：真正的改状态/归档/编辑/删除都在 `GroupTasksBoard` 里
 * （那里已经握有折叠数据、权限判据与 API 调用），这里只渲染与 `emit`。
 */
import { computed, nextTick, ref, watch } from "vue";
import BaseModal from "@/components/BaseModal.vue";
import { useImagePreviewStore } from "@/stores/useImagePreview";
import MentionText from "@/components/message/MentionText.vue";
import TodoImageThumb from "@/components/TodoImageThumb.vue";
import TodoPickField from "@/components/TodoPickField.vue";
import TodoIconPicker from "@/components/TodoIconPicker.vue";
import CharCounter from "@/components/ui/CharCounter.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import {
  TODO_CATEGORIES, TODO_CATEGORY_LABEL_KEY, TODO_CATEGORY_PILL, TODO_CUSTOM_CATEGORY_MAX_LEN, TODO_PRIORITIES, TODO_PRIORITY_LABEL_KEY, TODO_PRIORITY_PILL, TODO_STATUSES, TODO_STATUS_LABEL_KEY, TODO_STATUS_PILL, isTodoTerminalStatus, todoCode, type TodoHistoryChange, type TodoHistoryEntry, type TodoCategory, type TodoItem, type TodoPriority, type TodoStatus, TODO_CUSTOM_ICON_DEFAULT, type TodoCustomIcon, } from "@/utils/todos";
import { fmtConversationTime } from "@/utils/time";
import { Archive, Pencil, Tag, UserPlus } from "lucide-vue-next";
import { Check, RotateCcw, Trash2 } from "@/components/ui/icons";
import { t } from "@/i18n";
import { useImeEnterGuard } from "@/composables/useImeEnterGuard";

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
  /** 切类型；custom 档第二个参数带用户输入的名字。 */
  (e: "category", category: TodoCategory, customName?: string): void;
  /** 换自定义类型的图标（用户 2026-10-14 同一条需求的另一格）：单字段发出去，其余由后端沿用。 */
  (e: "icon", icon: TodoCustomIcon): void;
  /** 认领 = "把自己追加进 assignees"这一步（不新增字段，权限跟着 assignees 走）。 */
  (e: "claim"): void;
  (e: "complete"): void;
  (e: "archive"): void;
  (e: "restore"): void;
  (e: "edit"): void;
  (e: "remove"): void;
}>();

const assignees = computed(() => (props.item?.assignees ?? []).map((id) => props.nameOf(id)).join("、"));
const creator = computed(() => (props.item?.creator ? props.nameOf(props.item.creator) : ""));

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
 * 自定义类型名的**编辑缓冲**：选「自定义…」只是把档位切到 custom，真正写入要等用户
 * 输完名字确认（与状态/优先级的"一点即写"刻意不同 —— custom 没有名字会被后端拒）。
 * 切到别的任务/打开弹窗时，用该任务当前的名字预填。
 */
const customDraft = ref("");
/** 本地“正在选自定义”档位：先让输入框出现并聚焦，不立刻写库。 */
const categoryDraft = ref<TodoCategory | null>(null);
const customInput = ref<HTMLInputElement | null>(null);
watch(
  () => [props.open, props.item?.todoId] as const,
  ([open]) => {
    if (open) {
      customDraft.value = props.item?.category === "custom" ? (props.item.customCategory ?? "") : "";
      categoryDraft.value = props.item?.category === "custom" ? "custom" : null;
    }
  },
  { immediate: true },
);

/** 类型胶囊当前文案：custom 档（已落库或正在选）显示用户输入的名字。 */
const categoryCurrent = computed(() => {
  const x = props.item;
  if (!x) return "";
  if (categoryDraft.value === "custom" || x.category === "custom") {
    return customDraft.value.trim() || x.customCategory || t(TODO_CATEGORY_LABEL_KEY.custom);
  }
  return t(TODO_CATEGORY_LABEL_KEY[x.category]);
});
/** 正在选自定义或已落库为自定义 —— 名字输入框与确认按钮的显示条件。 */
const showCustomCategory = computed(
  () => props.item?.category === "custom" || categoryDraft.value === "custom",
);

function onCategoryPick(v: string) {
  if (v === "custom") {
    // 已经是 custom 且有名字：再次点开菜单点它不产生写入（disabled 已挡住，这里兜底）。
    if (props.item?.category === "custom" && props.item.customCategory) return;
    // 第一次切到 custom：只展开输入框，不发请求（没名字，发了必被拒）。
    customDraft.value = props.item?.customCategory ?? "";
    categoryDraft.value = "custom";
    void nextTick(() => customInput.value?.focus());
    return;
  }
  categoryDraft.value = null;
  emit("category", v as TodoCategory);
}
const ime = useImeEnterGuard();

function applyCustomCategory() {
  const name = customDraft.value.trim();
  if (!name) return;
  emit("category", "custom", name);
}

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
      return t("todo.history.assigneesAdd", { names: (c.ids ?? []).map(nameOf).join("、") });
    case "assignees_remove":
      return t("todo.history.assigneesRemove", { names: (c.ids ?? []).map(nameOf).join("、") });
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
 * 不再是每个面板各挂一个 `ImageLightbox`），本组件只给数组 + 来源标记 `task:<todoId>`。
 * 相册条目按 **cid** 而不是 `msg_id` 解析 —— 待办描述图片的载荷里只有 sha256（= content store cid）。
 * 预览的 z-[80] 压在弹窗 z-[65] 之上（与合并转发卡片同一做法）。
 */
const gallery = computed(() =>
  (props.item?.images ?? []).map((im) => ({ cid: im.sha256, name: im.name })),
);
const preview = useImagePreviewStore();
/** 这份相册属于"哪条任务的详情"（关闭时按来源收，见 `onDialogClose`）。 */
const sourceKey = computed(() => (props.item ? `task:${props.item.todoId}` : null));
const previewIsMine = computed(
  () => preview.open && sourceKey.value !== null && preview.source === sourceKey.value,
);
function openAt(i: number) {
  preview.openGallery(gallery.value, i, sourceKey.value);
}

/**
 * 弹窗要求关闭（点遮罩 / Esc）。
 *
 * 预览开着时**只收预览、不关详情**：HeadlessUI 的 `Dialog` 把「面板之外的任何点击」都当成
 * 关闭信号（`useOutsideClick` 只认 `DialogPanel` 那几个容器），而预览是 `Teleport to="body"`
 * 的、就排在面板外面 —— 不挡一下的话，在预览里点「保存 / 关闭」会顺带把任务详情一起关掉。
 * 让最上面那层吃掉这一次关闭，也正好是浮层该有的层级语义。
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
  <BaseModal :open="open" :title="(fullCode ? fullCode + ' ' : '') + (item?.title ?? t('todo.title'))" width="max-w-lg" @close="onDialogClose">
    <div v-if="item" class="space-y-4">
      <!-- 优先级三档（默认「常规」）。可用的人 = 发起人 / 关联人 / 群主：
           与「改状态」同一档，所以复用同一个 `canChangeStatus` 入参，不另起一套判权。
           三格（状态 / 优先级 / 类型）共用 `TodoPickField` —— 观感与键盘行为只有一份，
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
      <!-- 类型四档（任务/需求/缺陷/自定义，默认「任务」）。判权与优先级同一档。
           custom 档选中后不立即写入：先展开输入框拿到名字，确认才发请求（后端对空名明确拒收）。 -->
      <div>
        <TodoPickField
          :label="t('todo.categoryLabel')"
          :hint="t('todo.categoryHint')"
          :model-value="categoryDraft ?? item.category ?? 'task'"
          :current="categoryCurrent"
          :current-class="TODO_CATEGORY_PILL[categoryDraft ?? item.category ?? 'task']"
          :options="categoryOptions"
          :disabled="!canChangeStatus"
          @update:model-value="onCategoryPick"
        />
        <div v-if="canChangeStatus && showCustomCategory" class="mt-2 flex items-center gap-2">
          <Tag class="h-3.5 w-3.5 shrink-0 text-[var(--gosslan-text-2)]" aria-hidden="true" />
          <input
            ref="customInput"
            v-model="customDraft"
            :maxlength="TODO_CUSTOM_CATEGORY_MAX_LEN"
            class="min-w-0 flex-1 rounded-[var(--gosslan-radius-md)] border border-transparent bg-[var(--gosslan-bg)] px-2.5 py-1.5 text-body outline-none transition focus:border-transparent"
            :placeholder="t('todo.categoryCustomPlaceholder')"
            @keydown.enter="ime.enter(applyCustomCategory, $event)"
            @compositionstart="ime.onStart"
            @compositionend="ime.onEnd"
          />
          <CharCounter :text="customDraft" :max="TODO_CUSTOM_CATEGORY_MAX_LEN" />
          <button
            type="button"
            class="tap-safe shrink-0 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-primary-active)] px-2.5 py-1.5 text-meta text-[var(--gosslan-on-primary)] transition hover:opacity-90 disabled:opacity-40"
            :disabled="!customDraft.trim()"
            @click="applyCustomCategory"
          >
            {{ t("common.confirm") }}
          </button>
        </div>
        <!-- 图标那一格与名字同档展开。这一份与看板草稿共用 `TodoIconPicker`：
             两个编辑器各写一排按钮就会开始不一致（同一判据两个家）。 -->
        <div v-if="canChangeStatus && item.category === 'custom'" class="mt-2">
          <TodoIconPicker
            :model-value="item.customIcon ?? TODO_CUSTOM_ICON_DEFAULT"
            @update:model-value="(v: TodoCustomIcon) => emit('icon', v)"
          />
        </div>
      </div>
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
          <UserPlus class="h-3.5 w-3.5" aria-hidden="true" />
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
      <div class="space-y-1 text-meta text-[var(--gosslan-text-2)]">
        <div v-if="item.createdAt">{{ t("todo.createdAt", { time: fmtConversationTime(item.createdAt, t) }) }}</div>
        <div v-if="creator">{{ t("todo.creator", { name: creator }) }}</div>
        <div v-if="assignees" :title="assignees">{{ t("todo.assigneesInline", { names: assignees }) }}</div>
        <!-- 终态时间：完成显示「完成时间」，做不了显示「标记时间」（同一个后端权威时间戳 done_at）。 -->
        <div v-if="item.doneAt && item.status === 'done'">{{ t("todo.doneAt", { time: fmtConversationTime(item.doneAt, t) }) }}</div>
        <div v-else-if="item.doneAt && item.status === 'impossible'">{{ t("todo.impossibleAt", { time: fmtConversationTime(item.doneAt, t) }) }}</div>
      </div>

      <!-- 描述（全文，不截断） -->
      <div>
        <div class="mb-1.5 text-xs text-[var(--gosslan-text-2)]">{{ t("todo.description") }}</div>
        <p
          v-if="item.description"
          class="whitespace-pre-wrap break-words text-meta leading-relaxed text-[var(--gosslan-text)]"
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
           这块本来就在 BaseModal 的滚动区里，再套一条就成"外层一条、里面一条"，
           滚轮落到哪条取决于鼠标停在哪 —— 与「操作条不许随内容滚走」是同一家族的第二个面。
           流水再长也交给外层那一条滚。 -->
      <div v-if="historyEntries.length" class="border-t border-[var(--gosslan-divider)] pt-3">
        <div class="mb-1.5 text-xs text-[var(--gosslan-text-2)]">{{ t("todo.history.sectionTitle") }}</div>
        <ul class="space-y-1">
          <li
            v-for="(entry, i) in [...historyEntries].reverse()"
            :key="entry.msgId + ':' + i"
            class="flex items-baseline gap-2 text-meta leading-relaxed"
          >
            <span class="shrink-0 tabular-nums text-[var(--gosslan-text-2)]">{{ fmtConversationTime(entry.ts, t) }}</span>
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

    <!-- 操作条走 footer 插槽 ⇒ 它在滚动区**之外**，永不随内容滚走（2026-10-12 用户要求）。 -->
    <template #footer>
      <!-- ⚠️ `v-if="item"` 必须带上：这条操作条现在在 `v-if="item"` 那层**之外**
           （它搬到了 footer 插槽，就是为了不随内容滚走）⇒ 少了这个判断，
           item 为 null 时按钮会去读 `item.status` 而崩。 -->
      <div v-if="item" class="flex flex-wrap items-center gap-2 border-t border-[var(--gosslan-divider)] pt-3">
        <PrimaryBtn
          v-if="canChangeStatus && !isTodoTerminalStatus(item.status)"
          type="button"
          @click="emit('complete')"
          >
          <Check class="h-3.5 w-3.5" />{{ t("todo.complete") }}
        </PrimaryBtn>
        <!-- 进入终态（完成/做不了）之后**手动**归档。
             归档那一档由 `canArchive` 决定 —— 它对**全体群成员**开放（用户 2026-09-24 #37），
             比"改状态"宽；但只在终态给按钮（后端拒绝归档非终态任务）。
             「恢复」仍然要 `canChangeStatus`：它是把状态改回待办，不是"取消归档"。 -->
        <button
          v-else-if="canArchive && isTodoTerminalStatus(item.status) && !archived"
          type="button"
          class="tap-safe flex items-center gap-1 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] px-3 py-1.5 text-body text-[var(--gosslan-text-2)] transition hover:text-[var(--gosslan-text)]"
          @click="emit('archive')"
        >
          <Archive class="h-3.5 w-3.5" />{{ t("todo.archive") }}
        </button>
        <!-- 「恢复」不在这里 —— 它是把状态从「完成」退回「待办」，见下面的 canRestore。 -->
        <button
          v-if="archived && canRestore"
          type="button"
          class="tap-safe flex items-center gap-1 rounded-[var(--gosslan-radius-md)] bg-[var(--gosslan-hover)] px-3 py-1.5 text-body text-[var(--gosslan-text-2)] transition hover:text-[var(--gosslan-text)]"
          @click="emit('restore')"
        >
          <RotateCcw class="h-3.5 w-3.5" />{{ t("todo.restore") }}
        </button>

        <span class="flex-1"></span>

        <button
          v-if="canEditStructure || canEditAssignees"
          type="button"
          class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-hover)]"
          :title="t('todo.edit')"
          :aria-label="t('todo.edit')"
          @click="emit('edit')"
        >
          <Pencil class="h-4 w-4" />
        </button>
        <button
          v-if="canDelete"
          type="button"
          class="tap-safe flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-danger-soft)] hover:text-[var(--gosslan-danger-ink)]"
          :title="t('todo.remove')"
          :aria-label="t('todo.remove')"
          @click="emit('remove')"
        >
          <Trash2 class="h-4 w-4" />
        </button>
      </div>
    </template>
  </BaseModal>

  <!-- 大图预览：Teleport 到 body，压在弹窗之上（与合并转发卡片同一做法） -->
</template>
