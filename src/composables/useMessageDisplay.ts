import { computed, toValue, type CSSProperties, type MaybeRefOrGetter } from "vue";
import dayjs from "dayjs";
import { useAppStore } from "@/stores/useAppStore";
import { findPreset, parsePeerStyle, resolveChatColors } from "@/utils/chatStyle";
import type { MessageRecord } from "@/types";

export type SendState = "sending" | "sent" | "delivered" | "read" | "failed";

/** 时间分割线阈值：与上一条间隔 ≥ 5 分钟。 */
const TIME_DIVIDER_GAP = 5 * 60 * 1000;

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
  /** 气泡：圆角/尖角取微信式，配色仍由用户预设决定（--bubble-bg 供尖角取色）。 */
  const bubbleStyle = computed<CSSProperties>(
    () =>
      ({
        "--bubble-bg": mine.value ? colors.value.mineBubble : colors.value.otherBubble,
        background: "var(--bubble-bg)",
        color: mine.value ? colors.value.mineText : colors.value.otherText,
        borderRadius: "var(--gosslan-bubble-radius, 4px)",
        border: mine.value ? "1px solid transparent" : "1px solid var(--gosslan-border)",
        position: "relative",
      }) as CSSProperties,
  );

  /** 每条消息独立完整渲染（不再合并连续消息）：时间行恒显示。 */
  const showTimeDivider = computed(
    () => !prev.value || message.value.ts - prev.value.ts >= TIME_DIVIDER_GAP,
  );
  const showNickname = computed(() => isGroup.value && !mine.value);

  const time = computed(() => dayjs(message.value.ts).format("YYYY年MM月DD日 HH:mm"));
  const fullTime = computed(() => dayjs(message.value.ts).format("YYYY-MM-DD HH:mm:ss"));
  const timeDividerText = computed(() => dayjs(message.value.ts).format("YYYY-MM-DD HH:mm"));

  const sendState = computed(() => message.value.status as SendState);
  const receiptTitle = computed(() => {
    switch (sendState.value) {
      case "sending":
      case "sent":
        return "发送中…";
      case "delivered":
        return "对方已收到，未读";
      case "read":
        return "对方已读";
      case "failed":
        return "发送失败";
      default:
        return "";
    }
  });

  return {
    mine,
    bubbleStyle,
    showTimeDivider,
    showNickname,
    time,
    fullTime,
    timeDividerText,
    sendState,
    receiptTitle,
  };
}
