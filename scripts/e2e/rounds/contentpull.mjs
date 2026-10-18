#!/usr/bin/env node
// 职责边界：双实例 E2E 的 **CONTENTPULL** 轮次分册（一族一轮：run）。
// 为什么按族切而不是按行数切：这一族的判据只读自己那几份族私有的量
//   （AST 现算：89 个顶层名字只在某一个块里出现，跨块的只有 9 个），所以一个族 = 一个文件是**作用点的边界**。
// ⚠️ 判据 C（scripts/check-doc-numbers.mjs）按下面这行 export const MODE 把本文件的 check( 归到这一轮：
//    改这行、或把断言挪去别的分册，都会让活文档里那句「N 条断言」当场对不上。
//
// 这一轮补的是 §九/§五 里唯一从没被跨实例判过的那条路径：**按 cid 把缺的内容从对端拉回来**。
// 在此之前双实例 harness 一次都没驱动过 `ContentRequest`（`grep` 过 rounds/ 全册：零命中），
// 而真机第 7 条（用户 2026-10-13 报「加好友后电脑端发的图片手机端一直转圈」）坏的就是这一条：
// 服务侧在**自己的入站循环里** await 整条握手 —— `handle_share.rs` 的 ContentRequest 那一支
// 发完 FileOffer 要等对端的 FileAccept，而那一帧正是由这条被堵住的 reader 循环读回来的
// ⇒ 每次必走满 15 秒（`file/send.rs` 里那句 `waiting FileAccept (15s)`），期间同链路的
// 群聊/单聊/心跳全部进不来，且 15 秒后必然超时 ⇒ 这一单**永远**取不回来。
// 现场读数（用户库 + 两份日志，见 CHANGELOG 那一节）：14 行 `receive/incomplete/262144/path NULL`，
// `file_transfers` 却全是 `done`；attempts=2/8、`next_attempt_at` 早就到点；日志里
// `ContentRequest：本机没有该内容` 与那 14 行里的一个 cid 对得上 ⇒ 同一个洞两个方向都在咬。
//
// ⚠️ 这一轮的预置为什么全是「停机写库」而不是「让应用执行一条命令」：
// 产品没有"自己发起一次拉取"的入口（拉取由 Hello/心跳臂里的 `retry_incomplete_content` 驱动），
// 而 harness 的既有口径就是「停机预置 SQLite 表达用户动作」—— 写进去的那 N 行
// `status='incomplete' / next_attempt_at=0 / path IS NULL` 正是真机卡住时那 14 行的形状，
// **上线后由生产侧自己发出真帧**（不是 harness 伪造的帧）。
export const MODE = "CONTENTPULL";
import { INSTANCES, LIE_SHA, ROUND, RUN_DIR, S, bootBaseOf, check, eid, launch, nowMs, openDb, seed, sleep, step, stopAll, stopOne, tailLog, tcpOpen, waitFor } from "../core.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { BOOT_LINE, bootReady, countLog } from "../../e2e-logtail.mjs";

// ── 族私有的量（只有这一族读）──
const PULL_LIE = ROUND === "contentpull-lie";
/// 每对端服务队列上限，与 `src-tauri/src/network/transport/queue_policy.rs` 的
/// `FILE_SERVICE_QUEUE_CAP` 同值。**这里只当"要造出溢出就得比它多"的算式输入**，
/// 不去 assert 它等于某个数 —— 那个数由 Rust 侧的容量判据钉（`overflow_is_bounded_and_recovers`）。
const CAP = 8;
/// 份数：必须 **> CAP + 1** 才谈得上"这一轮量到了队列满"（判据 ⑨）。
/// 用 max 兜住旋钮：把 `E2E_PULL_N` 调到 8 以下会让那条溢出判据变成假红 —— 红的是档位，不是产品。
const N = Math.max(CAP + 4, Number(process.env.E2E_PULL_N) || CAP + 4);
/// 第一份刻意给大：溢出是"提交比服务快"的结果，窗口必须由**实测的服务耗时**撑开，
/// 不能指望运气。回环上 100 MB 实测 ~0.78s（见驱动 kill 轮那段注释）⇒ 40 MB ≈ 0.3s，
/// 而那 N-1 次提交只是「两次查库 + 一次 try_send」，量级差 100 倍。
const BIG_MB = Number(process.env.E2E_PULL_BIG_MB) || 40;
const SMALL_MB = Number(process.env.E2E_PULL_MB) || 1;
/// 「A 的入站被服务占住多久」不再用墙上时间判（为什么见下面那条判据前的注释），
/// 但文本探针仍然要**等**到一个有界窗口再读，否则旧行为里那一轮会一直挂到步骤超时。
const PROBE_WAIT_MS = 300_000;
const PROBE_TEXT = "content pull did not block inbound";
/// 两个步骤之间的交接（step1 收尾时写、step2 读）：ESM 不给 import 绑定赋值，但可以改自己模块里的 let。
let handoff = null;

/// 跨 `.log` + `.old.log` 按**两个** needle 数行（`countLog` 只吃一个 needle，
/// 而这里要数的是「针对我这批 transfer 的那一类行」）。
/// `tailLog(file, 200000)` 取的是每个档各 200000 行 ⇒ 实际就是整份（同停滞轮的用法）。
function countLinesWith(inst, ...needles) {
  return (tailLog(inst.log, 200_000) || "")
    .split("\n")
    .filter((l) => needles.every((x) => l.includes(x))).length;
}

export async function run() {
  step("内容拉取跨实例判据：B 缺的 N 份必须真能取回来，取的过程中 A 的入站不许停（真机第 7 条那条自死锁）", async () => {
    await stopAll();

    // ── 预置：A 有货、B 缺货 ──────────────────────────────────────
    const ts = nowMs();
    const srcDir = path.join(RUN_DIR, "src", "pull");
    const recvB = path.join(RUN_DIR, "recv", "B");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(recvB, { recursive: true });
    const pulls = [];
    for (let i = 0; i < N; i++) {
      const tid = eid("p"); // transfer_id：B 侧预置、A 侧原样回发 ⇒ 这一轮同时钉住"应答匹配没被队列踩坏"
      const name = `${tid}.bin`;
      const bytes = Math.round((i === 0 ? BIG_MB : SMALL_MB) * 1024 * 1024);
      const buf = Buffer.alloc(bytes);
      // 逐 32 字节写一个由 (份号 i, 块号 k) 共同决定的数：
      // ① 每份内容互不相同 ⇒ 「串味」在 sha256 上必然暴露，而不是"两份一样大所以看不出来"；
      // ② 不用全零/纯随机 ⇒ 与 multi 轮同一立场（真随机也行，这里刻意要"可复算"）。
      for (let k = 0; k + 4 <= bytes; k += 32) buf.writeUInt32BE((((i + 1) * 0x9e3779b1) ^ (k / 32)) >>> 0, k);
      const srcFile = path.join(srcDir, name);
      fs.writeFileSync(srcFile, buf);
      pulls.push({
        cid: createHash("sha256").update(buf).digest("hex"),
        tid, name, bytes, srcFile,
        // updated_at 逐份递增：`list_resumable_for_peer` 按 updated_at ASC 出队
        // ⇒ 第一份（大块）必然先被请求，溢出窗口才撑得开。
        at: ts + i,
      });
    }
    const cidSet = new Set(pulls.map((p) => p.cid));
    /// 上面那一单"谁都没有的内容"：cid 现造（不是任何文件的 sha），A 侧**故意不写** `content_transfers` 行
    /// ⇒ `find_source` 必然取不到 ⇒ 生产代码走"本机没有该内容"那一支。
    const ghost = {
      cid: randomBytes(32).toString("hex"),
      tid: eid("g"),
      name: `ghost-${Math.random().toString(36).slice(2, 8)}.bin`,
      bytes: 1024,
    };
    const textMsgId = eid();

    seed(INSTANCES[0].db, (db) => {
      for (const p of pulls) {
        db.prepare("DELETE FROM content_transfers WHERE cid=?1").run(p.cid);
        // 「拥有即授权」的原料（`content/store.rs:find_source`）：只看 path 非空，
        // status 不参与 —— 这里写 'send'/'complete' 是复刻"A 发过一次、所以本机有完整字节"。
        db.prepare(
          `INSERT INTO content_transfers(cid,transfer_id,peer_id,group_id,name,size,direction,status,
             received,attempts,next_attempt_at,last_error,path,created_at,updated_at)
           VALUES(?1,NULL,?2,NULL,?3,?4,'send','complete',?4,0,0,NULL,?5,?6,?6)`,
        ).run(p.cid, S.idB.runtimeId, p.name, p.bytes, p.srcFile, p.at);
      }
    });
    seed(INSTANCES[1].db, (db) => {
      for (const p of pulls) {
        db.prepare("DELETE FROM content_transfers WHERE cid=?1").run(p.cid);
        db.prepare("DELETE FROM file_transfers WHERE id=?1").run(p.tid);
        // 真机那 14 行的形状：receive + incomplete + path NULL + 退避已到点。
        // ⚠️ 这里的 transfer_id 必须是**本轮新铸**的：接收端 `decide_offer` 会按它查 `.part`
        //    与"本机已收完"，复用上一轮那个 id 会判成 AlreadyHave ⇒ 红的是预置不是产品。
        db.prepare(
          `INSERT INTO content_transfers(cid,transfer_id,peer_id,group_id,name,size,direction,status,
             received,attempts,next_attempt_at,last_error,path,created_at,updated_at)
           VALUES(?1,?2,?3,NULL,?4,?5,'receive','incomplete',0,0,0,NULL,NULL,?6,?6)`,
        ).run(p.cid, p.tid, S.idA.runtimeId, p.name, p.bytes, p.at);
      }
      // ➕ 第 N+1 单：**谁都没有的那份内容**（cid 是现造的随机 32 字节，盘上不存在）。
      // 为什么它必须在这一轮里：`handle_share.rs` 那一臂的"本机没有该内容"那一支，
      // 此前跨实例**零判据**（既有各轮只走过"对方真有"那半边），而它是同一个洞的另一头 ——
      // 用户日志里那句 `ContentRequest：本机没有该内容 cid=b9e8df92…` 就是这一支。
      // 这一单要判的是两件事：服务方**明着说一句"我没有"**（不许静默不回，也不许回一份假的），
      // 以及它**不许把整条队列带下水**（一个永远取不到的 cid 只该消耗自己的 attempts 退避，
      // 不该卡住同对端其余各单 —— 那正是"界面永远转圈"的另一种死法）。
      db.prepare("DELETE FROM content_transfers WHERE cid=?1").run(ghost.cid);
      db.prepare("DELETE FROM file_transfers WHERE id=?1").run(ghost.tid);
      db.prepare(
        `INSERT INTO content_transfers(cid,transfer_id,peer_id,group_id,name,size,direction,status,
           received,attempts,next_attempt_at,last_error,path,created_at,updated_at)
         VALUES(?1,?2,?3,NULL,?4,?5,'receive','incomplete',0,0,0,NULL,NULL,?6,?6)`,
      ).run(ghost.cid, ghost.tid, S.idA.runtimeId, ghost.name, ghost.bytes, ts);
    });

    /// 那条 **B→A** 的普通文本 = 「服务把 A 的入站占了多久」的探针。
    /// ⚠️ 为什么它**不能**在停机预置里写（第一版就写在那里，结果在旧二进制上量到 `1ms`、
    /// 这条判据当场假绿）：B 的 Hello 臂里 `flush_outbox`（发文本）排在
    /// `retry_incomplete_content`（发这 N 个 ContentRequest）**之前** ⇒ 停机写好的那条文本
    /// 上线后第一件事就是被 B 发出去，于是它在 A 的 socket 里排在所有请求**前面**，
    /// A 的入站循环读到它时还没开始堵 ⇒ "1 毫秒就落库"量的其实是"帧到达的先后"，不是"入站被占死多久"。
    /// 现在改成：**等 A 已经进到第一次服务里**（看见针对第一单的 `offer SENT` 那行）再投这条文本，
    /// 于是它落库的耗时读的是"A 什么时候腾得出入站循环"。⚠️ 这个耗时今天**只打印不设判据**
    /// （为什么设不成判据见下面那条 `bAccepted` 前的注释），设判据的是那对确定性读数。
    /// 方向必须是 B→A：被堵的是**服务侧（A）**的 reader 循环；A→B 的文本走的是 A 的发送侧，
    /// 那条在旧行为里一样能出（发送不堵），只有落进 A 库的那一帧才量得到堵塞。
    /// ⚠️ 这一格同时是既有做法的复用，不是新发明的风险：`rounds/posttext.mjs` 就是在
    /// **应用跑着**的时候往 outbox 塞一行，由下一次心跳冲出去（本仓既有事实：flush 靠链路事件与心跳）。
    const seedProbeText = () => {
      const t = nowMs();
      seed(INSTANCES[1].db, (db) => {
        db.prepare("DELETE FROM messages WHERE msg_id=?1").run(textMsgId);
        db.prepare("DELETE FROM outbox WHERE msg_id=?1").run(textMsgId);
        db.prepare(
          `INSERT INTO messages(msg_id,conv_id,sender_id,receiver_id,kind,content,ts,seq,status)
           VALUES(?1,?2,?3,?4,'text',?5,?6,1,'sending')`,
        ).run(textMsgId, S.idA.runtimeId, S.idB.runtimeId, S.idA.runtimeId, PROBE_TEXT, t);
        db.prepare("INSERT INTO outbox(msg_id,peer_id,payload,created_at) VALUES(?1,?2,?3,?4)").run(
          textMsgId, S.idA.runtimeId,
          JSON.stringify({
            type: "chat_message", msg_id: textMsgId, from: S.idB.runtimeId, to: S.idA.runtimeId,
            kind: "text", content: "enc1:harness-placeholder", ts: t, seq: 1,
          }),
          t,
        );
      });
      return t;
    };

    const readB = () => {
      const d = openDb(INSTANCES[1].db, true);
      try {
        return d.prepare(
          "SELECT cid,status,path,transfer_id FROM content_transfers WHERE peer_id=?1",
        ).all(S.idA.runtimeId);
      } finally { d.close(); }
    };
    const readA = () => {
      const d = openDb(INSTANCES[0].db, true);
      try {
        return d.prepare("SELECT content,sender_id,status FROM messages WHERE msg_id=?1").all(textMsgId);
      } finally { d.close(); }
    };
    const landedSha = (p) => {
      const exact = path.join(recvB, p.name);
      if (fs.existsSync(exact)) return createHash("sha256").update(fs.readFileSync(exact)).digest("hex");
      // 改名兜底（`unique_path` 在撞名时会给 `name (1).bin`）：按内容认，不按名字赌。
      for (const f of fs.readdirSync(recvB)) {
        const fp = path.join(recvB, f);
        if (!fs.statSync(fp).isFile() || f.endsWith(".part")) continue;
        const h = createHash("sha256").update(fs.readFileSync(fp)).digest("hex");
        if (h === p.cid) return h;
      }
      return null;
    };

    const bPre = readB();
    const aPre = (() => {
      const d = openDb(INSTANCES[0].db, true);
      try {
        return d.prepare("SELECT COUNT(*) c FROM content_transfers WHERE path IS NOT NULL AND cid IN (" +
          pulls.map(() => "?").join(",") + ")").all(...pulls.map((p) => p.cid))[0].c;
      } finally { d.close(); }
    })();
    check("预置成立：B 缺这 N 份（incomplete + path NULL、盘上没有）、A 本机有这 N 份完整字节（find_source 的原料）",
      bPre.filter((r) => cidSet.has(r.cid)).length === N &&
      bPre.every((r) => !cidSet.has(r.cid) || r.status === "incomplete") &&
      bPre.every((r) => !cidSet.has(r.cid) || r.path === null) &&
      aPre === N && pulls.every((p) => fs.existsSync(p.srcFile)) &&
      pulls.every((p) => !fs.existsSync(path.join(recvB, p.name))),
      `A 侧 ${N} 行有 path / B 侧 ${N} 行 incomplete 且 path NULL、盘上零份`,
      `A ${aPre}/${N} · B ${bPre.filter((r) => cidSet.has(r.cid) && r.status === "incomplete" && r.path === null).length}/${N} · 已落地 ${pulls.filter((p) => fs.existsSync(path.join(recvB, p.name))).length}`);
    if (bPre.length === 0 || aPre !== N) return; // 预置不成立 ⇒ 后面每一条都在判一个不存在的路径

    for (const i of INSTANCES) {
      launch(i);
      await waitFor(() => tcpOpen(i.port), 60_000, `内容拉取轮：实例 ${i.label} 的 TCP ${i.port} 可连`);
      await waitFor(() => bootReady(i.log, bootBaseOf.get(i.n), BOOT_LINE), 30_000,
        `内容拉取轮：实例 ${i.label} 打出 boot 完成行`);
    }
    // 计时起点 = A 这一侧确实认到了这条链路（与默认轮那条判据同一个锚点），后面 `pullMs` 从此起算。
    // 起点选在这里而不是"launch 那一刻"：建链与 boot 各自要几秒，把它们算进"取回一整批用了多久"
    // 会让这个读数变成基础设施的函数。
    await waitFor(
      () => (tailLog(INSTANCES[0].log, 4000) || "").includes(`peer=${S.idB.runtimeId}`),
      90_000, "内容拉取轮：A 侧日志出现与 B 的链路（这一行之后才开始量阻塞）",
    );
    const tLink = nowMs();

    // 探针投放点：**必须已经看见 A 进到第一次服务里**（那一单是 40 MB 那份，第一份出队），
    // 这样它才不是"排在请求前面的那条帧"（见 seedProbeText 那段为什么不能在停机时写）。
    // 落库耗时在这里只如实打印；"入站被自己的握手占住"改由下面那对确定性读数判。
    await waitFor(
      () => countLinesWith(INSTANCES[0], "[FILE] offer SENT", pulls[0].tid) > 0,
      120_000, `内容拉取轮：A 侧开始服务第一单（看见针对 ${pulls[0].name.slice(-6)} 的 offer SENT 行）`,
    );
    const tProbe = seedProbeText();

    // ① 先等那条文本落进 A 库（有界；新行为里几秒内，旧行为里它同样会落、只是说不清被谁耽误）
    let textMs = -1;
    const textDeadline = nowMs() + PROBE_WAIT_MS;
    for (;;) {
      if (readA().length > 0) { textMs = nowMs() - tProbe; break; }
      if (nowMs() >= textDeadline) break;
      await sleep(250);
    }
    // ② 再等这 N 份到位（有界；到点把最后一次读数交给判据判红，不 throw）
    let pullMs = -1;
    const pullDeadline = nowMs() + 240_000;
    for (;;) {
      const rows = readB();
      if (rows.filter((r) => r.status === "complete" && r.path !== null && cidSet.has(r.cid)).length === N) {
        pullMs = nowMs() - tLink;
        break;
      }
      if (nowMs() >= pullDeadline) break;
      await sleep(500);
    }

    // ── 判据 ──
    const bRows = readB();
    const byCid = new Map(bRows.map((r) => [r.cid, r]));
    // 反向档只翻**判据读的那两份值**（期望的 cid 摘要 + 期望的台账终态），预置、时序、拓扑一字不动。
    // 读真 id / 真字节的其余各条照绿 ⇒ 红来自断言本身。
    const wantSha = PULL_LIE ? LIE_SHA : null;
    const wantStatus = PULL_LIE ? "complete-but-tampered" : "complete";
    /// 「真的到位了几行」——永远按真状态数，**不吃反向档那两个翻过的值**。
    /// 为什么要有这一份：下面那条「完成后不再重复请求」的前提要用它，
    /// 若直接复用 `ledger`（读的是翻过的期望），反向档里那条会跟着一起红 ⇒
    /// 三格红来自同一次翻值，"红恰好落在被翻的那一格"这条对照就废了。
    const doneReal = bRows.filter((r) => cidSet.has(r.cid) && r.status === "complete" && r.path !== null).length;
    const wrong = pulls.filter((p) => landedSha(p) !== (wantSha ?? p.cid));
    check("每一份取回的文件，其 sha256 必须等于它自己的 cid（cid 就是内容地址 ⇒ 对不上就是串味或半份）",
      wrong.length === 0, `全部 ${N} 份各对自己的 cid`,
      wrong.length ? `对不上 ${wrong.length} 份：${wrong.slice(0, 3).map((p) => p.name.slice(-6)).join(",")}` : `全对（用时 ${pullMs}ms）`);
    const ledger = pulls.filter((p) => byCid.get(p.cid)?.status === wantStatus && byCid.get(p.cid)?.path !== null);
    check("两张台账必须同时收口（B1 那一格）：content_transfers 到 complete 且写入 path，一次拉取每侧各只一行",
      ledger.length === N, `${N} 行 status=${wantStatus} 且 path 非空`,
      `达标 ${ledger.length}/${N}（实测 ${pullMs === -1 ? `240s 内没到位` : `${pullMs}ms`}）· 读数 ${JSON.stringify([...new Set(bRows.filter((r) => cidSet.has(r.cid)).map((r) => r.status))])}`);
    const partLeft = fs.readdirSync(recvB).filter((f) => pulls.some((p) => f.includes(p.tid) && f.endsWith(".part")));
    const stillResumable = bRows.filter((r) => cidSet.has(r.cid) &&
      ["queued", "active", "incomplete"].includes(r.status)).length;
    check("取完就是取完：接收目录不许留这 N 单的任何 .part，B 侧也不许再有任何一行落在可恢复名单里（否则下次建链还会重取一遍）",
      partLeft.length === 0 && stillResumable === 0, "0 个 .part / 0 行可恢复",
      `.part ${partLeft.length} 个 · 可恢复 ${stillResumable} 行`);
    const tmo = pulls.reduce((s, p) => s + countLinesWith(INSTANCES[0], "[FILE] offer TIMEOUT/REJECTED", p.tid), 0);
    const acc = pulls.reduce((s, p) => s + countLinesWith(INSTANCES[0], "[FILE] accept RECEIVED", p.tid), 0);
    check("握手必须真的被对端接下：A 侧针对这批 transfer 的 offer 满额超时 0 行、且每一单都有一条 accept RECEIVED（这条直接量「入站循环再没被握手占死」）",
      tmo === 0 && acc >= N, "超时 0 行 / 受理 ≥ " + N,
      `超时 ${tmo} 行 · 受理 ${acc} 行`);
    const textRows = readA();
    // ⚠️ 这条**不再写成墙上时间判据**。第一版是"A 进入服务后 30 秒内那条文本要落进 A 库"，
    // 结果在旧二进制上量到 5300 ms ⇒ 假绿（更早一版把它放在停机预置里，量到 1 ms，也是假绿）。
    // 本机同时有 LAN 与 Routed **两条**链路，两条 reader 循环各堵各的 15 秒，链路一抖就双双走进
    // 「同一个 transfer_id 被两次注册、后一次把前一次的等待者踩掉」那条死法 ⇒ 15 秒的等待
    // 塌成一串**瞬时**失败（实测：同一秒内 `offer SENT` 与 `offer TIMEOUT/REJECTED` 成对刷屏）。
    // 所以"入站被占死多久"改由下面那条**确定性读数对**判，这里的耗时只如实打印。
    check("落进 A 库的那一条内容与方向都对（服务期间聊天这条管道还活着：re-seal→解密→落库整条走完）",
      textRows.length === 1 && textRows[0]?.content === PROBE_TEXT && textRows[0]?.sender_id === S.idB.runtimeId,
      `1 行 · content=${PROBE_TEXT.slice(0, 14)}… · sender=${S.idB.runtimeId}`,
      textRows.length === 0 ? "0 行" : JSON.stringify(textRows.map((r) => [r.content?.slice(0, 18), r.sender_id, r.status])));
    // 「对端确实答了」与「服务方一条都没读到」这一对，才是入站被自己的握手占死的**确定性**证据。
    // 为什么"盘上有这一单的文件"就等于"对端答过"：接收端在 `handle_file.rs` 的同一个臂里
    // **先建接收器（这一步就开出 `<transfer_id>.part`）、紧接着才 try_send FileAccept** ⇒
    // 那一单在 B 的接收目录里留了脚印（`.part` 或收尾后的终名文件），B 就必然发过应答。
    // ⚠️ 刻意**不**用 `file_transfers` 那一行当证据：实测旧行为跑完 12 单里只有 1 行
    // （`run-2026-10-13T10-05-52-683Z` 的 after-B.db 现读），说明接收侧那张表的写入点
    // 不在"建接收器"这一步上 —— 拿一个自己没读懂的写入点当判据输入，红了也归不了因。
    // 旧行为里这一对必然「B 有脚印而 A 一条都没读到」；新行为里两边都必须够数。
    const bAnswered = pulls.filter((p) => {
      if (!fs.existsSync(recvB)) return false;
      return fs.readdirSync(recvB).some((f) => f.includes(p.tid));
    }).length;
    check("对端确实回了应答、而服务方一条都没读到 ⇒ 这条判的就是「应答只能由被握手占住的那条入站循环读回来」",
      bAnswered >= N && acc >= N, `B 侧留脚印 ≥ ${N} 且 A 侧读到 accept ≥ ${N}`,
      `B 侧 ${bAnswered}/${N} 已应答 · A 侧读到 ${acc} 行`);
    // 「完成后不再重复请求」：这一条钉的是本轮新加的那半个心跳臂 ——
    // `retry_incomplete_content` 现在每 5s 跑一次，若已完成的行还被 `list_resumable_for_peer` 捞回去，
    // 界面上"转圈"会变成"永远转圈 + 每 5 秒一次的重复请求"。多等两个心跳周期，看计数还涨不涨。
    const reqNeedle = "建链自动重试未完成内容";
    const reqCount = () => pulls.reduce((s, p) => s + countLinesWith(INSTANCES[1], reqNeedle, p.cid), 0);
    const reqBefore = reqCount();
    await sleep(15_000); // 心跳 5s（transport.rs:1992）⇒ 15s 至少跨过两个重投机会
    const reqAfter = reqCount();
    check("到位之后不许再请求（新心跳臂的收口判据）：再多等两个心跳周期，这批 cid 的重投行数不增长",
      reqAfter === reqBefore && reqBefore >= N && doneReal === N,
      `行数不变且 ≥ ${N}`, `${reqBefore} → ${reqAfter}（真到位 ${doneReal}/${N}）`);
    const overflow = countLog(INSTANCES[0].log, "ContentRequest 服务队列已满");
    check("队列确实有界：第一份在飞时把其余各单灌进同一个对端队列 ⇒ A 侧必须数得到「服务队列已满」那行留痕（静默丢单=界面永远转圈）",
      overflow >= 1, "≥ 1 行", `${overflow} 行`);
    // ── 「本机没有那一单」那一支（同一条臂的另一头）──
    // 三条读数一起判：说过"我没有"（留痕）+ **没有**假装完成（台账不许 complete、盘上不许有文件）
    // + 它**没有**把其余各单卡住（其余各单照常全部到位）。
    // 只判第一条会漏掉最贵的那种死法：静默不回 = 对端永远等 = 界面永远转圈，而日志上干干净净。
    // 两个 needle 一起数（`countLog` 只吃一个，会数到别的 cid 那一行 ⇒ 假绿）
    const ghostLog = countLinesWith(INSTANCES[0], "本机没有该内容", ghost.cid);
    const ghostRow = (() => {
      const d = openDb(INSTANCES[1].db, true);
      try {
        return d.prepare("SELECT status,path,attempts FROM content_transfers WHERE cid=?1 AND peer_id=?2")
          .get(ghost.cid, S.idA.runtimeId) ?? null;
      } finally { d.close(); }
    })();
    const ghostLanded = fs.existsSync(recvB) && fs.readdirSync(recvB).some((f) => f.includes(ghost.tid));
    check("本机没有那一单时，服务方必须明着说一句「本机没有该内容」，而且**不许**把它写成完成、也不许落一个假文件（静默不回=对端永远转圈，而日志干干净净）",
      ghostLog >= 1 && ghostRow !== null && ghostRow.status !== "complete" && ghostRow.path === null && !ghostLanded,
      "留痕 ≥ 1 行 + B 侧那一行不是 complete 且无 path + 盘上零份",
      `留痕 ${ghostLog} 行 · 台账 ${JSON.stringify(ghostRow)} · 落盘 ${ghostLanded ? "有" : "无"}`);
    check("永远取不到的那一单只该消耗自己的退避：它反复重投的同时，其余各单必须全部到位且接收目录不 residue（一个缺 cid 不许卡住同对端的整条队列）",
      ghostRow !== null && ghostRow.attempts >= 1 && doneReal === N && partLeft.length === 0,
      `它的 attempts ≥ 1 且其余 ${N} 份全部 complete`,
      `ghost.attempts=${ghostRow?.attempts} · 真到位 ${doneReal}/${N} · .part ${partLeft.length} 个`);
    // 实际耗时/行数一律现印（报告契约要的「耗时」之外，这一行还是"时间上界是不是被量出来的"的现场证据：
    // 上面那条 30s 界如果哪天需要调，依据就是这里读到的数，不是谁的感觉）。
    console.log(`      实测：从建链到 ${N} 份拉取 ${pullMs}ms · 溢出留痕 ${overflow} 行（每对端上限 ${CAP}）` +
      ` · 重投行 ${reqBefore}→${reqAfter} · 文本落库 ${textMs === -1 ? `${PROBE_WAIT_MS / 1000}s 内没落库` : textMs + "ms"}`);
    // 「应答到了但没人等」那两行诊断（本轮补上的、过去被静默吞掉的那一支）——
    // 是否出现取决于迟到应答与超时收尾的先后，**只打印不设判据**（协议里没有"必须有一条迟到应答"这件事）。
    const noWaiter = countLog(INSTANCES[0].log, "但本机没在等它");
    console.log(`      A 侧「应答到了但已无人等待」诊断行 ${noWaiter} 行（只打印，不设判据）`);
    handoff = { srcDir, recvB, ts };
  });

  // ── 第二格：服务方进程**半路消失**，新起来的那条连接必须把剩下的做完 ──────────
  // 为什么必须单独一格（合同点名的那一格）：A 阶段的队列语义全靠 Rust 单测钉（`close_peer`、
  // generation、panic 收口），而「旧连接没开工的作业不许变成永久占位、旧连接也不许阻塞新连接」
  // 这句话只有**真把服务方杀掉**才量得到 —— 单测里那条链路是假的。
  // 为什么批次 2 用 4 份 40 MB：杀进程要落在"第一批已在飞、后面还排着没开工的"那一刻。
  // 回环上实测一份 40 MB ~0.3s（见上一节那条 ★），单发 2 MB 十几毫秒就完了 ⇒ 抓不住窗口，
  // 所以刻意一次灌 4 份大的，让"在飞 1 份 + 队列里 3 份"这段真实存在。
  step("断线那一半：服务方半路被杀再起回来，旧连接里没开工的各单必须由新连接取完（不许永久占位、不许阻塞新连接）", async () => {
    const { srcDir, recvB: dlB } = handoff ?? {};
    if (!srcDir) throw new Error("第一格没跑完（handoff 为空）⇒ 这一格的窗口无从制造");
    const t = nowMs();
    const batch = [];
    for (let i = 0; i < 4; i++) {
      const tid = eid("q");
      const name = `${tid}.bin`;
      const bytes = 40 * 1024 * 1024;
      const buf = Buffer.alloc(bytes);
      for (let k = 0; k + 4 <= bytes; k += 32) buf.writeUInt32BE(((1000 + i) * 0x85ebca6b ^ (k / 32)) >>> 0, k);
      const srcFile = path.join(srcDir, name);
      fs.writeFileSync(srcFile, buf);
      batch.push({ cid: createHash("sha256").update(buf).digest("hex"), tid, name, bytes, srcFile });
    }
    // A 侧：写"本机有完整字节"的那些行（服务原料）；B 侧：逐行 incomplete/path NULL。
    seed(INSTANCES[0].db, (db) => {
      for (const b of batch) {
        db.prepare("DELETE FROM content_transfers WHERE cid=?1").run(b.cid);
        db.prepare(
          `INSERT INTO content_transfers(cid,transfer_id,peer_id,group_id,name,size,direction,status,
             received,attempts,next_attempt_at,last_error,path,created_at,updated_at)
           VALUES(?1,NULL,?2,NULL,?3,?4,'send','complete',?4,0,0,NULL,?5,?6,?6)`,
        ).run(b.cid, S.idB.runtimeId, b.name, b.bytes, b.srcFile, t + 100 + batch.indexOf(b));
      }
    });
    seed(INSTANCES[1].db, (db) => {
      for (const b of batch) {
        db.prepare("DELETE FROM content_transfers WHERE cid=?1").run(b.cid);
        db.prepare("DELETE FROM file_transfers WHERE id=?1").run(b.tid);
        db.prepare(
          `INSERT INTO content_transfers(cid,transfer_id,peer_id,group_id,name,size,direction,status,
             received,attempts,next_attempt_at,last_error,path,created_at,updated_at)
           VALUES(?1,?2,?3,NULL,?4,?5,'receive','incomplete',0,0,0,NULL,NULL,?6,?6)`,
        ).run(b.cid, b.tid, S.idA.runtimeId, b.name, b.bytes, t + 100 + batch.indexOf(b));
      }
    });

    // 等 A 进到批次 2 的第一次服务里（那一刻队列里还有没开工的），然后**整个杀掉它**。
    // ⚠️ 这一步**不能**写成 `waitFor(...)`：旧行为里 A 根本没空开始服务批次 2（上一批的满额握手
    // 把入站占着），那条等待会以「超时（180000ms）等 …」的面目抛出去 ⇒ 报出来的红长得像基础设施坏了。
    // 现在改成有界轮询 + 一条**自己会说话的判据**：红的时候直接说出"90 秒内一次都没开始服务"。
    let serveStarted = false;
    const startDeadline = nowMs() + 90_000;
    for (;;) {
      if (countLinesWith(INSTANCES[0], "[FILE] offer SENT", batch[0].tid) > 0) { serveStarted = true; break; }
      if (nowMs() >= startDeadline) break;
      await sleep(500);
    }
    check("服务方必须真地腾出手来开始服务这一批（否则下面根本没有「半路杀掉」这个窗口）",
      serveStarted, "90s 内看见针对批次 2 第一单的 offer SENT",
      serveStarted ? "开始了" : "90s 内一次都没开始服务 ⇒ 上一批的满额握手还把这台的入站占着");
    if (!serveStarted) return; // 这一格已经红了，不必再往下杀
    // 杀之前的 accept 也算"已经开工"：2026-10-19 实测 `E2E_PULL_BIG_MB=300` 时，
    // 批次 2 的 `ucoh1k` 在 stop 前就已被旧连接接下（旧日志 17:47:55 accept RECEIVED），
    // 重启后新连接只补了其余 3 单、4 份文件全部落盘且 sha 正确。
    // 原断言要求"新连接 accept ≥ 4"把这一份合法的杀前进度当成失败 ⇒ 按**剩余份额**判。
    const preAcc = batch.reduce(
      (n, b) => n + countLinesWith(INSTANCES[0], "[FILE] accept RECEIVED", b.tid),
      0,
    );
    await stopOne(INSTANCES[0]);
    const killedAt = nowMs();
    await sleep(3_000); // 让 B 那侧真的看到链路断了（不是"进程还在、只是没回话"）
    launch(INSTANCES[0]);
    await waitFor(() => tcpOpen(INSTANCES[0].port), 60_000, "断线格：A 重起后 TCP 可连");
    await waitFor(() => bootReady(INSTANCES[0].log, bootBaseOf.get(INSTANCES[0].n), BOOT_LINE), 30_000,
      "断线格：A 重起后打出 boot 完成行");

    // 有界等 B 把这 4 单取完。窗口为什么给到 200s 而不是照抄上一格的 240s：
    // 半途断掉的那一行状态是 `active`，而 Active 的重投门是「距上次更新 > 60s」
    // （`retry_incomplete_content` 里那条，不是本轮新加的行为）⇒ 那一单最快也要 60s 才被再请求。
    const readBatch = () => {
      const d = openDb(INSTANCES[1].db, true);
      try {
        return d.prepare("SELECT cid,status,path FROM content_transfers WHERE peer_id=?1").all(S.idA.runtimeId);
      } finally { d.close(); }
    };
    let recovMs = -1;
    const dead = nowMs() + 200_000;
    for (;;) {
      const rows = new Map(readBatch().map((r) => [r.cid, r]));
      if (batch.every((b) => rows.get(b.cid)?.status === "complete" && rows.get(b.cid)?.path !== null)) {
        recovMs = nowMs() - killedAt;
        break;
      }
      if (nowMs() >= dead) break;
      await sleep(1_000);
    }
    const rows2 = new Map(readBatch().map((r) => [r.cid, r]));
    const got = batch.filter((b) => {
      const f = path.join(dlB, b.name);
      if (!fs.existsSync(f)) return false;
      return createHash("sha256").update(fs.readFileSync(f)).digest("hex") === b.cid;
    }).length;
    check("服务方半路被杀之后，剩余各单必须由**重起来的连接**取完：4 份全部落盘且逐份 sha 等于自己的 cid（旧连接里没开工的作业不许变成永久占位）",
      got === batch.length && batch.every((b) => rows2.get(b.cid)?.status === "complete" && rows2.get(b.cid)?.path !== null),
      `${batch.length} 份全部到位且台账 complete`,
      `落盘且 sha 对得上 ${got}/${batch.length} · 用时 ${recovMs === -1 ? "200s 内没补齐" : `${recovMs}ms`} · 读数 ${JSON.stringify(batch.map((b) => rows2.get(b.cid)?.status))}`);
    // 重启前 `stashLogs` 把旧日志整份移进 run 目录 ⇒ 这里数到的行**只可能来自新连接**。
    // 这就是"旧连接不阻塞新连接"的现场读数，不需要去猜是哪条链路干的。
    const newAcc = batch.reduce((n, b) => n + countLinesWith(INSTANCES[0], "[FILE] accept RECEIVED", b.tid), 0);
    const newTmo = batch.reduce((n, b) => n + countLinesWith(INSTANCES[0], "[FILE] offer TIMEOUT/REJECTED", b.tid), 0);
    check("补齐剩余的必须是**新起的那条连接**：杀前已接下的不算剩余；其余各单都必须在重启后的日志里有 accept RECEIVED、且没有一次满额超时（旧连接的队列与登记不许留在新连接上）",
      preAcc < batch.length && newAcc + preAcc >= batch.length && newTmo === 0,
      `杀前 accept < ${batch.length} 单，且杀前 + 新连接 accept ≥ ${batch.length}、超时 0 行`,
      `杀前 accept ${preAcc} 行 · 新连接 accept ${newAcc} 行 · 超时 ${newTmo} 行`);
  });

  // A-16：受众闸的「非好友、同群」那一臂此前只有纯函数单测，跨实例零判据。
  // 造法按路线图最便宜的那条：A 侧删掉 B 的好友行、只留共同群身份；B 仍保留 A 的好友行
  // （它只影响 B 的拨号/密钥解析，不影响 A 侧的授权判定）。内容行必须带 group_id，
  // 否则闸门拿不到"所属群"这件事实，测的就退化成"陌生人不许取"。
  step("内容服务受众闸：请求方不是好友、但同群 ⇒ 必须服务（A-16）", async () => {
    await stopAll();
    const token = Math.random().toString(36).slice(2, 8);
    const gid = `g-a16-${token}`;
    const tid = eid("q", token);
    const srcDir = path.join(RUN_DIR, "src", "a16");
    const dlB = path.join(RUN_DIR, "recv", "B-a16");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(dlB, { recursive: true });
    const bytes = 1024 * 1024;
    const buf = Buffer.alloc(bytes, 0x7b);
    const src = path.join(srcDir, `${tid}.bin`);
    fs.writeFileSync(src, buf);
    const cid = createHash("sha256").update(buf).digest("hex");
    const ts = nowMs();
    seed(INSTANCES[0].db, (db) => {
      db.prepare("DELETE FROM friends WHERE device_id=?1").run(S.idB.runtimeId);
      db.prepare("INSERT OR REPLACE INTO groups(id,name,creator,created_at) VALUES(?1,?2,?3,?4)")
        .run(gid, `a16-${token}`, S.idA.runtimeId, ts);
      db.prepare("DELETE FROM group_members WHERE group_id=?1").run(gid);
      for (const m of [S.idA.runtimeId, S.idB.runtimeId]) {
        db.prepare("INSERT INTO group_members(group_id,device_id) VALUES(?1,?2)").run(gid, m);
      }
      db.prepare("DELETE FROM content_transfers WHERE cid=?1").run(cid);
      db.prepare(
        `INSERT INTO content_transfers(cid,transfer_id,peer_id,group_id,name,size,direction,status,
           received,attempts,next_attempt_at,last_error,path,created_at,updated_at)
         VALUES(?1,NULL,?2,?3,?4,?5,'send','complete',?5,0,0,NULL,?6,?7,?7)`,
      ).run(cid, S.idB.runtimeId, gid, `${tid}.bin`, bytes, src, ts);
    });
    seed(INSTANCES[1].db, (db) => {
      db.prepare("INSERT OR REPLACE INTO groups(id,name,creator,created_at) VALUES(?1,?2,?3,?4)")
        .run(gid, `a16-${token}`, S.idA.runtimeId, ts);
      db.prepare("DELETE FROM group_members WHERE group_id=?1").run(gid);
      for (const m of [S.idA.runtimeId, S.idB.runtimeId]) {
        db.prepare("INSERT INTO group_members(group_id,device_id) VALUES(?1,?2)").run(gid, m);
      }
      db.prepare("DELETE FROM content_transfers WHERE cid=?1").run(cid);
      db.prepare("DELETE FROM file_transfers WHERE id=?1").run(tid);
      db.prepare(
        `INSERT INTO content_transfers(cid,transfer_id,peer_id,group_id,name,size,direction,status,
           received,attempts,next_attempt_at,last_error,path,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,'receive','incomplete',0,0,0,NULL,NULL,?7,?7)`,
      ).run(cid, tid, S.idA.runtimeId, gid, `${tid}.bin`, bytes, ts);
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('downloads_dir',?1)").run(dlB);
    });
    const friendGone = (() => {
      const db = openDb(INSTANCES[0].db, true);
      const n = db.prepare("SELECT COUNT(*) c FROM friends WHERE device_id=?1").get(S.idB.runtimeId).c;
      const m = db.prepare("SELECT COUNT(*) c FROM group_members WHERE group_id=?1").get(gid).c;
      db.close();
      return { n, m };
    })();
    for (const inst of INSTANCES) {
      launch(inst);
      await waitFor(() => tcpOpen(inst.port), 60_000, `A-16：实例 ${inst.label} 的 TCP 可连`);
      await waitFor(() => bootReady(inst.log, bootBaseOf.get(inst.n), BOOT_LINE), 30_000,
        `A-16：实例 ${inst.label} 打出 boot 完成行`);
    }
    let got = null;
    await waitFor(() => {
      const db = openDb(INSTANCES[1].db, true);
      const row = db.prepare("SELECT status,path FROM content_transfers WHERE cid=?1").get(cid);
      db.close();
      if (row?.status === "complete" && row.path) got = row;
      return !!got;
    }, 120_000, "A-16：非好友同群的内容必须被服务并落盘");
    const fileSha = got?.path && fs.existsSync(got.path)
      ? createHash("sha256").update(fs.readFileSync(got.path)).digest("hex") : null;
    const denied = countLinesWith(INSTANCES[0], "ContentRequest：请求方无权限", cid);
    const offered = countLinesWith(INSTANCES[0], "[FILE] offer SENT", tid);
    check("前置：A 侧确实不再把 B 当好友，但两人仍是同一个群的成员（否则测的不是这一臂）",
      friendGone.n === 0 && friendGone.m === 2, "好友 0 行 / 群成员 2 行",
      `好友 ${friendGone.n} 行 / 群成员 ${friendGone.m} 行`);
    check("非好友、同群 ⇒ 内容必须被服务：B 的台账到 complete 且写入了 path",
      got?.status === "complete" && !!got?.path, "complete + path 非空",
      JSON.stringify({ status: got?.status, path: got?.path }));
    check("取回的字节必须逐份等于 cid（授权放行不等于可以给错内容）",
      fileSha === cid, cid.slice(0, 12) + "…", fileSha ? fileSha.slice(0, 12) + "…" : "未落盘");
    check("A 侧必须真的走出服务分支：有 offer SENT，且没有针对这个 cid 的“无权限”拒绝",
      offered > 0 && denied === 0, "offer ≥1 行 / 拒绝 0 行",
      `offer ${offered} 行 / 拒绝 ${denied} 行`);
  });
}
