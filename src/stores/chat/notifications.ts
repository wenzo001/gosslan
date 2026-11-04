/**
 * 系统通知 / 未读外显 / 强提醒 / 窗口抖动。
 *
 * 职责边界：只决定「要不要打扰用户、怎么打扰」，不改消息与会话数据；发送回执仍走
 * `messaging.send`，打开会话/定位仍走 `conversations`。
 */
import { ref, watch } from "vue";
import { api, emitAction, NAVIGATE_TO_CONTACTS } from "@/api";
import { trimOldest } from "@/utils/bounded";
import { isStaleNudge } from "@/utils/nudge";
import { prefersReducedMotion } from "@/utils/platform";
import { shouldRunThrottled } from "@/utils/defer";
import { notifyTitle } from "@/utils/notifyTitle";
import { previewText } from "@/utils/messages";
import { mergeNoticesInto, notificationBody, type QueuedNotice } from "@/utils/notifications";
import { batchIsUrgent } from "@/utils/notifyUrgency";
import { buildRemindAckPayload, parseRemind } from "@/utils/reminders";
import { countsTowardUnread } from "@/utils/messageKinds";
import { todoCardConcernsMe, todoMentionsMe, todoTerminalForCreator } from "@/utils/todos";
import { t } from "@/i18n";
import {
  createChannel,
  Importance,
  removeChannel,
  sendNotification,
  Visibility,
} from "@tauri-apps/plugin-notification";
import type { MessageRecord } from "@/types";
import type { ChatContext } from "./runtime";

export function createNotificationsModule(ctx: ChatContext) {
  const { app, activeConv, totalUnread, groups, myDeviceId, nicknameOf } = ctx.state;
  const { send, openConversation, locateMessageInConv } = ctx.api;

  let notifSeq = 1;
  // ⚠️ 只加不删（审计阶段 4 · 4.2 顺带发现）：删除点只有"通知被点击"和"动作按钮命中"两处，
  // 用户直接把通知划掉时条目永久留着，而 `notifSeq` 单调递增 ⇒ 每条通知必进一份。
  // 比 pendingAcks 更确定性地增长，所以同样上闸；上限 128 远大于一屏可见的通知数。
  const notifMap = new Map<number, string>();
  const NOTIF_MAP_MAX = 128;

  // ---------------- 通知：抑制 + 短窗口合并 ----------------
  // 抑制矩阵：前台且正查看该会话 → 不通知；其他会话 / 后台 → 进入合并队列。
  // 合并：首条消息开 1.5s 窗口，窗口内同会话只累积；窗口结束按会话各发一条
  // （count > 1 显示「…等 N 条新消息」）。窗口结束前用户已切到该会话 → 跳过。
  const NOTIFY_DEBOUNCE_MS = 1500;
  const notifyQueue = new Map<string, QueuedNotice>();
  let notifyTimer: number | null = null;

  function queueNotification(rec: MessageRecord) {
    const q = notifyQueue.get(rec.conv_id);
    if (q) {
      q.count += 1;
      q.last = rec;
    } else {
      notifyQueue.set(rec.conv_id, { count: 1, last: rec });
    }
    if (notifyTimer !== null) return;
    notifyTimer = window.setTimeout(() => {
      notifyTimer = null;
      flushNotifications();
    }, NOTIFY_DEBOUNCE_MS);
  }

  function flushNotifications() {
    const entries = [...notifyQueue.values()];
    notifyQueue.clear();
    // 用户关了通知 → 一条都不发；权限在这条之后才去查（关着就不该弹权限）
    if (!app.notifyEnabled || entries.length === 0) return;
    void app.ensureNotifyPermission().then((granted) => {
      if (!granted) return;
      // 只要这一批里真的弹出了通知，就顺手提请注意（Windows 闪任务栏 / macOS 弹跳 Dock）。
      // 放在这里而不是 maybeNotify：闪烁必须与**实际发出的通知**同进同出 —— 通知被去抖
      // 合并、被"正在看该会话"跳过时，用户不该被闪。循环后统一触发一次，
      // 同一批多个会话也只闪一次（逐条调用是同一次视觉事件的重复请求）。
      let anyReminded = false;
      for (const { count, last } of entries) {
        // 窗口期间用户已切到该会话且**可见**前台 → 该会话跳过通知
        if (!document.hidden && document.hasFocus() && activeConv.value === last.conv_id) continue;
        // 群消息标题 = 「群名 · 发送者昵称」（审计 2026-11-03 第 2 项；唯一口径在 utils/notifyTitle）。
        const title = notifyTitle(
          last.conv_id,
          nicknameOf(last.sender_id),
          last.conv_id.startsWith("group:")
            ? (groups.value.find((g) => g.id === last.conv_id.slice("group:".length))?.name ?? null)
            : null,
        );
        const body = notifyBody(count, last);
        const convId = last.conv_id;
        anyReminded = true;
        if (app.isMobile) {
          // 移动端：plugin 通知（Android 有 actionPerformed 点击事件桥）。
          // 注意 `sendNotification` 是 fire-and-forget（返回 void，不是 Promise）⇒ 这里
          // 没有可 catch 的失败信号，清单 4.2 说的"无 catch 丢批"其实不成立；真正会 reject
          // 的是上面那次权限查询，它的 catch 在本函数末尾。
          const id = notifSeq++;
          notifMap.set(id, convId);
          trimOldest(notifMap, NOTIF_MAP_MAX);
          void sendNotification({
            id,
            title,
            body,
            autoCancel: true,
            // 「标记已读」动作按钮：见 init 里 registerActionTypes；桌面端 Web Notification 不支持按钮
            actionTypeId: "chat",
            extra: { type: "chat", conv_id: convId },
          });
        } else {
          // 桌面端：统一走 notify_desktop 命令（Rust → notify-rust）。
          //
          // 为什么不再用 WebView 原生 Notification：Tauri 的 notification 插件会把
          // window.Notification 换成“转发到 plugin:notification|notify”的实现，所以
          // 这里的 onclick 永远不会触发（点击无法定位会话）；而且那条链路把真正的
          // toast 错误 spawn 掉丢了 —— Windows 上“收不到通知”完全没有线索。
          // 现在由后端发送：失败会返回并记日志，设置页还能“发送测试通知”自检。
          // `convId` 是**点击定位**的依据：点击发生在后端，前端补不了这个信息。
          void api.notifyDesktop(title, body, convId).catch(() => {
            /* 通知失败不影响聊天本身；后端已记日志 */
          });
        }
      }
      if (anyReminded && !app.isMobile) {
        // 紧急程度按**这批真正发出去的通知**判（`entries` 就是去抖合并后的那批，
        // 每个会话取其最后一条），不是按整个未读列表 —— 否则一条三天前的紧急任务
        // 会让每次新消息都弹跳 Dock。
        const urgent = batchIsUrgent(entries.map((e) => e.last));
        requestAttentionOnce(urgent);
      }
    }).catch((e) => {
      // ⚠️ 本批修的正是这里：`flushNotifications` **先 `clear()` 再 await 权限**，
      // 而这条链原先没有 catch ⇒ `isPermissionGranted()` / `requestPermission()` 任一 IPC
      // reject，这批通知就彻底消失（用户少收一条，毫无线索，还附赠一条 unhandled rejection）。
      // 放回队列是安全的：失败点在**任何一条通知发出之前**，不会重复提醒。
      console.warn("[notify] 权限查询失败，这批通知退回队列", e);
      mergeNoticesInto(notifyQueue, entries);
    });
  }

  /**
   * 提请注意（Windows 闪任务栏 / macOS 弹跳 Dock）的**唯一字面调用点** ——
   * 守卫钉"只此一处"：打断必须与"通知确实已发出"同进同出。普通消息批在
   * `flushNotifications`（去抖合并后）调；强提醒在 `handleIncomingRemind`
   * （通知命令返回 sent=true 后）调。两处都不许直接写 api.requestAttention。
   */
  function requestAttentionOnce(urgent: boolean) {
    if (app.isMobile) return; // 移动端没有任务栏/Dock 可闪（命令本身也是空实现）
    void api.requestAttention(urgent).catch(() => {
      /* 个别 Linux 桌面环境不支持闪烁，忽略即可（通知本身已经发出） */
    });
  }

  // ---------------- 未读外显（托盘红点 / 任务栏角标 / Dock 数字） ----------------
  // 为什么不跟通知一起做：通知回答"刚来了一条新消息"，角标回答"还有多少条没读"。
  // 标记已读、切会话、删会话都会改未读数，却不该弹任何通知 —— 所以这条链路跟着
  // `totalUnread` 走，而不跟着消息走。
  //
  // 去抖 300ms：消息洪水、或"一键已读"会让 totalUnread 连续跳好几次，而 Windows 上换
  // 托盘图标是**肉眼可见的一下**（图标被重建）；只推最后一次就够了。
  const BADGE_DEBOUNCE_MS = 300;
  let badgeTimer: number | null = null;
  let lastBadgeCount = -1;

  function pushUnreadBadge() {
    if (app.isMobile) return; // 移动端没有托盘可改（命令本身也是空实现，省一次 IPC）
    const n = totalUnread.value;
    if (n === lastBadgeCount) return; // 值没变就不去动系统图标
    lastBadgeCount = n;
    void api.setUnreadBadge(n).catch(() => {
      /* 角标失败不影响聊天（个别 Linux 桌面环境不支持） */
    });
  }

  watch(totalUnread, () => {
    if (badgeTimer !== null) window.clearTimeout(badgeTimer);
    badgeTimer = window.setTimeout(() => {
      badgeTimer = null;
      pushUnreadBadge();
    }, BADGE_DEBOUNCE_MS);
  });

  /**
   * 通知正文：按「显示消息内容」隐私开关决定是否带正文。
   * 关掉时只提示"收到新消息"（锁屏 / 通知中心不泄内容），标题仍保留发送者昵称。
   * 拼装逻辑在 utils/notifications.ts（纯函数、有单测），这里只喂入实时数据。
   */
  function notifyBody(count: number, last: MessageRecord): string {
    let preview = previewText(last);
    const terminal = todoTerminalForCreator(last, myDeviceId.value);
    if (terminal !== null) {
      // 我创建的任务进入终态：通知里明确说「已完成 / 标记为做不了」，而不是笼统的「[任务] 标题」。
      preview = terminal.status === "impossible"
        ? (terminal.title
          ? t("todo.impossibleNotice", { title: terminal.title })
          : t("todo.impossibleNoticeNoTitle"))
        : (terminal.title
          ? t("todo.completedNotice", { title: terminal.title })
          : t("todo.completedNoticeNoTitle"));
    } else if ((last.kind === "todo" || last.kind === "todo_update") && todoMentionsMe(last, myDeviceId.value)) {
      // 任务 @ 我：预览前缀「@你」，让锁屏/通知中心一眼看出是点名我
      // （与「有人@我」徽标同口径：被指派人 = 被 @）。
      preview = `${t("todo.mentionYou")} ${preview}`;
    }
    return notificationBody(
      {
        showContent: app.notifyShowContent,
        count,
        sender: nicknameOf(last.sender_id),
        preview,
      },
      t,
    );
  }

  /** 已提示过的「任务完成」msg_id：同一事件经多条投递路径反复 emit 时不重复提示创建人。 */
  const notifiedTodoDone = new Set<string>();
  const NOTIFIED_TODO_DONE_MAX = 500;

  function maybeNotify(rec: MessageRecord) {
    const myId = app.device?.device_id;
    if (!myId || rec.sender_id === myId) return;

    // 群任务**建卡**只打扰相关人（创建人 + 被指派人，用户 2026-11-02 拍板）。
    // 判据本体在 `utils/todos::todoCardConcernsMe`（纯函数，边界由 todos.test.ts 逐条钉）；
    // 这里只拦通知，**不动**未读与时间线 —— 卡片照旧进列表、照旧计未读，
    // 别人建的、没派给我的活不该弹一条系统通知把我从别的事里拽出来。
    if (!todoCardConcernsMe(rec, myId)) return;

    // 任务进入终态（完成 / 做不了）→ 给**创建人**提示。`todo_update` 本是静默事件
    //（不打扰全群），但"我派的活有了结论"对创建人是个该知道的变化，单独放行；
    // 其余静默事件照旧不弹。按 msg_id 去重：同一事件经多条投递路径反复 emit 时不重复提示。
    const terminal = todoTerminalForCreator(rec, myId);
    if (terminal !== null && !notifiedTodoDone.has(rec.msg_id)) {
      notifiedTodoDone.add(rec.msg_id);
      trimOldest(notifiedTodoDone, NOTIFIED_TODO_DONE_MAX);
      const terminalText = terminal.status === "impossible"
        ? (terminal.title
          ? t("todo.impossibleNotice", { title: terminal.title })
          : t("todo.impossibleNoticeNoTitle"))
        : (terminal.title
          ? t("todo.completedNotice", { title: terminal.title })
          : t("todo.completedNoticeNoTitle"));
      // 正看着该会话：系统通知会被抑制，改用应用内 toast —— 否则创建人"什么都看不到"。
      if (!document.hidden && document.hasFocus() && activeConv.value === rec.conv_id) {
        app.toast(terminalText, "info");
        return;
      }
      if (!app.notifyEnabled) return;
      queueNotification(rec);
      return;
    }

    // 「不打扰」一族（表情回应/撤回 = 静默事件，`system` = 经广播来的成员变更与下载请求）
    // 一律不弹通知：它们不是"内容"。判据与后端 `is_non_notifying_kind` 同一份
    // （`utils/messageKinds::countsTowardUnread`），与未读记账那处（`utils/messages.ts`）也同一份。
    // 系统消息漏这一条的真实后果："X 加入了群聊"给群里每个人推一条系统通知，
    // 而后端明写它不打扰（`protocol.rs::is_non_notifying_kind` 就是这个理由）。
    if (!app.notifyEnabled) return;
    if (!countsTowardUnread(rec.kind)) return;
    // 应用在前台且正查看该会话 → 不通知（不进队列）。
    // 必须同时判 !document.hidden：窗口被隐藏/最小化到托盘时，WebView 的
    // document.hasFocus() 仍可能是 true，只看它会漏掉真正该提醒的消息。
    if (!document.hidden && document.hasFocus() && activeConv.value === rec.conv_id) return;
    queueNotification(rec);
  }

  // ---------------- 强提醒：接收处理（与普通消息通知分开） ----------------
  // 已在本机处理过的 remind msg_id：多投递路径 / 重复帧只生效一次（不再回执、不再响）。
  const remindedIds = new Set<string>();
  const REMINDED_IDS_MAX = 512;
  /** 独立抖动的去重集合（与强提醒分开：抖动不产生任何回执/折叠状态）。 */
  const nudgedIds = new Set<string>();
  /**
   * 会话内临时抖动提示（不落库、不导出、不进虚拟列表）：
   * `from` = 发起方 device_id；发送方自己也会收到一条「已向对方发送」。
   */
  const nudgeNotice = ref<{ convId: string; from: string; at: number } | null>(null);
  let nudgeNoticeTimer: number | null = null;
  function showNudgeNotice(convId: string, from: string) {
    nudgeNotice.value = { convId, from, at: Date.now() };
    if (nudgeNoticeTimer !== null) window.clearTimeout(nudgeNoticeTimer);
    nudgeNoticeTimer = window.setTimeout(() => {
      nudgeNotice.value = null;
      nudgeNoticeTimer = null;
    }, 5000);
  }

  /**
   * Android 强提醒通知通道：High 重要级 = 横幅弹出 + 锁屏可见，声音/振动跟随通道设置。
   * 插件约定「通道不存在时带 channelId 的通知不会发出」⇒ init 必须先建；
   * 声音/振动开关变化时 remove+create 重建（Android 不允许直接改已建通道的声/振）。
   * 用户在系统设置里对通道的手动修改不被覆盖（只有我们自己的开关变化才重建）。
   */
  const REMIND_CHANNEL_ID = "gosslan_remind";
  let remindChannelReady = false;
  async function ensureRemindChannel(recreate: boolean) {
    if (!app.isMobile) return;
    try {
      if (recreate) await removeChannel(REMIND_CHANNEL_ID).catch(() => {});
      await createChannel({
        id: REMIND_CHANNEL_ID,
        name: t("msg.remind"),
        description: t("remind.channelDesc"),
        importance: Importance.High,
        visibility: Visibility.Public,
        lights: true,
        vibration: app.remindVibrate,
        // 声音不传：tauri-plugin-notification 2.x 只支持「自定义 raw 资源」，
        // 不支持 setSound(null) 静音 —— 空串等于跳过 setSound，通道仍是系统默认声。
        // Android 的通道声音只能由用户在系统通道设置里关（文案已如实说明）。
      });
      remindChannelReady = true;
    } catch {
      // 建不上就不带 channelId 发（走系统默认通道），不能让通知整条丢掉。
      remindChannelReady = false;
    }
  }

  // ---------------- 强提醒的窗口抖动（收到时的视觉表达） ----------------
  /**
   * 抖动信号（自增计数）：触发聊天窗口抖动动画的**唯一入口**。
   * 用计数而非布尔 —— 连续收到强提醒时只有值变化才能让 `watch` 每次都重放动画。
   */
  const shakeSignal = ref(0);
  /** 抖动节流（ms）：防连发强提醒把窗口抖个不停。 */
  const SHAKE_ANIM_MIN_INTERVAL_MS = 1200;
  let lastShakeAt = 0;
  /**
   * 抢占这一次抖动额度。**移动端的 CSS 抖与桌面搬 OS 窗口的抖共用同一份预算** ——
   * 所以判据只有一处（`shouldRunThrottled`，间隔规则与边界都在那个家里），
   * 两条分支各写一遍时间差比较是这一族的旧写法：常量虽然同源，比较方向与
   * 「什么时候把 last 推到 now」却各自定义，改一处就悄悄分成两种预算。
   */
  function claimShakeSlot(): boolean {
    const now = Date.now();
    if (!shouldRunThrottled(now, lastShakeAt, SHAKE_ANIM_MIN_INTERVAL_MS)) return false;
    lastShakeAt = now;
    return true;
  }
  function triggerRemindShake() {
    if (!claimShakeSlot()) return;
    shakeSignal.value += 1;
  }

  /**
   * 收到点名的强提醒（含工具栏「抖动」按钮）时：**把窗口直接拉到前台 + 切到该会话，再抖动**。
   *
   * 用户 2026-10-12：抖动可以不提醒，但窗口要直接给他打开 —— 所以先把窗口/会话带出来再抖，
   * 而不是只在"此刻正看着"时才抖（那样在两个窗口间点一下发送就必然不抖）。
   * 抽成独立函数还有一个原因：`handleIncomingRemind` 的体被 `remindFlow` 守卫按固定长度切片，
   * 调用点只留一行才不会把后面那段通知逻辑挤出切片（切片是守卫判"回执先于通知"的锚）。
   */
  function raiseAndShakeOnRemind(convId: string) {
    void api.focusWindow();
    if (activeConv.value !== convId) void openConversation(convId);
    // 抖动 = **整个 OS 窗口**抖动（Rust 移动窗口，仿 QQ）；移动端没有可移动的独立窗口
    // ⇒ 退回聊天区 CSS 动画（`shakeSignal` → ChatWindow 的 `gosslan-shake`）。
    if (app.isMobile) {
      triggerRemindShake();
      return;
    }
    // 桌面抖的是**整扇 OS 窗口**（Rust 连发 7 次 `set_position`，实测约 315ms），CSS 那条
    // 全局降级管不着它 —— 动效族里只有这一个出口是"JS 不调，系统开关就没人接"。
    // 系统开了「减弱动态效果」时不再搬窗口；提醒本身没丢：上面两行已经把窗口拉到前台、
    // 会话切过去，声音/通知/Dock·任务栏仍在原来的分支上。
    if (prefersReducedMotion()) return;
    if (!claimShakeSlot()) return;
    void api.shakeWindow().catch(() => {});
  }

  /**
   * 接收一条 kind=remind：
   * 1. 判「是不是发给我」：群聊看 actors 名单（受众是名单层语义），私聊恒为对端→我；
   * 2. 按 remind msg_id 去重（R8：同帧重复到达不能反复响 / 反复回执）；
   * 3. 立刻回 stage=alerted 自动回执 —— 只在「帧已确认归属本机」时发，
   *    不挂在本地通知 API 成功上（R1：通知调用成功 ≠ 对方收到 ≠ 用户确认）；
   * 4. 振动（支持的平台）+ 高优先级通知：绕过 1.5s 去抖合并（R2），
   *    但仍尊重总开关 / 权限 / 「前台正查看该会话」的抑制；
   * 5. 声音由后端的系统通知通道处理（系统静音 / 勿扰时由系统决定）。
   */
  /**
   * 接收独立窗口抖动：**不 ack、不建强提醒、不弹普通通知**。
   * 只做「按总开关聚焦/抖窗 + 一条会话内灰字」，60 秒以上的迟到帧直接丢。
   */
  function handleIncomingNudge(rec: MessageRecord) {
    const myId = app.device?.device_id;
    if (!myId || rec.sender_id === myId) return;
    if (isStaleNudge(rec.ts)) return;
    if (nudgedIds.has(rec.msg_id)) return;
    nudgedIds.add(rec.msg_id);
    trimOldest(nudgedIds, REMINDED_IDS_MAX); // Set 迭代保序 ⇒ FIFO
    if (app.notifyEnabled) raiseAndShakeOnRemind(rec.conv_id);
    showNudgeNotice(rec.conv_id, rec.sender_id);
  }

  function handleIncomingRemind(rec: MessageRecord) {
    const myId = app.device?.device_id;
    if (!myId || rec.sender_id === myId) return;
    const payload = parseRemind(rec);
    if (!payload) return;
    if (rec.conv_id.startsWith("group:")) {
      if (!payload.actors.includes(myId)) return;
      // actors 是发起时刻拍的名单；帧到达时本机可能已被移出群（密钥轮换后本解不开
      // 新帧，但轮换前加密的帧仍可能送达）⇒ 以**当前**成员表再校验一次（风险 R6）。
      const gid = rec.conv_id.slice(6);
      const stillMember = groups.value.some(
        (g) => g.id === gid && g.members.includes(myId),
      );
      if (!stillMember) return;
    }
    if (remindedIds.has(rec.msg_id)) return;
    remindedIds.add(rec.msg_id);
    trimOldest(remindedIds, REMINDED_IDS_MAX); // Set 迭代保序 ⇒ FIFO

    // S3 自动回执：此刻帧已通过签名/解密/归属校验（后端落库前已做），与本地通知是否弹出无关。
    void send(rec.conv_id, buildRemindAckPayload(rec.msg_id, "alerted"), "remind_ack").catch(
      () => {
        /* 回执发送失败不影响提醒本身；重连后 outbox 会补发同类帧 */
      },
    );

    // 收到点名的强提醒（含「抖动」按钮）：把窗口拉到前台 + 切到该会话，再抖动窗口。
    const viewing =
      !document.hidden && document.hasFocus() && activeConv.value === rec.conv_id;
    if (app.notifyEnabled) raiseAndShakeOnRemind(rec.conv_id);
    // 总开关关着：不响不振不弹（声音/振动是通知的子集，用户预期一致）。
    // `payload.shake`：工具栏「抖动」发起的帧**只抖不弹**系统通知
    //（用户 2026-10-15「抖动就可以了，不要接强提醒的弹窗通知」）—— 抖动本身已在上一行完成。
    if (!app.notifyEnabled || viewing || payload.shake) return;

    const title = `${t("remind.notifyTitle")} · ${nicknameOf(rec.sender_id)}`;
    const body = app.notifyShowContent
      ? t("remind.notifyBody")
      : t("remind.notifyBodyHidden");

    if (app.isMobile) {
      // Android 13+ 的 POST_NOTIFICATIONS 是运行时权限：被拒就不弹
      //（S3 回执不依赖权限，已在上面发出）。首次收到强提醒时这也是一次合理的申请时机。
      // 振动由通知**通道**承载（按 remindVibrate 建的 High 通道），不再额外调
      // navigator.vibrate —— 两者叠加会震两遍；通道没建成时退回系统默认通道。
      void app.ensureNotifyPermission().then((granted) => {
        if (!granted) return;
        const id = notifSeq++;
        notifMap.set(id, rec.conv_id);
        trimOldest(notifMap, NOTIF_MAP_MAX);
        void sendNotification({
          id,
          title,
          body,
          autoCancel: true,
          actionTypeId: "chat",
          // 通道就绪才挂 channelId（插件约定通道不存在时通知不发出）：
          // 高重要级通道给强提醒横幅 + 系统声/振动；没建上就退回系统默认通道。
          ...(remindChannelReady ? { channelId: REMIND_CHANNEL_ID } : {}),
          extra: { type: "chat", conv_id: rec.conv_id, msg_id: payload.target },
        });
      });
    } else {
      // 桌面：系统通知声音由后端按 remindSound 加；振动无可用 API
      //（WKWebView / WebView2 的 navigator.vibrate 恒为 undefined）；
      // 打断感由 requestAttention（Dock 弹跳 / 任务栏闪烁）承担。
      void api
        .notifyDesktop(title, body, rec.conv_id, {
          msgId: payload.target,
          sound: app.remindSound,
          actionLabel: t("notification.view"),
        })
        .then((sent) => {
          // 强提醒恒按紧急处理（Windows 闪任务栏 / macOS 弹跳 Dock）。
          // ⚠️ 这一路径不经过通知中心、不受勿扰开关影响 —— 设置页需如实说明。
          if (sent) requestAttentionOnce(true);
        })
        .catch(() => {
          /* 后端已记日志 */
        });
    }
  }

  async function handleNotificationClick(convId: string, msgId?: string) {
    await api.focusWindow();
    // 翻页排在加载之前（用户 2026-09-24 #29）：`focusWindow` 必须先行（窗口还在托盘里时
    // 切，用户会在浮出瞬间看到一次跳变），但 `openConversation` 不能等 —— 它内部是
    // 同步写下 `activeConv` + 骨架 + 两轮 IPC 拉消息，await 它等于让移动端
    // 「点通知」白等一次读库才翻页。
    if (app.isMobile) app.mobileView = "chat";
    await openConversation(convId);
    // 强提醒：打开会话后继续翻页定位到**被提醒的原消息**；失败提示而不是静默。
    if (msgId) {
      const r = await locateMessageInConv(convId, msgId);
      if (r === "not-found" || r === "error") {
        app.toast(t("remind.locateFail"), "info");
      }
    }
  }

  /**
   * 通知点击的**统一路由**：桌面端（后端 `notification-clicked` 事件）与移动端
   * （插件的 `actionPerformed`）共用一份 —— 两条路径的载荷同形（`type` / `conv_id` /
   * `msg_id`），各写一份就一定会漂移（"桌面点得动、手机点不动"这类只在某一个平台现形的缺陷）。
   */
  function routeNotificationClick(
    type: string | undefined,
    convId: string | undefined,
    msgId?: string,
  ) {
    if (type === "friend_request") {
      // 唤起窗口后再切视图：窗口还在托盘里时切，用户会在浮出瞬间看到一次跳变。
      void api.focusWindow().then(() => {
        emitAction(NAVIGATE_TO_CONTACTS);
      });
      return;
    }
    if (convId) void handleNotificationClick(convId, msgId);
  }

  /** 通知/角标/抖动提示的挂起定时器：换实例（HMR / 重新 init）时必须整批拆掉。 */
  function cancelNotificationTimers() {
    if (notifyTimer !== null) {
      window.clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    if (badgeTimer !== null) {
      window.clearTimeout(badgeTimer);
      badgeTimer = null;
    }
    if (nudgeNoticeTimer !== null) {
      window.clearTimeout(nudgeNoticeTimer);
      nudgeNoticeTimer = null;
    }
  }

  /** 通知点击/动作按钮命中后取出对应会话（取走即删，上限由 `NOTIF_MAP_MAX` 管）。 */
  function takeNotifConv(id: number): string | undefined {
    const convId = notifMap.get(id);
    notifMap.delete(id);
    return convId;
  }

  /** 清空数据/重置时把通知 id → 会话的映射一并清掉。 */
  function clearNotifMap() {
    notifMap.clear();
  }

  return {
    queueNotification,
    flushNotifications,
    requestAttentionOnce,
    pushUnreadBadge,
    notifyBody,
    maybeNotify,
    showNudgeNotice,
    ensureRemindChannel,
    claimShakeSlot,
    triggerRemindShake,
    raiseAndShakeOnRemind,
    handleIncomingNudge,
    handleIncomingRemind,
    handleNotificationClick,
    routeNotificationClick,
    shakeSignal,
    nudgeNotice,
    notifMap,
    takeNotifConv,
    clearNotifMap,
    cancelNotificationTimers,
  };
}
