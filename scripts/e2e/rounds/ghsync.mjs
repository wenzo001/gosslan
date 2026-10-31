#!/usr/bin/env node
// 职责边界：双实例 E2E 的 **GHSYNC** 轮次分册（一族一轮：run）。
// 为什么按族切而不是按行数切：这一族的判据只读自己那几份族私有的量，
//   跨块的只有 core 里那几个公共原语 ⇒ 一个族 = 一个文件是**作用点的边界**（口径同 group/contentpull 册）。
// ⚠️ 判据 C（scripts/check-doc-numbers.mjs）按下面这行 export const MODE 把本文件的 check( 归到这一轮：
//    改这行、或把断言挪去别的分册，都会让活文档里那句「N 条断言」当场对不上。
//
// 这一轮判的是 2026-10-16 那条需求「新进群的人自动拿到群里的聊天与群任务」里
// **只有第二个进程才能证明的那一半**：
//   Rust 侧那 32 条用例判的是"选源怎么算、一页怎么落库、授权四格、水位不复活"（同进程内存库）；
//   而"两台真的把一页密封的群历史跨链路搬过去了"这件事，只有 A 与 B 两个真进程 + 真 TCP + 真群密钥才成立。
//   在此之前 harness 从没驱动过 `group_history_request`（`grep -rn group_history scripts/e2e/rounds/` 落笔前为零命中）。
//
// ⚠️ 这一轮的预置为什么是「停机写库」而不是「让应用执行一条命令」：
// 入群的触发点是 `handle_group_key`（那条帧只有群主的 IPC 命令发得出，进程外造不出那一帧 ——
// 这条边界与 `docs/stability-roadmap.md` 里「仍缺跨实例建群那一半」是同一条），
// 所以这里直接写进 B 的 `settings` 那一行 `ghsync:group:<gid> = {"status":"pending",…}` ——
// 那正是 `note_new_membership` 在真入群时会写下的同一份形状。
// **写进去之后，后面每一帧都是生产码自己发的**（选源、摘要、取页、密封、落库、标记收口全部由两个应用自己跑完）。
//
// ⚠️ 起跑时机：B 侧没有入群钩子可触发，这一趟靠 `spawn_group_history_sweeper` 那把 60s 周期扫。
// 所以下面所有等待都按「首个扫描周期 + 一轮问答 + 分页」给到 240s；把等待压到 30s 会让这一轮
// 定期报红在时钟上而不是产品上（与 contentpull 那轮刻意用有界等待同一口径）。
export const MODE = "GHSYNC";
import {
  GROUP_ID, GROUP_KEY_STR, GROUP_NAME, INSTANCES, ROUND, RUN_DIR, S,
  bootBaseOf, check, launch, nowMs, openDb, seed, sleep, step, stopAll, tcpOpen, waitFor,
} from "../core.mjs";
import fs from "node:fs";
import path from "node:path";
import { BOOT_LINE, bootReady, countLog } from "../../e2e-logtail.mjs";

/// 反向档：拓扑、预置、时序全都一样，只把判据要读的那几条 `msg_id` 换成必定不存在的值。
/// 与所有 `-lie` 档同规矩：**不进任何门禁层**（那会把能红变成常红）。
const GHSYNC_LIE = ROUND === "ghsync-lie";

/// 这一轮的夹具正文（刻意带得上唯一的哨兵串，跨进程比对只可能命中这一轮的落库行）。
const OLD_TEXT = "group history line one from before I joined";
const OLD_TEXT2 = "group history line two from before I joined";
const TASK_ID = "e2e-ghsync-task";
const FILE_ID = "e2e-ghsync-file";
/// A 那份本机落盘路径 —— 这一轮要证明它**不会**跟着历史一起搬到 B。
const A_LOCAL_PATH = "/Users/e2e-never-appears-on-B/ghsync.png";
/// A 侧种几条历史（含一条群任务与一条文件卡片）。
const SEED_ROWS = [
  { msgId: "ghs-1", kind: "text", content: OLD_TEXT, seq: 1, tsOff: 9 * 86400_000 },
  { msgId: "ghs-2", kind: "text", content: OLD_TEXT2, seq: 2, tsOff: 9 * 86400_000 + 1000 },
  {
    msgId: "ghs-3",
    kind: "todo",
    content: JSON.stringify({ todo_id: TASK_ID, title: "买牛奶", number: 7, status: "open" }),
    seq: 3,
    tsOff: 9 * 86400_000 + 2000,
  },
  {
    msgId: `gfile-${FILE_ID}`,
    kind: "image",
    content: JSON.stringify({
      name: "ghsync.png", size: 1234, sha256: "ab".repeat(32), path: A_LOCAL_PATH,
    }),
    seq: 4,
    tsOff: 9 * 86400_000 + 3000,
  },
];

/// 停机预置：A 有全部历史，B 是"刚入群、手里一格历史都没有"的那一台。
function preset() {
  const convId = `group:${GROUP_ID}`;
  const ts = nowMs();
  for (const inst of INSTANCES) {
    seed(inst.db, (db) => {
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)")
        .run(`gk:${GROUP_ID}`, GROUP_KEY_STR);
      db.prepare("INSERT OR REPLACE INTO groups(id,name,creator,created_at) VALUES(?1,?2,?3,?4)")
        .run(GROUP_ID, GROUP_NAME, S.idA.runtimeId, ts);
      db.prepare("DELETE FROM group_members WHERE group_id=?1").run(GROUP_ID);
      for (const m of [S.idA.runtimeId, S.idB.runtimeId]) {
        db.prepare("INSERT OR IGNORE INTO group_members(group_id,device_id) VALUES(?1,?2)")
          .run(GROUP_ID, m);
      }
    });
  }
  // A：整段历史 + 会话行 + 时钟（都是"这一台早就在群里说过话"的形状）。
  seed(INSTANCES[0].db, (db) => {
    db.prepare("DELETE FROM messages WHERE conv_id=?1").run(convId);
    for (const r of SEED_ROWS) {
      db.prepare(
        `INSERT INTO messages(msg_id,conv_id,sender_id,receiver_id,kind,content,ts,seq,status)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'delivered')`,
      ).run(r.msgId, convId, S.idA.runtimeId, GROUP_ID, r.kind, r.content, ts - r.tsOff, r.seq);
    }
    db.prepare("INSERT OR REPLACE INTO conversation_clocks(conv_id,seq) VALUES(?1,?2)")
      .run(convId, SEED_ROWS.length);
    db.prepare(
      "INSERT OR REPLACE INTO conversations(id,kind,name,avatar,unread,updated_at,last_ts)"
      + " VALUES(?1,'group',?2,NULL,1,?3,?3)",
    ).run(convId, GROUP_NAME, ts);
    // A 也有一枚"已收口"标记：它是老成员，这一轮**不该**由它去拉别人（下面有一条判据读这个）。
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)").run(
      `ghsync:group:${GROUP_ID}`,
      JSON.stringify({
        status: "done", source: "", synced: 0, total: 0, updated_at: ts,
      }),
    );
  });
  // B：入群标记为 pending，除此之外手里关于这一群的东西一格都没有。
  seed(INSTANCES[1].db, (db) => {
    db.prepare("DELETE FROM messages WHERE conv_id=?1").run(convId);
    db.prepare("DELETE FROM conversations WHERE id=?1").run(convId);
    db.prepare("DELETE FROM conversation_clocks WHERE conv_id=?1").run(convId);
    db.prepare("DELETE FROM group_files WHERE group_id=?1").run(GROUP_ID);
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)").run(
      `ghsync:group:${GROUP_ID}`,
      JSON.stringify({
        status: "pending", source: "", synced: 0, total: 0, updated_at: ts,
      }),
    );
  });
}

/// 读一台关于这一群的整份历史（按 seq 升序），返回普通对象数组便于逐字段比。
function readHistory(inst) {
  const db = openDb(inst.db, true);
  try {
    return db.prepare(
      "SELECT msg_id,kind,content,ts,seq,sender_id,conv_id FROM messages WHERE conv_id=?1"
      + " ORDER BY seq ASC",
    ).all(`group:${GROUP_ID}`);
  } finally { db.close(); }
}

function readSettingRow(inst, key) {
  const db = openDb(inst.db, true);
  try {
    return db.prepare("SELECT value FROM settings WHERE key=?1").get(key)?.value ?? null;
  } finally { db.close(); }
}

function readConvRow(inst) {
  const db = openDb(inst.db, true);
  try {
    return db.prepare("SELECT id,unread,last_msg,last_ts FROM conversations WHERE id=?1")
      .get(`group:${GROUP_ID}`) ?? null;
  } finally { db.close(); }
}

function readClock(inst) {
  const db = openDb(inst.db, true);
  try {
    return db.prepare("SELECT seq FROM conversation_clocks WHERE conv_id=?1")
      .get(`group:${GROUP_ID}`)?.seq ?? 0;
  } finally { db.close(); }
}

export async function run() {
  step("群历史跨实例：B 这个新成员自动从 A 拿到了入群之前的聊天与群任务，且保真（2026-10-16 需求）", async () => {
    await stopAll();
    preset();

    // ── 夹具自查（停机读，不是"某一瞬间没发生"那种竞态判据）──
    const aRows = readHistory(INSTANCES[0]);
    check("夹具自查：A 手里确实有那几条历史（没有它就等于在空集上判绿）",
      aRows.length === SEED_ROWS.length,
      SEED_ROWS.length, aRows.length);
    const bRowsBefore = readHistory(INSTANCES[1]);
    check("夹具自查：B 这一台关于该群一格历史都没有（它必须是「新来的那一个」）",
      bRowsBefore.length === 0, 0, bRowsBefore.length);
    check("夹具自查：B 的会话行也不存在（新成员原本就看不到这个群）",
      readConvRow(INSTANCES[1]) === null, "无会话行", JSON.stringify(readConvRow(INSTANCES[1])));

    for (const inst of INSTANCES) launch(inst);
    for (const inst of INSTANCES) {
      await waitFor(() => tcpOpen(inst.port), 60_000, `群历史轮：实例 ${inst.label} 的 TCP ${inst.port} 可连`);
      await waitFor(() => bootReady(inst.log, bootBaseOf.get(inst.n), BOOT_LINE),
        30_000, `群历史轮：实例 ${inst.label} 打出 boot 完成行`);
    }
    await waitFor(() => countLog(INSTANCES[1].log, `建链 peer=${S.idA.runtimeId}`) > 0,
      60_000, "前置：B 与 A 建成链路（没有直连就没有这一趟的来源）");

    // ── 等 B 自己把历史搬回来（靠生产侧的清扫任务触发，见文件头那条时机说明）──
    // ★ **等待用真 id、判据读翻过的 id**（口径照 `--round=groupcrash` 那条）：反向档里生产
    //   照样把四条搬到位，判据去看那套必然不存在的 id ⇒ 红只可能来自"判据读的那一格"，
    //   而不是应用没起来。等待要是也跟着翻，反向轮就得白等满 240 秒才出结论。
    const want = (id) => (GHSYNC_LIE ? `${id}-lie` : id);
    let rows = [];
    {
      const until = nowMs() + 240_000;
      for (;;) {
        rows = readHistory(INSTANCES[1]);
        const landed = SEED_ROWS.every((r) => rows.some((x) => x.msg_id === r.msgId));
        if (landed || nowMs() >= until) break;
        await sleep(2000);
      }
    }
    check("★ B 的库里出现了 A 那四条历史（新成员自动拿到入群之前的聊天与群任务）",
      SEED_ROWS.every((r) => rows.some((x) => x.msg_id === want(r.msgId)))
        && rows.length === SEED_ROWS.length,
      `${SEED_ROWS.length} 行：${SEED_ROWS.map((r) => want(r.msgId)).join(",")}`,
      `${rows.length} 行：${rows.map((r) => r.msg_id).join(",")}`);
    const byId = new Map(rows.map((r) => [r.msg_id, r]));

    // 下面这几格逐个判"搬过去的到底是不是同一件事"，都是这轮真正新增的东西：
    // 单测里判过一遍，但那是同一个进程的一份内存库；跨进程这一段今天第一次有读数。
    // 保真那一格**按行分开判**：文件卡片那条的正文在上线前刻意被剥掉了本机路径（剥路径正是
    // 下面单独那条判据要钉的事），所以它的期望是"字段还在、path 不给了"，不是逐字节相等 ——
    // 跨语言比 JSON 的**字节**会把 serde 的键顺序当成契约（本仓为"我以为的实现形状"付过学费）。
    // 其余三条没有被剥任何东西，逐字相等才是对的期望。
    const contentMatches = (r, got) => {
      if (r.kind !== "image") return got.content === r.content;
      let o;
      try { o = JSON.parse(got.content); } catch { return false; }
      const want = JSON.parse(r.content);
      return o?.name === want.name && o?.size === want.size && o?.sha256 === want.sha256
        && (o.path === undefined || o.path === null);
    };
    check("正文与发送者与 seq 保真（同一条逻辑消息，实时收到与同步来的不许成两件事：INV-P08）",
      SEED_ROWS.every((r) => {
        const got = byId.get(want(r.msgId));
        return !!got && contentMatches(r, got) && got.sender_id === S.idA.runtimeId
          && got.seq === r.seq && got.conv_id === `group:${GROUP_ID}`;
      }),
      SEED_ROWS.map((r) => `${r.msgId}:seq=${r.seq}`).join(" | "),
      SEED_ROWS.map((r) => {
        const g = byId.get(want(r.msgId));
        return g ? `${g.msg_id}:seq=${g.seq}/${g.content.slice(0, 20)}` : `${r.msgId}:<无此行>`;
      }).join(" | "));

    const aTs = new Map(aRows.map((r) => [r.msg_id, r.ts]));
    check("★ 显示时间是 A 当初发那条的时刻，不是 B 收到这一页的时刻（照抄实时接收那句 now_ms 就会全变「刚刚」）",
      SEED_ROWS.every((r) => byId.get(want(r.msgId)) && byId.get(want(r.msgId)).ts === aTs.get(r.msgId)),
      SEED_ROWS.map((r) => `${r.msgId}=${aTs.get(r.msgId)}`).join(","),
      SEED_ROWS.map((r) => `${r.msgId}=${byId.get(want(r.msgId))?.ts}`).join(","));

    const task = byId.get(want("ghs-3"));
    check("群任务那一行进来了、kind 仍是 todo、载荷里的 todo_id 与编号原样",
      task?.kind === "todo" && task?.content.includes(TASK_ID) && task?.content.includes('"number":7'),
      `todo / ${TASK_ID} / number=7`, `${task?.kind} / ${task?.content}`);

    const card = byId.get(want(`gfile-${FILE_ID}`));
    check("★ 文件卡片那行的 A 本机路径被剥掉了（带着它 B 会去预览一个本机不存在的路径）",
      !!card && !card.content.includes(A_LOCAL_PATH) && card.content.includes("ab".repeat(32)),
      "不含本机路径、仍含 sha256", `${card?.content}`);

    const conv = readConvRow(INSTANCES[1]);
    check("B 的会话行由这次聊天活动建出来，且未读为 0（补 4 条历史不该变成 4 条红点）",
      !!conv && conv.unread === 0, "会话行存在且 unread=0", JSON.stringify(conv));

    // ── 审计 A1（用户 2026-10-31 拍板）：补齐后那一行的**两个字段**也要有跨进程读数 ──────
    // 上面那格只判了 unread。`last_msg`/`last_ts` 一直在读却从没被断言过，而 A1 要的就是这两格。
    // 单测（`src-tauri/src/db/group_history.rs` 里 `history_sync_recomputes_the_head_but_never_the_unread`
    // 与 `the_head_follows_the_logical_clock_and_ignores_silent_rows`）在同一进程的一份内存库里判过；
    // 这里判的是"B 那台把**密封的一页**解开、落库之后，生产码有没有把它自己库里的这一行挪到真实末条"。
    // 期望从**库里现算**，不在这里点名"哪条该是末条"：口径与产品同一句 —— 取 `seq` 最大
    // （`db/conversations.rs` 的 `newest_message_for_summary` 用 `ORDER BY seq DESC` 而不是 `ts`；
    // 两台时钟不同步时按 ts 取会把摘要写成时间线里更早的一条，那正是 A1 的原始症状）。
    // ⚠️ 这一轮的夹具四条 kind（text/text/todo/image）都可当末条，没有 reaction/pin 那类静默行 ⇒
    //   这里可以直接取最大 seq；将来夹具若种进静默事件，要跟着 `newest_message_for_summary` 的排除口径改。
    const newestRow = rows.length ? rows.reduce((a, b) => (b.seq > a.seq ? b : a)) : null;
    const headRow = newestRow ? byId.get(want(newestRow.msg_id)) : null;
    check("★ 补齐后 B 那一行的排序键 = 库里真实末条自己的 ts（不是同步时刻：写 now 会把补来的历史顶到列表最前）",
      !!conv && !!headRow && conv.last_ts === headRow.ts,
      `last_ts=${headRow?.ts}（末条 ${headRow?.msg_id} seq=${headRow?.seq}）`,
      `last_ts=${conv?.last_ts} / 而这一趟的同步时刻约 ${nowMs()}`);
    // 预览文案不在这本手抄 kind→字面量表：从 `protocol::preview_text` 那一个家现解析
    //（TS 侧与 Rust 侧那两组标签已由 `src/utils/messageKinds.test.ts` 的 DUP-12 逐项钉死 ⇒
    //  解析出来的就是界面会画的那一句）。解析不到就把期望写成 null ⇒ 这一格红在仪表上，不静默放行。
    const previewLabel = (kind) => {
      const src = fs.readFileSync(new URL("../../../src-tauri/src/protocol.rs", import.meta.url), "utf8");
      const at = src.indexOf("pub fn preview_text");
      const m = at > 0
        && new RegExp(`"${kind}" => "(\\[[^\\]]{1,8}\\])"`).exec(src.slice(at, src.indexOf("\n}", at)));
      return m ? m[1] : null;
    };
    const wantLabel = headRow ? previewLabel(headRow.kind) : null;
    check("★ 补齐后 B 那一行的预览 = 真实末条那种 kind 的人话标签（JSON 载荷不许漏进会话列表）",
      !!conv && !!wantLabel && conv.last_msg === wantLabel,
      wantLabel ?? "<从 protocol.rs 解析不到该 kind 的预览标签 ⇒ 仪表坏了>",
      `last_msg=${JSON.stringify(conv?.last_msg)} / 末条 kind=${headRow?.kind}`);

    const clockB = readClock(INSTANCES[1]);
    check("B 的会话逻辑时钟被抬到历史之后（否则 B 之后自己发的消息会排到刚同步来的历史前面）",
      clockB >= SEED_ROWS.length, `>= ${SEED_ROWS.length}`, String(clockB));

    const stateB = readSettingRow(INSTANCES[1], `ghsync:group:${GROUP_ID}`);
    let parsed = null;
    try { parsed = JSON.parse(stateB || "null"); } catch { /* 坏 JSON 当作没状态，交给下面那条判据报红 */ }
    check("★ B 的同步标记从 pending 收成 done（没跑完就不写标记那条纪律的跨进程读数）",
      parsed?.status === "done" && parsed?.source === S.idA.runtimeId,
      `done / source=${S.idA.runtimeId}`, stateB);

    check("A 侧日志里留下了「交出一页」那一条（服务端确实在应答，不是 B 自己造出来的行）",
      countLog(INSTANCES[0].log, "群历史交出一页") > 0,
      ">=1 行", String(countLog(INSTANCES[0].log, "群历史交出一页")));
    check("B 侧日志里留下了「同步收口」那一条，且写的是新入库条数",
      countLog(INSTANCES[1].log, "群历史同步收口") > 0,
      ">=1 行", String(countLog(INSTANCES[1].log, "群历史同步收口")));

    // 老成员那一格：A 自己也带着"已收口"标记，它不该反过来向 B 拉历史。
    // ⚠️ 这一格判的是"没有反向那一页"，而 A 手里本来就有全部四行 ⇒ 反向拉取即使发生也只会是
    //   duplicate 一行不增，所以**不能**拿 A 的行数当判据；能判的只有 A 的日志里
    //   没有"作为请求方"的那条收口行（B 才会打"交出一页"）。
    check("A 没有反过来向 B 拉历史（它的标记已是 done：老成员不该被这轮扫到）",
      countLog(INSTANCES[0].log, "群历史交出一页") >= 1
      && countLog(INSTANCES[0].log, "群历史同步收口") === 0,
      "A 只答不拉（收口行 0）",
      `交出一页=${countLog(INSTANCES[0].log, "群历史交出一页")} / 收口=${countLog(INSTANCES[0].log, "群历史同步收口")}`);

    // ── 第二阶段（2026-10-27）：**重连补拉** ──────────────────────────────────────
    // 用户场景：A 发任务时 C 离线；随后 A 也下线。C 再上线时，谁把任务给它？
    // 旧行为：没有任何触发点 —— 待同步标记只在"新成员入群"时写，C 是老成员 ⇒ 永远拉不到。
    // 这一阶段模拟同一件事：B 先同步过一次（标记 done），随后停机；A 在它离线期间再发一条；
    // B 重新上线 ⇒ 靠 Hello 时的摘要探测发现"A 比我全"，写 pending 并补拉。
    await stopAll();
    const convId = `group:${GROUP_ID}`;
    const CATCHUP_ID = "ghs-5";
    const CATCHUP_TASK = "e2e-ghsync-catchup-task";
    const catchupTs = nowMs();
    seed(INSTANCES[0].db, (db) => {
      db.prepare(
        `INSERT INTO messages(msg_id,conv_id,sender_id,receiver_id,kind,content,ts,seq,status)
         VALUES(?1,?2,?3,?4,'todo',?5,?6,5,'delivered')`,
      ).run(CATCHUP_ID, convId, S.idA.runtimeId, GROUP_ID,
        JSON.stringify({ todo_id: CATCHUP_TASK, title: "离线期间的任务", number: 8, status: "open" }),
        catchupTs);
      db.prepare("UPDATE conversation_clocks SET seq=5 WHERE conv_id=?1").run(convId);
    });
    // 前置：B 的标记仍是 done ⇒ 旧逻辑（只扫 pending）下它永远不会再看这一群。
    let bStateBefore = null;
    try { bStateBefore = JSON.parse(readSettingRow(INSTANCES[1], `ghsync:group:${GROUP_ID}`) || "null"); } catch { /* 交给下面那条判据报红 */ }
    check("重连补拉前置：B 的标记是 done（老成员不会被清扫任务扫到 —— 这正是缺的那条触发点）",
      bStateBefore?.status === "done", "status=done", JSON.stringify(bStateBefore));
    check("重连补拉前置：A 手里确实多了一条 B 没有的（没有它就等于在空集上判绿）",
      readHistory(INSTANCES[0]).length === SEED_ROWS.length + 1
        && !readHistory(INSTANCES[1]).some((r) => r.msg_id === CATCHUP_ID),
      `${SEED_ROWS.length + 1} 行 / B 侧无 ${CATCHUP_ID}`,
      `A=${readHistory(INSTANCES[0]).length} B=${readHistory(INSTANCES[1]).length}`);

    for (const inst of INSTANCES) launch(inst);
    for (const inst of INSTANCES) {
      await waitFor(() => tcpOpen(inst.port), 60_000, `重连补拉：实例 ${inst.label} 的 TCP ${inst.port} 可连`);
      await waitFor(() => bootReady(inst.log, bootBaseOf.get(inst.n), BOOT_LINE),
        30_000, `重连补拉：实例 ${inst.label} 打出 boot 完成行`);
    }
    let caught = [];
    {
      const until = nowMs() + 180_000;
      for (;;) {
        caught = readHistory(INSTANCES[1]);
        if (caught.some((x) => x.msg_id === want(CATCHUP_ID)) || nowMs() >= until) break;
        await sleep(2000);
      }
    }
    check("★ 重连后 B 自动补上了离线期间那条任务（A 已发完就退出的同形场景）",
      caught.some((x) => x.msg_id === want(CATCHUP_ID) && x.content.includes(CATCHUP_TASK)),
      `含 ${want(CATCHUP_ID)}`,
      `${caught.length} 行：${caught.map((x) => x.msg_id).join(",")}`);
    check("补拉是幂等的：B 的历史正好多出那一条，没有重复行",
      caught.length === SEED_ROWS.length + 1,
      SEED_ROWS.length + 1, caught.length);
    // A1 里"重复执行历史补齐不能产生错误预览或错误排序"那一格在跨进程层的读数：
    // 补来的那条 seq=5 比第一阶段四条都新 ⇒ 那一行的排序键必须跟着挪（第一阶段的末条是
    // 那张图片卡片）。这里只比排序键的**推进**，不再判预览文案 —— 任务卡片的 `[任务] …` 口径
    // 有 Rust 单测与 DUP-12 那格跨语言对账兜着，抄第二份字面量只会造出第二个真源。
    const conv2 = readConvRow(INSTANCES[1]);
    const newHead = caught.find((x) => x.msg_id === want(CATCHUP_ID));
    check("★ 重复补齐后 B 那一行的排序键挪到新落库那条真实末条上（没留在第一阶段那张图片卡片）",
      !!conv2 && !!newHead && conv2.last_ts === newHead.ts && conv2.last_ts > conv.last_ts,
      `last_ts=${newHead?.ts}（> 第一阶段 ${conv?.last_ts}）`,
      `last_ts=${conv2?.last_ts} / msg=${JSON.stringify(conv2?.last_msg)}`);
    check("B 侧日志留下了「重连补拉」那条（证明走的是新触发点，不是清扫任务碰巧扫到）",
      countLog(INSTANCES[1].log, "重连补拉") > 0,
      ">=1 行", String(countLog(INSTANCES[1].log, "重连补拉")));
    let bStateAfter = null;
    try { bStateAfter = JSON.parse(readSettingRow(INSTANCES[1], `ghsync:group:${GROUP_ID}`) || "null"); } catch { /* 同上 */ }
    check("补拉收口后 B 的标记回到 done（没跑完不写完成标记那条纪律照常成立）",
      bStateAfter?.status === "done", "status=done", JSON.stringify(bStateAfter));

    try {
      fs.copyFileSync(INSTANCES[1].log, path.join(RUN_DIR, `instance-${INSTANCES[1].label}.app.log`));
      fs.mkdirSync(path.join(RUN_DIR, `sqlite-${INSTANCES[1].label}`), { recursive: true });
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(INSTANCES[1].db + suffix)) {
          fs.copyFileSync(INSTANCES[1].db + suffix,
            path.join(RUN_DIR, `sqlite-${INSTANCES[1].label}`, path.basename(INSTANCES[1].db + suffix)));
        }
      }
    } catch { /* 产物复制失败不改判定（判定只看库与日志里的真事实） */ }
  });
}
