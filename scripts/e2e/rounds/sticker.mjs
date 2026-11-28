#!/usr/bin/env node
export const MODE = "STICKER";
import { INSTANCES, LIE_SHA, ROUND, RUN_DIR, S, check, eid, nowMs, openDb, seed, step, waitFor, waitSendTerminal } from "../core.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const STICKER_LIE = ROUND === "sticker-lie";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);

export async function run() {
  step("自定义表情跨实例：A 入队 sticker 文件，B 必须收到同字节且仍带表情身份", async () => {
    const tid = eid("st");
    const name = `${tid}.png`;
    const srcDir = path.join(RUN_DIR, "src", "sticker");
    fs.mkdirSync(srcDir, { recursive: true });
    const src = path.join(srcDir, name);
    fs.writeFileSync(src, PNG_1X1);
    const sha = createHash("sha256").update(PNG_1X1).digest("hex");
    const wantSha = STICKER_LIE ? LIE_SHA : sha;
    const ts = nowMs();
    const msgId = `file-${tid}`;
    const content = JSON.stringify({
      name,
      path: src,
      size: PNG_1X1.length,
      subtype: "image",
      sticker: true,
      sha256: sha,
      w: 1,
      h: 1,
    });

    seed(INSTANCES[0].db, (db) => {
      db.prepare("DELETE FROM file_outbox WHERE transfer_id=?1").run(tid);
      db.prepare("DELETE FROM file_transfers WHERE id=?1").run(tid);
      db.prepare("DELETE FROM messages WHERE msg_id=?1").run(msgId);
      const seq = db.prepare("SELECT COALESCE(MAX(seq),0)+1 s FROM messages WHERE conv_id=?1")
        .get(S.peerTo).s;
      db.prepare(
        `INSERT INTO messages(msg_id,conv_id,sender_id,receiver_id,kind,content,ts,seq,status)
         VALUES(?1,?2,?3,?4,'image',?5,?6,?7,'sending')`,
      ).run(msgId, S.peerTo, S.idA.runtimeId, S.peerTo, content, ts, seq);
      db.prepare(
        `INSERT INTO file_transfers(id,peer_id,name,size,direction,status,path,progress,sticker,created_at)
         VALUES(?1,?2,?3,?4,'send','pending',?5,0,1,?6)`,
      ).run(tid, S.peerTo, name, PNG_1X1.length, src, ts);
      db.prepare(
        `INSERT INTO file_outbox(transfer_id,peer_id,group_id,local_path,name,size,status,attempts,next_attempt_at,sticker,created_at)
         VALUES(?1,?2,NULL,?3,?4,?5,'pending',0,0,1,?6)`,
      ).run(tid, S.peerTo, src, name, PNG_1X1.length, ts);
    });

    const readB = () => {
      const db = openDb(INSTANCES[1].db, true);
      try {
        return {
          message: db.prepare("SELECT kind,content FROM messages WHERE msg_id=?1").get(msgId) ?? null,
          transfer: db.prepare("SELECT status,sticker,path FROM file_transfers WHERE id=?1").get(tid) ?? null,
          count: db.prepare("SELECT COUNT(*) c FROM messages WHERE msg_id=?1").get(msgId).c,
        };
      } finally {
        db.close();
      }
    };

    await waitFor(() => {
      const row = readB();
      return row.transfer?.status === "done" && !!row.transfer.path && fs.existsSync(row.transfer.path);
    }, 150_000, "B 侧表情传输落到 done 且最终文件在位");
    const b = readB();
    const meta = b.message ? JSON.parse(b.message.content) : null;
    const gotSha = b.transfer?.path && fs.existsSync(b.transfer.path)
      ? createHash("sha256").update(fs.readFileSync(b.transfer.path)).digest("hex")
      : null;
    const sent = await waitSendTerminal(tid);

    check("B 侧这条表情消息恰好落一条（不重复投递）",
      b.count === 1, 1, b.count);
    check("B 侧消息仍是 image/subtype=image，并保留 sticker=true 与源摘要",
      b.message?.kind === "image" && meta?.subtype === "image" && meta?.sticker === true && meta?.sha256 === wantSha,
      `image / image / sticker=true / sha=${wantSha.slice(0, 12)}…`,
      b.message === null ? "0 行" : `${b.message.kind} / ${meta?.subtype} / sticker=${meta?.sticker} / sha=${String(meta?.sha256).slice(0, 12)}…`);
    check("B 侧传输台账终态为 done 且 sticker 列保持为 1",
      b.transfer?.status === "done" && b.transfer.sticker === 1,
      "done / sticker=1", `${b.transfer?.status ?? "无行"} / sticker=${b.transfer?.sticker ?? "无行"}`);
    check("B 盘上的表情字节与源文件逐字节一致",
      gotSha === wantSha, `${wantSha.slice(0, 12)}…`, gotSha ? `${gotSha.slice(0, 12)}…` : "未落地");
    check("A 侧传输已由对端确认 done，且 file_outbox 已回收",
      sent.row?.status === "done" && sent.queued === 0,
      "done / outbox=0", `${sent.row?.status ?? "无行"} / outbox=${sent.queued}`);
    check("接收端只保留最终文件，不把 .part 当完成态",
      !!b.transfer?.path && !b.transfer.path.includes(".part") && gotSha !== null,
      "最终路径且无 .part", b.transfer?.path ?? "无路径");
  });
}
