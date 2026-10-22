/**
 * 群任务的**折叠**（纯函数，便于单测）。
 *
 * 一条任务 = 定义层里的一个 **LWW 寄存器**：`kind = "todo"`，按 `todo_id` 合并，
 * 版本 = `(seq, msg_id)`。改标题 / 换指派人 / 改状态 / 删除都是"重新发一份定义"，
 * 所以折叠只需要"同 `todo_id` 取最新那一份"。
 *
 * **状态是任务级的单值**（用户 2026-09-16 定的四态：待办 / 进行中 / 延期 / 完成，
 * 手动选、不做截止时间）—— 不是"每人各自一格完成"。
 * 为什么单值用 LWW 就够：一条任务"当前处于什么阶段"本来就是单值语义，并发改动时后写者胜
 * 是期望行为（看板类工具都这样）；真正会丢更新的模型是"每人一格的完成标记"，而这里不做它。
 *
 * 授权口径与后端 `commands::may_change_todo` **必须一致**（后端是权威、这里是显示用的镜像）：
 * 改状态 = 创建者或被指派人；改标题/指派人/删除 = 创建者或群主；
 * **只动归档位** = 任何群成员（用户 2026-09-24）。两边都有各自的用例表。
 */
import type { MessageRecord } from "@/types";

/**
 * 任务状态取值 —— **与 Rust `protocol::TODO_STATUSES` 必须一致**，
 * 由 `messageKinds.test.ts` 读 `protocol.rs` 逐项比对（与 `WIRE_KINDS` 同一套跨语言契约）。
 */
// ⚠️ `impossible`（做不了）与 `done` 同族，是**终态**：见 isTodoTerminalStatus
// （徽标排除、归档门、done_at 与自动归档共用）。位置在 done 前一档，菜单按语义递进排列。
export const TODO_STATUSES = ["todo", "doing", "overdue", "impossible", "done"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];

/** 终态 = 完成 / 做不了（与 Rust `todo_status_is_terminal` 同一份口径）。 */
export function isTodoTerminalStatus(s: unknown): s is "done" | "impossible" {
  return s === "done" || s === "impossible";
}

/**
 * 任务优先级三档的**唯一取值表**（与 Rust `TODO_PRIORITIES` 同序同值）。
 * ⚠️ 改这里必须同时改 Rust 那一处：`src/utils/messageKinds.test.ts` 会直接读 `protocol.rs`
 * 比对**表体与缺省值**（缺省值不一致更阴 —— 旧载荷没这一格时两侧各回落一份，
 * 同一条任务在两个成员界面上显示成不同档位）。
 */
export const TODO_PRIORITIES = ["high", "normal", "low"] as const;
export type TodoPriority = (typeof TODO_PRIORITIES)[number];
/** 缺省档（历史任务与旧版载荷读出来都是它，不是"没优先级"）。 */
export const TODO_PRIORITY_DEFAULT: TodoPriority = "normal";
/** 展示名：一句话说得清、卡片里放得下。 */
export const TODO_PRIORITY_LABEL_KEY: Record<TodoPriority, string> = {
  high: "todo.priority.high",
  normal: "todo.priority.normal",
  low: "todo.priority.low",
};
/** 只有「紧急」抢视觉权重；常规/不急刻意压在次级色，避免三档都变红海。 */
export const TODO_PRIORITY_CLASS: Record<TodoPriority, string> = {
  high: "font-medium text-[var(--gosslan-primary)]",
  normal: "text-[var(--gosslan-text-2)]",
  low: "text-[var(--gosslan-text-2)]",
};

/**
 * 优先级胶囊（详情弹窗那一格与看板行共用）。
 *
 * 配色形状刻意与 [`TODO_CATEGORY_PILL`] 同构（同一批 token、同一档 alpha）：
 * 只有「紧急」抢主色，另两档走中性底 —— 同一条任务上「类型」和「优先级」两个角标
 * 都上彩色的话会互相抢注意力。
 */
export const TODO_PRIORITY_PILL: Record<TodoPriority, string> = {
  high: "bg-[color-mix(in_srgb,var(--gosslan-primary)_14%,transparent)] text-[var(--gosslan-accent-ink)]",
  normal: "bg-[var(--gosslan-hover)] text-[var(--gosslan-text-2)]",
  low: "bg-[var(--gosslan-hover)] text-[var(--gosslan-text-2)]",
};

function isTodoPriority(v: unknown): v is TodoPriority {
  return typeof v === "string" && (TODO_PRIORITIES as readonly string[]).includes(v);
}

/**
 * 任务**类型**三档的取值表（与 Rust `TODO_CATEGORIES` 同序同值，同一套跨语言守卫）。
 *
 * 三者**同列一张表**，靠 tag 区分（用户 2026-09-29：不要为类型另开列表、也不要筛选成互斥视图）。
 * 加第四种 = 这里与 Rust 各加一个值 + 下面 label/class 两张表补齐。
 * 名字用 `category` 而不是 `kind`：本仓的 `kind` 固定指线上消息类型，
 * 而 `parseTodo` 上一行就在判 `rec.kind`，同名会在同一段代码里撞车。
 */
// custom = 用户自己输入的类型名（配 customCategory 文本字段，由服务端校验非空/长度）。
export const TODO_CATEGORIES = ["task", "requirement", "bug", "custom"] as const;
export type TodoCategory = (typeof TODO_CATEGORIES)[number];
/** 缺省档（历史任务与旧版载荷读出来都是它，不是"没类型"）。 */
export const TODO_CATEGORY_DEFAULT: TodoCategory = "task";
export const TODO_CATEGORY_LABEL_KEY: Record<TodoCategory, string> = {
  task: "todo.category.task",
  requirement: "todo.category.requirement",
  bug: "todo.category.bug",
  // 菜单里那一项的固定文案（「自定义…」）；胶囊当前值要显示用户输入的名字，见 todoCategoryName。
  custom: "todo.category.custom",
};
/**
 * 类型 → **胶囊徽标**配色（soft 底 + `*-ink` 字，与 `TODO_STATUS_PILL` 同一套家风）。
 *
 * 与优先级刻意分开：优先级是**文字**、只有「紧急」抢主色；类型三档都是角标。
 * 「缺陷」用 danger 是语义正当的（它确实是出错），与「延期」那次视觉走查的纠正不冲突 ——
 * 那条是"需要关注"、当时被错标成红，这里不重复那个误用。
 * ⚠️ 彩色文字一律走 `*-ink` 档（设计规范 §3.1）；这里只用 style.css 里**已存在**的 token。
 */
export const TODO_CATEGORY_PILL: Record<TodoCategory, string> = {
  task: "bg-[var(--gosslan-hover)] text-[var(--gosslan-text-2)]",
  requirement:
    "bg-[color-mix(in_srgb,var(--gosslan-primary)_14%,transparent)] text-[var(--gosslan-accent-ink)]",
  bug: "bg-[var(--gosslan-danger-soft)] text-[var(--gosslan-danger-ink)]",
  // 自定义类型 = 用户自己起的标签，语义上中立：走中性底，不抢三种内置类型的颜色。
  custom: "bg-[var(--gosslan-hover)] text-[var(--gosslan-text)]",
};

function isTodoCategory(v: unknown): v is TodoCategory {
  return typeof v === "string" && (TODO_CATEGORIES as readonly string[]).includes(v);
}

/**
 * 自定义类型可选的**图标键**白名单（用户 2026-10-14：「自定义类型名称，图标」）。
 *
 * 线上只传这里的键名（与 Rust `TODO_CUSTOM_ICONS` 同序同值，由 `messageKinds.test.ts`
 * 那条跨语言守将对账），两端各自映射成图标组件：
 *  · 不传 emoji —— 同一枚符号在 Windows/鸿蒙上可能落回方框，而图标在这里承担"扫一眼分类"；
 *  · 不传组件名 —— 那会把前端实现细节写进协议，对端拿到一个它没有的组件只剩空白。
 * 键顺序 = 选择器里的展示顺序（常用的放前面）。
 */
export const TODO_CUSTOM_ICONS = [
  "tag",
  "flag",
  "star",
  "zap",
  "wrench",
  "heart",
  "book",
  "clock",
  "target",
  "sparkles",
] as const;
export type TodoCustomIcon = (typeof TODO_CUSTOM_ICONS)[number];

/** 没挑、或旧对端不认识这一格时，两端画同一个形状（与 Rust `TODO_CUSTOM_ICON_DEFAULT` 同值）。 */
export const TODO_CUSTOM_ICON_DEFAULT: TodoCustomIcon = "tag";

/** 图标键是否合法。表外的值一律不认（宁可回落默认，也不让一枚未知形状进渲染）。 */
export function isTodoCustomIcon(v: unknown): v is TodoCustomIcon {
  return typeof v === "string" && (TODO_CUSTOM_ICONS as readonly string[]).includes(v);
}

/**
 * 类型 → **文字**颜色：聊天气泡里那一行用。
 *
 * 与胶囊那份分开是刻意的：气泡表头那一行的字数与 `utils/messageHeight.ts` 的 `TODO_CARD_DESC`
 * 是成对判据（渲染与估算必须同高），在那里多画一枚胶囊会挤掉标题的截断宽度、
 * 却不会改变行高 —— 文字档既能区分又不扰动高度。彩色文字一律走 `*-ink`（设计规范 §3.1）。
 */
export const TODO_CATEGORY_TEXT_CLASS: Record<TodoCategory, string> = {
  task: "text-[var(--gosslan-text-2)]",
  requirement: "text-[var(--gosslan-accent-ink)]",
  bug: "text-[var(--gosslan-danger-ink)]",
  custom: "text-[var(--gosslan-text)]",
};

/**
 * 类型 → **图标**颜色（看板行首那一枚，用户 2026-10-09 要的行前小图标）。
 *
 * 与 `TODO_CATEGORY_TEXT_CLASS` 刻意差一档：`requirement` 这里用**纯主题色**而不是 `accent-ink`。
 * 理由与 `style.css` 里导航栏图标那条同源 —— `accent-ink` 是把主题色**朝黑加深**给正文用的，
 * 压在 14px 的描边图标上偏暗；图标这一族在本仓一直吃纯 `--gosslan-primary`
 * （看分组头的 `TODO_STATUS_CLASS.doing`、任务卡那枚 `ListTodo`）。
 * ⚠️ 只用 style.css 里**已存在**的 token；`*-ink` 与纯色的对比度门槛不同（图标 3.0、文字 4.5），
 * 别把这两张表合并成一张。
 */
export const TODO_CATEGORY_ICON_CLASS: Record<TodoCategory, string> = {
  task: "text-[var(--gosslan-text-2)]",
  requirement: "text-[var(--gosslan-primary)]",
  bug: "text-[var(--gosslan-danger-ink)]",
  custom: "text-[var(--gosslan-text-2)]",
};

/**
 * 优先级 → **图标**颜色：只有「紧急」上色，常规/不急压成次级色。
 *
 * 与 `TODO_PRIORITY_CLASS` / `TODO_PRIORITY_PILL` 同一条立场（"三档都变红海"那次定的）。
 * ⚠️ 但**三档一律画**：2026-09-30 已经用「类型角标」证明过一回 —— 刻意不画的那一档
 * 才是最难认的，扫一眼只能靠猜。区分靠形状（↑ / — / ↓），颜色只负责把「紧急」提出来。
 */
export const TODO_PRIORITY_ICON_CLASS: Record<TodoPriority, string> = {
  high: "text-[var(--gosslan-primary)]",
  normal: "text-[var(--gosslan-text-2)]",
  low: "text-[var(--gosslan-text-2)]",
};

/**
 * 群任务编号的**唯一显示口径**（用户 2026-09-30 那八条规则，全文见
 * `docs/protocol-invariants.md` 的 INV-P29「群任务编号规则」）。
 *
 * 编号 = **当前类型的字母** + **组内永久递增的数字**（`R12` / `B12345` / `T3`）：
 * - 字母**不落库、不上线**，只由 `category` 现推 ⇒ 改类型天然只换字母、数字一字不动（规则 3），
 *   也不必为"换类型要保留原号"再写一条迁移；
 * - 数字的唯一来源是 `resolveTodoNumbers`（创建那一刻由后端 `next_todo_number` 从高水位 +1 分配、
 *   删除与归档都不回收；多人同时发起时折叠按 (号, id) 确定性顶开 ⇒ 各端算出同一份）（规则 2/4）；
 * - 数字超过 `TODO_CODE_DIGITS` 位时，**紧凑界面**（聊天里的任务卡片、看板行）只显示后四位，
 *   完整编号靠悬停（PC）/ 打开详情（移动端，详情本来就是全码）露出（规则 5/6）；
 * - 缩短那份**只是视觉识别码**：库、线上载荷、引用与口头核对用的都是 `full` + 内部 `todoId`（规则 7）。
 */
export const TODO_CATEGORY_LETTER: Record<TodoCategory, string> = {
  requirement: "R",
  bug: "B",
  task: "T",
  // 自定义类型统一用 C（Custom）：名字是自由文本、字母只服务编号识别，不为每个自定义名单独造字母。
  custom: "C",
};

/** 自定义类型名上限 —— 必须与 Rust `TODO_CUSTOM_CATEGORY_MAX_LEN` 同一个数。 */
export const TODO_CUSTOM_CATEGORY_MAX_LEN = 20;

/** 任务标题上限（Rust `group_files.rs::MAX_TODO_TITLE_LEN`）。 */
export const MAX_TODO_TITLE_CHARS = 200;

/** 任务描述上限（Rust `group_files.rs::MAX_TODO_DESC_LEN`）。 */
export const MAX_TODO_DESC_CHARS = 4000;

/**
 * 一条任务当前该显示的**类型名**：custom 档显示用户输入的名字，其余档显示枚举的 i18n key
 * （调用方再 `t()`）。custom 名字缺失（旧载荷/异常）时退回枚举文案，不留空白胶囊。
 */
export function todoCategoryName(
  item: Pick<TodoItem, "category" | "customCategory">,
): { key: string; text: string | null } {
  if (item.category === "custom" && item.customCategory) {
    return { key: "", text: item.customCategory };
  }
  return { key: TODO_CATEGORY_LABEL_KEY[item.category] ?? TODO_CATEGORY_LABEL_KEY.task, text: null };
}

/** 紧凑界面里数字最多占几位；超出只留**后**几位（前缀字母永远在）。 */
export const TODO_CODE_DIGITS = 4;

export interface TodoCode {
  /** 完整编号（如 `B12345`）：详情、复制、引用与对账用的都是它。 */
  full: string;
  /** 紧凑界面用的码；没被缩短时与 `full` 逐字相同。 */
  label: string;
  /** true ⇒ `label` 是后四位，界面必须同时给出"这不是全码"的说明（规则 6）。 */
  shortened: boolean;
}

/**
 * 算出这串编号的三种形态。`number` 为 0/缺（旧版本对端建的任务载荷里就没这个键）时返回
 * **null**：宁可什么都不显示，也不按顺序补一个号 —— 补出来的号会随集合变，正是本条要防的形状。
 */
export function todoCode(category: unknown, number: unknown): TodoCode | null {
  if (!isTodoCategory(category)) return null;
  const n = typeof number === "number" && Number.isFinite(number) ? Math.trunc(number) : 0;
  if (n <= 0) return null;
  const letter = TODO_CATEGORY_LETTER[category];
  const digits = String(n);
  const shortened = digits.length > TODO_CODE_DIGITS;
  const full = `${letter}${digits}`;
  return { full, label: shortened ? `${letter}${digits.slice(-TODO_CODE_DIGITS)}` : full, shortened };
}

/** 新建任务的缺省状态（与 Rust `default_todo_status()` 同值）。 */
export const TODO_STATUS_DEFAULT: TodoStatus = "todo";

/**
 * 状态 → i18n key。放在这里而不是各面板里各写一份：任务状态在**两个**地方出现
 * （群任务面板、群成员面板的任务分区），两处各写一份就会漂移
 * （典型症状：一个面板写「进行中」、另一个写「处理中」）。
 */
export const TODO_STATUS_LABEL_KEY: Record<TodoStatus, string> = {
  todo: "todo.status.todo",
  doing: "todo.status.doing",
  overdue: "todo.status.overdue",
  impossible: "todo.status.impossible",
  done: "todo.status.done",
};

/**
 * 状态 → 文字颜色。彩色**文字**一律走 `*-ink` 档（设计规范 §3.1 的硬约束）。
 *
 * ⚠️ 「延期」用 **warning（橙）**：它是"需要关注"而不是"出错"。此前这里是 `danger-ink`（红），
 * 而群任务看板自己抄了一份橙 —— 同一个状态在两个面板里两种颜色（用户 2026-09-17 视觉走查发现）。
 * 现在三个消费者（本文件、看板、任务卡气泡）共用下面这份映射，口径只有一处。
 */
export const TODO_STATUS_CLASS: Record<TodoStatus, string> = {
  todo: "text-[var(--gosslan-text-2)]",
  doing: "text-[var(--gosslan-primary)]",
  overdue: "text-[var(--gosslan-warning-ink)]",
  // 做不了是**结论**而不是出错（不抢缺陷红/延期橙），用次级文本色与 X 图标表达"此路不通"。
  impossible: "text-[var(--gosslan-text-2)]",
  done: "text-[var(--gosslan-success-ink)]",
};

/**
 * 状态 → **胶囊徽标**配色（soft 底 + `*-ink` 字）—— 与应用的「胶囊徽标」同一套。
 *
 * 看板与任务卡气泡共用（此前各自抄了一份）：`doing` 的主题色浅底用 `color-mix` 派生，
 * 跟随用户自定义主题色，不写死色值。
 */
export const TODO_STATUS_PILL: Record<TodoStatus, string> = {
  todo: "bg-[var(--gosslan-hover)] text-[var(--gosslan-text-2)]",
  doing: "bg-[color-mix(in_srgb,var(--gosslan-primary)_14%,transparent)] text-[var(--gosslan-accent-ink)]",
  overdue: "bg-[var(--gosslan-warning-soft)] text-[var(--gosslan-warning-ink)]",
  impossible: "bg-[var(--gosslan-hover)] text-[var(--gosslan-text-2)]",
  done: "bg-[var(--gosslan-success-soft)] text-[var(--gosslan-success-ink)]",
};

/**
 * 状态 → 列表行的**左侧色条**（用户 2026-09-24 #37：不同状态的任务列表要看得出颜色）。
 *
 * 为什么是一条 2px 色条而不是"整行换底色"：底色要么太淡（等于没有）、要么把
 * `--gosslan-hover` 与选中态盖掉，而四种底色同屏会花。色条与状态胶囊同一族色
 * （`primary` / `warning` / `success`；「待办」是"还没开始"⇒ 中性灰，与离线点同一个 token），
 * 扫一眼就能分组，又不跟行内的其他颜色抢。
 * ⚠️ 只准用 token、别写死色值：深色模式下这四个 token 另有取值。
 */
export const TODO_STATUS_BAR: Record<TodoStatus, string> = {
  todo: "bg-[var(--gosslan-status-offline)]",
  doing: "bg-[var(--gosslan-primary)]",
  overdue: "bg-[var(--gosslan-warning)]",
  // 与「待办」同为灰系但深一档：色条分族（在办=蓝/橙、终态=绿/深灰），区分靠 X 图标与胶囊。
  impossible: "bg-[var(--gosslan-text-2)]",
  done: "bg-[var(--gosslan-success)]",
};

export function isTodoStatus(v: unknown): v is TodoStatus {
  return typeof v === "string" && (TODO_STATUSES as readonly string[]).includes(v);
}

export interface TodoImage {
  /** 跨端唯一 id（= 文件 sha256 / cid），落盘文件名与去重键。 */
  id: string;
  name: string;
  size: number;
  sha256: string;
  subtype: string;
}

/**
 * 聊天气泡卡片里**最多画几张缩略图**（用户 2026-10-12：超过就显示「查看更多」）。
 *
 * 为什么必须是共享常量而不是各写一个 4：这个数同时决定两件事 ——
 *  ① `TodoCardBubble` 的 `v-for` 取前几张；
 *  ② `utils/messageHeight.ts` 的 `todoImageAllowance()` 按"可见几张"占几行高度。
 * 两处只要有一处写字面量，改数量时另一边就会静默不同步 ⇒ 虚拟列表遮挡（本仓已记的契约）。
 *
 * 为什么是 4：卡片 `w-64`，内容宽 `256 − 24(px-3×2) = 232px`，缩略图 80px + gap 4px
 * ⇒ 每行正好 2 张，4 张 = 整整 2 行；再多就得靠「查看更多」去详情弹窗里看全部
 * （详情弹窗是「查看全部」的目的地，显示全部图，不截断）。
 */
export const TODO_CARD_IMAGE_VISIBLE = 4;

/**
 * 按上限切出要画的缩略图，并告诉调用方"是否还有更多"（`TodoCardBubble` 的唯一入口）。
 *
 * 单独成函数而不是让组件自己 `slice` + `>` 比较：判据要与 `todoImageAllowance()`
 * 的行数算式**逐字对应**（见 messageHeight.ts 的注释），放在这里两处才不会各自漂移。
 */
export function visibleTodoImages<T>(images: T[]): { shown: T[]; hasMore: boolean } {
  const shown = images.slice(0, TODO_CARD_IMAGE_VISIBLE);
  return { shown, hasMore: images.length > TODO_CARD_IMAGE_VISIBLE };
}

export interface TodoItem {
  todoId: string;
  title: string;
  assignees: string[];
  status: TodoStatus;
  creator: string;
  /** 优先级（三档，缺省常规）。 */
  priority: TodoPriority;
  /** 类型（任务/需求/缺陷/自定义，缺省普通任务）。同列，界面上用胶囊 tag 区分。 */
  category: TodoCategory;
  /** 自定义类型名（仅 category==="custom" 有值；由服务端校验非空与长度）。 */
  customCategory: string;
  /**
   * 自定义类型的图标键（用户 2026-10-14：名字之外还要能挑图标；仅 custom 档有意义）。
   * 解析端保证**永远是白名单内的键**（读不出来就落 `TODO_CUSTOM_ICON_DEFAULT`）⇒ 渲染层
   * 不必再判 undefined，也不会出现"这一格没挑所以画空白"。
   */
  customIcon: TodoCustomIcon;
  /** 长文本描述（2026-09-17 优化）。 */
  description: string;
  /** 描述里附带的图片（仅元数据，真实字节走群文件管线）。 */
  images: TodoImage[];
  /** 是否**显式**归档（完成之后手动归档；用户 2026-09-17 起完成不再自动归档）。 */
  archived: boolean;
  /**
   * 群内固定编号的数字部分（1 起、组内唯一、创建时定、编辑/归档不改、删了也不回收）；
   * 0 = 无号（旧版本对端建的任务，载荷里根本没有这个字段 ⇒ 不猜号、不补号）。
   * 界面上那个「R12 / B2345」的码只许由 `todoCode()` 从这一格 + `category` 现算
   * （`resolveTodoNumbers` 是数字的唯一来源），别再在别处按顺序数一遍。
   */
  number: number;
  /** 状态变为「完成」的权威时间戳（ms）；未完成/旧载荷为 null。 */
  doneAt: number | null;
  /** 创建时间（创建那条 `todo` 消息的 ts）；由 `foldTodos` 从创建记录回填，旧数据可能为 null。 */
  createdAt: number | null;
}

interface TodoDef extends TodoItem {
  deleted: boolean;
  seq: number;
  msgId: string;
  /**
   * 这一份载荷里，`priority` / `category` / `number` 哪几格**没读出一个合法值**
   * （键不存在，或值不认识 ⇒ 本端表达不了就等于"这位没说这一格"）。
   *
   * 为什么非要留这一份信息：`4.31.14` 之前的载荷根本没有这三个键，而按默认值读会让
   * "老对端改一次状态"顺手把类型/优先级/编号抹平（mesh 没有服务器也没有强制升级 ⇒ 混合版本是常态）。
   * ⇒ 折叠时**没说的格子沿用这条任务已知的值**，见 [`carryAbsentTodoFields`]。
   */
  absent?: TodoAbsent;
}

interface TodoAbsent {
  priority: boolean;
  category: boolean;
  number: boolean;
  /** 载荷里没带 `custom_icon` 键（老对端不认识这一格）⇒ 折叠时沿用已知的，别抹成默认。 */
  customIcon: boolean;
}

/** 完成态超过该天数后自动归档（前端计算，见 `isEffectivelyArchived`）。 */
export const TODO_AUTO_ARCHIVE_DAYS = 7;

/** 版本序比较：**(seq, msg_id) 元组**。只看 seq 会让不同副本算出不同结果
 *  （seq 是 Lamport 时钟，两端离线后各发一条都可能拿到同一个 seq）。
 *  ⚠️ 与 Rust `commands::latest_todo_def` 的 `ORDER BY seq DESC, msg_id DESC` 同规则。 */
function newer(seq: number, msgId: string, cur: { seq: number; msgId: string } | undefined): boolean {
  return !cur || seq > cur.seq || (seq === cur.seq && msgId > cur.msgId);
}

export function parseTodo(rec: MessageRecord): TodoDef | null {
  // 两种 kind 同构：`todo` = 创建（Card，会通知），`todo_update` = 改状态/改标题/删除
  // （Silent，不打扰全群）。它们同属一条 LWW 序列，所以折叠时一视同仁。
  if (rec.kind !== "todo" && rec.kind !== "todo_update") return null;
  try {
    const p = JSON.parse(rec.content) as Record<string, unknown>;
    if (typeof p.todo_id !== "string" || !p.todo_id) return null;
    // 「这一格没说」= 键不存在 **或** 值本端读不出合法值（后者含未来新增的档位：
    // 本端表达不了就等于没说，宁可沿用自己的已知值，也不要每来一份新载荷就回落默认值抖一次）。
    const absent: TodoAbsent = {
      priority: !isTodoPriority(p.priority),
      category: !isTodoCategory(p.category),
      number: !(typeof p.number === "number" && p.number > 0),
      customIcon: !isTodoCustomIcon(p.custom_icon),
    };
    return {
      todoId: p.todo_id,
      title: typeof p.title === "string" ? p.title : "",
      assignees: Array.isArray(p.assignees)
        ? p.assignees.filter((x): x is string => typeof x === "string")
        : [],
      // 未知/缺失状态一律回落「待办」：宁可显示成一条待办，也不要让这条任务从列表里消失
      status: isTodoStatus(p.status) ? p.status : TODO_STATUS_DEFAULT,
      creator: typeof p.creator === "string" ? p.creator : "",
      // 未知/缺失一律回落「常规」：宁可给一档可读的默认，也不让这条任务的优先级变成空白
      //（⚠️ 这里的缺省只在**没有前一份定义**时成立；有前一份 ⇒ 折叠时沿用，见 carryAbsentTodoFields）
      priority: isTodoPriority(p.priority) ? p.priority : TODO_PRIORITY_DEFAULT,
      // 类型同口径：读不出合法值 ⇒ 先当"没说这一格"，由折叠决定沿用还是回落
      category: isTodoCategory(p.category) ? p.category : TODO_CATEGORY_DEFAULT,
      // 自定义名是普通字符串字段：没带就是空串。是否沿用由折叠结合 absent.category 决定
      //（老对端不认识 custom 档时，类别与名字要一起沿用，不能只留类别不留名字）。
      customCategory: typeof p.custom_category === "string" ? p.custom_category.trim() : "",
      // 图标读不出合法键 ⇒ 落默认那枚（渲染要的是一个确定形状）。是否"沿用旧的"看 absent.customIcon。
      customIcon: isTodoCustomIcon(p.custom_icon) ? p.custom_icon : TODO_CUSTOM_ICON_DEFAULT,
      deleted: p.deleted === true,
      description: typeof p.description === "string" ? p.description : "",
      images: Array.isArray(p.images)
        ? p.images.filter(
            (x): x is TodoImage =>
              !!x && typeof x === "object" && typeof (x as TodoImage).sha256 === "string",
          )
        : [],
      archived: p.archived === true,
      number: typeof p.number === "number" && p.number > 0 ? Math.trunc(p.number) : 0,
      doneAt: typeof p.done_at === "number" ? p.done_at : null,
      createdAt: null,
      seq: rec.seq,
      msgId: rec.msg_id,
      absent,
    };
  } catch {
    return null;
  }
}

/**
 * 一条任务的后一份定义**没说到**的格子，沿用前一份已知值。
 *
 * ★ 这条规矩必须与 Rust `commands::latest_todo_def` 里的同一份一致（那边也要沿用才判得出权），
 *   两处分头实现 ⇒ 改动时两个文件一起改，别只改一边。
 *   `number` 还有一层：**它是创建那一刻定死的绝对坐标**，折叠另外只认创建那一条显式带的号
 *   （老对端从库里整份重建载荷时会写 0，那种 0 也算"没说"）。
 */
export function carryAbsentTodoFields(prev: TodoDef, next: TodoDef): TodoDef {
  const a = next.absent;
  if (!a || (!a.priority && !a.category && !a.number && !a.customIcon)) return next;
  return {
    ...next,
    priority: a.priority ? prev.priority : next.priority,
    category: a.category ? prev.category : next.category,
    // 类别沿用时自定义名必须一起沿用：只把 category=custom 留下而名字变空串，
    // 下一次保存就会被服务端按"自定义名称不能为空"拒掉。
    customCategory: a.category ? prev.customCategory : next.customCategory,
    // 图标与名字同一条规矩的另一个面：类别沿用时图标必须一起沿用，否则"老对端改一次状态"
    // 就把用户挑过的图标抹回默认那枚（Rust 侧 `latest_todo_def` 里有同一条，两边一起改）。
    customIcon: a.customIcon ? prev.customIcon : next.customIcon,
    number: a.number ? prev.number : next.number,
  };
}

/** 折叠出当前全部任务（墓碑不列），按**最新定义的 seq 从大到小**（＝"最近被改过的在最前"）。
 *
 * ⚠️ 排序键**不是**创建时间：`seq` 来自 LWW 折叠后留下的那份**最新定义**，
 * 所以一条老任务只要被改一次就会排到新创建的任务前面。以前这句注释写的是"按创建版本从新到旧"，
 * 与本文件自己的 `newer()`/实现都不符（#154 第 10 条的另一半）—— 注释错了比没有注释更坏，
 * 因为它会让人以为看板顺序稳定，而实际顺序会随每次编辑跳动。
 * 要"按创建时间排"得改实现并配一条反向断言，那是产品决定，不在本轮收尾范围。
 *
 * 创建时间单独收集：它来自**创建那条记录**（`kind === "todo"`），而 LWW 折叠保留的是
 * 最新定义（往往是 `todo_update`）—— 两条是不同的记录，不能混在一张表里。 */
/**
 * 把"载荷里的号"折成"这一群当前显示的号"。
 *
 * 正常路径是恒等：创建时分配的号已经是组内唯一，这里原样给出。
 * 只有一种情况会动它——**两个成员在彼此离线的窗口里各自建任务，撞了同一个号**
 * （`number` 由各自本地分配，中间没有任何仲裁者，这是 P2P 下无法避免的一次窗口）。
 * 收敛办法是把规则写成"当前这批定义"的**纯函数**：按 (号, todo_id) 定序，
 * 号相同则 `todo_id` 小的保住原号、其余顺延 ⇒ 每个成员拿到同一批定义时必然算出同一套号，
 * 不需要额外同步帧，也不需要谁去改写谁的定义。
 *
 * 无号（0，旧版本对端建的）不参与编号，也不占号。
 *
 * ⚠️ 顺延只发生在撞号那一条上：一条已显示 #5 的任务不会因为"来了新任务"变成 #6。
 */
export function resolveTodoNumbers(defs: { todoId: string; number: number }[]): Map<string, number> {
  const numbered = defs.filter((d) => d.number > 0).sort((a, b) => a.number - b.number || (a.todoId < b.todoId ? -1 : 1));
  const out = new Map<string, number>();
  let prev = 0;
  for (const d of numbered) {
    const n = Math.max(d.number, prev + 1);
    out.set(d.todoId, n);
    prev = n;
  }
  return out;
}

export function foldTodos(records: MessageRecord[]): TodoItem[] {
  const defs = new Map<string, TodoDef>();
  const created = new Map<string, number>();
  // 创建那一条**显式带来的号**：`number` 是绝对坐标，只有创建那一刻说的话算数
  // （取 seq 最小的那条创建记录 —— 同一 todo_id 理论上只有一条，这里是防御）。
  const createdNumber = new Map<string, { n: number; seq: number }>();
  for (const rec of records) {
    const d = parseTodo(rec);
    if (!d) continue;
    if (rec.kind === "todo") {
      // 防御性保留较早的 ts（同一 todo_id 只应有一条创建记录）。
      const prev = created.get(d.todoId);
      if (prev === undefined || rec.ts < prev) created.set(d.todoId, rec.ts);
      if (!d.absent?.number) {
        const keep = createdNumber.get(d.todoId);
        if (!keep || d.seq < keep.seq) createdNumber.set(d.todoId, { n: d.number, seq: d.seq });
      }
    }
    const prevDef = defs.get(d.todoId);
    // ★ 后一份定义**没说到**的格子沿用已知的值（老对端的载荷根本没有这三格 ⇒
    //   不沿用就会被一次编辑抹平）。规矩与 Rust `commands::latest_todo_def` 同一条。
    let merged = prevDef ? carryAbsentTodoFields(prevDef, d) : d;
    // 类别仍是 custom 却没带名字（老对端重建载荷时会丢这一格）⇒ 沿用上一个已知名字，
    // 与 Rust `latest_todo_def` 的 carry_custom_category 同口径。
    if (
      merged.category === "custom" &&
      !merged.customCategory &&
      prevDef?.category === "custom" &&
      prevDef.customCategory
    ) {
      merged = { ...merged, customCategory: prevDef.customCategory };
    }
    if (newer(merged.seq, merged.msgId, prevDef)) defs.set(d.todoId, merged);
  }
  const live = [...defs.values()]
    .filter((d) => !d.deleted)
    .map((d) => ({ ...d, number: createdNumber.get(d.todoId)?.n ?? d.number }));
  const numbers = resolveTodoNumbers(live);
  return live
    .sort((a, b) => {
      if (a.seq !== b.seq) return b.seq - a.seq; // 新的在前
      return a.msgId < b.msgId ? 1 : -1; // 同 seq 按 msg_id 比（与 newer 同规则）
    })
    .map(({ todoId, title, assignees, status, creator, priority, category, customCategory, customIcon, description, images, archived, doneAt }) => ({
      todoId,
      number: numbers.get(todoId) ?? 0,
      title,
      assignees,
      status,
      creator,
      priority,
      // ⚠️ 这一串是**白名单式**解构：新字段不写在这里就会在 parse 之后被静默丢掉
      // （能编译、门禁全绿、界面上没有那一格 —— 最难查的一种"接了一半"）。
      category,
      customCategory,
      customIcon,
      description,
      images,
      archived,
      doneAt,
      createdAt: created.get(todoId) ?? null,
    }));
}

/**
 * 时间线上每张任务卡片**现在**该显示的那一格（状态 + 编号码）。
 *
 * 两个字段走的是同一条道理（用户 #23 + 2026-09-30 的编号规则 3）：卡片气泡读的是创建那条
 * `todo` 消息的载荷，之后的改动全走静默的 `todo_update` ⇒ 载荷**永远停在创建那一刻**。
 * 所以「干完了还挂着待办」和「改成缺陷了还写着 R」是同一个缺陷的两个面：
 * 状态要查折叠结果，**类型字母也一样要查**（字母由当前 `category` 现推，数字仍是创建那个号）。
 * 与看板同源：这里只是把 `foldTodos` 的结果换成按 `todo_id` 查表，判据不在这里再写一遍。
 */
export interface TodoLive {
  status: TodoStatus;
  /** null = 折叠结果里没有可显示的号（旧版本对端建的）⇒ 卡片退回自己的创建快照。 */
  code: TodoCode | null;
}

export function todoLiveMap(items: TodoItem[]): Map<string, TodoLive> {
  const m = new Map<string, TodoLive>();
  for (const x of items) {
    m.set(x.todoId, { status: x.status, code: todoCode(x.category, x.number) });
  }
  return m;
}

/**
 * 一条任务**实际上**是否已归档（用于列表过滤）。
 *
 * 两种情况（用户 2026-09-17：完成之后手动归档）：
 * - 显式 `archived` 为真 ⇒ 已归档（用户在进入终态之后手动点的）；
 * - 或「终态（完成/做不了）且超过 `TODO_AUTO_ARCHIVE_DAYS` 天」⇒ 自动归档（没手动归档的兜底）。
 *
 * 自动归档是**前端计算**的（`doneAt` 由后端在**首次**进入终态时填权威时间戳、重复保存不改），
 * 不另存字段、也不依赖定时任务，跨端结果一致。
 */
export function isEffectivelyArchived(
  item: Pick<TodoItem, "status" | "archived" | "doneAt">,
  now: number = Date.now(),
): boolean {
  if (item.archived) return true;
  if (isTodoTerminalStatus(item.status) && item.doneAt != null) {
    return now - item.doneAt >= TODO_AUTO_ARCHIVE_DAYS * 86400000;
  }
  return false;
}

/**
 * 「与我相关且还活着」的任务 —— 蓝色徽标的**唯一**判据（用户 2026-09-26）。
 *
 * 口径原话是"除了完成和归档的其他数据都统计"，所以排除的只有两类：
 * - **终态**（`done` 完成 / `impossible` 做不了）；
 * - **归档**，且必须走 [`isEffectivelyArchived`] 那一份 —— 它同时含"手动归档"与
 *   "终态满 7 天自动归档"，在别处再写一遍 `item.archived` 就会与列表口径分叉。
 * 其余状态（待办 / 进行中 / 延期）一律计入。
 *
 * "与我相关" = 指派里有我 **或** 我是创建人（我发的任务还挂着，用户也要看得见）。
 * ⚠️ 会话列表与聊天头的任务图标**都必须调这一份**；两处各数一次就是两份真源。
 * `myId` 为空 ⇒ 直接返回空：身份还没就绪时不许点亮一个假数字。
 */
export function openTodosForMe<
  T extends Pick<TodoItem, "status" | "archived" | "doneAt" | "assignees" | "creator">,
>(items: T[], myId: string, now: number = Date.now()): T[] {
  if (!myId) return [];
  return items.filter(
    (t) =>
      !isTodoTerminalStatus(t.status) &&
      !isEffectivelyArchived(t, now) &&
      (t.assignees.includes(myId) || t.creator === myId),
  );
}

/**
 * 我能不能改这条任务（**显示用**的镜像，后端 `commands::may_update_todo` 才是权威）。
 * 归档另有一档（比这里宽），见 [`canArchiveOrReopenTodo`]。
 *
 * | 改动 | 允许谁 |
 * |---|---|
 * | 改标题 / 删除（结构） | 创建者 **或** 群主 |
 * | 其余改动（描述 / 图片 / 指派人 / 状态） | 创建者 **或** 群主 **或** 当前被指派人 |
 *
 * 群主**什么都能改**（用户 2026-09-20：「群主不能编辑群任务」—— 此前群主的改动被落到
 * 「只改状态」那一档，描述 / 图片 / 状态都会被拒）。
 *
 * 判据与后端 `may_update_todo` 必须一致（后端是权威、这里是显示用的镜像）。
 */
export function canUpdateTodo(
  item: Pick<TodoItem, "creator" | "assignees">,
  actor: string,
  groupCreator: string,
  structural: boolean,
): boolean {
  // 创建者 / 群主：改什么都行。
  if (item.creator === actor || groupCreator === actor) return true;
  // 被指派人：能改描述 / 图片 / 指派人 / 状态，但不能改结构（标题 / 删除）。
  if (structural) return false;
  return item.assignees.includes(actor);
}

/**
 * 把指派收敛到当前群成员。成员表为空（群资料尚未加载）时原样返回，不能把历史指派误删光。
 * 用于新增/编辑/认领三条会显式写 `assignees` 的路径。
 */
export function assigneesInGroup(assignees: readonly string[], members: readonly string[]): string[] {
  if (members.length === 0) return [...assignees];
  const allowed = new Set(members);
  return assignees.filter((id) => allowed.has(id));
}

/**
 * 我能不能**改指派人**（用户 2026-09-17：被 @ 的人也能转派/加人）。
 * 创建者 / 群主 / 当前被指派人 都行；与后端 `edits_assignees` 分支一致。
 */
export function canEditAssignees(
  item: Pick<TodoItem, "creator" | "assignees">,
  actor: string,
  groupCreator: string,
): boolean {
  if (item.creator === actor) return true;
  if (groupCreator === actor) return true;
  return item.assignees.includes(actor);
}

/**
 * 我能不能**归档 / 还原**这条任务（用户 2026-09-24：「群里所有人都可以归档」，
 * 同日追加：「归档和被归档的数据还原，任何人都可以操作，其他权限不变」）。
 *
 * 对应后端 `commands::may_change_todo` 的「成员窄档」。后端是**两条**判据
 * （`archive_only_change` 只翻归档位 / `reopen_only_change` 只把状态从完成退回待办），
 * 但放行条件相同（是本群成员即可），所以这里合成一个判据 —— 两处各写一份迟早会漂。
 *
 * ⚠️ 它**只**覆盖归档与还原：改标题 / 描述 / 图片 / 指派人 / 完成状态仍走
 * [`canUpdateTodo`] 那两档。尤其"把一条没干完的任务标成完成"没有放宽 ——
 * 成员能收摊、也能把活重新拎回来，但不能替别人宣布干完了。
 * 归档只在「完成」态成立（后端明确拒绝未完成任务的归档请求），所以调用方还要自己判
 * `status === "done"` 才给按钮。
 */
export function canArchiveOrReopenTodo(
  item: Pick<TodoItem, "creator" | "assignees">,
  actor: string,
  groupCreator: string,
  memberIds: readonly string[],
): boolean {
  if (canUpdateTodo(item, actor, groupCreator, false)) return true;
  return !!actor && memberIds.includes(actor);
}

/**
 * 该任务是否点名了我（被指派人之一）—— 用于「有人@我」徽标与通知。
 *
 * 显式 @ 指派的人（用户 2026-09-17 定的口径）：被指派 ═ 被 @。指派人是 device id，
 * 所以直接拿我的 `device_id` 去比对 `assignees`，不走昵称匹配
 * （昵称可重复、可改，device id 才是稳定身份）。
 */
export function todoMentionsMe(rec: MessageRecord, myId: string): boolean {
  if (!myId) return false;
  const d = parseTodo(rec);
  if (!d) return false;
  return d.assignees.includes(myId);
}

/**
 * 这条记录是否是「**我创建的任务进入终态了**」—— 用于给创建人提示
 * （完成：用户 2026-09-17；做不了：2026-10-12 同族放行）。
 *
 * 返回终态与任务标题（标题为空串时仍返回空串，调用方自行回落文案）；不是该情形返回 `null`。
 *
 * 为什么单独放行：改状态走的是 `todo_update`（Silent，不打扰全群），但"我派的活有了结论"
 * 对**创建人**是个该知道的变化 —— 只在创建人这里破例，其他人仍然一条通知都不多。
 * 只认终态（完成/做不了），改标题/改指派人/删除都不提示。
 */
export function todoTerminalForCreator(
  rec: MessageRecord,
  myId: string,
): { status: TodoStatus; title: string } | null {
  if (!myId || rec.kind !== "todo_update") return null;
  const d = parseTodo(rec);
  if (!d || d.deleted || !isTodoTerminalStatus(d.status) || d.creator !== myId) return null;
  return { status: d.status, title: d.title };
}

/**
 * 旧的窄口径包装：只认「完成」。保留给既有调用点/测试；新代码用
 * [`todoTerminalForCreator`]（做不了与完成同族）。
 */
export function todoCompletedForCreator(rec: MessageRecord, myId: string): string | null {
  const t = todoTerminalForCreator(rec, myId);
  return t && t.status === "done" ? t.title : null;
}

// ---------------- 操作记录（全员对这条任务的改动流水） ----------------
//
// 数据源就是消息库里这条任务的全部 `todo`/`todo_update` 事件：任务定义是 LWW 寄存器，
// 每次改动都是"重新发一份完整定义"，所以相邻两份定义逐字段 diff 就能还原**谁在什么时候
// 改了什么**（用户 2026-10-12：任务列表里要展示所有人的操作记录）。不新增协议字段、
// 不新增数据库表 —— 事件日志本来就在（ADR-0018 任务无专表）。

/** 一类可展示的改动；文案在视图层用 i18n 映射，纯函数不依赖翻译。 */
export type TodoHistoryChangeKind =
  | "created"
  | "title"
  | "description"
  | "status"
  | "priority"
  | "category"
  | "assignees_add"
  | "assignees_remove"
  | "archived"
  | "restored"
  | "deleted";

export interface TodoHistoryChange {
  kind: TodoHistoryChangeKind;
  /** status/priority 变更：原档/新档（视图层映射 i18n）。 */
  from?: string;
  to?: string;
  /** category 变更时两档的自定义名（非 custom 档为空串，视图层对枚举档走 i18n）。 */
  fromCustom?: string;
  toCustom?: string;
  /** 指派人变更：进出的成员 id（视图层用 nameOf 解析昵称）。 */
  ids?: string[];
}

export interface TodoHistoryEntry {
  /** 该条事件的消息时间（ms）。 */
  ts: number;
  /** 操作者 device_id（= 该条消息的 sender_id）。 */
  actor: string;
  /** 这一次事件包含的全部改动（通常 1 条；旧客户端合并改动时可能多条）。 */
  changes: TodoHistoryChange[];
  /** 产生该条记录的消息 id（去重/排查用）。 */
  msgId: string;
}

interface HistoryDef {
  d: TodoDef;
  ts: number;
  actor: string;
  msgId: string;
}

/**
 * 还原一条任务的操作流水（**旧的在前**）。
 *
 * - 输入是该群的原始消息行（与 `foldTodos` 同源），函数自己按 `(seq, msg_id)` 排序，
 *   与 LWW 折叠同一条序规则；
 * - 同一条事件里被删除/重建（理论上不会发生）按定义顺序逐段 diff；
 * - 墓碑是最后一个可见事件；图片增删不进流水（描述附图是编辑的一部分，单列只会刷噪声）；
 * - 一条事件里没有可识别改动（例如只换了图片）则**不产生条目**：流水只记读得懂的动作。
 */
export function buildTodoHistory(todoId: string, records: MessageRecord[]): TodoHistoryEntry[] {
  const defs: HistoryDef[] = [];
  for (const rec of records) {
    const d = parseTodo(rec);
    if (!d || d.todoId !== todoId) continue;
    defs.push({ d, ts: rec.ts, actor: rec.sender_id, msgId: rec.msg_id });
  }
  defs.sort((a, b) => a.d.seq - b.d.seq || (a.d.msgId < b.d.msgId ? -1 : 1));
  const out: TodoHistoryEntry[] = [];
  let before: TodoDef | null = null;
  for (const cur of defs) {
    const changes: TodoHistoryChange[] = [];
    const d = cur.d;
    if (before === null) {
      // 库里最早的一份：正常是 kind="todo" 的创建事件；历史裁剪导致只剩 update 时也按"创建"展示。
      changes.push({ kind: "created" });
    } else if (d.deleted && !before.deleted) {
      changes.push({ kind: "deleted" });
    } else if (!d.deleted) {
      if (d.title !== before.title) changes.push({ kind: "title" });
      if (d.description !== before.description) changes.push({ kind: "description" });
      // 还原 = 从终态退回待办（服务端同时清归档位与完成时间），它在语义上不是普通状态变更。
      if (d.status !== before.status) {
        if (isTodoTerminalStatus(before.status) && d.status === "todo") {
          changes.push({ kind: "restored" });
        } else {
          changes.push({ kind: "status", from: before.status, to: d.status });
        }
      }
      if (d.priority !== before.priority) {
        changes.push({ kind: "priority", from: before.priority, to: d.priority });
      }
      if (d.category !== before.category || d.customCategory !== before.customCategory) {
        changes.push({
          kind: "category",
          from: before.category,
          to: d.category,
          fromCustom: before.customCategory,
          toCustom: d.customCategory,
        });
      }
      // 闭包里 TS 不再保持 null 收窄 ⇒ 用局部常量（逻辑上进入 else 时 before 必非空）。
      const prevDef = before;
      const added = d.assignees.filter((a) => !prevDef.assignees.includes(a));
      const removed = prevDef.assignees.filter((a) => !d.assignees.includes(a));
      if (added.length) changes.push({ kind: "assignees_add", ids: added });
      if (removed.length) changes.push({ kind: "assignees_remove", ids: removed });
      if (d.archived && !before.archived) changes.push({ kind: "archived" });
    }
    if (changes.length) {
      out.push({ ts: cur.ts, actor: cur.actor, changes, msgId: cur.msgId });
    }
    before = d;
  }
  return out;
}

// ---------------- 看板 / 面板取的那一份源（#154-9） ----------------
//
// 为什么需要它：徽标一直走后端**全表读**（`api.getGroupTodoMessages`），而看板、任务面板、成员面板
// 折的是 `chat.messages[convId]` —— 那份消息缓存有两道上界（`PAGE_SIZE × MAX_PAGES = 1000 条/会话`、
// `MAX_CACHED_CONVS = 8` 个会话整块逐出）。于是「徽标还亮着，看板里却再也列不出这条任务」是可达状态，
// 用户没法归档一个看不见的任务。`refreshConversations` 的注释早就写明"用内存里已有的消息算不行"，
// 那句话当时只应用在徽标那一半 ⇒ 同一句判据两个家。下面这三个函数是那**一个家**的语义，
// store 只做持有，消费者（看板/面板/成员页）只读 `chat.groupTodoRows`。

/** 按会话存的任务相关行（后端全表读的结果）。
 *  **键存在 = 这个群读到过**（空数组 = 读了、确实没有任务）；键不存在 = 还没读过。
 *  这两件事必须分得开，否则"没有任务"与"还没数据"画成同一个样子，看板每次打开都要重读一遍。 */
export type TodoRowsByConv = Record<string, MessageRecord[]>;

/**
 * 每个会话最多保留多少条任务消息行（决策 5，拍板 5A(500)）。
 *
 * 后端只限会话数、不限行数（`get_todo_messages_for_conns` 的 `ORDER BY seq ASC`），
 * 而看板/徽标折的是这份全表读 ⇒ 不封顶会随任务事件单调增长；`foldTodos` 还会
 * 在每个新事件上把整份重解析一遍。取最末尾的 N 条（后端升序返回、增量事件追加在尾部）
 * ⇒ 最近的任务状态优先保留。
 *
 * ⚠️ **只裁前端运行态缓存，不碰数据库**：被裁掉的老任务仍在 `messages` 表里，
 * 需要时仍可从库里取回（拍板明确禁止为了省内存永久删除任务历史）。
 */
export const MAX_TODO_ROWS_PER_CONV = 500;

function capTodoRows(rows: MessageRecord[]): MessageRecord[] {
  // `bounded.ts::trimOldest` 只接受 Map/Set；这里是按插入序的数组，等价地保留末尾 N 条。
  return rows.length > MAX_TODO_ROWS_PER_CONV ? rows.slice(-MAX_TODO_ROWS_PER_CONV) : rows;
}

/** 整表读的结果落进那份源：`convIds` 是这次读**点到**的全部会话（后端只回有任务的会话）。 */
export function putTodoRows(
  prev: TodoRowsByConv,
  convIds: string[],
  rows: MessageRecord[],
): TodoRowsByConv {
  const byConv: TodoRowsByConv = {};
  for (const r of rows) {
    const list = byConv[r.conv_id];
    if (list) list.push(r);
    else byConv[r.conv_id] = [r];
  }
  const next: TodoRowsByConv = { ...prev };
  for (const cid of convIds) next[cid] = capTodoRows(byConv[cid] ?? []);
  return next;
}

/** 读到过没有（区分「没有任务」与「还没读过」）。 */
export function isTodoRowsLoaded(rows: TodoRowsByConv, convId: string): boolean {
  return Object.prototype.hasOwnProperty.call(rows, convId);
}

/** 取某个会话的任务行。 */
export function todoRowsFor(rows: TodoRowsByConv, convId: string): MessageRecord[] {
  return rows[convId] ?? [];
}

/**
 * 任务行首屏的三态（看板 / 任务弹窗 / 成员面板共用一份判据）。
 *
 * - 读到过 ⇒ `ready`：**即使**失败记录还留着（成功过就以数据为准，错误不该盖住内容）；
 * - 没读到 + 有失败记录 ⇒ `error`（带原因，调用方给重试入口）；
 * - 没读到 + 没有记录 ⇒ `loading`（"还没开始/正在读"都算，调用方不许显示空态）。
 */
export type TodoRowsLoadState = { status: "loading" | "ready" | "error"; error: string };
export function todoRowsLoadState(
  rows: TodoRowsByConv,
  errors: Record<string, string>,
  convId: string,
): TodoRowsLoadState {
  if (isTodoRowsLoaded(rows, convId)) return { status: "ready", error: "" };
  const error = errors[convId] ?? "";
  return error ? { status: "error", error } : { status: "loading", error: "" };
}

/**
 * 乐观更新（自己刚发的、或事件里收到的任务行）落在**同一份**源上。
 *
 * 两条规矩都要：
 *  - 只写**已加载**的会话：给没读过的会话建键 = 拿一份局部快照冒充全量，那正是这次要消灭的形状；
 *  - 同 `msg_id` 是刷新而不是追加：后端对同一条消息存在回填式重发（见 store 里 `applyIncoming` 的注释），
 *    追加会让一条任务被折两遍。
 */
export function mergeIncomingTodoRows(
  rows: TodoRowsByConv,
  incoming: MessageRecord[],
): TodoRowsByConv {
  const todo = incoming.filter((m) => parseTodo(m) !== null);
  if (todo.length === 0) return rows;
  const next: TodoRowsByConv = { ...rows };
  let changed = false;
  for (const m of todo) {
    if (!isTodoRowsLoaded(next, m.conv_id)) continue;
    const existing = next[m.conv_id];
    const i = existing.findIndex((x) => x.msg_id === m.msg_id);
    const merged = i >= 0 ? existing.map((x, j) => (j === i ? m : x)) : [...existing, m];
    next[m.conv_id] = capTodoRows(merged);
    changed = true;
  }
  return changed ? next : rows;
}
