#!/usr/bin/env node
// 职责边界：双实例 E2E 的 **FRIENDREQ** 轮次分册（一族一轮：run）。
//   按族切而不是按行数切：这一族只读自己那一份 `settings` 行与自己的磁盘日志，
//   跨块的只有 core 里那几个公共原语（口径同 group/contentpull/ghsync 册）。
// ⚠️ 判据 C（scripts/check-doc-numbers.mjs）按下面这行 `export const MODE` 把本文件的 check( 归到这一轮：
//    改这行、或把断言挪去别的分册，都会让活文档里那句「N 条断言」当场对不上。
//
// 这一轮判的是第三轮审计 **A4** 里**能被磁盘上的事实表达**的那一半：
// 未处理的好友申请落在库里的这一行，跨一次真实启动之后仍然在，而且恢复那一路**不走通知**。
//
// ★ 这一轮的预置是「数据库预置恢复测试」里的**接收侧**那一半，不是「真实好友申请链路测试」，
//   也不是「申请方那半」——三件事别混：
//   · **主语是接收方**：`friend_req:<对端 id>` 这一行写在**收到申请的那一台**库里，本轮证的
//     是"接收方手里那条未处理申请跨重启仍在、且恢复不弹"。
//     ⚠️ **申请方**那本「已发出、等对方答应的申请」是 `AppState::pending_out_requests`
//     （`state.rs` 里声明，进程内 HashMap、不落库）⇒ 申请方重启后没有持久化保障，
//     本轮**不判它**，它也不是同一件事（是否要一起持久化 = 待用户拍板，见验收矩阵与 CHANGELOG）。
//   · 真链路那一半要有一份**从对端进来的 FriendRequest 帧**，只能由应用自己发
//     （命令 `send_friend_request` → `send_friend_request_via_link`，补发节奏见
//     `friend_request_flush_decision`），停机写库造不出真申请帧，而进程外拼帧属于本次
//     明令禁止的"新增自动化注入机制"。
//     2026-10-31 深夜那一半已由**双实例真实操作**补上（A 走界面加好友 → B 同意 → A 收到回执并建会话），
//     读数记在 `docs/acceptance/stability-smoke-matrix.md` 的「好友申请真链路」那一条与
//     audit 册 §4.0bk / §13 第 7 项；本轮仍然是预置恢复臂，两者不互相顶替。
//   · 这里判的是恢复臂：`restore_pending_requests`（在 `lib.rs` 的 setup 里、`app.manage` 之后
//     且联网之前那一步）从库里把那行填回内存，而"填回内存"正是"重启不重复弹窗"的机制本身
//     （`friend_request_arrival_decision` 判的是"本机是否已经握着这条申请"，内存不预填 ⇒
//      下一次补发会被当成首次见到 ⇒ 又弹一次）。
//
// ⚠️ 申请方刻意用一个**本轮自己铸的、不在任何好友表里**的 id：
//   `is_actionable_request` 只有一句 `!friend_ids.contains(req.from)`，而公共播种步把
//   INSTANCES[0] 与 [1] 互为好友 ⇒ 拿真对手 A 的 id 预置，B 首屏那次 `get_pending_requests`
//   会把它当"已是好友"过滤掉并**顺手删库里那行**（A4 自己加的清扫）⇒
//   下面所有格都会红在过滤器上，而不是红在恢复上。用一个陌生 id 才是"待处理"的那个形状。
export const MODE = "FRIENDREQ";
import {
  INSTANCES, ROUND, bootBaseOf, check, eid, launch, nowMs, noteId, openDb, seed,
  sleep, step, stopAll, stopOne, tcpOpen, waitFor,
} from "../core.mjs";
import { BOOT_LINE, bootReady, countLog, readLogTail } from "../../e2e-logtail.mjs";

/// 反向档：拓扑、预置、时序全都一样，**只把判据去库里读的那个 id 换成必定不存在的值**。
/// 与所有 `-lie` 档同规矩：不进任何门禁层（那会把"能红"变成"常红"）。
const FRIENDREQ_LIE = ROUND === "friendreq-lie";

const B = INSTANCES[1];
/// 预置的那条申请（from / 昵称 / 时间都是夹具自己造的，判据只吃它）。
const REQUESTER = eid("friendreq");
noteId(`${REQUESTER}-lie`);
const NICK = "E2E 申请方";
const REQ_TS = nowMs() - 60_000;
const keyOf = (id) => `friend_req:${id}`;
const payload = JSON.stringify({
  from: REQUESTER, from_nickname: NICK, from_avatar: null, ts: REQ_TS,
});

/// 停机读 B 那一行（恢复臂与"不许复制"那几格都读它）。
function readReqRow(inst, id) {
  const db = openDb(inst.db, true);
  try {
    return db.prepare("SELECT value FROM settings WHERE key=?1").get(keyOf(id))?.value ?? null;
  } finally { db.close(); }
}
function countReqRows(inst) {
  const db = openDb(inst.db, true);
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'friend_req:%'")
      .get().n;
  } finally { db.close(); }
}
function isFriend(inst, id) {
  const db = openDb(inst.db, true);
  try {
    return !!db.prepare("SELECT 1 FROM friends WHERE device_id=?1").get(id);
  } finally { db.close(); }
}

/// 磁盘日志里那两条 needle —— 两条**都**由 `state.logger.info("friend", …)` 写出去
/// （`logging.rs` 的 `Logger::info` → `Logger::log(Level::Info…)` → 落盘），所以第 ② 条能在盘上读到，
/// 就是第 ① 条"0 次"不是量具瞎的直接凭据（A9 那一族教训：判据钉的串在当前构建里根本不落盘 ⇒
/// 把"读不到"报成"产品失效"）。两条原文：
///   · 首次到达（会弹系统通知那一路）：`收到好友申请 peer=<id> nickname=<昵称>`
///     —— 直连臂在 `handle_identity.rs` 写这条（按串「收到好友申请」现寻），跨跳臂那句是「收到跨跳好友申请」，这里两条都数进来。
///   · 只填表那一路：`重启恢复 N 条待处理好友申请（只填表，不重复通知）`
const ARRIVED_NEEDLES = ["收到好友申请 peer=", "收到跨跳好友申请 peer="];
const RESTORED_NEEDLE = "条待处理好友申请（只填表，不重复通知）";
const arrivedCount = (peerId) => ARRIVED_NEEDLES.reduce(
  (n, needle) => n + countLog(B.log, `${needle}${peerId}`), 0);
const restoredCount = () => countLog(B.log, RESTORED_NEEDLE);
/// 命中行原样带回（红时看得见到底是哪一条），与 lanoff 那本同一口径。
const linesWith = (needle) => readLogTail(B.log, 6000)
  .split("\n").filter((l) => l.includes(needle)).slice(-3).join(" ⏎ ") || "(磁盘上没有这一行)";

export async function run() {
  step("好友申请重启恢复：库里那一行跨两次真实启动仍在、恢复只填表、不走通知那一路（审计 A4 可自动的那一半）", async () => {
    await stopAll();
    // 预置：B 手里一条待处理申请，除此之外关于这个"人"什么也没有。
    seed(B.db, (db) => {
      db.prepare("DELETE FROM friends WHERE device_id=?1").run(REQUESTER);
      db.prepare("DELETE FROM settings WHERE key LIKE 'friend_req:%'").run();
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)")
        .run(keyOf(REQUESTER), payload);
    });

    // ── 夹具自查（停机读，不是"某一瞬间没发生"那种竞态判据）──
    check("夹具自查：预置那一行确实在库里且 from 与键一致（list_friend_requests 认不上就当坏行跳过）",
      readReqRow(B, REQUESTER) === payload,
      payload, String(readReqRow(B, REQUESTER)));
    check("夹具自查：B 的好友表里没有这个申请方（有就会被 get_pending_requests 当陈旧行当场删掉 ⇒ 红的不是恢复）",
      isFriend(B, REQUESTER) === false, "不是好友（false）", String(isFriend(B, REQUESTER)));

    const want = (id) => (FRIENDREQ_LIE ? `${id}-lie` : id);
    const boot = async (inst, tag) => {
      await waitFor(() => tcpOpen(inst.port), 60_000, `${tag}：实例 ${inst.label} 的 TCP ${inst.port} 可连`);
      await waitFor(() => bootReady(inst.log, bootBaseOf.get(inst.n), BOOT_LINE),
        30_000, `${tag}：实例 ${inst.label} 打出 boot 完成行`);
    };

    // ── 第一次真实启动 ──
    launch(B);
    await boot(B, "首启");
    // ★ 屏障用磁盘上那一条恢复日志本身，不用墙钟。理由：`restore_pending_requests` 跑在
    //   `app.manage` 之后、联网之前，它那一行出现 = 恢复这一段确实过去了；而原先那句
    //   `sleep(3000)` 想等的是"界面首屏自己拉了一次 `get_pending_requests`"——**盘上没有任何
    //   观测点能证明那一次读取发生过**（它既不落日志也不写库），所以本轮不再声称证明过它。
    //   下面那条"通知 0 次"判的是**恢复这一路**不弹，不是"整个启动过程没有任何通知"。
    await waitFor(() => restoredCount() >= 1, 30_000,
      "首启：磁盘日志里出现「重启恢复 … 条待处理好友申请」那一条（量具正控：这条能读到，下面那条 0 次才不是瞎读）");

    check("★ 首启跑完之后库里那一行**一字未变**（恢复不删、不改写、不覆盖成别的载荷）",
      readReqRow(B, want(REQUESTER)) === payload,
      payload, String(readReqRow(B, want(REQUESTER))));
    check("★ 磁盘日志里留下了「重启恢复 1 条待处理好友申请」恰好一次（恢复真跑了；这条同时是下面那条 0 次的量具正控 —— 同一个 info(\"friend\") 出口落得了盘）",
      restoredCount() === 1, "1 次", `${restoredCount()} 次；行样：${linesWith(RESTORED_NEEDLE)}`);
    check("★ 恢复这一路**没有**走通知那一条：`收到好友申请 peer=` 在盘上出现 0 次（首次到达才弹，重启只填表）",
      arrivedCount(REQUESTER) === 0, "0 次", `${arrivedCount(REQUESTER)} 次；行样：${linesWith("好友申请 peer=")}`);
    check("重复启动不许把一行复制成多行：`friend_req:%` 仍然只有一行",
      countReqRows(B) === 1, 1, countReqRows(B));

    // ── 第二次真实重启（同一条申请，再来一遍恢复臂）──
    // ⚠️ 计数按"这一次启动自己那一段窗口"判，不判累计：`launch()` 里那趟 `stashLogs`（`scripts/e2e-logtail.mjs`）会把上一次的
    //   `.log` **整份移动**进 run 目录，第二次起之后 `countLog` 看见的必然是新文件 ⇒
    //   写"累计 2 次"会红在量具的搬运语义上，而不是红在产品上。
    await stopOne(B);
    await sleep(1_500);
    launch(B);
    await boot(B, "二次启动");
    // 同一把屏障（`stashLogs` 已把上一段整份移走 ⇒ 这个计数天然只覆盖本次启动）。
    await waitFor(() => restoredCount() >= 1, 30_000, "二次启动：本窗口日志里出现「重启恢复 …」那一条");

    check("★ 第二次重启后那一行仍在（用户那句「重启不会丢好友申请」判的是跨多次重启，不只是一次）",
      readReqRow(B, want(REQUESTER)) === payload,
      payload, String(readReqRow(B, want(REQUESTER))));
    // ★ 两条可测量各自一条断言 —— 原先写成 `恢复 1 次 && 到达 0 次` 一条，红的时候分不清
    //   是"恢复臂没跑"（量具瞎）还是"它偷偷弹了"（产品坏），而这两种的处置完全相反。
    check("★ 第二次启动恢复臂又真跑了一次（本窗口那条「重启恢复」恰好 1 次 —— 不是 0 次也不是 2 次）",
      restoredCount() === 1, "本窗口 1 次",
      `${restoredCount()} 次；行样：${linesWith(RESTORED_NEEDLE)}`);
    check("★ 第二次启动也不走通知那一条：本窗口「…好友申请 peer=」0 次（判的是**恢复臂**不弹；"
      + "不判「整个启动过程没有任何通知」，也不证明前端那次读取跑过 —— 那一条盘上没有观测点）",
      arrivedCount(REQUESTER) === 0, "0 次",
      `${arrivedCount(REQUESTER)} 次；行样：${linesWith("好友申请 peer=")}`);
    check("二次重启后仍只有一行（既不复制也不被读侧清扫）",
      countReqRows(B) === 1, 1, countReqRows(B));

    await stopOne(B);
  });
}
