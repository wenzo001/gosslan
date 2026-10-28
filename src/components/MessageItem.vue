<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type CSSProperties } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { useClipboard } from "@/composables/useClipboard";
import { useExclusivePopup } from "@/composables/useExclusivePopup";
import { useMessageDisplay } from "@/composables/useMessageDisplay";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { useMessageFile } from "@/composables/useMessageFile";
import { useMemberProfile } from "@/composables/useMemberProfile";
import { CODE_SURFACE, IMAGE_PLACEHOLDER_HEIGHT, textNeedsClamp } from "@/utils/previewMetrics";
import {
  isFavoritableKind, isForwardableKind, isKnownKind, isMultiSelectable, isRemindableKind, isTipKind, kindClass, UNSUPPORTED_KIND_LABEL, } from "@/utils/messageKinds";
import { cardCopyText } from "@/utils/cardText";
import { isSelfMessage } from "@/utils/selfChat";
import { resendChannelFor } from "@/utils/resendChannel";
import { EMPTY_REACTION_CHIPS, EMPTY_STRING_LIST } from "@/utils/emptyList";
import { parseQuote, stripQuoteMsgId } from "@/utils/quote";
import { QUOTE_BG, QUOTE_TEXT_STYLE } from "@/utils/quoteStyle";
import { parseFileMeta } from "@/utils/fileMeta";
import { openLocalFile } from "@/utils/localFile";
import { saveImageAs } from "@/utils/saveImageAs";
import { haptic } from "@/utils/haptics";
import { shouldStartLongPress, shouldSwallowLongPressRelease } from "@/utils/longPress";
import { shouldPreventContextMenu } from "@/utils/contextMenu";
import {
  isRecallableKind,
  isWithinRecallWindow,
  recalledRowKey,
} from "@/utils/recall";
import { previewBody } from "@/utils/messages";
import type { MessageGroupSide } from "@/utils/messageKinds";
import { cancelSendChannelFor } from "@/utils/cancelSend";
import { cancelOutcome, groupResendNotice, messageCancelNotice } from "@/utils/cancelFeedback";
import { hasTextSelection, isSelectableTextTarget, selectionTextWithin } from "@/utils/textSelection";
import { detectCode } from "@/utils/codeDetect";
import { t } from "@/i18n";
import MessageAvatar from "@/components/message/MessageAvatar.vue";
import MessageTextBubble from "@/components/message/MessageTextBubble.vue";
import MessageCodeBubble from "@/components/message/MessageCodeBubble.vue";
import MergeCard from "@/components/message/MergeCard.vue";import MessageFileBubble from "@/components/message/MessageFileBubble.vue";
import MessageImageBubble from "@/components/message/MessageImageBubble.vue";
import MessageReceipt from "@/components/message/MessageReceipt.vue";
import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import MessageReactionBar from "@/components/message/MessageReactionBar.vue";
import BubbleTail from "@/components/message/BubbleTail.vue";
import EmojiPicker from "@/components/EmojiPicker.vue";
import type { ReactionChip } from "@/utils/reactions";
import type { TodoLive } from "@/utils/todos";
import MessageContentModal from "@/components/message/MessageContentModal.vue";
import TodoCardBubble from "@/components/TodoCardBubble.vue";
import UnsupportedKindBubble from "@/components/message/UnsupportedKindBubble.vue";
import MessageContextMenu from "@/components/message/MessageContextMenu.vue";
import RemindAudienceDialog from "@/components/RemindAudienceDialog.vue";
import ActionSheet from "@/components/ActionSheet.vue";
import { BellRing, Code2, Copy, CornerUpLeft, FileText, ListChecks, Pin, Save, Share2, Smile, Star, TextSelect, Undo2 } from "lucide-vue-next";
import { Check, ImageOff } from "@/components/ui/icons";
import type { MessageRecord, MsgKind } from "@/types";
import type { ReminderPhase, ReminderState } from "@/utils/reminders";
import { StaleGuard } from "@/utils/staleGuard";
import { api } from "@/api";
import { loadGroupFileSummary } from "@/utils/groupSummaryCache";

const props = withDefaults(
  defineProps<{
    message: MessageRecord;
    /** 上一条消息（同会话），用于时间分割线判定 */
    prev?: MessageRecord | null;
    /** 群聊：显示发送者昵称 */
    isGroup?: boolean;
    /**
     * 本条在「连续消息组」里的位置（会话层用 `messageKinds.groupSide` 算好传入）。
     * 它同时决定：间距、相邻边圆角、群聊是否展示头像/昵称；缺省 single = 老调用点行为。
     */
    groupSide?: MessageGroupSide;
    /** 本会话是否允许添加/取消回应（群与好友单聊 = true；自聊 = false）。
     *  刻意与 isGroup 分开：入口开在哪一类会话是**产品口径**，不是「这是不是群」。 */
    canReact?: boolean;
    /** 在本条消息上方显示未读分割线 */
    showUnreadDivider?: boolean;
    /** 群聊发送者昵称（由父组件解析） */
    senderName?: string;
    /** 已读该群消息的成员 ID（由父组件按消息时间计算） */
    groupReaderIds?: string[];
    /** 正在闪烁定位的消息键（点击引用块跳转时高亮 1.6s） */
    highlightId?: string | number | null;
    /** 群成员名列表：文本气泡据此高亮 @提及（单聊不传） */
    mentionNames?: string[];
    /** 查看者自己是谁（透传给正文/长文弹窗，用于把 @到自己 渲染成「@你」）。 */
    selfMention?: { name: string; label: string } | null;
    /** 已折叠的表情回应（由会话层算好传入，避免每条消息各自 O(n) 重算）。 */
    reactions?: ReactionChip[];
    /** 该消息当前是否被置顶（决定菜单显示「置顶」还是「取消置顶」） */
    pinned?: boolean;
    /**
     * 多选模式（**会话级**状态，由 ChatWindow 持有）：点击本行 = 勾选/取消勾选，
     * 长按不弹菜单，气泡内的链接/图片/引用一律让路（用透明覆盖层吃掉点击）。
     */
    selectMode?: boolean;
    /** 多选模式下本行是否已选中（决定勾选框的实心态）。 */
    selected?: boolean;
    /**
     * 群任务卡片的**当前**状态与编号表（`todo_id` → 那两格），由会话层折叠一次传下来。
     * 卡片自己的载荷是创建那一刻的快照，不查这张表就会永远显示「待办」，
     * 类型改成缺陷了也还会写着旧的字母。
     */
    todoLive?: Map<string, TodoLive>;
    /** 已删除任务的 `todo_id` 集合（与看板同源的墓碑判定，见 `todoTombstoneIds`）。 */
    todoDeletedIds?: Set<string>;
    /** 本条消息作为强提醒目标时的折叠状态（会话层算好传入；null = 没有强提醒）。 */
    reminder?: ReminderState | null;
    /**
     * 这条是已撤回行时：**撤回者**的 device_id（会话层从 `kind==="recall"` 的静默事件行
     * 现推，见 ChatWindow 的 `recallSources`）。undefined = 索引里没有（老数据 / 事件行
     * 不在已加载窗口）⇒ 提示行退回通用文案，宁可少说一句也不骗人。
     */
    recallerId?: string;
  }>(),
  {
    prev: null,
    isGroup: false,
    groupSide: "single",
    canReact: false,
    showUnreadDivider: false,
    senderName: "",
    groupReaderIds: () => EMPTY_STRING_LIST,
    highlightId: null,
    mentionNames: () => EMPTY_STRING_LIST,
    selfMention: null,
    selectMode: false,
    selected: false,
    todoLive: () => new Map(),
    todoDeletedIds: () => new Set(),
    reminder: null,
  },
);

const app = useAppStore();

/**
 * 「点击重取」：文件/图片没拿到（未完成 / 已被清理）时，请对端按 cid 再发一份。
 * 对方无需确认（拥有即授权）；对方版本不支持时给出明确提示，而不是静默。
 */
async function refetchContent() {
  const myId = app.device?.device_id;
  const peer =
    props.message.sender_id === myId ? props.message.receiver_id : props.message.sender_id;
  if (!peer) return;
  try {
    const ok = await api.requestContent(peer, props.message.msg_id);
    app.toast(t(ok ? "msg.refetchRequested" : "msg.refetchUnsupported"), ok ? "info" : "error");
  } catch (e) {
    app.toastError(e, t("msg.refetchFail"));
  }
}

/** 这条内容在统一状态里是否「未完成 / 校验失败」⇒ 文件卡片给「重新获取」。 */
const retryableContent = computed(() => {
  if (props.message.kind !== "file" && props.message.kind !== "image") return null;
  // 载荷解析走唯一一份 `utils/fileMeta`（此前这里又手写了一次 JSON.parse）
  const sha = parseFileMeta(props.message.content)?.sha256;
  if (!sha) return null;
  const rec = chat.contentTransfers.find((c) => c.cid === sha);
  if (!rec) return null;
  return rec.status === "incomplete" || rec.status === "rejected" ? rec : null;
});
const chat = useChatStore();
const { memberProfile } = useMemberProfile();

// 群文件（gfile-）投递摘要：成员状态语义（已发送给 N 人 · M 人待上线 · K 人已取消）。
// status 变化（含 CompleteAck 推进）时自动刷新。
// `cancelled` 与 `waiting` 是两格（B2）：已取消的成员**永远不会再收**，
// 后端摘要里他们不能留在 waiting —— 那样这句"M 人待上线"会永久挂着。
const deliverySummary = ref<{ completed: number; failed: number; waiting: number; cancelled: number } | null>(null);
const isGroupFile = computed(() => props.message.msg_id.startsWith("gfile-"));
/**
 * 后发先至守卫（审计阶段 4 · 4.2）。这条 watch 的触发源有两个（msg_id 与 status），
 * 快速翻状态或列表回收复用实例时，先发起的 IPC 可能后回来：
 * ① 旧摘要覆盖新摘要（"已发送给 3 人"停在"0 人"）；
 * ② 更糟的是 catch 分支 —— 它会把**更新的那次刚写好的值**抹成 null，
 *    表现是绿勾群读数一闪之后整块消失。所以 catch 也必须过闸。
 */
const summaryGuard = new StaleGuard();
watch(
  [() => props.message.msg_id, () => props.message.status],
  async ([msgId]: [string, unknown]) => {
    const tok = summaryGuard.begin("summary");
    if (!msgId.startsWith("gfile-")) {
      deliverySummary.value = null;
      return;
    }
    try {
      // P1 #19：同键单飞 + 10s TTL（滚动回收后重挂不再重复打 IPC）。
      const r = await loadGroupFileSummary(msgId, String(props.message.status ?? ""));
      if (!summaryGuard.isCurrent("summary", tok)) return;
      deliverySummary.value = r;
    } catch {
      if (!summaryGuard.isCurrent("summary", tok)) return;
      deliverySummary.value = null;
    }
  },
  { immediate: true },
);

const display = useMessageDisplay({
  message: () => props.message,
  prev: () => props.prev,
  isGroup: () => props.isGroup,
  groupSide: () => props.groupSide,
});
const {
  mine,
  bubbleStyle,
  cardStyle,
  showTimeDivider,
  showNickname,
  fullTime,
  timeDividerText,
  sendState,
  receiptTitle,
} = display;

const {
  streamCode,
  streamCodeClamped,
  fileMeta,
  fileReady,
  fileTappable,
  fileProgress,
  fileStatusText,
  fileStatusTone,
  attachmentUrl,
  attachmentMissing,
  previewNote,
  openFile,
  saveAs,
} = useMessageFile(() => props.message, () => sendState.value);
const { copiedKey, copyContent } = useClipboard();

/**
 * 复制文本并**给出反馈**（右键菜单与移动端操作面板用）。
 * 这两处点完菜单立刻关闭，气泡上的"已复制"勾不会渲染（它只在长文本操作条里），
 * 所以必须用 toast 告知结果 —— 否则用户以为没复制上，会反复长按。
 * 气泡内联的复制按钮仍只靠自身勾选反馈（就在指尖，无需 toast 打扰）。
 */
async function copyTextWithToast(key: string, text: string) {
  await copyContent(key, copyOut(text));
  app.toast(t("common.copied"), "success");
}

/**
 * 本条消息在长按面板里是否给「复制」这一条（复制的是**文字形态**）。
 * 正文/代码自不必说；**卡片类（待办/投票/群公告）也给** —— 复制的是它的文字形态，
 * 与收藏页的「复制」同源（`utils/cardText`）。用户 2026-09-21：
 * 「群任务也不能复制啊，收藏咋还有复制呢」。
 * ⚠️ 图片/文件在面板里有各自的「复制图片 / 复制文件」，不走这一条。
 */
const copyableText = computed(
  () =>
    props.message.kind === "text" ||
    props.message.kind === "code" ||
    kindClass(props.message.kind) === "card",
);

/**
 * 执行复制（右键菜单 / 长按面板共用）。卡片走 `cardCopyText`；
 * 解析不出来（载荷非法、待办已删）就明确报失败，而不是把 JSON 原样塞进剪贴板。
 */
function copyFromMenu() {
  if (kindClass(props.message.kind) === "card") {
    const text = cardCopyText(props.message.kind, props.message.content);
    if (!text) {
      app.toast(t("msg.copyFail"), "error");
      return;
    }
    void copyTextWithToast("card", text);
    return;
  }
  void copyTextWithToast(
    props.message.kind === "code" ? "code" : "text",
    props.message.content,
  );
}

/**
 * 复制出去的文本（右键菜单 / 操作面板 / 气泡按钮 / 全文弹窗四条路径共用）。
 * 引用头里的 `|msg_id` 是内部路由信息，不该混进用户复制的内容 ——
 * 用户看到的是「引用 张三：…」，复制出来却是 `…|msg_ab12」`。
 * ⚠️ 只在复制路径上剥：转发要原样保留，接收方靠它跳到被引用的那条消息。
 */
function copyOut(content: string): string {
  return stripQuoteMsgId(content);
}

/** 头像取色名：必须与列表/回执/弹层同源（昵称），否则同一人两处颜色分叉。
 *  群聊由父组件传 nicknameOf 结果；单聊在此兜一把。
 *  ⚠️ 不再往后面接 `|| sender_id`：`chat.nicknameOf` 判不到时返回「未知成员 + id 后四位」，
 *  永远非空 —— 再接一次就是把第二条兜底写进第二个家（见 `utils/memberName.ts`）。 */
const avatarName = computed(() =>
  mine.value
    ? app.device?.nickname || ""
    : props.senderName || chat.nicknameOf(props.message.sender_id),
);
/**
 * 头像：自己取本机；对端从好友/在线节点表取（peer 改资料后由 syncProfileFromPeers
 * 同步到 friends / peers，这里读到的就是最新头像）。没有头像就走 MessageAvatar 的
 * avatarSeed 默认块——同一个人（同一个设备 id）在单聊/群聊/消息列表永远同一张脸。
 */
const avatarSrc = computed(() => {
  if (mine.value) return app.device?.avatar ?? null;
  return memberProfile(props.message.sender_id).avatar;
});

/** 是否为被点击引用所定位的消息（短暂高亮） */
const highlighted = computed(
  () => props.highlightId != null && props.highlightId === (props.message.msg_id ?? props.message.id),
);

/**
 * 选中态的**底色**（铺在整条消息项的最外层）—— 多选选中与"引用定位"**共用同一种颜色**。
 *
 * ⚠️ 两者必须一致（用户 2026-09-21：「引用消息定位的选中颜色怎么和消息多选的颜色不一样？」）：
 * 定位高亮原先用主题浅色 `--gosslan-primary-light`（橙），多选用 `--gosslan-hover`（浅灰），
 * 同一件事两套观感 ⇒ 统一到多选那档浅灰。定位是 1.6s 的瞬时高亮，正常态本来没有底色，
 * 所以"闪一下浅灰"足够显眼，不需要再靠颜色区分。
 */
const tintClass = computed(() => {
  const on = highlighted.value || (props.selectMode && props.selected);
  return on ? "bg-[var(--gosslan-chat)]" : "";
});

/**
 * 选中底色的**绘制方式**：把浅色 `--gosslan-hover` 叠在同色底（`--gosslan-chat`）上合成出来，
 * 结果**不透明**。
 *
 * ⚠️ 为什么要这么绕（用户 2026-09-21：「出现黑线了」）：底色原来是半透明的，
 * 而条目盒子的高度是小数（代码气泡行高不是整数）⇒ 相邻两条盒子的边界落在**小数坐标**上，
 * 浏览器光栅化时会把边界那一行**双重覆盖**，半透明色叠两次 ⇒ 颜色变深 ⇒ 一条深色发丝线。
 * 换成"底层不透明 + 上层是同色渐变"后：每个盒子画的都是**不透明**的一整块，
 * 相邻两块在边界处的覆盖度之和恰好为 1 ⇒ 不深不浅，边界彻底干净。
 * （视觉结果与原来完全一致：就是 `--gosslan-hover` 铺在 `--gosslan-chat` 上的颜色。）
 */
const tintStyle = computed(() => {
  const on = highlighted.value || (props.selectMode && props.selected);
  if (!on) return undefined;
  return {
    backgroundColor: "var(--gosslan-chat)",
    backgroundImage: "linear-gradient(var(--gosslan-hover), var(--gosslan-hover))",
  };
});

/**
 * 正文块（气泡行 / 提示行）要不要自己带 6px **上**间距。
 *
 * 那 6px 原本来自列表项的 `py-1.5`，现在改由"本项的第一个可见块"承担（消息块那层只留 `pb-1` = 4px，见模板）：
 * 底色要包住整块、相邻块要相接，所以正文块的盒子必须从列表项的上边缘就开始。
 * 但分割行压在正文块上面时不能重复给 —— 分割行的 `pt` 里已经含了这 6px（见模板）。
 */
const needsTopPad = computed(() => !showTimeDivider.value && !props.showUnreadDivider);

/** 长文本判定与 estimateHeight 共用 textNeedsClamp：字号档位变了两边一起变。 */
const isLongText = computed(
  () =>
    props.message.kind === "text" &&
    textNeedsClamp(props.message.content, app.chatStyle.fontSize),
);

/**
 * 提示行（撤回 / 文件下载 / 群成员变更…）：微信式居中灰字，**不是一条消息** ——
 * 不带头像、不带气泡、不带昵称行，也没有任何菜单入口。
 *
 * 判定共用 `messageKinds.isTipKind`：`messageHeight` 的高度估算要按同一份清单算，
 * 两边各写一份的话，估算与实际渲染差一行就会让虚拟列表的两条消息互相遮挡。
 */
const isTip = computed(() => isTipKind(props.message.kind));

/** 组首：群聊的头像与昵称只在这里出现（连续消息不重复展示身份信息）。 */
const atGroupStart = computed(() => props.groupSide === "first" || props.groupSide === "single");

/** 自聊消息（收发双方都是本机）：不挂回执（见模板里的说明）。 */
const isSelfMsg = computed(() => isSelfMessage(props.message));

/** 全文弹窗：文本与代码共用一个 Modal，DOM 在消息之外，不参与 VirtualList 排布。 */
const fullModalOpen = ref(false);
const fullModalKind = ref<"text" | "code">("text");
const fullModalContent = ref("");
function openFullModal(kind: "text" | "code", content: string) {
  fullModalKind.value = kind;
  fullModalContent.value = content;
  fullModalOpen.value = true;
}

/** 图片查看器（相册式，由 ChatWindow 统一承载）：点图只上抛 msg_id，定位到该图。 */
function openImageLightbox() {
  emit("open-image", props.message.msg_id);
}

// ---------------- 消息右键菜单：复制 / 保存图片 / 引用 / 转发 ----------------
// 展开态参与全局浮层互斥：右键另一条消息（或好友菜单）时，本菜单自动收起。
// 关键在于右键只触发 contextmenu、不触发 click，靠 document click 关闭靠不住。
const ctxMenuPopup = useExclusivePopup(`menu:${props.message.msg_id ?? props.message.id}`);
/**
 * `selectedText` 是**右键那一刻**从选区抓下来的文本快照（不是响应式选区）：
 * 菜单获得焦点后浏览器可能改写/收起选区，点击菜单项时再读会拿到别的或空文本。
 */
const ctxMenu = ref<{ x: number; y: number; selectedText: string } | null>(null);

watch(ctxMenuPopup.isActive, (mine) => {
  if (!mine && ctxMenu.value) ctxMenu.value = null;
});

function openContextMenu(e: MouseEvent, selectedText: string) {
  if (isTip.value) return;
  // 移动端没有右键：长按走底部 ActionSheet。部分 WebView 在长按之后仍会补发
  // `contextmenu`（也会在长按选中文字时弹系统菜单），若这里再弹一次，就会出现
  // 「右键菜单 + ActionSheet」同时挂在屏幕上，而两者 claim 的是**同一个**互斥 key
  // （`menu:${msg_id}`）⇒ 谁也无法通过互斥关掉对方。
  if (app.isMobile) return;
  ctxMenu.value = { x: e.clientX, y: e.clientY, selectedText };
  ctxMenuPopup.claim();
}

/**
 * 触屏上最近一次落在可选正文上的触摸**属于哪条消息的内容列**。
 *
 * WebKit 有时会把 contextmenu 的 target 从文本节点上提到气泡根/列上；只按 `e.target`
 * 判会误拦系统选字。这里记住"这次触摸起点是正文"的那一列，同一列内的 contextmenu 也放行；
 * 换到非正文触摸时立刻清空（长按昵称/卡片仍然走自定义面板）。
 */
let lastTouchTextCol: Element | null = null;

/**
 * contextmenu 的统一入口（处理器挂在本条消息的 `[data-msg-col]` 上，见模板）。
 *
 * 两条互斥分支，**桌面与触屏策略刻意不同**：
 *  · 桌面：一律 preventDefault 并弹自定义消息菜单；有有效选区时把选区文本快照带进菜单，
 *    由菜单里的「复制选中内容」负责只复制选中部分（「复制消息」仍复制整条）。
 *  · 触屏：可选正文上的 contextmenu **完全让给 WebView**（系统选字手柄 + 系统复制菜单），
 *    这里只 stopPropagation，避免 `App.vue` 的全局兜底在"选区还没建立"的那一帧再 prevent 一次；
 *    非正文区域才 prevent，自定义面板由长按定时器负责。
 *
 * ⚠️ 2026-10-23 之前桌面是"有选区就放行原生菜单"，用户实测右键气泡偶尔弹 WebKit 菜单
 * （之前双击选过词，选区还在）⇒ 现在桌面不再按选区放行。
 */
function onContextMenu(e: MouseEvent) {
  // 表情回应的笑脸按钮**在 data-msg-col 里**（绝对定位到气泡外侧）：它是控件，不是消息内容，
  // 不能因为落在列里就弹消息菜单。表情回应条自 2026-10-24 起也进了列内（它是气泡的底栏），
  // 同样按控件处理 —— 点胶囊是"切回应"，不该顺手弹一条消息菜单。
  if (
    e.target instanceof Element &&
    e.target.closest("[data-reaction-entry], [data-reaction-strip]")
  ) {
    return;
  }

  const mobile = app.isMobile;
  const hasSelection = hasTextSelection();
  // target 本身是可选正文，或者本次触摸起点是正文、WebKit 把 target 上提到了同一列里的元素。
  const sameColAsTextTouch = mobile && !!lastTouchTextCol
    && e.target instanceof Element && e.target.closest("[data-msg-col]") === lastTouchTextCol;
  const onSelectableText = isSelectableTextTarget(e.target) || sameColAsTextTouch;
  if (
    !shouldPreventContextMenu({
      isMobile: mobile,
      textSelecting: textSelecting.value,
      hasSelection,
      onSelectableText,
    })
  ) {
    if (mobile) e.stopPropagation();
    return;
  }
  e.preventDefault();
  if (mobile) return;
  const col = e.currentTarget instanceof Element ? e.currentTarget : null;
  openContextMenu(e, col ? selectionTextWithin(col) : "");
}

/**
 * 复制**右键那一刻的选区快照**（不是整条消息，也不在点击时重新读选区）。
 * 走与其它复制入口相同的 toast 反馈；菜单先收起，避免浮层压在 toast 上。
 */
function copySelectionFromMenu() {
  const text = ctxMenu.value?.selectedText ?? "";
  closeContextMenu();
  if (!text) return;
  void copyTextWithToast("selection", text);
}

function closeContextMenu() {
  ctxMenuPopup.release();
  ctxMenu.value = null;
}

// ---------------- 移动端长按 → 底部 Action Sheet（HIG：触屏用长按唤出上下文操作） ----------------
// 桌面端走右键菜单（MessageContextMenu），移动端没有右键，用长按唤出底部操作面板。
const sheetOpen = ref(false);
/**
 * 移动端「选择文字」快捷模式（2026-10-23 口径更新）。
 *
 * 正文长按现在**直接**进入系统原生选字（见 style.css 的 `pointer: coarse` 块与
 * `utils/longPress.ts`）；本模式不再负责“开放正文选择”，只作为**非正文区长按面板**
 * 里的「全选」快捷入口：`MessageTextBubble` 会自动全选，随后交给系统手柄/工具条。
 */
const textSelecting = ref(false);
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
/** 长按起点：用来做"手指抖动容差"（见 `onTouchMove`）。 */
let longPressOrigin: { x: number; y: number } | null = null;
/**
 * 长按那根手指是否还按着（面板就是这次按压弹出来的）。
 *
 * 用途只有一个：**吞掉抬手指那一下**（见 `swallowLongPressRelease`）。
 * 放在 `touchstart` 置位、在 `touchend`/`touchcancel` 的**窗口捕获**处理里复位。
 */
let longPressHeld = false;
/** 长按判定时长：与 iOS/微信一致（500ms 是 HIG 的常用值）。 */
const LONG_PRESS_MS = 500;
/**
 * 手指抖动容差（px）。用户 2026-09-13：「长按触发的效果感觉不太灵」。
 * 旧实现把 `@touchmove` 直接接到 `cancelLongPress` —— **手指动 1px 就取消**，
 * 真机上几乎不可能"完全不动地按住 500ms"，于是长按十次九次不触发。
 * 现在只有移动超过容差（或明显是滑动/滚动）才取消。
 */
const LONG_PRESS_MOVE_TOLERANCE = 12;

function openActionSheet() {
  if (isTip.value) return;
  // 多选态下不弹操作面板：这一点是"勾选/取消"，弹面板会让用户分不清选上没有
  // （与 `shouldStartLongPress` 的 multiSelect 判据同一条口径，这里是第二道闸门）。
  if (props.selectMode) return;
  // 系统已经进入选字（手柄/工具条还在）：绝不再叠第二个菜单。长按正文本身不会起
  // 定时器；这里兜住"先选字、再按住非正文"以及拖动选区手柄时起点落在气泡内边距的情况。
  if (hasTextSelection()) return;
  sheetOpen.value = true;
  ctxMenuPopup.claim();
}

function closeActionSheet() {
  ctxMenuPopup.release();
  sheetOpen.value = false;
}

/**
 * 吞掉"弹面板那一下"的抬手事件。
 *
 * 历史根因（用户 2026-09-13 Android 实测「弹出 sheet 之后一放手立马就缩回去了」）：
 * 当时面板是 HeadlessUI `Dialog`，它的 `useOutsideClick` 在 **document 捕获阶段** 挂了 `touchend`，
 * 判据是"`touchend` 的 target 在不在对话框容器里" —— 而 touch 事件的 target 在
 * **`touchstart` 那一刻就固定**成那条消息了，所以抬手必被判成"点了外面" ⇒ 立刻 `@close`。
 *
 * 现在面板是 Reka UI 的 Dialog：outside-click 走 document 上的 `pointerdown`（冒泡），
 * 抬手只产生 pointerup / touchend ⇒ 原触发路径已不存在。监听保留为**不依赖弹层库**的兜底：
 * 顺带杀掉这次 tap 的合成 `click`（不会误触气泡里的链接）。
 *
 * ⚠️ 监听**必须挂在 `window` 的捕获阶段**：`document` 上的捕获监听与它同阶段、同目标时按注册
 * 顺序执行（库先注册，我们一定排在后面）；而捕获路径是 `window → document → … → target`，
 * 只有挂 `window` 才抢得到它前面。`preventDefault` 对任何按 `defaultPrevented` 让路的实现都够。
 */
function swallowLongPressRelease(e: TouchEvent) {
  if (!shouldSwallowLongPressRelease({ openedByHeldPress: longPressHeld, sheetOpen: sheetOpen.value })) {
    longPressHeld = false;
    return;
  }
  longPressHeld = false;
  e.preventDefault();
}

/** 面板展开期间才需要拦（平时一次监听都不挂，避免影响滚动/其它手势）。 */
watch(sheetOpen, (open) => {
  if (open) {
    window.addEventListener("touchend", swallowLongPressRelease, { capture: true, passive: false });
    window.addEventListener("touchcancel", swallowLongPressRelease, { capture: true });
  } else {
    window.removeEventListener("touchend", swallowLongPressRelease, { capture: true });
    window.removeEventListener("touchcancel", swallowLongPressRelease, { capture: true });
    longPressHeld = false;
  }
});

/** 「全选」快捷入口：关掉面板 → 本条气泡自动全选（原生选字本来就可直接长按进入）。 */
function enterTextSelect() {
  closeActionSheet();
  textSelecting.value = true;
}

/**
 * 选区一消失就退出选择模式（用户点了别处、收起了系统手柄）。
 * 不退出的后果：这条气泡一直"可选择"，下次长按又弹不出菜单（典型的状态残留）。
 */
function onSelectingChanged() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.toString().length === 0) textSelecting.value = false;
}
watch(textSelecting, (on) => {
  if (on) document.addEventListener("selectionchange", onSelectingChanged);
  else document.removeEventListener("selectionchange", onSelectingChanged);
});

function onTouchStart(e: TouchEvent) {
  cancelLongPress();
  const el = e.target as HTMLElement | null;
  lastTouchTextCol = isSelectableTextTarget(e.target)
    ? (el?.closest("[data-msg-col]") ?? null)
    : null;
  // 表情回应的笑脸按钮在 data-msg-col 里（绝对定位）：它是控件，长按不归消息面板。
  // 回应条（2026-10-24 起是气泡底栏）同理：胶囊自己有一套长按看名单的手势。
  if (el?.closest("[data-reaction-entry], [data-reaction-strip]")) return;
  // 判据收在 `utils/longPress.ts`（纯函数、真值表单测）：
  // 桌面走右键 / 系统消息没有菜单 / 选字模式与多选让路 /
  // **触屏命中可选正文 ⇒ 不起定时器**，把长按完整留给系统原生选字（手柄+系统复制菜单）。
  const canStart = shouldStartLongPress({
    isMobile: app.isMobile,
    isSystem: isTip.value,
    selectMode: textSelecting.value,
    multiSelect: props.selectMode,
    hitSelectable: !!el?.closest(".gosslan-selectable"),
  });
  if (!canStart) return;
  const t0 = e.touches[0];
  if (!t0) return;
  longPressHeld = true;
  longPressOrigin = { x: t0.clientX, y: t0.clientY };
  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    longPressOrigin = null;
    // 系统已经进入选字（拖动选区手柄时起点可能落在气泡内边距）：不再叠第二个菜单。
    // 这一句也顺手挡住了"先选字、再按住非正文"的长按。
    if (hasTextSelection()) return;
    // 触觉反馈：长按"到点了"必须有一下明确的反馈，否则用户会以为没生效而反复长按
    // （`heavy` 的语义就是"长按菜单弹出"，见 utils/haptics.ts）
    haptic("heavy");
    openActionSheet();
  }, LONG_PRESS_MS);
}

/** 手指移动超过容差才取消长按（旧实现是"一动就取消"，真机上等于长按失灵）。 */
function onTouchMove(e: TouchEvent) {
  if (!longPressTimer || !longPressOrigin) return;
  const t0 = e.touches[0];
  if (!t0) return;
  const dx = t0.clientX - longPressOrigin.x;
  const dy = t0.clientY - longPressOrigin.y;
  if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_TOLERANCE) cancelLongPress();
}

function cancelLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  longPressOrigin = null;
}

onBeforeUnmount(() => {
  cancelLongPress();
  // 窗口级监听不随组件卸载自动消失（它挂在 window 上），必须自己摘
  window.removeEventListener("touchend", swallowLongPressRelease, { capture: true });
  window.removeEventListener("touchcancel", swallowLongPressRelease, { capture: true });
  // ⚠️ `selectionchange` 挂在 **document** 上，由 `watch(textSelecting)` 增删 ——
  // 那条 watch 只在开关时才跑，组件若**在选择模式下**被卸载（滚出虚拟列表就回收），
  // 它永远等不到 else 分支，监听会一直留在 document 上。每进入一次漏一个，
  // 之后在输入框/搜索框里选字，每个 selectionchange 都要白跑 N 次 getSelection()。
  document.removeEventListener("selectionchange", onSelectingChanged);
});

/**
 * 转发 / 收藏的判据从 `utils/messageKinds` 取（**唯一一份**）：右键菜单、长按面板、
 * 收藏详情三处的动作集合必须一致（此前各写一份 ⇒ "菜单没有转发、收藏页却有"，
 * 而且点下去必被发送侧白名单拒）。见 `isForwardableKind` / `isFavoritableKind` 的说明。
 */
const forwardable = isForwardableKind;
const favoritable = isFavoritableKind;

/**
 * 本条消息引用的原消息 id（没有引用则为空）。
 * 供「定位到引用消息」菜单项使用 —— 与微信一致：引用跳转既可以从引用块点，
 * 也可以在消息菜单里选（用户 2026-09-21）。
 */
const quotedMsgId = computed(() => parseQuote(props.message.content).msgId ?? "");

/**
 * 引用块的头一行（「引用 发送者：片段」）：引用块画在**气泡外的正文下方**（微信同款），
 * 只有文本/代码消息才会带引用（回复永远是文本消息）。
 */
const quoteHeader = computed(() => {
  if (props.message.kind !== "text" && props.message.kind !== "code") return "";
  return parseQuote(props.message.content).header;
});

/**
 * 点引用块 = **直接查看**被引用的内容（用户 2026-09-21：「能直接查看的要能直接查看，不要跳转」）：
 *   图片 → 相册大图（ChatWindow 按 msg_id 定位）；合并卡片 → 卡片详情；
 *   文本/代码 → 全文弹窗；文件 → 用系统应用打开。
 * 原消息不在本机（未加载/已删除）时提示，而不是偷偷跳转。
 * 「定位到原消息」仍然有 —— 在消息菜单里（见 `quotedMsgId`），与微信一致。
 */
async function viewQuoted() {
  const id = quotedMsgId.value;
  if (!id) return;
  const convId = props.message.conv_id;
  const orig = chat.messages[convId]?.find((m) => m.msg_id === id);
  if (!orig) {
    app.toast(t("msg.quoteOriginalMissing"), "info");
    return;
  }
  if (orig.kind === "image") {
    emit("open-image", id);
    return;
  }
  if (orig.kind === "merge") {
    emit("open-merge", { content: orig.content, senderId: orig.sender_id });
    return;
  }
  if (orig.kind === "file") {
    // 被引用的是**另一条**消息 ⇒ 拿不到它的传输记录，只能用载荷里已落下的路径
    // （解析走唯一一份 `utils/fileMeta`，与气泡那侧同一个实现）。
    const meta = parseFileMeta(orig.content);
    if (!meta?.path) {
      app.toast(t("msg.filePathUnavailable"), "error");
      return;
    }
    try {
      // owner 传**原消息**的 msg_id：后端回绑该消息的传输台账（SEC-01）。
      await openLocalFile(meta.path, meta.name || t("common.file"), orig.msg_id);
    } catch (e) {
      app.toastError(e, t("msg.openFileFail"));
    }
    return;
  }
  if (orig.kind === "text" || orig.kind === "code") {
    openFullModal(orig.kind, orig.content);
    return;
  }
  app.toast(t("msg.quoteOriginalMissing"), "info");
}

// ---------------- 表情回应入口（飞书式：气泡外侧笑脸按钮 → 完整表情选择器） ----------------
/**
 * 选择器的开/关与**全局浮层互斥**（key 按消息区分 ⇒ 两条消息的选择器不会并存）。
 * 点外部收起（入口按钮与选择器根上都 `@click.stop`，不会误关）。
 *
 * ⚠️ 弹出位置必须**自己算**（用户 2026-09-21：「表情弹出的时候不计算弹出位置吗？」）：
 * 选择器挂在消息里会被消息列表的 `overflow-y: auto` **裁掉**，所以这里
 * ① Teleport 到 body、② 用入口按钮的 `getBoundingClientRect()` 算出 fixed 坐标：
 *    横向夹在视口内（面板宽 min(360, 视口-32)），纵向按入口在视口的上/下半决定往上还是往下弹。
 * 滚动/改窗口大小时直接收起（比跟着飘更稳）。
 */
const reactionPickerOpen = ref(false);
const reactionPopup = useExclusivePopup(`reaction-picker:${String(props.message.msg_id ?? props.message.id ?? "")}`);

/** Reka Popover 的受控开关：定位/翻转/外点/Esc 由 floating-ui + DismissableLayer 接管。 */
function onReactionPickerOpenChange(open: boolean) {
  reactionPickerOpen.value = open;
  if (open) reactionPopup.claim();
  else reactionPopup.release();
}
function closeReactionPicker() {
  reactionPopup.release();
  reactionPickerOpen.value = false;
}
/**
 * 被别的浮层抢走展开权 ⇒ 收起自己。
 *
 * 这是 `useExclusivePopup` 协议的**另一半**（上面右键菜单那条 watch 一直在，
 * `popupRegistry.ts` 顶部写的就是这个 bug 的原型）。表情面板原先只 claim 不看被抢，
 * 于是"点 A 的表情、再点 B 的表情" → B 拿到展开权、A 的 isActive 变 false 却没人读它
 * ⇒ 两块面板同时挂着（用户 2026-09-24 真机）。同一种缺陷在同一个文件里只修了一半。
 */
watch(reactionPopup.isActive, (mine) => {
  if (!mine && reactionPickerOpen.value) closeReactionPicker();
});
function onReactionPick(emoji: string) {
  closeReactionPicker();
  emit("react", emoji);
}

/** 「定位到引用的消息」：先收掉菜单/面板，再跳（否则浮层会盖在目标上，看起来像"跳错了"） */
function onLocateQuote() {
  closeContextMenu();
  closeActionSheet();
  if (quotedMsgId.value) emit("locate", quotedMsgId.value);
}

/** 图片可预览 URL：新格式走 objectURL（JSON 元数据），旧格式兼容 content=dataURL。 */
const imageDataUrl = computed(() => {
  if (props.message.kind === "image") {
    if (attachmentUrl.value) return attachmentUrl.value;
    // 旧格式兼容（开发阶段遗留的 data URL）
    if (props.message.content.startsWith("data:")) return props.message.content;
    return "";
  }
  if (props.message.kind === "file" && attachmentUrl.value) return attachmentUrl.value;
  return "";
});

async function copyImage() {
  closeContextMenu();
  const url = imageDataUrl.value;
  if (!url) return;
  try {
    const blob = await (await fetch(url)).blob();
    const png = blob.type === "image/png" ? blob : await toPngBlob(url);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    app.toast(t("msg.imageCopied"), "success");
  } catch {
    app.toast(t("msg.copyImageFail"), "error");
  }
}

/** 非 PNG 源转 PNG：经 canvas 重绘。 */
async function toPngBlob(url: string): Promise<Blob> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext("2d")!.drawImage(img, 0, 0);
  return await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
}

async function saveImage() {
  closeContextMenu();
  const url = imageDataUrl.value;
  if (!url) return;
  try {
    const source = props.message.msg_id ? { msgId: props.message.msg_id } : undefined;
    if ((await saveImageAs(url, source)) === "saved") app.toast(t("msg.imageSaved"), "success");
  } catch (e) {
    app.toastError(e, t("msg.saveImageFail"));
  }
}

/** 引用片段：文本取前 40 字，其它类型用占位标签。 */
function quoteSnippet(kind: MsgKind, content: string): string {
  if (kind === "image") return t("msg.image");
  if (kind === "code") return t("msg.code");
  if (kind === "file") return t("msg.file");
  // 合并转发：引用它是"引用一张聊天记录卡片"，正文是 JSON，不能截进引用块
  if (kind === "merge") return t("merge.title");
  // 本机不认识的 kind（对端版本更新）：载荷通常是 JSON，截进引用块等于把 JSON 露出来
  if (!isKnownKind(kind)) return UNSUPPORTED_KIND_LABEL;
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine;
}

const emit = defineEmits<{
  (e: "quote", payload: { sender: string; snippet: string; msgId: string | number }): void;
  (e: "forward", payload: { kind: MsgKind; content: string; snippet: string; filePath?: string; msgId?: string }): void;
  (e: "locate", msgId: string): void;
  /** 点了某个表情 chip（已点过则是取消） */
  (e: "react", emoji: string): void;
  /** 切换置顶（群聊） */
  (e: "pin"): void;
  /** 收藏这条消息（微信式：独立存储，删会话/清缓存都不影响） */
  (e: "favorite"): void;
  (e: "open-image", msgId: string): void;
  /** 点开合并转发卡片（上抛载荷 JSON，由 ChatWindow 统一渲染详情弹窗） */
  (e: "open-merge", payload: { content: string; senderId: string }): void;
  /** 进入多选模式（微信式批量操作） */
  (e: "multi-select"): void;
  /** 多选模式下切换本行的勾选态（由覆盖层点击触发） */
  (e: "toggle-select"): void;
  /** 点了任务卡片里的「查看任务」：打开群任务面板（由 ChatWindow 接住）。 */
  (e: "open-tasks", todoId?: string): void;
  /** 点对方头像：进入好友资料（与通讯录同一个页面）。 */
  (e: "open-profile", senderId: string): void;
}>();

/**
 * 能否撤回：自己的消息、未被撤回、且在 5 分钟窗口内。
 *
 * 用函数而不是 computed：`Date.now()` 不会进入 Vue 的依赖，computed 一旦算过就不会
 * 随真实时间推进；右键菜单 / 移动 ActionSheet 打开时会触发一次渲染，这里在那一刻现算。
 * `mine` 是 ComputedRef，script 内必须写 `.value`（裸写恒真值，曾导致群里任何人的消息
 * 都出现撤回入口）。
 */
/**
 * 本机是不是**这个群**的群主。口径与 `ChatWindow.canPublishAnnouncement` 同一份
 * （读本地 `groups.creator`）；它只决定入口要不要显示 —— 真正的裁决在后端命令层，
 * 而**每台接收设备还各自判一次**（`protocol::recall_receive_allowed`），
 * 前端这一份改不动别人的库。
 */
const isGroupOwnerHere = computed(() => {
  if (!props.isGroup) return false;
  const conv = props.message.conv_id || "";
  if (!conv.startsWith("group:")) return false;
  return (
    chat.groups.find((g) => g.id === conv.slice("group:".length))?.creator
    === app.device?.device_id
  );
});

/**
 * 能否撤回。两档（负责人 2026-10-28 拍板，见 `docs/adr/0023`）：
 * · 作者档 —— 自己的、未被撤回、在 `RECALLABLE_KINDS` 里、5 分钟窗口内（今天的行为）；
 * · 群主档 —— 群里**任何人**的**任意一条可撤行**（分母与作者档同一份），**不看时限**。
 *
 * 用函数而不是 computed：`Date.now()` 不会进入 Vue 的依赖，computed 一旦算过就不会
 * 随真实时间推进；右键菜单 / 移动 ActionSheet 打开时会触发一次渲染，这里在那一刻现算。
 * `mine` 是 ComputedRef，script 内必须写 `.value`（裸写恒真值，曾导致群里任何人的消息
 * 都出现撤回入口）。
 */
function canRecallNow(): boolean {
  if (isSelfMsg.value || props.message.kind === "recalled") return false;
  // 自己发的、还在窗口内 ⇒ 走作者档（附件也能撤：后端在物化前先停传输）。
  if (mine.value && isWithinRecallWindow(props.message.ts) && isRecallableKind(props.message.kind)) {
    return true;
  }
  // 群主档：替别人撤、或撤自己早就过窗的那条。分母与作者档**同一份**（卡片没有独立真源，
  // 撤卡等于删本体，见 utils/recall.ts 与 ADR-0023 §3.6）。
  return isGroupOwnerHere.value && isRecallableKind(props.message.kind);
}

/** 已撤回那一行显示哪句话：撤的人不是作者 ⇒ 说清是群主干的（索引缺失退回通用文案）。 */
const recalledTextKey = computed(() => recalledRowKey(props.recallerId, props.message.sender_id));

/** 仅原作者可切：code→text 总是可切；text→code 只在内容像代码时给入口。 */
const renderTo = computed<"code" | "text" | null>(() => {
  if (isSelfMsg.value || !mine.value) return null;
  if (props.message.kind === "code") return "text";
  if (props.message.kind === "text" && detectCode(props.message.content).likely) return "code";
  return null;
});

/**
 * 「取消发送」该不该出现、走哪条通道 —— 判据只有 `utils/cancelSend` 那一份。
 *
 * ⚠️ 这里修掉一个旧口径的错：以前的条件是 `if (!isSelfMsg) return false`，
 * 于是这个入口**只在自聊里出现**（而自聊在输入框就拦掉了图片/文件，根本发不出文件）。
 * 正常单聊/群聊里正在发送的文件反而没有入口 —— 与"所有未完成的发送都能取消"正好相反。
 */
const cancelSendChannel = computed(() =>
  cancelSendChannelFor({
    msgId: props.message.msg_id,
    kind: props.message.kind,
    status: props.message.status,
    group: props.isGroup,
    selfChat: isSelfMsg.value,
    mine: mine.value,
  }),
);
const canCancelSend = computed(() => cancelSendChannel.value !== "none");

/**
 * 这一条的**消息行**里有没有头像那一列（= 群聊里别人的消息）。
 * 表情回应条和强提醒条是消息行的**兄弟节点**（不是行内的一支），要和气泡的边对齐，
 * 就得把同一列让出来。⚠️ 让多少不能按"我/他"写死：5.7 起自己的行和单聊两方都没有头像列，
 * 再让一整列宽就会把胶囊推离气泡边（运行时探针 `roster` 段实测到并判红过）。
 * 让出的那个数住在 `--gosslan-msg-gutter`（= 行的 px-4 + 头像列 + 行 gap-2），
 * 头像列的宽度住在 `--gosslan-msg-avatar`，两者由探针 `rowpair` 段在真浏览器里钉着等式。
 */
const avatarCol = computed(() => props.isGroup && !mine.value);
const avatarGutterClass = computed(() =>
  avatarCol.value
    ? mine.value
      ? "justify-end pr-[var(--gosslan-msg-gutter)]"
      : "pl-[var(--gosslan-msg-gutter)]"
    : mine.value
      ? "justify-end pr-4"
      : "pl-4",
);

/**
 * 表情回应条自 2026-10-24 起**并入气泡**（用户：「把所有的表情回复包在气泡里面」）。
 * 它不再是消息行的兄弟节点，而是气泡外壳的底栏 —— 所以底色必须与上面那块气泡是
 * **同一格**，否则又是"贴上去的一张条"。
 * 底色只有这几个来源，按渲染分支取同一个值，组件里不另写一份色：
 * 文本/兜底/未知 → bubbleStyle · 卡片（文件/合并/任务）→ cardStyle · 代码 → CODE_SURFACE。
 * 图片没有"气泡底色"（它就是图），用卡片色兜底；它本来也没有尾巴。
 */
const hasReactions = computed(() => (props.reactions?.length ?? 0) > 0);
const cardLikeBubble = computed(
  () =>
    props.message.kind === "file" ||
    props.message.kind === "merge" ||
    props.message.kind === "todo" ||
    props.message.kind === "image",
);
/**
 * 这一条最终画出来的气泡**有没有 1px 描边**（决定底栏要不要补边框）。
 *
 * 气泡的边框来源只有两处：文本/兜底/未知 = `bubbleStyle.border`（自己的消息是透明边）、
 * 文件/合并/任务卡 = `cardStyle.border`（卡片线）；**代码卡片与图片没有描边**
 * （代码 2026-10-24 起去掉了四边描边，图片本身就是图）。
 * 文件消息但已解析出图片预览（`attachmentUrl`）时画的是图片盒 ⇒ 也没有描边。
 * 底栏只有在这条为真时才补 `左/右/下` 三边 —— 无描边的卡片补一条只出现在底部的线，
 * 看起来就是"凭空多出一条边框"。
 */
const bubbleHasBorder = computed(() => {
  const k = props.message.kind;
  if (k === "code" || k === "image") return false;
  if (k === "file" && attachmentUrl.value) return false;
  return true;
});
/** 底栏三边描边的颜色：与它上面那条气泡**同一条线**（自己的卡片是透明边）。 */
const stripBorderColor = computed(() => {
  if (!bubbleHasBorder.value) return "transparent";
  if (cardLikeBubble.value) return String(cardStyle.value["--bubble-line"] ?? "transparent");
  return mine.value ? "transparent" : "var(--gosslan-border)";
});
const reactionSurface = computed(() => {
  if (props.message.kind === "code") return app.dark ? CODE_SURFACE.dark : CODE_SURFACE.light;
  if (cardLikeBubble.value) return String(cardStyle.value["--bubble-bg"] ?? "var(--gosslan-card)");
  return String(bubbleStyle.value["--bubble-bg"] ?? "transparent");
});

/**
 * 尾巴挂在哪一侧（null = 这一条没有尾巴，群聊/提示行/图片/未知/裸文本兜底）。
 * 尾巴的取色、气泡那一侧的下圆角、底栏那一侧的下圆角都要读同一个 side ——
 * 分开算就会出现"尾巴在左、圆角却按右拉平"这种一眼能看出的错位。
 */
const tailSide = computed<"left" | "right" | null>(() => {
  if (props.isGroup || isTip.value) return null;
  const k = props.message.kind;
  const hasBody =
    k === "text" ||
    k === "code" ||
    k === "merge" ||
    k === "todo" ||
    (k === "file" && !attachmentUrl.value && !!fileMeta.value);
  return hasBody ? (mine.value ? "right" : "left") : null;
});
const showTail = computed(() => tailSide.value !== null);

/** 外壳只负责两件事：尾巴取色（`--bubble-bg` / `--bubble-line`）与给底栏一层定位。 */
const shellStyle = computed<CSSProperties>(
  () =>
    ({
      "--bubble-bg": reactionSurface.value,
      "--bubble-line":
        props.message.kind === "code"
          ? "var(--gosslan-card-line)"
          : cardLikeBubble.value
            ? String(cardStyle.value["--bubble-line"] ?? "transparent")
            : mine.value
              ? "transparent"
              : "var(--gosslan-border)",
    }) as CSSProperties,
);

/**
 * 底栏自己的下圆角必须与**它上面那块气泡**同档：连续消息组里相邻侧收成 tight，
 * 底栏若一律用 18px，接缝处会豁出一个角。上圆角恒为 0（与气泡是同一块）。
 * ★ 尾巴那一侧的下圆角必须拉平：尾巴的根部要覆盖一条**直的**边缘才能与气泡同一条线
 *   （圆角会把气泡底色切掉，尾巴看起来就是浮在旁边的一张叶片 —— 用户 2026-10-25 的截图）。
 */
const reactionStripStyle = computed<CSSProperties>(() => {
  const radii =
    props.message.kind === "code"
      ? { borderBottomLeftRadius: "var(--gosslan-radius-md)", borderBottomRightRadius: "var(--gosslan-radius-md)" }
      : cardLikeBubble.value
        ? { borderBottomLeftRadius: "var(--gosslan-bubble-radius, 4px)", borderBottomRightRadius: "var(--gosslan-bubble-radius, 4px)" }
        : {
            borderBottomLeftRadius: bubbleStyle.value.borderBottomLeftRadius,
            borderBottomRightRadius: bubbleStyle.value.borderBottomRightRadius,
          };
  if (tailSide.value === "left") radii.borderBottomLeftRadius = 0;
  if (tailSide.value === "right") radii.borderBottomRightRadius = 0;
  return {
    background: reactionSurface.value,
    ...radii,
    // 上面那条边不画（与气泡是同一块）；左右下三边补齐，接缝处的竖线才不会断。
    borderStyle: "solid",
    borderWidth: bubbleHasBorder.value ? "0 1px 1px" : "0",
    borderColor: stripBorderColor.value,
  };
});

/**
 * 表情回应底栏的高度（表情入口要从列的底边往上让出这一段）。
 *
 * 为什么现量而不是按胶囊行数算：胶囊会随列宽折行，同一份回应在宽/窄窗口里的底栏高度不同；
 * 猜一个"每行 32px"会让入口在窄窗口里压住胶囊、宽窗口里悬空。
 * 底栏只在真有回应时渲染 ⇒ 没有回应的消息根本不建观察者。
 */
const stripEl = ref<HTMLElement | null>(null);
const entryBottom = ref(0);
let stripRo: ResizeObserver | null = null;
watch(stripEl, (el) => {
  stripRo?.disconnect();
  stripRo = null;
  entryBottom.value = el ? el.offsetHeight : 0;
  if (!el) return;
  stripRo = new ResizeObserver(() => {
    entryBottom.value = el.offsetHeight;
  });
  stripRo.observe(el);
});
onBeforeUnmount(() => stripRo?.disconnect());

function doCancelSend() {
  closeContextMenu();
  closeActionSheet();
  const channel = cancelSendChannel.value;
  if (channel === "transfer") {
    const mid = props.message.msg_id;
    let transferId = "";
    if (mid.startsWith("file-")) transferId = mid.slice(5);
    else if (mid.startsWith("gfile-")) transferId = mid.slice(6);
    if (!transferId) return;
    api.cancelFileTransfer(transferId).then(
      (res) => {
        // 四个分支的唯一判据在 `utils/cancelFeedback`：
        // 已送达 / 台账写失败（本机停了但状态待重试）/ 仅本机取消 / 已通知对面。
        switch (cancelOutcome(res)) {
          case "already_done":
            app.toast(t("msg.cancelSend.alreadyDone"), "info");
            break;
          case "ledger_pending":
            app.toast(t("transfer.cancelLedgerPending"), "info");
            break;
          case "local_only":
            app.toast(t("transfer.cancelLocalOnly"), "info");
            break;
          default:
            app.toast(t("msg.cancelSend.requested"), "success");
        }
      },
      (e: unknown) => app.toastError(e, t("msg.cancelSend.fail")),
    );
    return;
  }
  if (channel !== "message") return;
  // 消息通道：后端把 pending 行置 cancelled + 状态写 cancelled；对端还没收到的人不会再收到。
  // 群消息可能只取消了剩余成员（有人已收到）—— 结论与计数由 `messageCancelNotice` 统一说。
  api.cancelMessage(props.message.conv_id, props.message.msg_id).then(
    (res) => {
      const notice = messageCancelNotice(res);
      app.toast(t(notice.key, notice.params ?? {}), notice.kind);
    },
    (e: unknown) => app.toastError(e, t("msg.cancelSend.fail")),
  );
}

/** 撤回前的二次确认：破坏性且不可逆（对方看到的是「消息已撤回」，收不回来）。 */
const confirmingRecall = ref(false);

function doRecall() {
  closeContextMenu();
  closeActionSheet();
  confirmingRecall.value = true;
}

/**
 * 跨人撤回的确认话术（负责人 2026-10-28 拍板：「区分确认：显示作者 + 原文摘要」）。
 *
 * 为什么值得多这一个分支：这是**替别人做一个不可逆决定** —— 墓碑是 G-Set
 * （`db/recalls.rs` 的 INSERT OR IGNORE，只增不减），撤错了一条没有"搜回"这条路。
 * 卡片那一支不塞摘要：它的 `content` 是载荷 JSON，贴出来只会糊一屏花括号。
 */
const recallConfirmBody = computed(() => {
  if (!(isGroupOwnerHere.value && !mine.value)) return t("msg.recallConfirm");
  const name = props.senderName || chat.nicknameOf(props.message.sender_id);
  // 摘要必须走 `previewBody` 那一份同源实现：直接切 `content` 的话，`image` / `file`
  // 的载荷是 JSON，会把**本机绝对路径**贴进弹窗（载荷形状见 commands/files.rs 的 name/path/size），
  // 而 merge / todo 那类会得到 '{"title":"群聊的聊天记录"' 这种东西。
  const snip = previewBody(props.message.kind, props.message.content, 40);
  return t("msg.recallConfirmOwner", { name, snip });
});

async function confirmRecall() {
  confirmingRecall.value = false;
  const convId = props.message.conv_id;
  try {
    await chat.recallMessage(convId, props.message.msg_id);
    app.toast(t("msg.recallDone"), "success");
  } catch (e) {
    app.toastError(e, t("msg.recallFail"));
  }
}

async function doRender() {
  closeContextMenu();
  closeActionSheet();
  const to = renderTo.value;
  if (!to) return;
  try {
    await chat.setMessageRender(props.message.conv_id, props.message.msg_id, to);
  } catch (e) {
    app.toastError(e, t("msg.renderFail"));
  }
}

function doQuote() {
  // ⚠️ 必须收起**底部面板**（不只是桌面右键菜单）：用户 2026-09-13 安卓实测
  // 「点『引用』之后那个 sheet 还挂在那儿」。引用会跳到输入框去操作，浮层留着就是挡路。
  // `ActionSheet` 面板层已经统一做了"点任何一项即收起"，这里是**第二道保险**：
  // 这两个动作是"跳到别处去操作"，即使以后面板的通用规则改了，也不该让 sheet 留在新界面上面。
  closeActionSheet();
  closeContextMenu();
  const msg = props.message;
  emit("quote", {
    sender: mine.value ? app.device?.nickname || t("common.me") : props.senderName || chat.nicknameOf(msg.sender_id),
    snippet: quoteSnippet(msg.kind, msg.content),
    msgId: msg.msg_id ?? msg.id,
  });
}

function doForward() {
  const msg = props.message;
  const payload = {
    kind: msg.kind as MsgKind,
    content: msg.content,
    snippet: quoteSnippet(msg.kind, msg.content),
    // 文件转发按本地路径重走传输链路（内容里的 JSON 只是元信息）。
    // `msgId` 随行：后端用它要求「这条路径归这条消息」，堵住对端写 path 的越权（SEC-01）。
    filePath: msg.kind === "file" ? (fileMeta.value?.path ?? "") : undefined,
    msgId: msg.kind === "file" ? msg.msg_id : undefined,
  };
  // 同上：转发会打开转发弹窗（跳转到界面内去操作），底部面板必须先收掉
  closeActionSheet();
  closeContextMenu();
  emit("forward", payload);
}

/**
 * 收藏这条消息。
 *
 * 只上抛事件、这里不直接调 api：**两端（桌面右键 / 移动长按面板）都要走同一处**，
 * 而 toast 与"已在收藏中"的提示逻辑在 `ChatWindow` 里 —— 与转发同一条路子
 * （见 doForward），避免同一个动作在桌面和移动上出现两套提示。
 * 同样必须先收掉浮层：收藏会弹 toast，浮层留着就是挡路。
 */
function doFavorite() {
  closeActionSheet();
  closeContextMenu();
  emit("favorite");
}

/**
 * 进入多选模式（微信式批量操作）。
 *
 * 与转发/收藏同一条路子：只上抛事件，状态与批量动作都归 `ChatWindow` 管 ——
 * 桌面右键菜单与移动端底部面板是两套独立模板，两处各存一份"进入多选"的状态必然漂移。
 */
function doMultiSelect() {
  closeActionSheet();
  closeContextMenu();
  emit("multi-select");
}

// ---------------- 强提醒：发起 / 接收标识 / 确认 ----------------

/**
 * 能否从本条发起强提醒：自己发 + kind 可提醒 + **消息本身已成功发出** + 不是自聊。
 * sending/failed/cancelled 的消息对方还没收到（或永远收不到），此时提醒会让对方收到
 * 一条指向"幽灵消息"的强提醒（点开还定位不到）⇒ 只允许 sent/delivered/read。
 * 自聊没有接收方（只支持文本/代码本地留存），没有可提醒对象。
 */
const REMINDABLE_STATUS = new Set(["sent", "delivered", "read"]);
const canRemindEntry = computed(
  () =>
    mine.value &&
    !isSelfMsg.value &&
    isRemindableKind(props.message.kind) &&
    REMINDABLE_STATUS.has(props.message.status),
);

/**
 * 置顶入口（规范 §六「群聊且不是 recalled」）。桌面右键与移动端长按是两套独立模板，
 * 但这一条判断只许有一个家 —— 同族的「撤回」以前就是内联写的、漏了 `isGroup`，
 * 结果单聊长按也出现「撤回」而点了确认后什么都不发生（见模板里那条注释）。
 */
const canPinEntry = computed(
  () => props.isGroup && props.message.kind !== "recalled",
);

/**
 * 从「我」的视角看这台设备对应的提醒相：
 * - 发起方：看总览相（群聊＝最慢的一台）；
 * - 接收方：看 perActor 里自己那格（群聊在回执前已由发起名单 base 预填）。
 */
const myReminderPhase = computed<ReminderPhase | null>(() => {
  const r = props.reminder;
  if (!r) return null;
  if (mine.value) return r.phase;
  const myId = app.device?.device_id ?? "";
  return r.perActor[myId] ?? null;
});

/** 强提醒标识是否出现：我发起的，或这台设备在受众/回执名单里。 */
const showReminderBadge = computed(
  () => props.reminder != null && (mine.value || myReminderPhase.value != null),
);

/** 标识文案：六态各自独立命名。 */
const reminderPhaseLabel = computed(() => {
  const p = myReminderPhase.value;
  if (!p) return "";
  return t(`remind.stage${p[0].toUpperCase()}${p.slice(1)}`);
});

/** 标识底色：失败红、确认绿、其余主色（相名本身已足够区分）。 */
const reminderBadgeClass = computed(() => {
  const p = myReminderPhase.value;
  if (p === "failed") return "bg-[var(--gosslan-danger-soft)] text-[var(--gosslan-danger-ink)]";
  if (p === "confirmed") return "bg-[var(--gosslan-success-soft)] text-[var(--gosslan-success-ink)]";
  return "bg-[var(--gosslan-primary-soft)] text-[var(--gosslan-accent-ink)]";
});

/** 群聊发起方：成员各自状态（给标识做 title，不另开面板）。 */
const reminderRosterTitle = computed(() => {
  const r = props.reminder;
  if (!r || !mine.value || !props.isGroup) return "";
  const parts: string[] = [];
  for (const [id, phase] of Object.entries(r.perActor)) {
    if (!phase) continue;
    const name = memberProfile(id).name;
    parts.push(`${name}: ${t(`remind.stage${phase[0].toUpperCase()}${phase.slice(1)}`)}`);
  }
  return parts.join("\n");
});

/** 「我知道了」按钮出现条件：接收方 + 当前相为已送达/已提醒（未确认、未失败）。 */
const canConfirm = computed(
  () =>
    !mine.value &&
    (myReminderPhase.value === "delivered" || myReminderPhase.value === "reminded"),
);

/** 群聊受众选择弹窗（第一版不默认全群）。 */
const remindAudienceOpen = ref(false);

function doRemind() {
  closeActionSheet();
  closeContextMenu();
  if (props.isGroup) {
    remindAudienceOpen.value = true;
    return;
  }
  // 私聊：默认目标＝聊天对方，受众名单为空
  void chat
    .sendReminder(props.message.conv_id, props.message.msg_id)
    .catch((e) => app.toastError(e, t("remind.sendFail")));
}

async function onAudiencePicked(actors: string[]) {
  remindAudienceOpen.value = false;
  try {
    await chat.sendReminder(props.message.conv_id, props.message.msg_id, actors);
  } catch (e) {
    app.toastError(e, t("remind.sendFail"));
  }
}

async function doConfirmReminder() {
  try {
    await chat.confirmReminder(props.message.conv_id, props.message.msg_id);
  } catch (e) {
    app.toastError(e, t("remind.confirmFail"));
  }
}

/**
 * 「这条能不能再发一次、该走哪条通道」—— 判据只有 `utils/resendChannel` 那一份。
 *
 * 附件是否还在本机用 `useMessageFile` 的 `attachmentMissing`（它的真值来自后端
 * `media_present`），不在这里自己 `fs exists`：那一格已经有一份口径与一条竞态守卫了。
 */
const resendChannel = computed(() =>
  resendChannelFor({
    kind: props.message.kind,
    group: props.isGroup || isGroupFile.value,
    hasLocalFile: !!fileMeta.value?.path && !attachmentMissing.value,
    mine: mine.value,
  }),
);

/**
 * 这条群消息的成员级投递摘要（**只读 store 里那份后端台账**）。
 *
 * 为什么不在组件里数成员/已读：台账回答的是"谁收到"，已读回答的是"谁读过"，
 * 两者混在一起就会重新造出"排队却显示已送达"的矛盾。摘要为 undefined 时角标什么都不显示。
 */
const groupDelivery = computed(() => {
  if (!props.isGroup) return null;
  const conv = chat.groupDeliveries[props.message.conv_id];
  return conv?.[props.message.msg_id] ?? null;
});

async function retrySend() {
  const msg = props.message;
  const channel = resendChannel.value;
  // 算不出通道 = 这个按钮本来就不该渲染出来（回执那边同一个判据）。这里再挡一次是
  // 防两条出口将来不一致，不是为了兜错。
  if (!channel) return;
  if (channel === "message") {
    // 群消息：有成员级台账（2026-10-25 起）就**按成员补发原信封** —— 不新建消息、
    // 不重签，已 Ack 的成员不会收到第二条；取消掉的成员行被重置为 pending。
    // 没有台账（升级前发出的历史消息）才退回"整条重发"这条旧路径。
    if (props.isGroup) {
      try {
        const res = await api.resendGroupDelivery(msg.conv_id, msg.msg_id);
        if (res.outcome !== "no_ledger" && res.outcome !== "unsupported") {
          const notice = groupResendNotice(res);
          app.toast(t(notice.key, notice.params ?? {}), notice.kind);
          return;
        }
      } catch (e) {
        app.toastError(e, t("msg.sendFailed"));
        return;
      }
      // 升级前发出的群消息没有台账：原信封已经不在了，**没有身份可复用**，
      // 只能整条重发（新 msg_id 是事实，旧那条失败行留原地也是事实）。
      try {
        await chat.send(msg.conv_id, msg.content, msg.kind, undefined, msg.msg_id);
      } catch {
        // 失败状态已由 send() 内部处理（原地退回 failed）
      }
      return;
    }
    try {
      // 单聊：**复用原 msg_id** 原地重投（计划 D1）。后端复用同一身份/ts/seq，接收端
      // 按 msg_id 去重 ⇒ 上一次其实送到、只是 Ack 丢了的话，对方只会再回一次 Ack。
      // 不再走 `chat.send(..., msg.msg_id)`：那条会生成新 msg_id，等于又发了一条新消息。
      await chat.resend(msg.conv_id, msg.msg_id);
    } catch (e) {
      // 重发被如实拒绝（已送达/状态已变）或入队失败：说原因，不静默。
      app.toastError(e, t("msg.resendFail"));
    }
    return;
  }
  // 文件与图片**只能回到造它们的那条通道**（`send_file_auto` / `send_group_file`）。
  // 以前图片漏在这里：`retryable` 与 `retrySend` 都只排除 `file`，于是失败的图片被按
  // 普通消息重发了一份 JSON 载荷 —— 里面那个 `path` 只在本机存在，对端收到的是
  // "有名字没有字节"的一张图，而本机这条还转成绿色（假成功）。
  const path = fileMeta.value?.path;
  if (!path) return;
  try {
    if (channel === "group-file") {
      await chat.sendGroupFileTo(msg.conv_id.replace(/^group:/, ""), path);
    } else {
      await chat.sendFileTo(msg.conv_id, path);
    }
    // 这两条命令自己负责 toast（成功会由后端 emit 出新的气泡与进度；
    // 与文本族不同，文件的一次重试是**新的一次传输**，所以旧那条失败行留在原地是事实，
    // 不是重复消息 —— 台账与气泡都各说各的那一次尝试）。
  } catch {
    // 发送入口内部已经报过错，这里不再重复提示
  }
}

/**
 * 「重新发送」的二次确认（2026-10-26 用户：「点了之后要有二次确认，确认后要在后台任务里
 * 看到这条重新发送」）。
 *
 * 为什么要确认而不是直接发：重发是一次**新的投递**（群那条还会给未收到的成员再发一遍），
 * 旧行为是点一下红叉就静默开始 —— 用户既不知道有没有点上、也没有反悔的机会，
 * 而「点了没反应」的观感正来自这里（图标原地不变，唯一的反馈是一句 toast）。
 * 确认后先 `markResending` 再走 `retrySend` ⇒ 任务中心那一行当场就是「重发中」，
 * 不等后端往返；往返失败时由 store 的剪枝按台账事实摘掉这格标记。
 */
const confirmingResend = ref(false);

function requestResend() {
  closeContextMenu();
  closeActionSheet();
  confirmingResend.value = true;
}

async function confirmResend() {
  confirmingResend.value = false;
  chat.markResending(props.message.msg_id);
  await retrySend();
}

// ---------------- 文件消息：微信式交互（整卡打开 / 右键保存·转发·复制） ----------------

/** 未就绪时点「下载」：接收是自动的（对方设备上线即传输），这里只解释状态。 */
function onFileDownload() {
  closeContextMenu();
  app.toast(t("msg.fileWillReceive"), "info");
}

/** 右键「保存」：另存为（复制本地已就绪的文件到用户选择的位置）。 */
function saveFileTo() {
  closeContextMenu();
  void saveAs();
}

/** 右键「复制文件」：文件本体写系统剪贴板（CF_HDROP），
 *  可在资源管理器粘贴出文件，也可直接粘贴回聊天框发送（微信式）。 */
async function copyFileToClipboard() {
  closeContextMenu();
  const path = fileMeta.value?.path;
  if (!path) {
    app.toast(t("msg.fileNotSynced"), "info");
    return;
  }
  try {
    await api.copyFileToClipboard(path);
    app.toast(t("msg.fileCopied"), "success");
  } catch (e) {
    app.toastError(e, t("msg.copyFail"));
  }
}
</script>

<template>
  <!-- 选中底色（`:class="tintClass"`）铺在**最外层这一圈**上 —— 它包住本项的**全部**内容：
       消息块（`.group/msg`）+ 它下面的兄弟节点"表情回应条"。

       ⚠️ 为什么必须包到最外层（这是用户 2026-09-21 连报几轮的"消息中间一条白线"的真身）：
       群里 `interactive` 恒为真 ⇒ 表情回应条**每条都会渲染**，且自带 `mt-1`(4px)。
       底色只铺在 `.group/msg` 上时，每条选中块的**下方**会留出那 4px 白缝，
       两条相邻选中消息之间就是"一条白线"（之前几轮我盯着分割行/焦点环找，都找错了）。
       包到外层后：底色上下连续，相邻两条直接相接，白线消失。

       这一层是**纯多包一层**：没有内外边距、没有边框 ⇒ 项高、各行高度、VirtualList 的
       高度估算全都不变（`messageHeight` 不用动）。横向也没有左右内边距 ⇒ 底色**通栏满宽**。

       ⚠️ 表情回应条的悬停揭示**在桌面端已按用户要求关掉**（2026-09-21：「表情回复桌面端先禁用掉」）：
       回应条是本层下面的兄弟节点，**在这层的包裹之内**；它的悬停揭示键是
       `group-hover/msg:` ⇒ **这层必须带 `group/msg`**，否则揭示永远不匹配
       （用户 2026-09-21 上一轮报「表情回应桌面端没有」、这一轮报「表情回应在哪儿？没看见」，
       都是因为这层少了个组名）。入口做成**飞书式**：气泡外侧单个表情按钮 → 点开完整选择器。
       （触屏仍可用：那颗入口的 `.kb-reveal` 在 `@media (hover: none)` 里退化成常显；
       已有的表情胶囊照常显示与点击。）

       ⚠️ 不要给它加 `background-clip`/`-inset-*`/`w-fit`/`ring-*`，也不要把底色挪回 `.group/msg`
       或消息行上：挪回 `.group/msg` 就露出那 4px 白缝；挪到消息行则连"头像上面 / 气泡下面"
       的 6px 内边距都没有了 —— 这几条都被用户逐个否过。 -->
  <div class="group/msg" :class="tintClass" :style="tintStyle">
    <!-- 消息块：纵向只留 **`pb-1`(4px)** 这一条下间距，它同时是"同一发送者连续消息"的组内留白；
         组首（`atGroupStart`）再自己带 `pt-1.5`(6px) ⇒ 组与组之间是 4+6=10px。
         分割行压在上面时不带那 6px（见 needsTopPad），免得重复给间距。
         这两档的分母在 `messageKinds`（MSG_GAP_TIGHT / MSG_GAP_NEW）+ `messageHeight`（GAP_BASE）——
         **改这里的类名必须同时改那两处**，否则虚拟列表的占位与真实画法会岔开、相邻消息互相遮挡。
         ⚠️ 别改回 `pb-1.5`：那是"每条都空 6px"的旧口径，连续消息看起来一条一条散着，
         与「同一人连发就是厚厚的一块气泡流」相反。 -->
    <div
      class="relative pb-1"
    >
    <!-- 多选态：透明覆盖层 + 左侧勾选框，两者都**绝对定位**，不进 flex 流。
         为什么必须这样：气泡宽度是 `max-w-[var(--gosslan-msg-max)]`（= 78%），勾选框若作为 flex 兄弟插进来会挤窄气泡、
         正文折行变多，而虚拟列表按 `previewMetrics.COLUMNS_PER_LINE` 估的高度不会跟着变
         ⇒ 相邻消息互相遮挡（`messageHeight` 文件头专门写过这个坑）。
         覆盖层的第二个作用：多选时气泡里的链接/图片/引用点击都不该响应，它一并吃掉。
         提示行（系统消息/已撤回）不可选，所以 `!isTip`。 -->
    <template v-if="selectMode && !isTip && isMultiSelectable(message.kind)">
      <!-- ⚠️ `outline-none` + `data-focus-ring-ok`（元素级豁免，理由见下）：
           这是"整行的透明点击层"，点选之后**它自己就是焦点元素**；此时再按任意键
           （用户按的是 ESC），Chromium 会把 `:focus-visible` 判为真 ⇒ 全局那圈
           2px 的焦点环画在**满宽的行**上，上下两条边就成了横贯整列的两条橙线
           （用户 2026-09-21：「我在选中状态按 ESC 就出现这个线」）。
           它没有任何可见内容，选中与否由左侧勾选圈（选中态实心 + 白勾）表达 ⇒ 不需要再画环。 -->
      <button
        class="absolute inset-0 z-10 outline-none"
        data-focus-ring-ok
        :aria-label="selected ? t('multi.deselect') : t('multi.select')"
        :aria-pressed="selected"
        @click="emit('toggle-select')"
      ></button>
    </template>
    <!-- 时间分割线（间隔 ≥ 5 分钟）：居中浅灰小字。
         · `pt-3.5`(14px) = 原来"列表项 pt-1.5(6) + 本行 py-2 的上半(8)"；
           `pb-2`(8px) 不含那 6px —— 正文块自己会带（见 needsTopPad）。纵向总高不变。
         · `bg-[var(--gosslan-chat)]` 不透明是**必须的**：底色铺在最外层、纵向连着铺，
           这行必须把自己那段盖回去，否则「连时间都被选中了」（用户 2026-09-21 原话）——
           时间戳只该在选中块**外面**（微信同样是白底的时间行）。 -->
    <div
      v-if="showTimeDivider"
      data-time-divider
      class="bg-[var(--gosslan-chat)] pt-3.5 pb-2 text-center text-caption text-[var(--gosslan-text-2)]"
    >
      {{ timeDividerText }}
    </div>

    <!-- 未读分割线（打开会话时定位的第一条未读上方）。总高同样不变：
         `mt-3`(12px) = 原"列表项 pt-1.5(6) + 本行 my-1.5(6)"，`mb-1.5`(6) 承原下外边距；
         正文块的 6px 上间距由它自己带。不透明的原因同时间分割线（这一行也不属于选中块）。 -->
    <div
      v-if="showUnreadDivider"
      class="mt-3 mb-1.5 flex items-center gap-2 bg-[var(--gosslan-chat)] px-3"
    >
      <div class="h-px flex-1 bg-[var(--gosslan-primary-soft)]"></div>
      <span class="rounded-full bg-[var(--gosslan-primary-light)] px-2 py-0.5 text-caption text-[var(--gosslan-accent-ink)]">{{ t("msg.unreadDivider") }}</span>
      <div class="h-px flex-1 bg-[var(--gosslan-primary-soft)]"></div>
    </div>

    <!-- 提示行（系统消息 / 已撤回）：微信式居中灰字，**通栏**、无头像、无气泡。
         之所以是"消息行"的**兄弟节点**而不是它内部的一支：放进消息行就会带上 36px 头像
         和 `max-w-[var(--gosslan-msg-max)]`（= 78%） 的列宽，居中后仍偏向一侧、看着还是一条普通消息 ——
         那正是用户 2026-09-16 报的问题。
         纵向间距同正文块：上间距看 `needsTopPad`（分割行会自己带），下间距由消息块那层的 `pb-1`。 -->
    <div
      v-if="isTip"
      class="px-4 text-center text-xs text-[var(--gosslan-text-2)]"
      :class="needsTopPad && atGroupStart ? 'pt-1.5' : ''"
    >
      {{ message.kind === "recalled" ? t(recalledTextKey) : message.content }}
    </div>

    <!-- 多选态给左侧勾选圈让出边槽：**只有"别人的"那一行**需要整排右移。
         自己的行头像在右侧、气泡是右对齐的，左移不动它 —— 加了这个内边距只会白白挤窄
         自己的气泡（多一圈折行），换不来任何观感收益。
         别人的行 `pl-10`(40px) = 圈 left-3(12) + 圆 18 + 间隙 10，头像正好从圈右侧干净地起排；
         圈本身**落在选中底色里**（微信同款，见下面那行的说明）。
         ⚠️ 这里只动横向内边距：高度估算用的 `COLUMNS_PER_LINE` 是**常量**、不随宽度变，
         所以不会破坏 VirtualList 的估算（横向挪动与"相邻消息互相遮挡"那个坑无关）。 -->
    <!-- 正文块（气泡行）：**只带条件性的上间距** `pt-1.5`（分割行压在上面时由分割行带），
         下间距统一由消息块那层的 `pb-1`(4px) 出（底色要包到那一层）。 -->
    <div
      v-else
      class="relative flex items-start gap-2 px-4 transition"
      :class="[
        needsTopPad && atGroupStart ? 'pt-1.5' : '',
        mine ? 'flex-row-reverse' : '',
        selectMode && !mine ? 'pl-10' : '',
      ]"
    >
      <!-- 选中态**底色铺在整条消息（列表项）上**：通栏满宽、直角、无边框，块内含上下 6px 间距，
           相邻两条选中的块**直接相接**，微信同款。
           ── 为什么最终是这个形态（别再改成"框住气泡"或"裁掉上下"）──
           用户同一天前后七轮：①「选中的背景色和边框左边没有边距，上下也没有」；
           ②「框和背景比消息气泡还小、整个消息都包不起来」；③对"整行满宽灰带"说「多选不对劲」；
           ④「实在不行就更微信一样这样也行啊」（附微信截图：整行浅底、勾选圈就在底色里）；
           ⑤「跟微信一样紧贴的成一片」；⑥「微信的选中的背景色他距离上下都有边距，你这个为啥没有？」；
           ⑦「微信他有间距（头像上面，气泡下面），连续消息没间距」← **最终口径**。
           中间试过、都已回退的形态：`inset-y-1 left-2 right-2` 装饰层（框比气泡小 —— 行盒**就是**
           消息的高度，纵向内缩等于把框画进气泡里）、`-inset-y-1` + 行盒 `w-fit` 外扩
           （开发环境几何正确，真机上退化成"整行一条 1px 横线"）、以及 `background-clip: content-box`
           裁掉上下内边距（⑥的误解：那样块与块之间会空 12px，与⑤⑦矛盾）。
           ⚠️ 不要加 `background-clip`、`-inset-*`、`w-fit`、`ring-*`，不要换回绝对定位的框，
           也不要把底色挪到这一行上（行盒 = 消息本身，挪过去就没有"头像上面/气泡下面"的间距了）。 -->
      <!-- 头像：单聊两方都不显示（联系人信息在顶部会话栏）；群聊只有对方、且只在组首显示。
           组内其余消息留一个同宽空位，气泡左边缘才不会一条一条地跳。 -->
      <template v-if="avatarCol">
        <button
          v-if="atGroupStart"
          type="button"
          class="tap-safe shrink-0 rounded-[var(--gosslan-avatar-radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          :aria-label="t('friend.openProfile', { name: avatarName })"
          @click="emit('open-profile', message.sender_id)"
        >
          <MessageAvatar
            :id="message.sender_id"
            :name="avatarName"
            :avatar="avatarSrc"
            :size="'var(--gosslan-msg-avatar)'"
          />
        </button>
        <span
          v-else
          aria-hidden="true"
          class="shrink-0"
          :style="{ width: 'var(--gosslan-msg-avatar)' }"
        ></span>
      </template>

      <!-- 勾选框（微信款）：18px 圆、未选 1px 细边、选中实底 + 细白勾。
           为什么不用 border-2：2px 的环在 16-18px 的圆里内孔只剩 12-14px，深色下是一圈
           又重又闷的「O」（用户 2026-09-17 反馈"太丑"）。微信的勾选圈之所以轻，
           靠的就是 1px 边 + 选中瞬间整个圆变实底，而不是靠加粗描边。
           填充色用 bg-[var(--gosslan-primary)]（正牌 token）—— 之前写的 --gosslan-accent **并不存在**，
           var() 解析失败会让整条声明被丢弃（选中态变成无色圆 + 看不见的白勾）。
           ⚠️ 竖向**对齐头像**，不是行的垂直居中（用户 2026-09-21：「微信的那个 radio 和头像对齐的」）：
           长消息里"行居中"会把圈甩到消息中间去。所以锚点挂在**消息行**上（`absolute` 的
           包含块 = 行的 padding box），`top-0`/`top-1.5` 对齐行的 content 顶（= 头像顶，
           行有 `pt-1.5` 时补上那 6px）＋ `mt-1.5`(6px) —— 头像 `--gosslan-msg-avatar` 高 30px、
           圈 18px，(30 − 18) / 2 = 6 ⇒ 两者竖向中心重合。**头像尺寸改过一次的教训**：
           这里原来是 `mt-2`(8px)，配的是 36px 的头像；头像换成 30px 后不跟着改就会低 2px。
           用标准间距类而不是 `calc(...)`：Tailwind 的任意值里漏一个空格就是**整条声明被丢弃**，
           而这条没有任何判据兜着（探针量的是气泡边缘，不是勾选圈）。
           横向 12px（`left-3`）：别人的行由 `pl-10`(40px) 把头像整排让开（圈 12..30 + 间隙 + 头像 40 起），
           自己的行消息在右侧、左边是空的，圈落在整行的选中底色之内。
           `z-20` 压在选中覆盖层（z-10）之上，但 `pointer-events-none` ⇒ 点击仍落到覆盖层。 -->
      <span
        v-if="selectMode && isMultiSelectable(message.kind)"
        class="pointer-events-none absolute left-3 z-20 mt-1.5 flex h-[18px] w-[18px] items-center justify-center rounded-full border transition"
        :class="[
          needsTopPad ? 'top-1.5' : 'top-0',
          selected
            ? 'border-primary bg-[var(--gosslan-primary-active)]'
            : 'border-[var(--gosslan-border)] bg-[var(--gosslan-panel)]',
        ]"
      >
        <Check v-if="selected" class="h-2.5 w-2.5 text-[var(--gosslan-on-primary)]" :stroke-width="2.5" aria-hidden="true" />
      </span>

      <!-- 尾巴的纵向位置自 2026-10-24 起不再依赖行顶/昵称行：它挂在气泡**左下/右下角、
           贴底边**（`bottom: 0`），所以这里不再传 `--bubble-tail-offset`。
           探针判据：尾巴下沿与气泡下沿齐平、外侧伸出 8~12px、上沿压进 12~16px。 -->
      <!-- 右键/长按的边界就是这一列（消息内容区）：昵称、引用块、正文、回执都在里面；
           头像、行内空白在列外 ⇒ 不会因为"同属一条消息"就弹消息菜单。
           表情回应的笑脸按钮与回应底栏虽然也在列内，但它们是控件：
           由 `onContextMenu` / `onTouchStart` 显式排除（`[data-reaction-entry]` / `[data-reaction-strip]`）。
           ⚠️ 触屏长按从这一列起手（不再只挂消息行）：昵称/引用块等非正文区也能开面板。 -->
      <div
        data-msg-col
        class="msg-stack relative flex min-w-0 max-w-[var(--gosslan-msg-max)] flex-col"
        :data-pos="groupSide"
        :class="mine ? 'items-end' : 'items-start'"
        :style="showNickname ? { '--bubble-tail-corner': '2px' } : undefined"
        @contextmenu="onContextMenu"
        @touchstart="onTouchStart"
        @touchend="cancelLongPress"
        @touchmove="onTouchMove"
        @touchcancel="cancelLongPress"
      >
        <!-- 表情回应入口（飞书式）：悬停本条消息 ⇒ **气泡外侧**出现笑脸按钮，
             点开 = 完整表情选择器（见下方 EmojiPicker），选中即作为表情回应发送/取消。
             ⚠️ 按钮 **absolute 脱离文档流**：悬停/选表情不改变本条消息的高度
             （上一版把一排快捷表情挂在流内，一悬停整条长高 ⇒ 「鼠标划过跳来跳去」）。
             选择器由 Reka Popover 传送到 body，位置/翻转/越界由 floating-ui 接管。
             位置：别人的消息在**气泡右侧**（`-right-11`）、自己的消息在**气泡左侧**（`-left-11`），
             竖向**与气泡内容底边对齐** —— 用户 2026-09-30：「按钮位置在视觉观感上应该与
             聊天内容最下边对齐」。以前是 `top-1/2 -translate-y-1/2` 居中线，单行消息上看着像
             浮在半空、多行消息上又和回应条错开。
             ⚠️ 横向仍锚在**本列**（列宽 = 气泡 + 回执让位后的整块），不能改锚到气泡本体：
             气泡在本列里往往更窄，锚到气泡会让按钮左移、压到回执上（2026-10-24 实测重叠 6px）。
             ⚠️ 竖向自 2026-10-24 起要减去**回应底栏的高度**：底栏并入气泡后，本列的底边 =
             底栏底边；不减的话按钮（连同选择器）会整体下坠 —— 窄窗口里选择器直接被顶出视口。
             那个高度由底下 `stripEl` 的 ResizeObserver 现量进 `entryBottom`，这里不猜。
             ⚠️ 揭示走 `.kb-reveal`（style.css，roadmap N19）而不是旧的 `hidden group-hover/msg:flex`：
             `display:none` 会**连可聚焦性一起去掉** ⇒ 键盘用户 Tab 跳不到这颗入口。现在它常驻布局
             （本来就 absolute ⇒ 不影响本条高度），悬停本条（组名在 `.group/msg` 上，本列在其内 ✓）、
             键盘聚焦到自己、或选择器开着（`kb-reveal-on`）时才显形。桌面端"悬停才现"那句要求没变。 -->
        <PopoverRoot
          v-if="canReact && !selectMode"
          :open="reactionPickerOpen"
          @update:open="onReactionPickerOpenChange"
        >
          <PopoverTrigger as-child>
            <button
              data-reaction-entry
              class="tap-safe kb-reveal absolute -right-11 bottom-0 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] shadow-sm transition"
              :class="[mine ? '-left-11' : '-right-11', reactionPickerOpen ? 'kb-reveal-on' : '']"
              :style="{ bottom: `${entryBottom}px` }"
              :title="t('msg.reactionAddEntry')"
              :aria-label="t('msg.reactionAddEntry')"
            >
              <Smile class="h-3.5 w-3.5 text-[var(--gosslan-text-2)]" :stroke-width="1.75" />
            </button>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent
              data-reaction-picker
              side="top"
              align="center"
              :side-offset="8"
              :collision-padding="8"
              hide-when-detached
              class="gosslan-popover-in z-[80] border-0 bg-transparent p-0 shadow-none"
              @open-auto-focus.prevent
              @close-auto-focus.prevent
            >
              <EmojiPicker
                :open="reactionPickerOpen"
                @select="onReactionPick"
                @close="closeReactionPicker"
              />
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>
        <!-- 引用块：挂在**气泡外面、正文下方**（微信同款：先自己的话，紧接着被引用的消息）。
             点击 = **直接查看**被引用的内容（用户 2026-09-21：「能直接查看的要能直接查看，不要跳转」）：
             图片→相册大图、合并卡片→卡片详情、文本/代码→全文弹窗、文件→系统打开；
             原消息不在本机时给提示，而不是无脑跳转。「定位到原消息」在消息菜单里
             （`quotedMsgId` 的说明 + 菜单项「定位到引用的消息」）。 -->
        <button
          v-if="quoteHeader"
          class="mt-1 block w-full cursor-pointer rounded-[var(--gosslan-radius-sm)] px-2 py-1 text-left text-meta leading-4 transition hover:brightness-110"
          :style="{ background: QUOTE_BG }"
          @click="viewQuoted"
        >
          <span class="quote-text" :style="QUOTE_TEXT_STYLE">{{ quoteHeader }}</span>
        </button>
        <!-- 群聊发送者昵称。
             视觉对齐：外层行是 `items-start` ⇒ **头像顶边 = 本行行盒顶边**。
             ⚠️ 不能省掉 `items-start`（2026-10-22 用户截图：头像在长消息里浮到中间）：
             flex 默认 `stretch` 会把头像按钮拉成整行高，头像在按钮里按行高居中 ⇒
             消息越长头像越往下沉，与名字完全错开。
             原先 `mb-0.5 text-caption`（行高 1.5 → 16.5px）会把墨迹往下推半行距约 3.7px，
             看起来名字比头像"低一点"（中英文都一样，实测 3.5px）。
             改成 `leading-none`（行盒 = 11px）+ `mb-[7px]`：墨迹贴到行盒顶（≈0.5px），
             与头像顶边齐平；且 **11 + 7 = 18px 与原来的 16.5 + 2 = 18.5 基本一致**，
             正好等于 messageHeight.NICKNAME_ROW(18)，虚拟列表估算不受影响。 -->
        <div
          v-if="showNickname"
          class="mb-[7px] px-1 text-caption leading-none text-[var(--gosslan-text-2)]"
        >
          {{ senderName || chat.nicknameOf(message.sender_id) }}
        </div>

        <!-- 消息行：气泡 + 侧挂回执（mine 时回执在气泡左侧）；右键（桌面）/长按（移动端）弹消息菜单 -->
        <div
          class="group/row flex w-full items-end gap-1.5"
          :class="mine ? 'justify-end' : 'justify-start'"
          :title="fullTime"
        >
          <!-- 回执：自聊消息**没有回执** —— 收发双方都是本机，不存在"已送达/已读"这个过程，
               挂上去只会显示一个永远转圈的圈（后端给自聊消息的状态直接是 read，
               但"绿勾已读"出现在自己发给自己上同样没有意义）。见 utils/selfChat。 -->
          <MessageReceipt
            v-if="mine && !isSelfMsg && sendState !== 'hidden'"
            :state="sendState"
            :title="receiptTitle"
            :is-group="isGroup"
            :reader-ids="groupReaderIds"
            :delivery="groupDelivery"
            :msg-key="message.msg_id ?? message.id"
            :retryable="resendChannel !== null"
            :can-cancel-send="canCancelSend"
            @retry="requestResend"
            @cancel="doCancelSend"
          />

          <!-- 气泡外壳：**气泡本体 + 表情回应底栏 + 尾巴**是同一块。
               （用户 2026-10-24：「把所有的表情回复包在气泡里面」；此前回应条是消息行的
               兄弟节点，连续气泡里看起来像另起了一条小气泡。）
               · 宽度 = max(气泡内容, 回应条)：底栏永远与气泡同宽，气泡本体撑满这层；
               · `items-end/items-start` 决定整块贴哪一侧；固定宽度的卡片自己 `self-*` 对齐；
               · 尾巴挂在这一层（不在气泡组件里）⇒ 有回应条时它落在**整块**的底角，
                 与底栏同一底色，不会悬在中间；
               · 回执留在外壳外，与整块底边对齐。 -->
          <div
            data-msg-bubble-shell
            class="msg-shell relative flex min-w-0 max-w-full flex-col"
            :class="mine ? 'items-end' : 'items-start'"
            :style="shellStyle"
            :data-has-reactions="hasReactions ? 'true' : undefined"
            :data-tail-side="tailSide ?? undefined"
          >
            <div
              data-msg-bubble
              class="relative flex w-full min-w-0 flex-col"
            >
              <!-- 文本 -->
              <MessageTextBubble
                v-if="message.kind === 'text'"
            :content="message.content"
            :bubble-style="bubbleStyle"
            :card-style="cardStyle"
            :clamped="isLongText"
            :copied="copiedKey === 'text'"
            :mine="mine"
            :mention-names="mentionNames"
            :self-mention="selfMention"
            :mention-targets="message.mention_targets"
            :select-mode="textSelecting"
            @expand="openFullModal('text', $event)"
            @copy="copyContent('text', copyOut($event))"
            @locate="emit('locate', $event)"
          />

              <!-- 代码：inline code 消息与代码附件同一套预览；超过 5 行裁断，全文进 Modal -->
              <MessageCodeBubble
                v-else-if="streamCode !== null"
            :code="streamCode"
            :clamped="streamCodeClamped"
            :copied="copiedKey === 'code'"
            :dark="app.dark"
            :mine="mine"
            @expand="openFullModal('code', $event)"
            @copy="copyContent('code', copyOut($event))"
          />

          <!-- 图片：已被存储清理时给出明确占位，而不是一个永远转圈/裂开的图片框。
               高度取 previewMetrics.IMAGE_PLACEHOLDER_HEIGHT —— 与 MessageImageBubble 的**终态**
               占位同一份常量（那条是"加载失败"，这条是"已被清理"，都不会再有图进来）。
               ⚠️ 刻意不等于 IMAGE_BUBBLE_HEIGHT：加载中要预留到估算那个数才不跳，
               终态不必，为一张不会再来的图撑 288px 灰块是最差的选项（见 N22）。
               ⚠️ 必须是 v-else-if：这里若写成 v-if 会**切断上面的 v-if/v-else-if 链**，
               使这条新链末尾的 <div v-else> 变成"对所有 text / code 消息都成立的兜底"——
               于是每条文本消息都被渲染两遍（MessageTextBubble 一遍 + 原始文字一遍，
               表现为表情显示成 [摊手] 原文、普通消息整条重复）。历史缺陷见 fd02f62。 -->
          <button
            v-else-if="message.kind === 'image' && attachmentMissing"
            type="button"
            class="flex w-52 cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--gosslan-bubble-radius)] bg-[var(--gosslan-hover)] text-caption text-[var(--gosslan-text-2)] transition hover:bg-[var(--gosslan-pressed)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            :class="mine ? 'self-end' : 'self-start'"
            :style="{ height: `${IMAGE_PLACEHOLDER_HEIGHT}px` }"
            :aria-disabled="mine ? 'true' : undefined"
            @click="mine ? undefined : refetchContent()"
          >
            <ImageOff class="h-6 w-6 opacity-50" />
            <span>{{ t("msg.imageCleaned") }}</span>
            <!-- 「向对方重新索取」是收件方才成立的出口：自己发出去的那张图，对端是接收方，
                 向它要一份既拿不到原图也没有意义。自己这一支只说清「为什么看不见了」。 -->
            <span class="opacity-70">{{ mine ? t("msg.imageCleanedMineHint") : t("msg.imageReRequest") }}</span>
          </button>

          <!-- 图片 -->
          <MessageImageBubble
            v-else-if="message.kind === 'image'"
            :class="mine ? 'self-end' : 'self-start'"
            :src="imageDataUrl"
            :mine="mine"
            :width="fileMeta?.w"
            :height="fileMeta?.h"
            @open="openImageLightbox"
            @refetch="refetchContent"
          />

          <!-- 附件图片预览（file + subtype:image，接收完成后显示本地图片） -->
          <!-- ⚠️ 有真实尺寸的附件图**不等预览 URL 就渲染图片框**：先渲染文件卡（90px）
               再换成图片气泡（145px）会让虚拟列表实测一次 90、再一次 145 ——
               2026-10-26 实测 7 行 × 55px 的整列上下抖。骨架按 w/h 预留，URL 到了只换内容不换高。 -->
          <MessageImageBubble
            v-else-if="
              message.kind === 'file' &&
              (attachmentUrl || (fileMeta?.subtype === 'image' && fileMeta?.w && fileMeta?.h))
            "
            :class="mine ? 'self-end' : 'self-start'"
            :src="attachmentUrl ?? ''"
            :mine="mine"
            :width="fileMeta?.w"
            :height="fileMeta?.h"
            @open="openImageLightbox"
            @refetch="refetchContent"
          />

          <!-- 文件 -->
          <MessageFileBubble
            v-else-if="message.kind === 'file' && fileMeta"
            :class="mine ? 'self-end' : 'self-start'"
            :meta="fileMeta"
            :bubble-style="cardStyle"
            :progress="fileProgress"
            :status-text="fileStatusText"
            :status-tone="fileStatusTone"
            :failed="sendState === 'failed'"
            :note="previewNote"
            :missing="attachmentMissing"
            :delivery="isGroupFile ? deliverySummary : null"
            :mine="mine"
            :ready="fileReady"
            :tappable="fileTappable"
            :content-retry="!!retryableContent"
            @cancel="doCancelSend"
            @open="openFile"
            @save="saveAs"
            @download="onFileDownload"
            @refetch="refetchContent"
          />

          <!-- 合并转发的聊天记录（微信式卡片）：定高 96px，与 `messageHeight.MERGE_CARD`
               的估算对齐（改卡片尺寸必须同时改那里，否则虚拟列表会遮挡相邻消息）。 -->
          <MergeCard
            v-else-if="message.kind === 'merge'"
            :class="mine ? 'self-end' : 'self-start'"
            :content="message.content"
            :card-style="cardStyle"
            :mine="mine"
            @open="emit('open-merge', { content: message.content, senderId: message.sender_id })"
          />

          <!-- 群任务卡片（`todo` = Card kind）：把 JSON 载荷渲染成可读卡片，替代原始 JSON 兜底 -->
          <TodoCardBubble
            v-else-if="message.kind === 'todo'"
            :class="mine ? 'self-end' : 'self-start'"
            :message="message"
            :card-style="cardStyle"
            :live-todo="todoLive"
            :deleted-ids="todoDeletedIds"
            :mention-names="mentionNames"
            :self-mention="selfMention"
            :mention-targets="message.mention_targets"
            :mine="mine"
            @open="emit('open-tasks', $event)"
            @open-panel="emit('open-tasks')"
          />

          <!-- 本机不认识的 kind（= 对端 Gosslan 比本机新）：给可解释的占位，
               绝不把载荷原文甩上屏（INV-P24 第 2 条）。判据只能走 isKnownKind ——
               `kindClass` 对未知值也返回 bubble，用它判会永远不进这个分支。 -->
          <UnsupportedKindBubble
            v-else-if="!isKnownKind(message.kind)"
            :kind="message.kind"
            :content="message.content"
            :bubble-style="bubbleStyle"
          />

          <!-- 已知但没有专门渲染分支的 kind：按纯文本兜底。
               排版必须与 MessageTextBubble 一致（py-1.5 / leading-normal），
               否则虚拟列表按 `previewMetrics.TEXT_BUBBLE_PADDING` 估的高度会对不上。 -->
          <div v-else class="select-text px-3 py-1.5 text-sm leading-normal break-all" :style="bubbleStyle">
            {{ message.content }}
          </div>
            </div>

            <!-- 表情回应底栏（2026-10-24 起并入气泡）：与气泡**同一块**——
                 「所有的表情回复包在气泡里面」（用户原话）。底色取上面那块气泡的同一格
                 （见 `reactionSurface`），上沿贴住气泡、下圆角跟气泡同档；气泡的两个下角
                 由 style.css 的 `.msg-shell[data-has-reactions]` 抹平，接缝处不会豁口。
                 只有真有回应时才渲染：群里 `interactive` 恒真，空条也会撑出内边距高度。
                 ⚠️ 它是控件区：右键/长按都不该弹消息菜单（见 `onContextMenu` / `onTouchStart`）。 -->
            <div
              v-if="!isTip && hasReactions"
              ref="stripEl"
              data-reaction-strip
              class="w-full px-3"
              :class="cardLikeBubble ? 'pb-1.5 pt-0.5' : 'pb-1.5 pt-1'"
              :style="reactionStripStyle"
              @contextmenu.stop
              @touchstart.stop
              @touchend.stop
              @touchmove.stop
              @touchcancel.stop
            >
              <MessageReactionBar
                :chips="reactions ?? EMPTY_REACTION_CHIPS"
                :mine="mine"
                :interactive="canReact"
                @toggle="emit('react', $event)"
              />
            </div>
            <!-- 尾巴挂在整块外壳上：有回应条时它落在底栏的左下/右下角，与底栏同一底色。 -->
            <BubbleTail v-if="showTail" :mine="mine" />
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 强提醒标识：气泡下方一条（发起方看总览/接收方看本机相），接收方未确认时带「我知道了」。
       让出多少由 `avatarGutterClass` 现算：有头像列的那侧让
       `--gosslan-msg-gutter`（= 行的 16 + 头像列 30 + 间隙 8），没有头像列的那侧只让行的
       16px 内边距 —— 这两档各被实测判红过一次：写死 60 让胶囊离气泡边 44px（撤头像列之后），
       而只让 16 又会在真有头像列的那行压进气泡。 -->
  <div
    v-if="showReminderBadge && !isTip"
    class="flex max-w-full flex-wrap items-center gap-2 pb-0.5"
    :class="avatarGutterClass"
  >
    <span
      :class="[
        'inline-flex items-center gap-1 rounded-full px-2 py-[1px] text-meta font-medium',
        reminderBadgeClass,
      ]"
      :title="reminderRosterTitle || undefined"
    >
      <BellRing class="h-3 w-3" />
      {{ reminderPhaseLabel }}
    </span>
    <button
      v-if="canConfirm"
      class="tap-safe rounded-full bg-[var(--gosslan-primary-active)] px-2.5 py-[1px] text-meta font-medium text-[var(--gosslan-on-primary)] transition hover:opacity-90"
      @click="doConfirmReminder"
    >
      {{ t("remind.gotIt") }}
    </button>
  </div>
  </div>

  <!-- ↓ 以下都是**浮层**（弹窗/右键菜单/长按面板）：它们 Teleport 到 body 或 `fixed`，
       不参与布局，所以留在选中底色的包裹之外（既不占高度、也不该被选中态影响）。 -->

  <!-- 撤回二次确认：破坏性且不可逆，必须显式确认（各端一致，移动端同样弹这个） -->
  <ConfirmDialog
    :open="confirmingRecall"
    :title="t('msg.recall')"
    :confirm-label="t('common.confirm')"
    :body="recallConfirmBody"
    @cancel="confirmingRecall = false"
    @confirm="confirmRecall"
  />

  <!-- 重发二次确认（2026-10-26）：与撤回同一套组件、同一套「确认才动手」的口径。
       移动端长按菜单走的也是同一个 requestResend ⇒ 两端行为一致。 -->
  <ConfirmDialog
    :open="confirmingResend"
    :title="t('msg.resend')"
    :confirm-label="t('common.confirm')"
    :body="t('msg.resendConfirm')"
    @cancel="confirmingResend = false"
    @confirm="confirmResend"
  />

  <MessageContentModal
    :open="fullModalOpen"
    :kind="fullModalKind"
    :content="fullModalContent"
    :mention-names="mentionNames"
            :self-mention="selfMention"
            :mention-targets="message.mention_targets"
    :copied="copiedKey === 'full'"
    @close="fullModalOpen = false"
    @copy="copyContent('full', copyOut($event))"
  />

  <!-- 群聊强提醒：受众选择（不默认全群） -->
  <RemindAudienceDialog
    :open="remindAudienceOpen"
    :group-id="(message.conv_id || '').slice(6)"
    @close="remindAudienceOpen = false"
    @picked="onAudiencePicked"
  />

  <!-- 消息右键菜单 -->
  <MessageContextMenu
    v-if="ctxMenu"
    :x="ctxMenu.x"
    :y="ctxMenu.y"
    :kind="message.kind"
    :quoted-id="quotedMsgId || undefined"
    :selected-text="ctxMenu.selectedText"
    @close="closeContextMenu()"
    @locate-quote="onLocateQuote"
    @copy-selection="copySelectionFromMenu"
    @copy-text="closeContextMenu(); copyFromMenu()"
    @copy-image="copyImage"
    @save-image="saveImage"
    @save-file="saveFileTo"
    @copy-file="copyFileToClipboard"
    @quote="doQuote"
    :can-recall="canRecallNow()"
    :can-render="renderTo !== null"
    :render-to="renderTo ?? 'text'"
    :can-pin="canPinEntry"
    :pinned="!!pinned"
    :can-cancel-send="canCancelSend"
    :can-remind="canRemindEntry"
    @pin="emit('pin')"
    @recall="doRecall"
    @render="doRender"
    @cancel-send="doCancelSend"
    @forward="doForward"
    @favorite="doFavorite"
    @remind="doRemind"
    @multi-select="doMultiSelect"
  />

  <!-- 移动端长按 → 底部操作面板（Action Sheet）。操作与右键菜单同源，只是展示形态不同。 -->
  <ActionSheet :open="sheetOpen" @close="closeActionSheet()">
    <div class="flex flex-col">
      <button
        v-if="copyableText"
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="closeActionSheet(); copyFromMenu()"
      >
        <Copy class="h-5 w-5 text-[var(--gosslan-text-2)]" />
        {{ t("msg.copyMessage") }}
      </button>
      <!-- 「选择文字」：非正文区长按打开面板后的「全选」快捷入口。
           正文本身**直接长按**就是系统原生选字（手柄 + 系统复制菜单），不经过这里；
           该入口只负责把整条正文一次性框进选区（`MessageTextBubble` 自动全选）。
           ⚠️ 只对 **text** 开放：代码气泡的可选元素在 `CodeBlock` 里，本轮没给它接选择模式，
           给个点了没反应的入口比不给更糟。 -->
      <button
        v-if="message.kind === 'text'"
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="enterTextSelect"
      >
        <TextSelect class="h-5 w-5 text-[var(--gosslan-text-2)]" />
        {{ t("common.selectText") }}
      </button>
      <template v-if="message.kind === 'image'">
        <button
          class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
          @click="copyImage"
        >
          <Copy class="h-5 w-5 text-[var(--gosslan-text-2)]" />
          {{ t("common.copyImage") }}
        </button>
        <button
          class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
          @click="saveImage"
        >
          <Save class="h-5 w-5 text-[var(--gosslan-text-2)]" />
          {{ t("common.saveImage") }}
        </button>
      </template>
      <template v-if="message.kind === 'file'">
        <button
          class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
          @click="saveFileTo"
        >
          <Save class="h-5 w-5 text-[var(--gosslan-text-2)]" />
          {{ t("common.save") }}
        </button>
        <button
          class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
          @click="copyFileToClipboard"
        >
          <Copy class="h-5 w-5 text-[var(--gosslan-text-2)]" />
          {{ t("common.copyFile") }}
        </button>
      </template>
      <button
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="doQuote"
      >
        <CornerUpLeft class="h-5 w-5 text-[var(--gosslan-text-2)]" />
        {{ t("common.quote") }}
      </button>

      <!-- 置顶：任意群成员都能置（可逆、低风险），与撤回不同。
           与桌面菜单**共用同一个判定**（`canPinEntry`）——这条以前在这里是内联写的，
           和同族「撤回」漏 `isGroup` 那次是同一个形状，改一处漏一处。 -->
      <button
        v-if="canPinEntry"
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="closeActionSheet(); emit('pin')"
      >
        <Pin class="h-5 w-5 text-[var(--gosslan-text-2)]" />
        {{ pinned ? t("msg.unpin") : t("msg.pin") }}
      </button>

      <!-- 撤回：与桌面右键菜单**共用同一个判定**（`canRecall`）——
           此前这里是内联条件且漏了 isGroup，导致单聊长按也出现「撤回」，
           而后端只实现了群撤回 ⇒ 点了确认后什么都不发生。 -->
      <button
        v-if="canRecallNow()"
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-danger-ink)] transition active:bg-[var(--gosslan-hover)]"
        @click="doRecall"
      >
        <Undo2 class="h-5 w-5" />
        {{ t("msg.recall") }}
      </button>
      <button
        v-if="renderTo"
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="doRender"
      >
        <component
          :is="renderTo === 'code' ? Code2 : FileText"
          class="h-5 w-5 text-[var(--gosslan-text-2)]"
        />
        {{ renderTo === "code" ? t("msg.renderAsCode") : t("msg.renderAsText") }}
      </button>
      <button
        v-if="forwardable(message.kind)"
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="doForward"
      >
        <Share2 class="h-5 w-5 text-[var(--gosslan-text-2)]" />
        {{ t("common.forward") }}
      </button>
      <!-- 收藏：与桌面右键菜单同一份判据（`favoritable`，含卡片类）与同一份 emit（`doFavorite`）。
           ⚠️ 移动端入口必须在这里**再写一遍** —— 右键菜单与 ActionSheet 是两套独立模板，
           只加一处的结果是"桌面能收藏、手机不能"（这类漂移在项目里已发生过多次）。 -->
      <button
        v-if="favoritable(message.kind)"
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="doFavorite"
      >
        <Star class="h-5 w-5 text-[var(--gosslan-text-2)]" />
        {{ t("favorite.add") }}
      </button>
      <!-- 强提醒：与桌面菜单同源（canRemindEntry）；两套独立模板都必须有 -->
      <button
        v-if="canRemindEntry"
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="doRemind"
      >
        <BellRing class="h-5 w-5 text-[var(--gosslan-text-2)]" />
        {{ t("remind.menuEntry") }}
      </button>
      <!-- 定位到引用消息：本条引用了谁就从菜单跳过去（与微信一致，用户 2026-09-21）。
           与引用块上的点击同一条 emit（`locate`）。 -->
      <button
        v-if="quotedMsgId"
        class="flex items-center gap-3 px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="closeActionSheet(); emit('locate', quotedMsgId)"
      >
        <CornerUpLeft class="h-5 w-5 text-[var(--gosslan-text-2)]" />
        {{ t("msg.locateQuote") }}
      </button>
      <!-- 多选：移动端同样要有入口（桌面右键菜单是另一套模板）。
           待办卡片不给（见 isMultiSelectable）。 -->
      <button
        v-if="isMultiSelectable(message.kind)"
        class="flex items-center gap-3 border-t border-[var(--gosslan-divider)] px-4 py-3 text-left text-title text-[var(--gosslan-text)] transition active:bg-[var(--gosslan-hover)]"
        @click="doMultiSelect"
      >
        <ListChecks class="h-5 w-5 text-[var(--gosslan-text-2)]" />
        {{ t("multi.enter") }}
      </button>
    </div>
  </ActionSheet>
</template>
