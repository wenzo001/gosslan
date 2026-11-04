/**
 * 群任务：徽标计数、看板取数（全表读）、独立任务窗口读路径、任务定义变更、置顶。
 *
 * 职责边界：任务的**读**（`groupTodoRows` 由入口持有、这里只写）与**写**（发到后端并入账）；
 * 时间线渲染仍由 `messaging`/ChatWindow 承担。
 */
import { ref } from "vue";
import { api } from "@/api";
import { StaleGuard } from "@/utils/staleGuard";
import { createSingleFlight } from "@/utils/singleFlight";
import {
  foldTodos,
  isTodoRowsLoaded,
  openTodosForMe,
  putTodoRows,
  type TodoImage,
} from "@/utils/todos";
import { detailText } from "@/composables/useErrorText";
import { t } from "@/i18n";
import type { MessageRecord } from "@/types";
import type { ChatContext } from "./runtime";

export function createTodosModule(ctx: ChatContext) {
  const {
    app,
    refreshGuard,
    conversations,
    activeConv,
    groupTodoRows,
    myDeviceId,
  } = ctx.state;
  const {
    refreshGroups,
    refreshFriends,
    refreshPeers,
    refreshConversations,
    loadMessages,
    enqueueMessage,
  } = ctx.api;

  /** 每个群「与我相关且未完成未归档」的任务数 —— 蓝色徽标的唯一数据源（用户 2026-09-26）。
   *  两处 UI（会话列表条目、聊天头的任务图标）都从这里取，**不在界面里各数一遍**。 */
  const openTodoByConv = ref<Record<string, number>>({});
  /** 每个群「任务相关的消息行」（后端全表读）—— 看板 / 任务面板 / 成员面板的**唯一取数口**。
   *
   *  为什么必须有它，而不能再折 `chat.messages`：徽标早就走全表读，而三处界面折的是那份
   *  **有上界的消息缓存**（`PAGE_SIZE × MAX_PAGES = 1000 条/会话`、`MAX_CACHED_CONVS = 8` 个会话整块逐出）
   *  ⇒ 「徽标还亮着、看板里却再也列不出这条任务」是可达状态，用户没法归档一个看不见的任务。
   *  `refreshConversations` 的注释里那句「用内存里已有的消息算不行」当时只应用在徽标那一半，
   *  于是同一句判据两个家（#154-9）。两者现在来自**同一次读**。
   *  键存在 = 读到过（空数组 = 确实没有任务）；语义见 `utils/todos::putTodoRows`。 */
  /** 任务行读失败的原因（键存在 = 这一次首屏读失败且还没有成功过）。 */
  const groupTodoRowsErrors = ref<Record<string, string>>({});
  /** 同一会话的单飞表：三个界面同时要求补读时只打一次 IPC（通用形状走 utils/singleFlight）。 */
  const groupTodoRowsInflight = createSingleFlight<void>();
  /** 读成功（无论走哪条取数口）就清掉这几个会话的失败记录。 */
  function clearGroupTodoRowsErrors(convIds: string[]) {
    let changed = false;
    const next = { ...groupTodoRowsErrors.value };
    for (const cid of convIds) {
      if (!next[cid]) continue;
      delete next[cid];
      changed = true;
    }
    if (changed) groupTodoRowsErrors.value = next;
  }
  /** 单调序号：只有最后一次发起的结果能落地（任务连着变时会话刷新会挨个追上来）。 */
  let openTodoSeq = 0;
  async function refreshOpenTodos() {
    const myId = myDeviceId.value;
    // 身份还没就绪 ⇒ 什么都不做（既不清空也不点亮）：清成 0 会让徽标闪一下消失；
    // 拿空串去比对又会把 `creator: ""` 那类畸形载荷算成"与我相关"。
    if (!myId) return;
    const ids = conversations.value.filter((c) => c.kind === "group").map((c) => c.id);
    if (ids.length === 0) {
      openTodoByConv.value = {};
      return;
    }
    const mine = ++openTodoSeq;
    let rows;
    try {
      rows = await api.getGroupTodoMessages(ids);
    } catch (e) {
      // 读不到就**保留上一次徽标**（清成 0 等于断言"任务都完成了"），只登记原因 + 提示一次。
      if (mine === openTodoSeq) {
        void app.toastError(e, t("task.badgeLoadFailed"));
      }
      return;
    }
    if (mine !== openTodoSeq) return;
    // 同一次读同时喂徽标与那三处界面（见 groupTodoRows 的注释）
    groupTodoRows.value = putTodoRows(groupTodoRows.value, ids, rows);
    clearGroupTodoRowsErrors(ids);
    const byConv = new Map<string, MessageRecord[]>();
    for (const r of rows) {
      const list = byConv.get(r.conv_id) ?? [];
      list.push(r);
      byConv.set(r.conv_id, list);
    }
    const next: Record<string, number> = {};
    // 折叠只有一份：`foldTodos` 出当前定义，`openTodosForMe` 出"还活着且与我相关"。
    for (const [cid, list] of byConv) {
      const n = openTodosForMe(foldTodos(list), myId).length;
      if (n > 0) next[cid] = n;
    }
    openTodoByConv.value = next;
  }

  /** 按需补读某个群的任务行：冷启动只开任务窗、或身份未就绪时 bulk 读没跑成的情况。
   *  已读到过就直接返回 ⇒ 不会每次打开面板都打一次 IPC（"读过没有"就看键在不在）。
   *
   *  三条入口（看板 / 任务弹窗 / 成员面板）会同时要求补读 ⇒ 同一会话**单飞**：
   *  否则每次打开都会打两三份 IPC，而 StaleGuard 只留最后一份，另外几份纯属白读。
   *  失败写进 `groupTodoRowsErrors` 而不向调用方抛：调用点全是 `void`，上一次
   *  未捕获的 rejection 在 Tauri 里只会安静地进控制台，界面继续理直气壮地显示
   *  「暂无任务」—— 与"假空态"是同一个缺陷。 */
  async function ensureGroupTodoRows(convId: string): Promise<void> {
    if (!convId || isTodoRowsLoaded(groupTodoRows.value, convId)) return;
    return groupTodoRowsInflight.run(convId, async () => {
      const tok = refreshGuard.begin(`todoRows:${convId}`);
      try {
        const rows = await api.getGroupTodoMessages([convId]);
        if (!refreshGuard.isCurrent(`todoRows:${convId}`, tok)) return;
        groupTodoRows.value = putTodoRows(groupTodoRows.value, [convId], rows);
        clearGroupTodoRowsErrors([convId]);
      } catch (e) {
        if (!refreshGuard.isCurrent(`todoRows:${convId}`, tok)) return;
        groupTodoRowsErrors.value = {
          ...groupTodoRowsErrors.value,
          [convId]: detailText(e, { log: true }),
        };
      }
    });
  }

  /**
   * 实时事件后的**单群**重读（独立任务窗专用）。
   *
   * 看板折的是 `groupTodoRows`（全表读，见上），不是有上界的 `messages` —— 早期
   * 独立窗口的实时订阅只重载 `loadMessages`，而看板早就不折那份缓存（提交 51dac87
   * 改了取数口、漏改订阅），表现就是「别人增/改/完成/归档任务，窗口里一动不动，
   * 切走再切回才更新」。这里以 DB 为真相**整表替换这一个群**：去重、防幽灵、
   * 防旧快照回滚全部由 DB 快照与 StaleGuard 承担，不做"按事件增量拼"（事件可能
   * 重复 / 乱序 / 重连后补发，拼错就是第二个真相源）。
   * 与 `ensureGroupTodoRows` 共用同一个 StaleGuard 键 ⇒ 首屏读与事件读互相作废，
   * 只有最后一次发起的结果能落地。读失败保留旧列表（与窗口焦点兜底同口径）。
   */
  async function reloadGroupTodoRows(groupId: string) {
    const convId = `group:${groupId}`;
    const tok = refreshGuard.begin(`todoRows:${convId}`);
    let rows: MessageRecord[];
    try {
      rows = await api.getGroupTodoMessages([convId]);
    } catch (e) {
      // 读失败保留旧列表（下次事件或窗口重新聚焦时再试）；悬空序号由下一次 begin 自行作废。
      // 但"从来没读到过"时不能只留一个空列表：那会被看板当成「暂无任务」，
      // 所以沿用首屏那条错误记录，界面至少给得出错误 + 重试。
      if (!isTodoRowsLoaded(groupTodoRows.value, convId)) {
        groupTodoRowsErrors.value = {
          ...groupTodoRowsErrors.value,
          [convId]: detailText(e, { log: true }),
        };
      }
      return;
    }
    if (!refreshGuard.isCurrent(`todoRows:${convId}`, tok)) return;
    groupTodoRows.value = putTodoRows(groupTodoRows.value, [convId], rows);
    clearGroupTodoRowsErrors([convId]);
  }
  // ---------------- 独立「群任务」窗口用的读路径 ----------------
  // ⚠️ 这两个函数是给**独立窗口**（`todos.html`）用的：那个窗口有自己的 store 实例，
  // 只服务一个群。绝不能在那里调 `init()`（会注册第二套事件监听 → 重复通知/未读/回执）
  // 或 `openConversation()`（会发群已读回执、写与主窗口共享的 localStorage）。

  /**
   * 「这个群的任务首屏取完了没有」—— 看板该转圈还是该显示内容的唯一依据。
   *
   * 为什么必须有（用户 2026-09-24：「点查看任务，弹窗弹出很慢，还以为没点上」）：群任务窗口
   * 原先把 `loadGroupTodos` 排在**挂载之前**，那段时间整扇窗是一块骨架灰屏（看不出在加载什么），
   * 而连点又被启动器的单飞/防抖吃掉 ⇒ 表现就是"点了没反应，过一会才蹦出来"。
   * 改成先挂载、数据后台取之后，没有这个标记的话首帧会理直气壮地显示「暂无任务」——
   * 那不是快了一点，那是**假空态**，比慢更糟。
   *
   * ⚠️ 语义是"这一次取数**结束了**"（成功或失败），不是"成功过"：失败也置位，否则
   * 一次 DB 出错就把窗口永久留在转圈上，而那是一个连点都救不回来的状态。
   * 失败由调用方 toast 出来（`src/entries/todos.ts`），本标记只负责"别一直转"。
   */
  const groupTodosSettled = ref<Record<string, true>>({});

  /** 该群的任务首屏是否已取完（未开始与进行中都返回 false ⇒ 看板显示加载态）。 */
  function todosLoadedOnce(groupId: string): boolean {
    return groupTodosSettled.value[groupId] === true;
  }

  /**
   * 群任务窗口的读路径：加载**一个群**的消息 + 解析成员名要用的数据。
   *
   * ⚠️ 不变量：调用方（群任务窗口）的 store 实例**只服务这一个会话**，所以这里
   * 把 `activeConv` 设成它（`loadMessages` 有 `activeConv === convId` 守卫）。
   */
  async function loadGroupTodos(groupId: string): Promise<void> {
    const convId = `group:${groupId}`;
    try {
      // 成员名/群名/头像来自 groups + friends + peers；conversations 让窗口内的
      // `enqueueMessage`（创建/更新任务后本地合并）不必再补一次拉取。
      await Promise.all([refreshGroups(), refreshFriends(), refreshPeers(), refreshConversations()]);
      activeConv.value = convId;
      await loadMessages(convId);
    } finally {
      groupTodosSettled.value[groupId] = true;
    }
  }

  let groupTodosUnlisten: (() => void) | null = null;
  let groupTodosTimer: number | null = null;
  /**
   * 切群竞态的唯一裁决者：`api.onMessageReceived` 是异步的，两次快速切群时
   * **先返回的那次会覆盖后返回的那次**，把新群的监听顶掉（每条消息多一次 reload，
   * 且旧群的监听永远留在总线上）。`StaleGuard` 同时挡住"切到别的群"与"同一个群连订两次"。
   */
  const groupTodosWatchGuard = new StaleGuard();

  /**
   * 只订阅**本会话**的 `message-received`，让窗口里的任务随远端改动实时刷新
   * （突发消息合并到 150ms 一次重拉）。返回取消函数。
   *
   * ⚠️ 去抖后重读的必须是 **`groupTodoRows`（全表读）**：看板折的是那一份，
   * 不是有上界的消息缓存。这里曾重载 `loadMessages`（写 `messages`），看板却
   * 在 51dac87 改成折 `groupTodoRows` ⇒ 别人改任务时订阅收到了事件、也发了 IPC，
   * 看板却一动不动（只有焦点兜底的全量重读碰巧把它刷新）。现在每条事件都以 DB
   * 为真相重拉这一个群的任务行，重复/乱序/补发事件都不会产生重复或回滚。
   */
  async function watchGroupTodos(groupId: string): Promise<() => void> {
    const convId = `group:${groupId}`;
    const token = groupTodosWatchGuard.begin("groupTodos");
    groupTodosUnlisten?.();
    groupTodosUnlisten = null;
    if (groupTodosTimer !== null) {
      window.clearTimeout(groupTodosTimer);
      groupTodosTimer = null;
    }
    const unlisten = await api.onMessageReceived((rec) => {
      if (rec.conv_id !== convId) return;
      // 订阅已过期（切群了）就不再为旧群排重读；监听本身会在下面立刻摘掉。
      if (!groupTodosWatchGuard.isCurrent("groupTodos", token)) return;
      if (groupTodosTimer !== null) window.clearTimeout(groupTodosTimer);
      groupTodosTimer = window.setTimeout(() => {
        groupTodosTimer = null;
        void reloadGroupTodoRows(groupId);
      }, 150);
    });
    if (!groupTodosWatchGuard.isCurrent("groupTodos", token)) {
      // 更晚的一次切换已经开始 ⇒ 本次结果整个丢弃，并立刻摘掉监听。
      // 不摘的话它会一直留在事件总线上，而且清理函数也再没人持有。
      unlisten();
      return () => {};
    }
    groupTodosUnlisten = unlisten;
    return () => {
      // 已被更晚的一次订阅取代时，共享的 timer 属于新群 —— 旧清理不许碰它。
      if (groupTodosWatchGuard.isCurrent("groupTodos", token)) {
        if (groupTodosTimer !== null) {
          window.clearTimeout(groupTodosTimer);
          groupTodosTimer = null;
        }
        groupTodosUnlisten = null;
      }
      unlisten();
    };
  }
  // ---------------- 群任务（Card kind：**时间线上也渲染**，同时折进任务面板） ----------------
  // ⚠️ 这行注释此前写的是"不在时间线上渲染"，与 `utils/messageKinds.ts` 的
  // `CARD_KINDS` / `isRenderedInTimeline("todo") === true` 相反 —— 就是这句假话让
  // "自己发的任务在主聊天窗看不见"被当成设计如此（2026-09-26 用户实测报出）。
  // 为什么都要 `enqueueMessage(rec)`：面板里的列表是 `foldTodos(该会话的消息)` 折出来的，
  // 事件不进 store 就折不出来 —— 界面要等下次重新拉全量（= 重进会话）才刷新
  // （与置顶/公告同一条理由）。⚠️ 但那只覆盖"发起方与接收方在同一个窗口"的情况：
  // 任务看板跑在独立窗口、另有一份 store，所以本端回送必须由后端 emit（见
  // `commands/window.rs::send_group_payload` 的自 emit 与 lib.rs 的同名形状守卫）。

  /** 新建一条群任务（任意成员）。description / images / 类型可选。返回新建的消息记录（含 todo_id）。 */
  async function createTodo(
    groupId: string,
    title: string,
    assignees: string[],
    description?: string,
    images?: TodoImage[],
    category?: string,
    customCategory?: string,
    customIcon?: string,
    relatedOn?: string,
  ): Promise<MessageRecord> {
    const rec = await api.sendGroupTodo(
      groupId,
      title,
      assignees,
      description,
      images,
      category,
      customCategory,
      customIcon,
      relatedOn,
    );
    enqueueMessage(rec);
    return rec;
  }

  /**
   * 更新一条群任务：改状态 / 改标题与指派人 / 删除。
   *
   * 前端把**整份定义**发过去（标题、指派人、状态一起）：定义层是"同 `todo_id` 取最新一份"
   * 的 LWW 寄存器，只发改动字段会让没带的字段被清空。`patch` 缺省沿用传进来的 `item`
   * （调用方从折出来的 `TodoItem` 里取值，本身就是最新的）。
   */
  async function updateTodo(
    groupId: string,
    item: {
      todoId: string;
      title: string;
      assignees: string[];
      status: string;
      description?: string;
      images?: TodoImage[];
      relatedOn?: string | null;
    },
    patch: Partial<{
      title: string;
      assignees: string[];
      status: string;
      deleted: boolean;
      description: string;
      images: TodoImage[];
      /** 显式归档：`true` = 手动归档（进入终态之后）。不传 = 保留库中原值。 */
      archived: boolean;
      /** 优先级（三档）。不传 = 保留库中原值 ⇒ 改状态/改描述都不会顺手把档位重置。 */
      priority: string;
      /** 类型（任务/需求/缺陷/自定义）。同 priority 那一格：不传就保留库里的。 */
      category: string;
      /** 自定义类型名（仅 category="custom" 有效）。不传 = 保留库里的名字。 */
      customCategory: string;
      /** 自定义类型的图标键（仅 custom 有效）。不传 = 保留库里挑过的那枚。 */
      customIcon: string;
      /**
       * 关联时间（`YYYY-MM-DD`，只到年月日）。三种取值：
       * 不传 = 保留库里原值；`""` = 明确清空；`YYYY-MM-DD` = 覆盖。
       */
      relatedOn: string;
    }> = {},
  ) {
    const rec = await api.updateGroupTodo(groupId, item.todoId, {
      title: patch.title ?? item.title,
      assignees: patch.assignees ?? item.assignees,
      status: patch.status ?? item.status,
      deleted: patch.deleted ?? false,
      description: patch.description ?? item.description,
      images: patch.images ?? item.images,
      archived: patch.archived,
      priority: patch.priority,
      // category 曾被**漏在这一行之外**：patch 类型里声明了它、api 也收它、后端也存它，
      // 但这里没转发 ⇒ 选完类型弹「已更新」而库里一字未动，类型检查与全量层都拦不住。
      // 键集合的对账由 src/utils/storeContract.test.ts 那条判据负责，别再靠人眼数。
      category: patch.category,
      customCategory: patch.customCategory,
      // 与上面那条注释同一个坑的另一格：`custom_icon` 声明了却没转发 ⇒
      // 选完图标弹「已更新」而库里一字未动。键集合由 storeContract 那条判据对账。
      customIcon: patch.customIcon,
      // 关联时间：不传 patch 就沿用 item 里的当前值；显式 `""` 才是"清空"。
      // 别用 `??` —— 它会把空串当成"没传"，用户就永远删不掉日期。
      relatedOn: patch.relatedOn !== undefined ? patch.relatedOn : (item.relatedOn ?? undefined),
    });
    enqueueMessage(rec);
  }

  /** 置顶/取消置顶一条群消息（任意成员；静默事件，由置顶条体现）。 */
  async function pinMessage(groupId: string, msgId: string, pinned: boolean) {
    // ⚠️ **必须 enqueue 进 store**：置顶在界面上的呈现（顶部的置顶条）
    // 是 `foldPinned(该会话的全部消息)` 折叠出来的 —— 事件不进 store，
    // 折叠就看不到它，界面要等下次重新拉全量（= 重进会话）才刷新。
    const rec = await api.pinGroupMessage(groupId, msgId, pinned);
    enqueueMessage(rec);
  }

  return {
    openTodoByConv,
    groupTodoRowsErrors,
    clearGroupTodoRowsErrors,
    refreshOpenTodos,
    ensureGroupTodoRows,
    reloadGroupTodoRows,
    groupTodosSettled,
    todosLoadedOnce,
    loadGroupTodos,
    watchGroupTodos,
    createTodo,
    updateTodo,
    pinMessage,
  };
}
