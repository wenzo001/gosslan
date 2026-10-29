<script setup lang="ts">
import type { CSSProperties } from "vue";
import BubbleTail from "@/components/message/BubbleTail.vue";
/**
 * 时间线里的群任务卡片气泡（用户 2026-09-17：任务消息不该在聊天里显示原始 JSON）。
 *
 * `todo` 是 Card kind：进时间线、计未读、弹通知，但不属于"聊天历史"。这里把它的 JSON 载荷
 * 渲染成一张可读的卡片（标题 / 状态 / 描述 / 图片 / 指派人 + 打开面板入口）。
 *
 * 载荷是**创建那一刻的快照**（改状态走的是 `todo_update`，那一条是静默事件、不进时间线），
 * 所以所有展示字段（状态 / 类型 / 标题 / 描述 / 图片 / 指派）都必须查父层传来的实时表
 * `liveTodo`（用户 #23：不查的话卡片永远挂着「待办」；2026-10-25：任务里补的图也不会出现）；
 * 表里查不到（任务已删 / 那条消息没被折叠进来）才退回快照。
 */
import { computed } from "vue";
import { useMemberProfile } from "@/composables/useMemberProfile";
import { useImagePreviewStore } from "@/stores/useImagePreview";
import MentionText from "@/components/message/MentionText.vue";
import TodoImageThumb from "@/components/TodoImageThumb.vue";
import { selectionTextWithin } from "@/utils/textSelection";
import {
  TODO_CATEGORY_LABEL_KEY,
  TODO_CATEGORY_TEXT_CLASS,
  TODO_PRIORITY_CLASS,
  TODO_PRIORITY_LABEL_KEY,
  TODO_STATUS_LABEL_KEY,
  TODO_STATUS_PILL,
  parseTodo,
  todoCode,
  visibleTodoImages,
  type TodoLive,
  type TodoStatus,
} from "@/utils/todos";
import { t } from "@/i18n";
import { ChevronRight, ListTodo } from "lucide-vue-next";
import type { MessageRecord } from "@/types";

const props = defineProps<{
  message: MessageRecord;
  /** 自己发的卡片：尖角朝右指向右侧头像。 */
  mine?: boolean;
  /** 从父层 MessageItem 透传的卡片样式（自己的卡片跟随自己的主题气泡色，对方保持中性）。 */
  cardStyle?: CSSProperties;
  /**
   * 任务 `todo_id` → **当前**状态与当前编号码（会话层折叠一次传下来，见 `ChatWindow.todoLive`）。
   * 缺省空表 = 单测/别的宿主没传 ⇒ 退回卡片自己的创建快照。
   */
  liveTodo?: Map<string, TodoLive>;
  /**
   * 已删除任务的 `todo_id` 集合（与看板同源的墓碑判定）。
   * 墓碑在 `foldTodos` 里被丢掉 ⇒ `liveTodo` 查不到它;不传这一份，卡片就会退回
   * "创建那一刻的快照"，看起来仍是一条活着的任务，而列表里早已没有（用户 2026-10-27）。
   */
  deletedIds?: Set<string>;
  /**
   * @ 渲染的判定输入（由 MessageItem 透传，与聊天正文同一份）。
   * 缺省 = 单测/别的宿主没传 ⇒ 描述里的 @ 不高亮，但文案仍是原文（不会退化成「@你」）。
   */
  mentionNames?: string[];
  selfMention?: { name: string; label: string } | null;
  /** 单聊显示气泡尾巴；群聊不显示（2026-10-23：群聊改为无尾巴的整体气泡）。 */
  tail?: boolean;
}>();
/** 带上 `todo_id`：点卡片要直达**这一条**任务的详情（用户 #23），不是只把看板打开。 */
const emit = defineEmits<{
  /**
   * 点**底部操作区**：打开看板并直达这条任务详情。载荷是这条任务的 todo_id
   * （查不到 id 时为 undefined，调用方退化为只打开看板）。
   */
  (e: "open", todoId: string | undefined): void;
  /**
   * 点**卡片主体**（头部 / 描述 / 指派人）：打开群任务面板并**定位到这条**（滚过去 + 闪一下），
   * 不展开详情。载荷与「查看任务」同一个 todo_id；两者只差"到了之后干什么"。
   * 与底部按钮是两个互不重叠的命中区，不共用一个处理器。
   */
  (e: "open-panel", todoId: string | undefined): void;
}>();

const { memberProfile } = useMemberProfile();

const todo = computed(() => parseTodo(props.message));
const todoId = computed(() => todo.value?.todoId);
/**
 * 折叠表里的**当前**任务（标题 / 描述 / 图片 / 指派 / 优先级 / 类型）。
 *
 * 载荷是创建那一刻的快照；2026-10-25 用户实测「在任务里加了图片，聊天里那张卡片没更新」。
 * 展示字段一律优先读这一份，查不到（任务被删 / 这条消息没折叠进来）才退回快照。
 */
const live = computed(() => (todoId.value ? (props.liveTodo?.get(todoId.value) ?? null) : null));
/** 这条任务已被删除（墓碑）—— 与看板口径同一份（看板直接不列出它）。 */
const deleted = computed(() => !!todoId.value && !!props.deletedIds?.has(todoId.value));
/** 当前处于归档态（显式归档或终态满 7 天）—— 看板的「全部」不列它，卡片要自己说清楚。 */
const archived = computed(() => !deleted.value && live.value?.archived === true);
const title = computed(() => live.value?.title ?? todo.value?.title ?? "");
const description = computed(() => live.value?.description ?? todo.value?.description ?? "");
const category = computed(() => live.value?.category ?? todo.value?.category ?? "task");
const customCategory = computed(() => live.value?.customCategory ?? todo.value?.customCategory ?? "");
const priority = computed(() => live.value?.priority ?? todo.value?.priority ?? "normal");
const assignees = computed(() => live.value?.assignees ?? todo.value?.assignees ?? []);
/**
 * 卡片里的图走**全局那一份**预览（§12「要做就做完整」）。
 *
 * 为什么这一格单独值得写一句：`TodoImageThumb` 的 `clickable` 默认是 **false**，所以"调用点漏给
 * 这一个 prop"不会编译报错、不会类型报错、单测也不红 —— 只是**图渲染出来了却点不动**。
 * 收藏那一处就是这么修的（`a077850`），而修完那一轮**同一个开关在聊天时间线的任务卡上仍然漏着**
 * ⇒ 现在由 `designGuards` 按形状数每个调用点，不靠人记得。
 * 来源标记用 `task-card:` 前缀，与任务详情弹窗那处的 `task:<todoId>` **刻意不同**：
 * 两处显示的是同一条任务的同一组图，但"按来源收预览"是精确匹配，共用一个 key 会让一边把另一边的收掉。
 */
const preview = useImagePreviewStore();
const cardImages = computed(() => live.value?.images ?? todo.value?.images ?? []);
/**
 * 卡片里**只画前 `TODO_CARD_IMAGE_VISIBLE` 张**（用户 2026-10-12：图多时先看几张，
 * 剩下的去详情弹窗）。条数上限共享自 `utils/todos.ts`，`messageHeight.ts` 的
 * `todoImageAllowance()` 按同一个常量算行数 —— 两处不许各写字面量，否则会遮挡。
 */
const cardThumbs = computed(() => visibleTodoImages(cardImages.value));
const cardGallery = computed(() =>
  cardImages.value.map((im) => ({ cid: im.sha256, name: im.name })),
);
const cardSource = computed(() => (todoId.value ? `task-card:${todoId.value}` : null));
function openCardImage(i: number) {
  preview.openGallery(cardGallery.value, i, cardSource.value);
}

/**
 * 点卡片**主体**：只打开群任务面板（不直达某一条）。
 *
 * 三个命中区互不重叠（见模板）：主体 → open-panel；底部操作条 → open(todoId)；
 * 图片缩略图 → 统一预览（**由缩略图自己** `stopPropagation`，见 `TodoImageThumb.open`）。
 * ⚠️ 拦截点在缩略图而不在图片带容器：容器一 stop 会把"图片周围那一圈"（空隙、`px-3` 内边距、
 * 右侧留白）一起吃掉，那正是 2026-10-12 用户实测「点图片周围没反应」的根因。
 * 描述里可能有真链接（MentionText → MessageLinkText 渲染的 `<a>`）：点链接必须
 * 只走外部打开，不能顺手把面板也弹出来。
 */
function openPanel(e: MouseEvent) {
  if ((e.target as HTMLElement | null)?.closest("a")) return;
  // 划选卡片描述（桌面档 `.gosslan-card-text`）结束那一下浏览器照样发 `click` ——
  // 选区就在这张卡里 ⇒ 这一次手势是"选中"，不是"打开面板"。负责人 2026-10-28 拍板只开桌面档，
  // 代价就是这里必须自己认出来；判据用现成的 `selectionTextWithin`（选区与该元素相交才算），
  // 不用 `hasTextSelection()`：那会把"别处还留着一次选区、这次真的想点开卡片"也吞掉。
  const card = e.currentTarget;
  if (card instanceof Element && selectionTextWithin(card)) return;
  // 带上 todoId：面板打开后要**滚到这条并闪一下**（负责人 2026-10-29："点上半区只表示是哪条"）。
  // 与底部「查看任务」的差别只在 mode，落在哪一条上是同一份数据。
  emit("open-panel", todoId.value);
}
function openPanelKey(e: KeyboardEvent) {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault(); // 空格不滚页
  emit("open-panel", todoId.value);
}
/**
 * 卡片显示的状态 = **当前**状态（折叠结果），查不到才退回创建时的快照。
 *
 * 为什么要专门查这一张表（用户 #23）：载荷是创建那一刻的快照，而之后的改动都走
 * `todo_update`（静默事件、不进时间线）⇒ 卡片自己的载荷**永远停在创建时**，
 * 而新建任务恒为「待办」。表现就是"群里任务早干完了，聊天里那条还挂着待办"，
 * 也正是用户去点卡片的原因 —— 查不到（任务被删 / 消息页没折叠到）时宁可显示快照，
 * 也不要空着或骗人说已同步。
 */
const status = computed<TodoStatus>(
  () => live.value?.status ?? todo.value?.status ?? "todo",
);
/**
 * 卡片上那串编号（字母 + 数字）。口径整份在 `utils/todos.ts` 的 `todoCode`，这里只负责取用：
 * 字母取**当前**类型（折叠表里那一份），查不到才退回创建快照 ⇒「改成缺陷了还写着 R」不会发生；
 * 数字是创建那一刻那一个（`resolveTodoNumbers` 已保证各端对同一批定义算出同一套号）。
 */
const code = computed(() => live.value?.code ?? todoCode(todo.value?.category, todo.value?.number));

/**
 * 自己的卡片（`mine`）底色是自己的主题气泡色 ⇒ 共享的 `TODO_*_CLASS`（给中性底写的）
 * 不能直接上屏：`--gosslan-text-2` / `--gosslan-primary` 在深色实底上会掉到 4.5 以下。
 * 这里只覆盖**颜色**，形状/字号/字重仍沿用共享表；对方卡片完全不变。
 */
const priorityClass = computed(() => {
  const key = priority.value;
  if (!props.mine) return TODO_PRIORITY_CLASS[key];
  return key === "high"
    ? "font-medium text-[var(--card-action)]"
    : "text-[var(--card-ink-soft)]";
});
const categoryClass = computed(() => {
  const key = category.value;
  if (!props.mine) return TODO_CATEGORY_TEXT_CLASS[key];
  if (key === "bug") return "text-[var(--card-danger)]";
  if (key === "requirement") return "text-[var(--card-action)]";
  if (key === "custom") return "text-[var(--card-ink)]";
  return "text-[var(--card-ink-soft)]";
});
const statusPillClass = computed(() =>
  props.mine
    ? "bg-[var(--card-chip)] text-[var(--card-ink)]"
    : TODO_STATUS_PILL[status.value],
);

function statusText(s: TodoStatus): string {
  return t(TODO_STATUS_LABEL_KEY[s]);
}
</script>

<template>
  <div class="relative w-64 max-w-full" :style="props.cardStyle">
    <!-- `data-todo-card`：有表情回应时底栏会接在下面，由 style.css 把这两个下角拉平
         （用户 2026-10-25：hover 下半区要是一条横条，不是又一块圆角底色）。 -->
    <div data-todo-card class="overflow-hidden rounded-[var(--gosslan-bubble-radius)]">
    <!-- 命中区①：卡片主体（头部 / 描述 / 指派人）→ 只打开群任务面板，不直达某一条。
         role=button + tabindex 让它与底部真按钮一样键盘可达；hover 给反馈。
         ⚠️ 这里不许用透明覆盖层：图片与底部操作条是**兄弟**命中区，盖一层会一起吃掉。
         ⚠️ 2026-10-25：`pb-2` 留在主体里、底部操作条不再 `mt-2` —— hover 背景必须一直铺到
         分隔线（旧形状在两者之间留了 8px 白缝，看起来就是"上半边 hover 没到底"）。 -->
    <div
      class="cursor-pointer pb-2 transition hover:bg-[var(--card-chip)]"
      role="button"
      tabindex="0"
      :aria-label="title || t('todo.title')"
      @click="openPanel"
      @keydown="openPanelKey"
    >
    <div class="flex items-center gap-2 px-3 pt-2.5">
      <ListTodo class="h-4 w-4 shrink-0 text-[var(--card-action)]" />
      <!-- 群内固定编号（`R12` / `B2345`）：成员各自库里同一条任务是同一个号，口头引用才对得上。
           没号（旧版本对端建的载荷里没这个键）⇒ 不显示，也不按顺序补一个（补出来的号会随集合变）。
           数字超过 4 位时这一行只显**后四位**（用户 2026-09-30 规则 5），全码有三个出口：
           PC 悬停（`title`）、读屏（aria-label 永远给全码）、点卡片进详情（详情标题写全码）。
           缩短那一份只是视觉识别码 —— 落库、上线、引用的都是完整编号 + 内部 todoId（规则 7）。 -->
      <span
        v-if="code"
        class="shrink-0 font-mono text-caption text-[var(--card-ink-soft)]"
        :aria-label="t('todo.codeAria', { code: code.full })"
        :title="code.shortened ? t('todo.codeShortTip', { full: code.full }) : undefined"
      >
        {{ code.label }}
      </span>
      <!-- 优先级（紧急 / 常规 / 不急）：只有「紧急」抢权重，其余压次级色，
           免得三档一起亮反而读不出重点。谁能改见 `canUpdateTodo`（发起人/关联人/群主）。 -->
      <span
        class="shrink-0 text-caption"
        :class="priorityClass"
      >
        {{ t(TODO_PRIORITY_LABEL_KEY[priority]) }}
      </span>
      <!-- 类型：只有「需求 / 缺陷」在这一行占一格（文字档，不画胶囊 —— 见
           `TODO_CATEGORY_TEXT_CLASS` 上那段与 messageHeight 成对的说明）。
           「任务」这一档不占位，旧数据读出来也是它 ⇒ 与不画完全同形。 -->
      <span
        v-if="category !== 'task'"
        class="shrink-0 max-w-[6rem] truncate text-caption"
        :class="categoryClass"
        :title="category === 'custom' ? customCategory : undefined"
      >
        <!-- 类型与自定义名也取**当前值**（任务面板改完，聊天卡片同步）。 -->
        {{ category === "custom"
          ? (customCategory || t(TODO_CATEGORY_LABEL_KEY.custom))
          : t(TODO_CATEGORY_LABEL_KEY[category]) }}
      </span>
      <span
        class="min-w-0 flex-1 truncate text-body font-medium text-[var(--card-ink)]"
        :title="title || t('todo.title')"
      >
        {{ title || t("todo.title") }}
      </span>
      <!-- 状态胶囊走共享映射（`TODO_STATUS_PILL`）；字号 11px 是设计规范的最小可用档。 -->
      <span class="shrink-0 inline-flex h-[18px] items-center justify-center rounded-full px-1.5 text-caption font-medium leading-none" :class="statusPillClass">
        {{ statusText(status) }}
      </span>
      <!-- 「已删除 / 已归档」：让聊天卡片与看板说同一件事。
           没有这一格时，已删除任务在聊天里仍是一张"活着"的卡（列表里已经没有了），
           而已归档任务在看板「全部」里也找不到 —— 两处都会被读成"同步坏了"。 -->
      <span
        v-if="deleted"
        class="shrink-0 inline-flex h-[18px] items-center justify-center rounded-full bg-[var(--card-chip)] px-1.5 text-caption font-medium leading-none text-[var(--card-ink-soft)]"
      >
        {{ t("todo.stateDeleted") }}
      </span>
      <span
        v-else-if="archived"
        class="shrink-0 inline-flex h-[18px] items-center justify-center rounded-full bg-[var(--card-chip)] px-1.5 text-caption font-medium leading-none text-[var(--card-ink-soft)]"
      >
        {{ t("todo.stateArchived") }}
      </span>
    </div>

    <!-- 描述：卡片里只看得到前 3 **整行**（全文在详情弹窗）。
         ⚠️ 高度必须落在整行上：这段行距是 `leading-relaxed`(1.625)，原先写的 `max-h-[4.2em]`
         等于 2.58 行 ⇒ 第 3 行被削掉半截字，比"少显示一行"更像 bug。
         改行数必须同步 `utils/messageHeight.ts` 的 `TODO_CARD_DESC`（渲染与估算成对，
         否则虚拟列表按旧值排布 ⇒ 相邻消息互相遮挡，那是本仓另一条已记的契约）。 -->
    <p
      v-if="description"
      class="gosslan-card-text mt-1 max-h-[calc(3*1.625em)] overflow-hidden whitespace-pre-wrap break-words px-3 text-meta leading-relaxed text-[var(--card-ink-soft)]"
    >
      <!-- 描述里的 @ 走与聊天正文**同一份**渲染件（§9）：段怎么切、@到算不算我、
           显示成什么，全部在 utils/linkify 那一处，这里只负责画出来。 -->
      <MentionText
        :text="description"
        :mention-names="mentionNames"
        :self-mention="selfMention"
      />
    </p>

    <!-- ⚠️ 这里的 `@click.stop` **不许**留在容器上（2026-10-12 用户实测：点图片周围没反应）：
         容器一 stop，整条图片带（含缩略图之间的空隙、右侧留白、px-3 内边距）全部不再冒泡
         ⇒ 点到"图片周围"什么都不会发生，而用户认为那些区域属于卡片主体、应该展开任务面板。
         正确形状是**只让缩略图自己拦**：`TodoImageThumb.open()` 里对可点的那一支调
         `e.stopPropagation()` ⇒ 点缩略图只开预览（不会顺手把面板也弹出来），
         而容器不再 stop ⇒ 图片周围那些区域正常冒泡到命中区①。
         ⚠️ 键域仍在这里 stop：缩略图的键盘处理**不合成 click**（走不到主体的 keydown），
         容器若放行 keydown，在缩略图上按回车会"又开预览又开面板"。
         ⇒ 这一层是**故意的**：click 交给缩略图自己拦、keydown 由容器兜住（Enter/Space 两键都要）。 -->
    <div
      v-if="cardImages.length"
      class="mt-1.5 flex flex-wrap gap-1 px-3"
      @keydown.enter.stop
      @keydown.space.stop
    >
      <!-- 命中区③：图片缩略图 → 只开统一预览。
           只画前 `TODO_CARD_IMAGE_VISIBLE` 张（超出的由下面的「查看更多」去详情弹窗看）；
           预览相册仍是**全部**图（cardGallery 未截断）⇒ 从第 2 张起往后翻能看到全部。 -->
      <TodoImageThumb
        v-for="(img, i) in cardThumbs.shown"
        :key="img.sha256"
        :image="img"
        clickable
        @open="openCardImage(i)"
      />
    </div>

    <!-- 图多于上限时的入口（用户 2026-10-12：图片超过 4 张应显示「查看更多」，
         点了像底部「查看任务」一样打开列表并直达这条任务）。
         ⚠️ 与底部按钮**同一套行为、同一个 emit**（`open` 带 todoId）：用户明确说
         「像查看任务一样」，所以这里不另开一条路径 —— 两处都落到 open(todoId)。
         ⚠️ `.stop` 是这条"一模一样"的一部分，不是可选的：底部那颗在命中区①**之外**，
         而这颗为了贴着图片带排在①**之内** ⇒ 不 stop 就会在 open(todoId) 之后再多冒一个
         open-panel（面板被打开两次，第二次还不带 todoId ⇒ 直达这条任务的效果被冲掉）。 -->
    <button
      v-if="cardThumbs.hasMore"
      type="button"
      class="mt-1.5 flex w-full items-center justify-center gap-1 px-3 py-1 text-meta text-[var(--card-action)] transition hover:bg-[var(--card-chip)]"
      @click.stop="emit('open', todoId)"
    >
      {{ t("todo.viewMoreImages") }}
      <ChevronRight class="h-3 w-3" />
    </button>

    <div class="mt-1.5 flex min-w-0 flex-wrap items-center gap-1 px-3">
      <span
        v-for="a in assignees"
        :key="a"
        class="truncate rounded-full bg-[var(--card-chip)] px-1.5 py-0.5 text-caption text-[var(--card-ink)]"
        :title="memberProfile(a).name"
      >
        {{ memberProfile(a).name }}
      </span>
      <span v-if="assignees.length === 0" class="text-caption text-[var(--card-ink-soft)]">
        {{ t("todo.assigneesEmpty") }}
      </span>
    </div>
    </div>
    <!-- /命中区①：主体 -->

    <!-- 命中区②：底部操作条 → 打开看板并直达**这条**任务详情（带 todoId）。
         ⚠️ 不再 `mt-2`：主体 hover 要铺到这条分隔线；间距由主体的 `pb-2` 提供。 -->
    <button
      type="button"
      class="flex w-full items-center justify-center gap-1 border-t border-[var(--card-line)] py-1.5 text-meta text-[var(--card-action)] transition hover:bg-[var(--card-chip)]"
      @click="emit('open', todoId)"
    >
      {{ t("todo.openPanel") }}
      <ChevronRight class="h-3 w-3" />
    </button>
    <!-- 内部包裹层在此闭合（带 overflow-hidden 做圆角裁切）；尖角必须放在外面，
         root 是 relative 但不 overflow-hidden，否则会被裁掉（尖角在卡片外 -5px 处）。 -->
    </div>
    <!-- 指向发送者头像的小尖角（与文本/代码气泡同款 .bubble-tail）：卡片无描边，
         直接用标准 -5px 偏移即可贴合，尖角色取 --bubble-bg（= card 底色）。 -->
    <BubbleTail v-if="tail" :mine="mine" />
  </div>
</template>
