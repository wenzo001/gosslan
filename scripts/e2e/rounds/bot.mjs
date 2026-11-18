#!/usr/bin/env node
// 职责边界：双实例 E2E 的 **BOT** 轮次分册（一族一轮：run）。
//
// 这一轮补的是 **v7 产品核心那条链**，而它在 2026-11-18 之前是零跨进程判据：
//   外部系统 `POST /publish/<send_token>` → 服务端入队落盘 → 客户端自己的后台轮询
//   `GET /pull/<client_token>` 取件 → 落 messages / conversations / bot_inbox 三处
//   → 投递成功才 `GET /ack/<client_token>/<event_id>` → 服务端队列清空。
//
// ## 为什么必须跨进程，而不是再加几条 Rust 单测
//
// `bots.rs` 那 13 条钉的都是**纯函数与 DB 往返**（`normalize_bot_server` 的形状、轮询策略、
// 收件箱幂等）。而这条链上有三件事只有真进程才看得见：
//   ① 后台 worker 真的在跑（`spawn_bot_poller` 是 `lib.rs` 里挂上去的，不是单测调用的）；
//   ② 客户端拿到的 event 会**同时**落 messages 与 bot_inbox（同一事务），
//      而「只落一处」在单测里各测各的、合起来不成立也没人发现；
//   ③ ack 是**投递成功之后**才发的（`pull_bot_once` 里 `if ok { ack }`），
//      所以「服务端队列清空」这件事本身就是「客户端认为投递成功」的独立证据。
//
// ## 服务端为什么是 `import` 真实现，而不是自己写个假 HTTP 服务
//
// 假服务只能证明「客户端会调用某个形状」，证明不了「客户端的形状与服务端实现一致」。
// 这里 `import` 的是 `gosslan-relay-server/notify.mjs`（v7 现役那一份），
// 只由本册给它套一层 20 行的 http 宿主 —— 生产里那层宿主是 `server.mjs`。
// ⚠️ 因此这一轮**依赖兄弟仓**（默认 `../gosslan-relay-server`，可用
// `GOSSLAN_RELAY_SERVER_DIR` 覆盖）。找不到就**红**，不静默跳过（§十：没跑不许写成 PASS）。
//
// ## 判据为什么这么排
//
// `queued 0 → 1 → 0` 是贯穿这条链的**单一计数器**：publish 前 0、publish 后 1、ack 后 0。
// 少了任何一环它都变不了 —— 比「读三张表然后各自解释」更难糊弄。
// 落库那几条读的是**产品自己写的行**（`botmsg-md-<event_id>` 的 msg_id 前缀是产品为
// 「Markdown 正文」造的契约，见 `deliver_event`），不是夹具自己拼的期望。
//
// ## 反向档
//
// `--round=bot-lie` 只翻**一条**期望：那行消息的 msg_id 前缀（`botmsg-md-` → `botmsg-`）。
// 预置、时序、服务端一个字节不动 ⇒ 恰好那一条红、其余照绿 ——
// 证明「绿是这条判据咬出来的」，不是「这一轮什么都没验」。
// 反向档不进任何门禁层（预期红）。
export const MODE = "BOT";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  INSTANCES, ROOT, ROUND, RUN_DIR, bootBaseOf, check, launch, openDb, seed,
  step, stopAll, tcpOpen, waitFor,
} from "../core.mjs";
import { BOOT_LINE, bootReady, readLogTail } from "../../e2e-logtail.mjs";

const BOT_LIE = ROUND === "bot-lie";
/// 有机器人的那一台（个人机器人 = 本机假身份会话，不需要对端）。
const A = INSTANCES[0];
/// 通知服务的 HTTP 端口：**刻意避开** 59993/59994（产品默认值，本机可能真跑着服务）
/// 与实例的 P2P 端口（59992 + n*10）。选 60994，起跑前再确认它真的空着。
const HTTP_PORT = 60994;

/// 兄弟仓位置：默认与主仓同级，可用环境变量覆盖。
const RELAY_DIR = process.env.GOSSLAN_RELAY_SERVER_DIR
  ?? path.resolve(ROOT, "..", "gosslan-relay-server");
const NOTIFY_MJS = path.join(RELAY_DIR, "notify.mjs");

const BOT_ID = `bot_e2e${Date.now().toString(36).slice(-6)}`;
const BOT_NAME = "E2E 通知机器人";
const SENT_TEXT = "**构建完成**\n- 分支：main\n- 用时：3m12s";
const SENT_TITLE = "CI";

let httpServer = null;
let sendToken = "";
let clientToken = "";
let eventId = "";

const urlOf = (p) => `http://127.0.0.1:${HTTP_PORT}${p}`;

/// 带超时的 JSON 请求（Node 内置 fetch 没有默认超时；长轮询要 15s，所以给 25s）。
async function req(method, p, body, timeoutMs = 25_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(urlOf(p), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 原样留在 text 里 */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

const queued = async () => (await req("GET", "/healthz")).json?.queued ?? -1;

/// 读 A 库里的机器人消息行（**不按前缀读**，否则反向档会连坐下面几条）。
function readBotMessages(id) {
  const db = openDb(A.db, true);
  try {
    return db.prepare("SELECT * FROM messages WHERE msg_id LIKE ?1").all(`%${id}`);
  } finally { db.close(); }
}

function readConversation() {
  const db = openDb(A.db, true);
  try {
    return db.prepare("SELECT * FROM conversations WHERE id=?1").get(`bot:${BOT_ID}`);
  } finally { db.close(); }
}

function countOutbox(msgId) {
  const db = openDb(A.db, true);
  try {
    return db.prepare("SELECT COUNT(*) c FROM outbox WHERE msg_id=?1").get(msgId).c;
  } finally { db.close(); }
}

function readInbox() {
  const db = openDb(A.db, true);
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key=?1").get(`bot_inbox:${BOT_ID}`)?.value;
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  } finally { db.close(); }
}

function readBotRecord() {
  const db = openDb(A.db, true);
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key=?1").get(`bot:${BOT_ID}`)?.value;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  } finally { db.close(); }
}

/// 关掉 HTTP 宿主。不关的话下一次 `--round=bot` 会撞上「端口被占」，
/// 而 60994 又是本轮**刻意选的固定端口**（不用随机端口：随机端口的失败现场没法复跑）。
async function closeServer() {
  if (!httpServer) return;
  await new Promise((resolve) => httpServer.close(resolve));
  httpServer = null;
}

export async function run() {
  step("机器人轮：publish → 客户端自取 → 落库 → ack（v7 产品核心那条链第一次跨进程）", async () => {
    try {
      // ── 0. 夹具前置：兄弟仓的现役实现必须真在，端口必须真空 ──
      const implOk = fs.existsSync(NOTIFY_MJS);
      check("通知服务实现存在（兄弟仓 gosslan-relay-server/notify.mjs，可用 GOSSLAN_RELAY_SERVER_DIR 覆盖）",
        implOk, NOTIFY_MJS, implOk ? NOTIFY_MJS : "缺文件（这一轮没法验证真链路）");
      if (!implOk) return;
      // ⚠️ `tcpOpen` 返回的是 Promise（`core.mjs` 里包在 `new Promise` 里）。
      // 写成 `!tcpOpen(port)` 会恒得 `false` —— Promise 恒真 ⇒ 这条自检恒红，
      // 读数是「永远被占用」而不是端口真被占。必须先 await 再取反。
      const busy = await tcpOpen(HTTP_PORT);
      const free = !busy;
      check(`端口 ${HTTP_PORT} 空闲（被占用时这一轮会打到别人家的服务上 ⇒ 读数全无意义）`,
        free, "空闲", free ? "空闲" : "被占用");
      if (!free) return;

      // ── 1. 起 v7 通知服务（真 notify.mjs + 本册那层最小 http 宿主）──
      // `WEBHOOK_DATA_DIR` 必须在 import 之前设：notify.mjs 在**模块求值时**就读它。
      process.env.WEBHOOK_DATA_DIR = path.join(RUN_DIR, "notify-data");
      const notifyMod = await import(pathToFileURL(NOTIFY_MJS).href);
      httpServer = http.createServer((rq, rs) => {
        // 请求日志：判红时「客户端到底有没有来取」是第一个要回答的问题。
        // 没有这行就只能靠猜（服务端队列没清空 ≠ 客户端没来，也可能是它拿错 token 被拒）。
        console.log(`      [notify] ${rq.method} ${rq.url}`);
        notifyMod.handleNotify(rq, rs).then((handled) => {
          if (handled) return;
          if (new URL(rq.url, "http://127.0.0.1").pathname === "/healthz") {
            rs.writeHead(200, { "content-type": "application/json; charset=utf-8" })
              .end(JSON.stringify(notifyMod.notifyStats()));
            return;
          }
          rs.writeHead(404, { "content-type": "application/json; charset=utf-8" })
            .end(JSON.stringify({ error: "not_found" }));
        }).catch(() => { if (!rs.headersSent) rs.writeHead(500).end(); });
      });
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(HTTP_PORT, "127.0.0.1", resolve);
      });

      // ── 2. 注册机器人（服务端生成两把 token，与客户端 `bot_create` 拿到的是同一契约）──
      const reg = await req("POST", "/v1/bots", { name: BOT_NAME });
      sendToken = reg.json?.send_token ?? "";
      clientToken = reg.json?.client_token ?? "";
      check("注册机器人返回 201，且两把 token 都 ≥32 且互不相同（发送密钥 ≠ 取件密钥）",
        reg.status === 201 && sendToken.length >= 32 && clientToken.length >= 32 && sendToken !== clientToken,
        "201 / 各 ≥32 且互不相同",
        `${reg.status} / ${sendToken.length} 与 ${clientToken.length}`);

      // ── 3. 预置 A 的机器人记录（形状与 `bot_create` 落库逐字段一致：settings 表，键 bot:<id>）──
      await stopAll();
      const record = {
        botId: BOT_ID,
        name: BOT_NAME,
        scope: "personal",
        doNotDisturb: false,
        avatar: "",
        serverUrl: `http://127.0.0.1:${HTTP_PORT}`,
        clientToken,
        publishUrl: urlOf(`/publish/${sendToken}`),
        target: { kind: "inbox", groupId: null, groupName: null },
        status: "active",
        createdAt: Date.now(),
        lastEventAt: null,
        lastError: null,
        pending: 0,
        failed: 0,
      };
      seed(A.db, (db) => {
        db.prepare("DELETE FROM settings WHERE key=?1").run(`bot_inbox:${BOT_ID}`);
        db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)")
          .run(`bot:${BOT_ID}`, JSON.stringify(record));
      });
      const readBack = readBotRecord();
      check("夹具自查：预置的机器人记录能被原样读回（status=active、target=inbox、token 非空）",
        readBack?.status === "active" && readBack?.target?.kind === "inbox" && !!readBack?.clientToken,
        "active / inbox / 有 clientToken",
        `${readBack?.status} / ${readBack?.target?.kind} / ${readBack?.clientToken ? "有" : "无"}`);

      // ── 4. 起 A（后台轮询 worker 随应用启动；首轮延迟 20s 是产品自己的节流，不改）──
      launch(A);
      await waitFor(() => tcpOpen(A.port), 60_000, `实例 A 的 TCP ${A.port} 可连`);
      await waitFor(() => bootReady(A.log, bootBaseOf.get(A.n), BOOT_LINE), 30_000,
        "实例 A 打出 boot 完成行");

      const before = await queued();
      check("publish 之前服务端队列是 0（给下面那条 1 当对照）",
        before === 0, 0, before);

      // ── 5. 外部系统投递（就是用户文档里那条 curl 的形状）──
      const pub = await req("POST", `/publish/${sendToken}`,
        { text: SENT_TEXT, title: SENT_TITLE, format: "markdown" });
      eventId = pub.json?.id ?? "";
      check("外部发布返回 200 且带 event_id（服务端先落盘才报成功）",
        pub.status === 200 && /^[0-9a-f-]{36}$/.test(eventId),
        "200 / 一个 UUID", `${pub.status} / ${eventId || "无 id"}`);

      const afterPub = await queued();
      check("发布之后队列恰好 1 条（入队真发生了，不是立刻被谁吃掉）",
        afterPub === 1, 1, afterPub);

      // ── 6. 等客户端自己拉走并落库（后台轮询 ≤20s 首延迟 + 长轮询立即唤醒）──
      const msgId = `botmsg-md-${eventId}`;
      await waitFor(() => readBotMessages(eventId).length > 0, 90_000,
        `A 侧出现这条机器人消息（msg_id 前缀 botmsg-md-，event=${eventId}）`);

      const rows = readBotMessages(eventId);
      const wantMsgId = BOT_LIE ? `botmsg-${eventId}` : msgId;
      check("A 侧落了一行机器人消息，msg_id 前缀说明它按 Markdown 正文渲染（反向档只翻这条）",
        rows.length === 1 && rows[0].msg_id === wantMsgId,
        `${wantMsgId}（恰好 1 行）`,
        `${rows.map((r) => r.msg_id).join(", ") || "无行"}`);
      check("这一行的会话与本机假身份都是 bot:<botId>（机器人消息不进网络、不占真会话）",
        rows[0]?.conv_id === `bot:${BOT_ID}` && rows[0]?.sender_id === `bot:${BOT_ID}`,
        `bot:${BOT_ID}`,
        `${rows[0]?.conv_id ?? "无行"} / ${rows[0]?.sender_id ?? "无行"}`);
      check("正文逐字等于发送内容（8192 以内不许截断 —— 会话列表的折行是 UI 的事）",
        rows[0]?.content === SENT_TEXT, SENT_TEXT, rows[0]?.content ?? "无行");
      const outboxRows = rows.length === 1 ? countOutbox(rows[0].msg_id) : -1;
      check("这条消息**不在** outbox 里（Frozen Core 红线：机器人消息不上可靠发送队列）",
        outboxRows === 0, 0, outboxRows);

      const conv = readConversation();
      check("会话列表里出现了这个机器人会话，摘要是刚收到的那条正文",
        !!conv && conv.id === `bot:${BOT_ID}` && conv.last_msg === SENT_TEXT,
        `bot:${BOT_ID} / ${SENT_TEXT}`,
        `${conv?.id ?? "无该会话"} / ${conv?.last_msg ?? "无摘要"}`);

      const inbox = readInbox();
      check("收件箱（bot_inbox）里有这条 event（幂等窗口与展示历史是两份，都要有）",
        inbox.length === 1 && inbox[0].eventId === eventId,
        1, `${inbox.length} 条`);

      // ── 7. ack 之后服务端必须真清空：这是「客户端认为投递成功」的独立证据 ──
      await waitFor(async () => (await queued()) === 0, 60_000, "服务端队列被 ack 清成 0");
      const drained = await queued();
      check("投递成功后服务端队列清成 0（ack 是产品代码在落库成功之后发的）",
        drained === 0, 0, drained);

      const again = await req("GET", `/pull/${clientToken}`);
      const left = again.json?.events?.length ?? -1;
      check("ack 之后再拉一次拿到 0 条（不是「取件不删」那种假消费）",
        again.status === 200 && left === 0, "200 / 0 条", `${again.status} / ${left} 条`);

      // ── 8. 日志：轮询 worker 真跑过自己那一轮，且带的是这个 bot 的 id ──
      const log = readLogTail(A.log, 4000) || "";
      const hit = log.split("\n").filter((l) => l.includes("收到机器人通知") && l.includes(BOT_ID));
      check("A 侧日志里有一行「收到机器人通知」且带这个 bot id（后台 worker 真跑过，不是别处塞的）",
        hit.length >= 1, "≥1 行", `${hit.length} 行`);
    } finally {
      // 关掉 HTTP 宿主：60994 是固定端口，留着会让下一次同一轮起不来。
      await closeServer();
    }
  });
}
