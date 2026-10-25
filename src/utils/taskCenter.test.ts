/**
 * 统一任务中心的读模型判据（纯函数层）。
 *
 * 这些用例守的是负责人 2026-10-23 那几句话的**形状**：
 *   · "只要没有发送到百分之百…都可以取消；100% 但未终态仍可取消" → 见 `sent` 与 1.0 那两条；
 *   · "已经完成的在这个列表里应该是不展示" → 见终态那一条；
 *   · "所有的状态可以归类为 排队/发送中/完成/已取消…让用户一眼看懂卡在哪个交互节点"
 *     → 见状态归一与排序那两条；
 *   · 截图里那两行 `61d8d9df4a00a8…` 当标题 → 见 cid 命名那一条。
 *
 * 家为什么在这里：`taskCenter.ts` 零 Vue 依赖（只 import 类型），所以跑得动 `node --test`
 * 的行为真值表；组件那一层（拖角、焦点、触摸目标）归 CDP 探针与人工，不在这里假称验过。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countOperations,
  deriveOperations,
  FALLBACK_TITLE_KEYS,
  isLiveTransferStatus,
  operationStatusText,
  sortOperations,
  type ContentTransfer,
  type PendingMessageOpView,
  type TransferInfo,
} from "./taskCenter.ts";

// `TransferInfo` / `ContentTransfer` 的类型来自 @/types（别名解析在 node 下不可用），
// 这里只按形状造夹具：字段名与那两个 interface 一一对得上，写错就编译不过。
function transfer(over: Partial<TransferInfo>): TransferInfo {
  return {
    id: "t1",
    peer_id: "p1",
    name: "a.bin",
    size: 100,
    direction: "send",
    status: "active",
    path: null,
    progress: 0.3,
    blocked_reason: null,
    created_at: 1000,
    ...over,
  };
}

function content(over: Partial<ContentTransfer>): ContentTransfer {
  return {
    cid: "c".repeat(64),
    peerId: "p1",
    groupId: null,
    name: "photo.jpg",
    size: 100,
    direction: "receive",
    status: "active",
    received: 40,
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    path: null,
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function msgOp(over: Partial<PendingMessageOpView>): PendingMessageOpView {
  return {
    msg_id: "m1",
    kind: "text",
    peer_id: "p1",
    group_id: null,
    waiting_for: 1,
    created_at: 1000,
    preview: "在吗",
    peer_offline: false,
    can_cancel: true,
    some_delivered: false,
    ...over,
  };
}

const byId = (rows: { id: string }[], id: string) => rows.find((r) => r.id === id);

test("终态一律不列：done / failed / cancelled 都不进任务中心", () => {
  const rows = deriveOperations({
    transfers: [
      transfer({ id: "done", status: "done", progress: 1 }),
      transfer({ id: "failed", status: "failed" }),
      transfer({ id: "cancelled", status: "cancelled" }),
      transfer({ id: "sent", status: "sent", progress: 1 }),
      transfer({ id: "active", status: "active" }),
      transfer({ id: "pending", status: "pending", progress: 0 }),
    ],
    contentTransfers: [],
  });
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(
    ids,
    ["active", "pending", "sent"],
    "只有未完成的三态在列；`sent`（已写出、等对方确认）没到终态，所以它必须在列、且可取消",
  );
});

test("100% 但没到终态的行照样可取消，并且不说「发送中 100%」", () => {
  const rows = deriveOperations({
    transfers: [transfer({ id: "sent1", status: "sent", progress: 1 })],
    contentTransfers: [],
  });
  const r = byId(rows, "sent1");
  assert.ok(r, "sent 行必须在列");
  assert.equal(r.state, "blocked", "它在等的是**对方确认**，不是本机还在发");
  assert.equal(r.blockedReason, "waiting_ack", "原因要说得出短码，界面才知道该显示哪句");
  assert.equal(r.progress, 1, "进度是真的到了 100%");
  assert.ok(r.actions.includes("cancel"), "用户的原话：100% 但未终态仍可取消");
});

test("接收中的行也可取消（B3a：本机停手 + 删 .part）", () => {
  const rows = deriveOperations({
    transfers: [transfer({ id: "rx", direction: "receive", status: "active", progress: 0.6 })],
    contentTransfers: [],
  });
  const r = byId(rows, "rx");
  assert.equal(r.kind, "file_receive");
  assert.ok(r.actions.includes("cancel"), "接收未完成必须能取消");
  assert.equal(r.state, "running");
});

test("排队行带后端短码时算「阻塞」，不带就是「排队」", () => {
  const rows = deriveOperations({
    transfers: [
      transfer({ id: "q1", status: "pending", blocked_reason: "peer_offline" }),
      transfer({ id: "q2", status: "pending" }),
    ],
    contentTransfers: [],
  });
  assert.equal(byId(rows, "q1").state, "blocked");
  assert.equal(byId(rows, "q1").blockedReason, "peer_offline");
  assert.equal(byId(rows, "q2").state, "queued", "没有原因就不要硬造一个");
});

test("排序把「要用户动手」的排最前，同档按最近发生", () => {
  // 走真实管道（derive → sort），不手搓行：上一版在这里手拼行对象、漏了 `state`，
  // `STATE_RANK[undefined]` 是 NaN ⇒ 比较结果全乱，第一次跑就红。这条注释就是那次红的记录。
  const rows = sortOperations(
    deriveOperations({
      transfers: [
        transfer({ id: "old-running", status: "active", created_at: 1 }),
        transfer({ id: "queued", status: "pending", created_at: 9 }),
        transfer({
          id: "blocked",
          status: "pending",
          blocked_reason: "retry_exhausted",
          created_at: 2,
        }),
        transfer({ id: "new-running", status: "active", created_at: 8 }),
      ],
      contentTransfers: [],
    }),
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["blocked", "new-running", "old-running", "queued"],
    "一眼看懂卡在哪 = 需要处理的第一眼看到；同档里最近的在前",
  );
});

test("排序不改原数组（调用方把 store 里的快照直接传进来）", () => {
  const rows = deriveOperations({
    transfers: [transfer({ id: "queued", status: "pending" }), transfer({ id: "run", status: "active" })],
    contentTransfers: [],
  });
  assert.equal(rows[0].id, "queued", "derive 自己不改序（原样吐出来）");
  sortOperations(rows);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["queued", "run"],
    "返回新数组是硬要求：Pinia 的 ref 数组被就地排过，别的读法会看到意外顺序",
  );
});

test("按 cid 取内容的行不许把 64 位哈希当标题", () => {
  const cid = "61d8d9df4a00a8381e13cdc4631379574d0f4a0f1e13cdc4631379574d0f4a0f";
  const rows = deriveOperations({
    transfers: [],
    contentTransfers: [content({ cid, name: cid })],
  });
  const r = rows[0];
  assert.equal(r.title, "", "机器码不上屏 ⇒ 界面按 kind 回落成一句类型文案");
  assert.equal(FALLBACK_TITLE_KEYS[r.kind], "task.kind.contentFetch", "回落文案的 key 由读模型给，编译器数全覆盖");
  assert.ok(r.actions.includes("retry_content"), "重取这条通道今天就有 ⇒ 可以给动作");
  const named = deriveOperations({
    transfers: [],
    contentTransfers: [content({ cid, name: "photo.jpg" })],
  })[0];
  assert.equal(named.title, "photo.jpg", "有真名字就用真名字");
});

test("「立即重取」只给单聊接收行：群行的 peerId 是 group_id，发出去石沉大海", () => {
  const rows = deriveOperations({
    transfers: [],
    contentTransfers: [
      content({ cid: "a".repeat(64), name: "photo.jpg" }),
      content({ cid: "b".repeat(64), name: "g.jpg", groupId: "g1" }),
      content({ cid: "c".repeat(64), name: "out.jpg", direction: "send", received: 0 }),
    ],
  });
  assert.ok(byId(rows, "a".repeat(64)).actions.includes("retry_content"), "单聊接收：这条通道今天就有");
  assert.equal(
    byId(rows, "b".repeat(64)).actions.includes("retry_content"),
    false,
    "群内容行的 peerId 存的是 group_id，按 device_id 发出去没人收 ⇒ 宁可不给按钮",
  );
  assert.equal(
    byId(rows, "c".repeat(64)).actions.includes("retry_content"),
    false,
    "本机发出去的内容不该由任务中心去「重取」",
  );
  // 取消只给**接收方向**：发送方向的 cid 行是"本机是源"，`cancel_content_fetch` 按 cid 找的是
  // 本机在拉的那一单，给了按钮点下去也只会回 already_done。
  assert.ok(
    byId(rows, "a".repeat(64)).actions.includes("cancel_content"),
    "接收中的内容必须能取消（用户：没到终态的任务都要能停）",
  );
  assert.equal(
    byId(rows, "c".repeat(64)).actions.includes("cancel_content"),
    false,
    "发送方向的 cid 行不给取消：那条命令只收口本机的接收行",
  );
});

test("消息行：有正文给正文，没正文给类型 key；补发队列行给取消（B4 已有真命令）", () => {
  const rows = deriveOperations({
    transfers: [],
    contentTransfers: [],
    messageOps: [
      msgOp({ msg_id: "m-text", preview: "晚上七点" }),
      msgOp({ msg_id: "m-json", kind: "merge", preview: null }),
      msgOp({ msg_id: "m-offline", peer_offline: true }),
      msgOp({ msg_id: "m-group", peer_id: null, group_id: "g1", waiting_for: 3 }),
    ],
  });
  assert.equal(byId(rows, "m-text").title, "晚上七点");
  assert.ok(
    byId(rows, "m-text").actions.includes("cancel_message"),
    "cancel_message 是真命令 ⇒ 未送达的消息必须能取消",
  );
  assert.equal(byId(rows, "m-json").title, "", "没有正文就不硬凑标题，回落成「补发消息」");
  assert.equal(byId(rows, "m-offline").state, "blocked");
  assert.equal(byId(rows, "m-offline").blockedReason, "peer_offline");
  const grp = byId(rows, "m-group");
  assert.equal(grp.convId, "group:g1", "群消息的会话身份带得出来 → 可以跳会话");
  assert.equal(grp.waitingFor, 3, "「还有 3 个人没收到」是这行的目标");
  assert.ok(grp.actions.includes("open_conversation"));
  assert.ok(grp.actions.includes("cancel_message"), "群补发队列行同样能取消（后端按 Ack 判）");
});

test("群消息部分送达：仍列出剩余成员，但不给取消键，状态说「部分成员已收到」", () => {
  const rows = deriveOperations({
    transfers: [],
    contentTransfers: [],
    messageOps: [
      msgOp({
        msg_id: "m-partial", peer_id: null, group_id: "g1",
        waiting_for: 1, can_cancel: false, some_delivered: true,
      }),
    ],
  });
  const row = byId(rows, "m-partial");
  assert.equal(row.someDelivered, true, "已有成员 Ack ⇒ 状态要能说「部分成员已收到」");
  assert.equal(
    row.actions.includes("cancel_message"),
    false,
    "后端已拒绝取消（already_delivered）⇒ 界面不许给一颗点了必然失败的按钮",
  );
  assert.ok(row.actions.includes("open_conversation"));
  assert.equal(row.waitingFor, 1, "只剩 1 个成员也要说出来（否则这一行没有目标）");
  assert.equal(row.state, "queued", "剩余成员还在队列里 ⇒ 归到排队档");
});

test("群历史：running 与 failed 都算任务，done 不列", () => {
  const rows = deriveOperations({
    transfers: [],
    contentTransfers: [],
    groupHistory: [
      { group_id: "g1", source: "p2", synced: 30, total: 100, phase: "running" },
      { group_id: "g2", source: "", synced: 0, total: 0, phase: "done" },
      { group_id: "g3", source: "p9", synced: 5, total: 10, phase: "failed", reason: "no_source" },
    ],
  });
  assert.deepEqual(rows.map((r) => r.id).sort(), ["group:g1", "group:g3"]);
  const failed = byId(rows, "group:g3");
  assert.equal(failed.state, "blocked");
  assert.equal(failed.blockedReason, "no_source");
  assert.ok(failed.actions.includes("sync_history_now"), "已有命令 ⇒ 可以给动作");
  assert.equal(failed.progress, 0.5);
});

test("读不到 total 的行进度是 null，不是 0%", () => {
  const rows = deriveOperations({
    transfers: [],
    contentTransfers: [content({ status: "active", size: 0, received: 0 })],
  });
  assert.equal(rows[0].progress, null, "把「不知道」画成 0% 是谎；界面该画一条没有刻度的条");
});

test("isLiveTransferStatus 与气泡口径的差别是语义：sent 在气泡上是完成、在任务里是还在等", () => {
  assert.equal(isLiveTransferStatus("sent"), true);
  assert.equal(isLiveTransferStatus("active"), true);
  assert.equal(isLiveTransferStatus("pending"), true);
  assert.equal(isLiveTransferStatus("done"), false);
  assert.equal(isLiveTransferStatus("cancelled"), false);
  assert.equal(isLiveTransferStatus(null), false);
});

test("countOperations 就是药丸上的数（与列表同源，不另算一份）", () => {
  const rows = deriveOperations({
    transfers: [transfer({ id: "a" }), transfer({ id: "b", status: "done" })],
    contentTransfers: [],
  });
  assert.equal(countOperations(rows), rows.length);
  assert.equal(countOperations(rows), 1);
});

// ---------------- 更新下载（B5：任务中心从这一批起列它） ----------------

test("更新下载只在 downloading 时列出，取消键只在那一格", () => {
  const base = { downloaded: 40, total: 100, version: "5.5.33" };
  const rows = deriveOperations({
    transfers: [],
    contentTransfers: [],
    updater: { ...base, phase: "downloading" },
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.kind, "update_download");
  assert.equal(row.state, "running");
  assert.equal(row.progress, 0.4);
  assert.equal(row.title, "v5.5.33", "目标版本号比「更新下载」更说明问题");
  assert.deepEqual(row.actions, ["cancel_update"], "正在下载才有取消（install 不可取消）");
});

test("更新下载的其它相位都不进列表：ready 是完成、installing 不可取消、failed/cancelled 是终态", () => {
  for (const phase of ["idle", "checking", "ready", "installing", "failed", "cancelled", "unsupported"]) {
    const rows = deriveOperations({
      transfers: [],
      contentTransfers: [],
      updater: { phase, downloaded: 100, total: 100, version: "5.5.33" },
    });
    assert.deepEqual(
      rows.map((r) => r.kind),
      [],
      `${phase} 不该出现在任务中心（只列「正在下」这一段）`,
    );
  }
});

test("更新下载没有 total 时进度是 null，不是 0%", () => {
  const rows = deriveOperations({
    transfers: [],
    contentTransfers: [],
    updater: { phase: "downloading", downloaded: 2048, total: null, version: null },
  });
  assert.equal(rows[0].progress, null);
  assert.equal(rows[0].title, "", "没有版本号就回落成类型文案（界面用 fallbackTitleKey）");
});

test("更新下载 100% 时任务行消失（没有后台工作，不再显示「100% 收尾中」）", () => {
  const rows = deriveOperations({
    transfers: [],
    contentTransfers: [],
    updater: { phase: "downloading", downloaded: 100, total: 100, version: "5.9.0" },
  });
  assert.deepEqual(rows, [], "字节已下满 ⇒ 下载任务从任务中心移除");
});

test("消息行/1:1 文件行带定位消息 id（去会话后尽量定位到原消息）", () => {
  const rows = deriveOperations({
    transfers: [transfer({ id: "t-locate", status: "active" })],
    contentTransfers: [],
    messageOps: [msgOp({ msg_id: "m-locate" })],
  });
  const file = rows.find((r) => r.id === "t-locate");
  assert.equal(file?.locateMsgId, "file-t-locate", "1:1 文件气泡的消息 id 是 file-<transfer_id>");
  const msg = rows.find((r) => r.id === "m-locate");
  assert.equal(msg?.locateMsgId, "m-locate", "消息行直接带 msg_id");
});

// ---------------- 100% 但未终态的状态文案（2026-10-25 用户反馈） ----------------

test("100% 未终态按 kind 说清在做什么：不再一律「收尾中」", () => {
  const tr = (key: string, params?: Record<string, unknown>) =>
    params?.pct !== undefined ? `${key}:${params.pct}` : key;

  // 更新下载 100% 不再进列表（没有后台工作），所以这里只测仍有后台工作的三类。
  const fetched = deriveOperations({
    transfers: [],
    contentTransfers: [content({ status: "active", received: 100, size: 100 })],
  })[0];
  assert.equal(operationStatusText(fetched, tr), "task.state.verifying");

  const history = deriveOperations({
    transfers: [],
    contentTransfers: [],
    groupHistory: [{ group_id: "g1", source: "p1", synced: 10, total: 10, phase: "running" }],
  })[0];
  assert.equal(operationStatusText(history, tr), "task.state.historyFinalizing");

  const sent = deriveOperations({
    transfers: [transfer({ status: "sent", progress: 1 })],
    contentTransfers: [],
  })[0];
  assert.equal(
    operationStatusText(sent, tr),
    "task.state.waitingAck",
    "「已发出，等对方确认」比「正在收尾」更能解释 100%",
  );
});
