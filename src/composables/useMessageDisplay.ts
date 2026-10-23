import { currentLocale, t } from "@/i18n";
import { computed, toValue, type CSSProperties, type MaybeRefOrGetter } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { findPreset, parsePeerStyle, resolveChatColors } from "@/utils/chatStyle";
import { fmtDateTime, fmtTimeDivider } from "@/utils/time";
import { shouldShowTimeDivider } from "@/utils/previewMetrics";
import { shouldShowNickname } from "@/utils/messageKinds";
import type { MessageRecord } from "@/types";

export type SendState = "sending" | "sent" | "delivered" | "read" | "failed" | "cancelled";

/**
 * 消息外观与版面判定（气泡配色、时间行、发送状态）。
 * MessageItem 与其子组件共用同一份判定，避免两边各写一套导致布局错位。
 */
export function useMessageDisplay(opts: {
  message: MaybeRefOrGetter<MessageRecord>;
  prev: MaybeRefOrGetter<MessageRecord | null | undefined>;
  isGroup: MaybeRefOrGetter<boolean>;
}) {
  const app = useAppStore();
  const message = computed(() => toValue(opts.message));
  const prev = computed(() => toValue(opts.prev) ?? null);
  const isGroup = computed(() => toValue(opts.isGroup));

  const mine = computed(() => message.value.sender_id === app.device?.device_id);

  /** 我发的消息用我的样式；对方发的优先用对方广播的样式（未同步过则回退本机）。 */
  const preset = computed(() => {
    if (!mine.value) {
      const raw = app.peerStyles[message.value.sender_id];
      if (raw) return findPreset(parsePeerStyle(raw).preset);
    }
    return findPreset(app.chatStyle.preset);
  });
  /** 气泡配色："theme" 预设按当前主题色运行时派生（本机消息跟随我的主题色，
   *  对方消息按对方广播的偏好渲染），其余预设取表中明/暗值。 */
  const colors = computed(() => resolveChatColors(preset.value.key, app.themeColor, app.dark));
  /**
   * 尖角那一侧的**上圆角**要跟着尖角走（用户 2026-10-23：「群聊里尾巴没有和气泡融合」）。
   *
   * 群聊有昵称行，气泡顶边被推到与头像中心齐平 ⇒ 尖角落在气泡的**左上/右上圆角**上。
   * 胶囊圆角是 18px：在尖角那 12px 的高度里，气泡边缘已经从 x=18 收到 x≈4.6，直边三角形
   * 只能碰到弧线的一个点，中间露出背景色，看起来就是"断开"。把这一侧的圆角压到 2px，
   * 尖角才贴在直边上（微信同形）。单聊没有昵称行、尖角在胶囊最左侧那条直边上，
   * `--bubble-tail-corner` 缺省回落到原胶囊值 ⇒ 形状一点不动。
   *
   * ⚠️ 必须写在**内联样式**里（主题预设也要读圆角），CSS 规则压不过内联。
   */
  const tailCornerRadius = "var(--bubble-tail-corner, var(--gosslan-bubble-radius, 4px))";
  const tailCorner = computed<CSSProperties>(() =>
    mine.value
      ? { borderTopRightRadius: tailCornerRadius }
      : { borderTopLeftRadius: tailCornerRadius },
  );

  /** 气泡：圆角/尖角取微信式，配色仍由用户预设决定（--bubble-bg 供尖角取色）。 */
  const bubbleStyle = computed<CSSProperties>(
    () =>
      ({
        "--bubble-bg": mine.value ? colors.value.mineBubble : colors.value.otherBubble,
        background: "var(--bubble-bg)",
        color: mine.value ? colors.value.mineText : colors.value.otherText,
        borderRadius: "var(--gosslan-bubble-radius, 4px)",
        ...tailCorner.value,
        border: mine.value ? "1px solid transparent" : "1px solid var(--gosslan-border)",
        position: "relative",
        // 真实底色（hex），供子组件 mentionHighlightColor 算对比度。
        // CSS 变量字符串无法传入 contrastRatio，必须额外挂一个真实值。
        "--bubble-bg-raw": mine.value ? colors.value.mineBubble : colors.value.otherBubble,
      }) as CSSProperties,
  );

  /**
   * 卡片型气泡（文件/代码）走中性色：学微信——非文本气泡不跟随主题色，
   * 自己发的和对方发的同色，靠左右位置和尖角区分归属，避免满屏都是品牌色。
   * 配色一律取主题 token（--gosslan-card*）：亮色＝浅灰卡片浮在近白画布上（靠 1px 描边区分），
   * 暗色＝比画布亮一档的深灰。**不要在组件里写死这两档色值**——
   * 写死就等于脱离主题，深浅切换时只能靠人肉记住两处都改（这正是本次收敛掉的东西）。
   */
  const cardStyle = computed<CSSProperties>(
    () =>
      ({
        "--bubble-bg": "var(--gosslan-card)",
        background: "var(--bubble-bg)",
        color: "var(--gosslan-card-ink)",
        borderRadius: "var(--gosslan-bubble-radius, 4px)",
        ...tailCorner.value,
        border: "1px solid var(--gosslan-card-line)",
        // 不加阴影：学微信，纯色卡片 + 1px 描边就够，阴影反而显脏
        position: "relative",
      }) as CSSProperties,
  );

  /** 这一条前面要不要插时间分割行。阈值与判定都取自 `previewMetrics` ——
   *  估算端（`messageHeight`）用的是同一个函数，因为分割行自己占 32px，
   *  两边判得不一致就会让相邻消息互相遮挡。 */
  const showTimeDivider = computed(() =>
    shouldShowTimeDivider(message.value.ts, prev.value?.ts),
  );
  const showNickname = computed(() =>
    shouldShowNickname({ isGroup: isGroup.value, mine: mine.value, kind: message.value.kind }),
  );

  const fullTime = computed(() => fmtDateTime(message.value.ts));
  const timeDividerText = computed(() => fmtTimeDivider(message.value.ts, t, currentLocale()));

  const sendState = computed(() => message.value.status as SendState);
  const receiptTitle = computed(() => {
    switch (sendState.value) {
      case "sending":
      case "sent":
        return t("msg.sending");
      case "delivered":
        return t("msg.delivered");
      case "read":
        return t("msg.read");
      case "failed":
        return t("msg.sendFailed");
      // 用户主动取消。`messages.status='cancelled'` 已经写了好几个版本，而这份映射里
      // 一直没有它 ⇒ 取消掉的发送回执走 default 返回**空串**：图标位是空的、读屏也什么都
      // 读不到，用户只能靠"内容没发出去"反推自己按过取消。与 INV-P26 的口径一起补上：
      // 取消与失败是两格，各自都要有能看见的名字。
      case "cancelled":
        return t("msg.canceled");
      default:
        return "";
    }
  });

  return {
    mine,
    bubbleStyle,
    cardStyle,
    showTimeDivider,
    showNickname,
    fullTime,
    timeDividerText,
    sendState,
    receiptTitle,
  };
}
