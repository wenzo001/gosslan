import { computed, toValue, type CSSProperties, type MaybeRefOrGetter } from "vue";
import dayjs from "dayjs";
import { useAppStore } from "@/stores/useAppStore";
import { findPreset, parsePeerStyle } from "@/utils/chatStyle";
import type { MessageRecord } from "@/types";

export type SendState = "sending" | "sent" | "delivered" | "read" | "failed";

/** 同发送者合并窗口：5 分钟内省略头像 / 昵称。 */
const SENDER_RUN_WINDOW = 5 * 60 * 1000;
/** 时间分割线阈值：与上一条间隔 ≥ 5 分钟。 */
const TIME_DIVIDER_GAP = 5 * 60 * 1000;

/**
 * 消息外观与版面判定（气泡配色、连续消息合并、时间行、发送状态）。
 * MessageItem 与其子组件共用同一份判定，避免两边各写一套导致布局错位。
 */
export function useMessageDisplay(opts: {
  message: MaybeRefOrGetter<MessageRecord>;
  prev: MaybeRefOrGetter<MessageRecord | null | undefined>;
  next: MaybeRefOrGetter<MessageRecord | null | undefined>;
  isGroup: MaybeRefOrGetter<boolean>;
}) {
  const app = useAppStore();
  const message = computed(() => toValue(opts.message));
  const prev = computed(() => toValue(opts.prev) ?? null);
  const next = computed(() => toValue(opts.next) ?? null);
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
  const colors = computed(() => (app.dark ? preset.value.dark : preset.value.light));
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

  /** 连续消息合并：同一发送者 5 分钟内的消息省略头像/昵称（紧凑模式可关）。 */
  const sameSenderRun = computed(() => {
    if (!app.chatStyle.compact) return false;
    const p = prev.value;
    if (!p || p.kind === "system" || p.sender_id !== message.value.sender_id) return false;
    return message.value.ts - p.ts < SENDER_RUN_WINDOW;
  });
  /** 同一分钟内的连续消息：合并显示（省略时间行、气泡更紧凑），不依赖紧凑开关。 */
  const sameMinuteRun = computed(() => {
    const p = prev.value;
    if (!p || p.kind === "system") return false;
    return dayjs(p.ts).isSame(message.value.ts, "minute");
  });
  const nextContinuesSenderRun = computed(() => {
    const n = next.value;
    if (!n || n.kind === "system" || message.value.kind === "system") return false;
    if (!app.chatStyle.compact || n.sender_id !== message.value.sender_id) return false;
    return n.ts - message.value.ts < SENDER_RUN_WINDOW;
  });
  /** 时间行只显示在分钟组的末条，避免时间标签把同一组的首条与第二条撑开。 */
  const isLastInMinute = computed(() => {
    const n = next.value;
    if (!n) return true;
    if (nextContinuesSenderRun.value) return false;
    return !dayjs(n.ts).isSame(message.value.ts, "minute");
  });
  const tight = computed(() => sameSenderRun.value || sameMinuteRun.value);
  const showTimeDivider = computed(
    () => !prev.value || message.value.ts - prev.value.ts >= TIME_DIVIDER_GAP,
  );
  const showNickname = computed(
    () => isGroup.value && !mine.value && !sameSenderRun.value,
  );

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
    sameSenderRun,
    sameMinuteRun,
    nextContinuesSenderRun,
    isLastInMinute,
    tight,
    showTimeDivider,
    showNickname,
    time,
    fullTime,
    timeDividerText,
    sendState,
    receiptTitle,
  };
}
