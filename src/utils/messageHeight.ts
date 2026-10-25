// 消息行高度估算：VirtualList 按它排布，MessageItem 按 previewMetrics 渲染，
// 两边必须共用同一套常量（见 previewMetrics.ts 顶部说明），否则相邻消息会互相遮挡。

import {
  CLAMPED_CODE_BLOCK_HEIGHT,
  IMAGE_BUBBLE_HEIGHT,
  codeBlockHeight,
  imageBubbleHeight,
  shouldShowTimeDivider,
  textBubbleHeight,
} from "@/utils/previewMetrics";
import { parseFileMeta } from "@/utils/fileMeta";
// 可见图片数的唯一家（卡片画几张、这里按几行估高，同一个常量）
import { TODO_CARD_IMAGE_VISIBLE } from "@/utils/todos";
import type { FontSizeKey } from "@/utils/chatStyle";
// 昵称行的判定与渲染端共用（提示行没有昵称行这条规则写在那个函数里）
import { groupSide, isKnownKind, messageTopGap, shouldShowNickname } from "@/utils/messageKinds";
import type { MessageRecord } from "@/types";

/**
 * 行距（2026-10-23 改成按「消息组」给，不再是一个常数）：
 *   组内相邻（same sender / 5 分钟内 / 都是 text|code）= 4px，换组 = 10px。
 * 实现是「本行恒定 4px 下边距 + 行首 0/6px 上间距」，两者相加正好是 4 / 10。
 * ⚠️ 与 `MessageItem` 的 `GAP_BASE` / `GAP_TOP_*` 成对，与 `messageKinds.groupSide` 同一个判定。
 */
const GAP_BASE = 4;
// 上间距的两个档（0 / 6）住在 messageKinds.messageTopGap：零依赖模块才跑得动真值表。
/** 群聊昵称行：leading-none(11) + mb-[7px](7) = 18px。
 *  字号/行高改动必须同步这里与 MessageItem 的昵称行（两者是同一份高度的两处表达）。
 *  行高取 leading-none 是为了让墨迹贴住行盒顶、与头像顶边齐平（行高 1.5 会往下推 ~3.7px，看着"名字偏低"）。 */
const NICKNAME_ROW = 18;
/** 时间分割线（含 py-2） */
const TIME_DIVIDER = 32;
/** 普通文件卡片 */
const FILE_CARD = 92;
/** 提示行（系统消息 / 已撤回）：text-xs 行盒 16 + ROW_PADDING 12。 */
const SYSTEM_ROW = 28;
/**
 * 合并转发卡片：固定高度（标题 1 行 + 最多 3 行预览 + 页脚 1 行 + 内外边距）。
 *
 * 卡片**刻意做成定高**：它的内容（N 条摘要）随条数变化，若高度随之变化，
 * 虚拟列表的估算就得跟着算一遍"3 行里每行会不会换行"，而卡片本来就有"最多 3 行预览"
 * 的截断设计 —— 让渲染与估算都锚在这个常量上最省事也最稳。
 * 改卡片内边距/行数时必须同步这里（`MergeCard.vue` 里有注释指向本常量）。
 */
const MERGE_CARD = 96;
/** 群任务卡片（TodoCardBubble）：头部(30) + 指派人行(24) + 底部按钮(38) + 余量。 */
const TODO_CARD_BASE = 96;
/** 任务卡片有描述时追加：描述预览 3 整行（12px × 行距 1.625 = 19.5）= 58.5，再加 `mt-1` 的 4 ⇒ 62.5，取 64。
 *  ⚠️ 与 `TodoCardBubble.vue` 那句 `max-h-[calc(3*1.625em)]` **成对**：改渲染行数就得改这里，
 *  否则就是低估 ⇒ 相邻消息互相遮挡（本文件顶部那条契约说的就是这件事）。
 *  这一对的实测锁在运行时探针 `scripts/check-ui-runtime.mjs` 的 #116 那条（量矩形，不靠肉眼）。 */
const TODO_CARD_DESC = 64;
/**
 * 任务卡片图片段的占位 —— 按**这一条自己的张数**算，不是按上限算。
 *
 * 三个数都来自运行时探针 `scripts/check-ui-runtime.mjs --only=task` 的「高度实测表」
 * （2026-10-13 实测：1 行那一段 80、2 行 164、`mt-1.5`=6、「查看更多」那颗 26）：
 *  - 缩略图 `h-20` = 80，`gap-1` = 4，图片带自己的 `mt-1.5` = 6；
 *  - 卡片 `w-64` ⇒ 内容宽 `256 − 24(px-3×2) = 232`，`80+4+80=164` 正好两列 ⇒ 每行 2 张；
 *  - 张数超过可见上限时多一行「查看更多」：`mt-1.5`(6) + 26 = 32。
 *
 * ⚠️ 为什么不能像上一版那样"有图就加一整块"（那是按 `VISIBLE` 张算的固定值）：
 *  一条只有 1 张图的任务会白占 2 行的高度（实测多留 86px ⇒ 卡片之间出现空洞），
 *  而一条 5 张以上的又**少**了「查看更多」那一行（实测差 32px ⇒ 相邻消息互相遮挡）。
 *  两个方向都被探针钉住：`真实 ≤ 估算` 与 `估算 − 真实 ≤ 100`。
 * ⚠️ 可见张数只许引 `TODO_CARD_IMAGE_VISIBLE`（`todos.ts` 那一个家）—— 卡片画几张与这里
 *  占几行必须同源，改一边忘一边就是本文件顶部那条契约说的已发生事故类型。
 */
const TODO_CARD_IMAGE_ROW = 80;
const TODO_CARD_IMAGE_GAP = 4;
const TODO_CARD_IMAGE_TOP = 6;
/** 每行 2 张：`80 + gap 4 + 80 = 164` 落在 232px 内容宽里，第三张必然折行。 */
const TODO_CARD_IMAGE_PER_ROW = 2;
const TODO_CARD_VIEW_MORE = 32;

/** 图片段（含「查看更多」那一行）占多少高度；`count` = 这条任务**载荷里**的图片张数。 */
function todoImageAllowance(count: number): number {
  if (count <= 0) return 0;
  const visible = Math.min(count, TODO_CARD_IMAGE_VISIBLE);
  const rows = Math.ceil(visible / TODO_CARD_IMAGE_PER_ROW);
  const band = TODO_CARD_IMAGE_TOP + rows * TODO_CARD_IMAGE_ROW + (rows - 1) * TODO_CARD_IMAGE_GAP;
  return band + (count > TODO_CARD_IMAGE_VISIBLE ? TODO_CARD_VIEW_MORE : 0);
}
/**
 * 未知 kind 的占位气泡（`UnsupportedKindBubble`）：说明行 + 展开按钮 + 上下边距，留余量。
 *
 * 它**与载荷长度无关** —— 未知消息的载荷往往是 JSON，按文本估会高出一大片空白。
 * 改占位气泡的行数时要同步这里（与 MERGE_CARD 同一类契约）。
 */
const UNSUPPORTED_BUBBLE = 92;
export interface EstimateContext {
  messages: MessageRecord[];
  isGroup: boolean;
  /** 本机 device_id：用于判断「非本人」及昵称行。 */
  selfId?: string;
  fontSize: FontSizeKey;
  /**
   * 任务卡片**当前**的展示尺寸输入（来自折叠结果）。
   *
   * 消息载荷是创建那一刻的快照；任务面板里补的图片/描述只走静默的 `todo_update`。
   * 卡片渲染已经改成读实时表（`TodoCardBubble`），估算也必须查同一份 —— 否则用户加图后
   * 卡片真实高度变大、估算还停在旧值，虚拟列表就会按旧高度排布相邻消息（本文件顶部那条契约）。
   */
  todoLive?: (todoId: string) => TodoCardLiveMetrics | undefined;
}

export interface TodoCardLiveMetrics {
  images: number;
  hasDescription: boolean;
}

/**
 * 气泡高度缓存：键 = 字号 + msg_id。
 *
 * 为什么必须有：VirtualList 的 offsets 是**全表前缀和**（O(n)），任何时候有行的实测高度与估算
 * 不一致，就会触发整表重算 → 重算里对每条消息都要调一次估算。50 万条的会话一重算就是
 * 50 万次估算，而估算对 file 类消息还要 `JSON.parse(content)`（10% 的消息命中）。
 *
 * 为什么只缓存「气泡」这一段：整体的高度还包含昵称行与时间分割线，而**分割线取决于上一条消息
 * 的时间**（`prev.ts`），所以整函数的结果随下标变化、不能按 msg_id 缓存。气泡段只依赖
 * (kind, content, 字号)，这三者对同一条消息是不变的（本应用没有「编辑消息」功能）。
 *
 * 为什么把字号放进键里：唯一会变的就是设置页的字号——放进去之后改字号自然全部失效，
 * 不需要任何手动清理逻辑。
 */
const bubbleCache = new Map<string, number>();
/** 缓存上限：超出后按插入顺序淘汰最早的一条（Map 保序，O(1)）。 */
const BUBBLE_CACHE_MAX = 50_000;

function bubbleHeightCached(
  m: MessageRecord,
  fontSize: FontSizeKey,
  live?: TodoCardLiveMetrics,
): number {
  // 任务卡片的实时尺寸会变（用户补图/补描述）⇒ 键里带上实时输入，变了自然失效。
  const key = live
    ? `${fontSize}|${m.msg_id}|t${live.images}:${live.hasDescription ? 1 : 0}`
    : `${fontSize}|${m.msg_id}`;
  const hit = bubbleCache.get(key);
  if (hit !== undefined) return hit;
  const v = computeBubbleHeight(m, fontSize, live);
  if (bubbleCache.size >= BUBBLE_CACHE_MAX) {
    const oldest = bubbleCache.keys().next().value;
    if (oldest !== undefined) bubbleCache.delete(oldest);
  }
  bubbleCache.set(key, v);
  return v;
}

/** 气泡本身的高度（不含昵称行 / 时间分割线）。 */
function computeBubbleHeight(
  m: MessageRecord,
  fontSize: FontSizeKey,
  live?: TodoCardLiveMetrics,
): number {
  switch (m.kind) {
    case "code":
      return codeBlockHeight(m.content);
    case "image": {
      const meta = parseFileMeta(m.content);
      return meta?.w && meta?.h ? imageBubbleHeight(meta.w, meta.h) : IMAGE_BUBBLE_HEIGHT;
    }
    case "file": {
      // 普通文件卡片 92；附件图片按真实比例（无尺寸回退 288）；附件代码按截断态占位。
      const meta = parseFileMeta(m.content);
      const sub = meta?.subtype ?? "file";
      const hasPath = !!meta?.path;
      if (hasPath && sub === "image") {
        return meta?.w && meta?.h ? imageBubbleHeight(meta.w, meta.h) : IMAGE_BUBBLE_HEIGHT;
      }
      if (hasPath && sub === "code") return CLAMPED_CODE_BLOCK_HEIGHT;
      return FILE_CARD;
    }
    case "system":
    // 「已撤回」与系统消息是**同一形态**（`messageKinds.TIP_KINDS`）——此前它落到 default
    // 按空文本气泡估 35px，比实际渲染的 28px 高 7px，虚拟列表就会把它下面那条推偏。
    case "recalled":
      return SYSTEM_ROW;
    // 合并转发卡片：定高（见 MERGE_CARD 的说明）
    case "merge":
      return MERGE_CARD;
    case "todo": {
      // 卡片高度随描述/图片**张数**变化；宁可多估留白，也不让相邻消息互相遮挡。
      // 张数要现数（不是"有没有图"那种布尔判断）：可见上限之外的图不画，但会多出一行
      // 「查看更多」⇒ 占位必须按这一条自己的张数算，见 `todoImageAllowance`。
      let desc = false;
      let imgCount = 0;
      try {
        const o = JSON.parse(m.content) as { description?: string; images?: unknown[] };
        desc = typeof o?.description === "string" && o.description.length > 0;
        imgCount = Array.isArray(o?.images) ? o.images.length : 0;
      } catch {
        /* 异常内容按最小卡片估 */
      }
      if (live) {
        desc = live.hasDescription;
        imgCount = live.images;
      }
      return TODO_CARD_BASE + (desc ? TODO_CARD_DESC : 0) + todoImageAllowance(imgCount);
    }    // 本机不认识的 kind（对端版本比本机新）⇒ 渲染占位气泡，高度与载荷长度无关
    // （详见 `UNSUPPORTED_BUBBLE` 的说明：按文本估会留出一大片空白）。
    default:
      return isKnownKind(m.kind) ? textBubbleHeight(m.content, fontSize) : UNSUPPORTED_BUBBLE;
  }
}

/** 任务消息的实时尺寸输入：载荷里的 `todo_id` → 折叠结果的图片/描述。 */
function liveTodoMetrics(
  m: MessageRecord,
  ctx: EstimateContext,
): TodoCardLiveMetrics | undefined {
  if (!ctx.todoLive || m.kind !== "todo") return undefined;
  try {
    const o = JSON.parse(m.content) as { todo_id?: unknown };
    return typeof o?.todo_id === "string" ? ctx.todoLive(o.todo_id) : undefined;
  } catch {
    return undefined;
  }
}

/** 单条消息的占位高度（气泡 + 时间/昵称/分割线，头像与气泡同行不计入）。 */
export function estimateMessageHeight(
  m: MessageRecord,
  index: number | undefined,
  ctx: EstimateContext,
): number {
  const prev = index != null && index > 0 ? ctx.messages[index - 1] : null;

  const bubble = bubbleHeightCached(m, ctx.fontSize, liveTodoMetrics(m, ctx));

  // 分割行的**判定**与渲染端共用 `shouldShowTimeDivider`（阈值也在那里）：分割行自己占
  // TIME_DIVIDER 那 32px，两边判得不一致就是"相邻消息互相遮挡"本文件顶部那条契约。
  const showDivider = shouldShowTimeDivider(m.ts, prev?.ts);
  const next = index != null ? (ctx.messages[index + 1] ?? null) : null;
  // 分割行会把「上一条 / 下一条」自然推开：组必须在这里断开，否则跨过一条通栏分割线还压平圆角。
  const side = groupSide({
    kind: m.kind,
    senderId: m.sender_id,
    ts: m.ts,
    prev: prev ? { kind: prev.kind, senderId: prev.sender_id, ts: prev.ts } : null,
    next: next ? { kind: next.kind, senderId: next.sender_id, ts: next.ts } : null,
    breakAbove: showDivider,
    breakBelow: next ? shouldShowTimeDivider(next.ts, m.ts) : false,
  });
  // 昵称行同族（占 NICKNAME_ROW 那 18px）：「提示行没有昵称行」这条规则现在写在判定函数里，
  // 不再靠 MessageItem 的 v-if/v-else 结构差持平 ⇒ 两边不可能各走一半。
  // 2026-10-23 起群聊只在**组首**展示身份信息 ⇒ 同一条判定多带一个 atGroupStart。
  const showNickname = shouldShowNickname({
    isGroup: ctx.isGroup,
    mine: m.sender_id === ctx.selfId,
    kind: m.kind,
    atGroupStart: side === "first" || side === "single",
  });

  // 分割行自己带间距，不再叠加组间距。
  const topGap = messageTopGap(side, showDivider);

  return bubble + GAP_BASE + topGap + (showNickname ? NICKNAME_ROW : 0) + (showDivider ? TIME_DIVIDER : 0);
}
