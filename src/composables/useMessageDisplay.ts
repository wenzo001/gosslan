import { currentLocale, t } from "@/i18n";
import { computed, toValue, type CSSProperties, type MaybeRefOrGetter } from "vue";
import { useAppStore } from "@/stores/useAppStore";
import { findPreset, parsePeerStyle, readableToneOn, resolveChatColors, UI_TONE_INKS } from "@/utils/chatStyle";
import { fmtDateTime, fmtTimeDivider } from "@/utils/time";
import { shouldShowTimeDivider } from "@/utils/previewMetrics";
import { shouldShowNickname, type MessageGroupSide } from "@/utils/messageKinds";
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
  /** 连续消息合并位置：群聊只在组首显示昵称（与估高端同一个判定）。 */
  groupSide?: MaybeRefOrGetter<MessageGroupSide>;
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

  /** 本条在连续消息组里的位置。判定由会话层（`ChatWindow.groupSideAt`）算好传进来，
   *  与 `messageHeight` 的估高共用同一个函数；没传就是独占一条。 */
  const groupSide = computed<MessageGroupSide>(() =>
    opts.groupSide ? toValue(opts.groupSide) : "single",
  );

  /**
   * 连续消息的四角：**与相邻那一条齐平的那一侧**收成小角，外侧仍是胶囊。
   *
   * 这段必须待在内联样式里。上一版把它写在样式表的
   * `.msg-stack[data-pos="…"] .gosslan-bubble-text` 上，而气泡的 `border-radius`
   * 本来就出自下面的 `bubbleStyle` ⇒ 内联压过样式表，四角实测恒为 18px，
   * 「合并」这件事只剩间距生效（2026-10-23 探针新加的那格连续消息量具抓出来的）。
   * 值仍只取令牌，像素不在这里。
   */
  const stackRadii = computed<Pick<
    CSSProperties,
    "borderTopLeftRadius" | "borderTopRightRadius" | "borderBottomLeftRadius" | "borderBottomRightRadius"
  >>(() => {
    const full = "var(--gosslan-bubble-radius, 4px)";
    const tight = "var(--gosslan-bubble-radius-tight, 6px)";
    const side = groupSide.value;
    const top = side === "middle" || side === "last" ? tight : full;
    const bottom = side === "middle" || side === "first" ? tight : full;
    return {
      borderTopLeftRadius: top,
      borderTopRightRadius: top,
      borderBottomLeftRadius: bottom,
      borderBottomRightRadius: bottom,
    };
  });

  /** 气泡：圆角/尖角取微信式，配色仍由用户预设决定（--bubble-bg 供尖角取色）。 */
  const bubbleStyle = computed<CSSProperties>(
    () =>
      ({
        "--bubble-bg": mine.value ? colors.value.mineBubble : colors.value.otherBubble,
        background: "var(--bubble-bg)",
        color: mine.value ? colors.value.mineText : colors.value.otherText,
        ...stackRadii.value,
        border: mine.value ? "1px solid transparent" : "1px solid var(--gosslan-border)",
        // 尖角描边取这条消息自己的边框色（`mine` 的边框是透明的 ⇒ 描边也透明，形状只靠填充）。
        // 用户 2026-10-23：「气泡有边框、尾巴没有 ⇒ 接缝对不上」——尾巴与气泡必须同一支线色。
        "--bubble-line": mine.value ? "transparent" : "var(--gosslan-border)",
        position: "relative",
        // 真实底色（hex），供子组件 mentionHighlightColor 算对比度。
        // CSS 变量字符串无法传入 contrastRatio，必须额外挂一个真实值。
        "--bubble-bg-raw": mine.value ? colors.value.mineBubble : colors.value.otherBubble,
      }) as CSSProperties,
  );

  /**
   * 卡片型气泡（文件/合并/任务）的统一配色。
   *
   * 2026-10-25 用户口径：自己发的卡片必须跟自己的主题气泡同色（"文件/代码卡片/超长文本
   * 的气泡颜色好像还是固定的……应该是统一的"），对方卡片保持中性。
   * 所有前景色都从这一处派生，组件里不许再写第二份 `--gosslan-card-ink`：
   *  - `--card-ink` / `--card-ink-soft`：正文与次要文字；
   *  - `--card-line`：边框与分隔线；
   *  - `--card-chip`：浅底 chip / 图标井 / 进度槽；
   *  - `--card-action`：卡片里的操作文字（对方 = 主题色，自己 = 气泡文字色）；
   *  - `--card-danger` / `--card-warning`：在 `mineBubble` 上现算到 ≥4.5 的语气色。
   * 代码卡片不读这里（`MessageCodeBubble` 保留 `CODE_SURFACE`）。
   */
  const cardStyle = computed<CSSProperties>(() => {
    const mineCard = mine.value;
    const bg = mineCard ? colors.value.mineBubble : "var(--gosslan-card)";
    const ink = mineCard ? colors.value.mineText : "var(--gosslan-card-ink)";
    const line = mineCard ? "transparent" : "var(--gosslan-card-line)";
    const tone = app.dark ? "dark" : "light";
    const vars: Record<string, string> = {
      "--bubble-bg": bg,
      "--bubble-line": line,
      "--card-ink": ink,
      "--card-ink-soft": `color-mix(in srgb, ${ink} 88%, ${bg})`,
      "--card-line": mineCard
        ? `color-mix(in srgb, ${ink} 18%, transparent)`
        : "var(--gosslan-card-line)",
      "--card-chip": mineCard
        ? `color-mix(in srgb, ${ink} 10%, ${bg})`
        : "var(--gosslan-hover)",
      "--card-action": mineCard ? "var(--card-ink)" : "var(--gosslan-primary)",
      "--card-danger": mineCard
        ? readableToneOn(colors.value.mineBubble, UI_TONE_INKS.danger[tone])
        : "var(--gosslan-danger-ink)",
      "--card-warning": mineCard
        ? readableToneOn(colors.value.mineBubble, UI_TONE_INKS.warning[tone])
        : "var(--gosslan-warning-ink)",
    };
    // 真实 hex 只在自己卡片上有（对方卡片是 CSS token，读不到 hex）——供 mention 对比度现算。
    if (mineCard) vars["--bubble-bg-raw"] = colors.value.mineBubble;
    return {
      ...vars,
      background: "var(--bubble-bg)",
      color: "var(--card-ink)",
      borderRadius: "var(--gosslan-bubble-radius, 4px)",
      border: "1px solid var(--bubble-line)",
      // 不加阴影：学微信，纯色卡片 + 1px 描边就够，阴影反而显脏
      position: "relative",
    } as CSSProperties;
  });

  /** 这一条前面要不要插时间分割行。阈值与判定都取自 `previewMetrics` ——
   *  估算端（`messageHeight`）用的是同一个函数，因为分割行自己占 32px，
   *  两边判得不一致就会让相邻消息互相遮挡。 */
  const showTimeDivider = computed(() =>
    shouldShowTimeDivider(message.value.ts, prev.value?.ts),
  );
  const showNickname = computed(() =>
    shouldShowNickname({
      isGroup: isGroup.value,
      mine: mine.value,
      kind: message.value.kind,
      atGroupStart: groupSide.value === "first" || groupSide.value === "single",
    }),
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
