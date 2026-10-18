#!/usr/bin/env node
// 职责边界：双实例 E2E 的 **MULTI** 轮次分册（一族一轮：run）。
// 为什么按族切而不是按行数切：这一族的判据只读自己那几份族私有的量
//   （AST 现算：89 个顶层名字只在某一个块里出现，跨块的只有 9 个），所以一个族 = 一个文件是**作用点的边界**。
// 「只搬不改」在这里是可证的：块体本来就是 2 格缩进（顶层 if 之内）⇒ 去掉旗标行与它顶格的 } 之后
//   正好是函数体缩进，逐字即所得、一行没重排。旗标与分发留在驱动脚本 e2e-multi-instance.mjs
//   （判据 D 与契约图那条 ROUND 现读命令因此一字不用改）。
// ⚠️ 判据 C（scripts/check-doc-numbers.mjs）按下面这行 export const MODE 把本文件的 check( 归到这一轮：
//    改这行、或把断言挪去别的分册，都会让活文档里那句「N 条断言」当场对不上。
export const MODE = "MULTI";
import { INSTANCES, INST_C, LIE, LIE_SHA, RUN_DIR, S, bootBaseOf, check, eid, launch, nowMs, openDb, readIdentity, seed, sleep, step, stopAll, tcpOpen, waitFor } from "../core.mjs";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { BOOT_LINE, bootReady } from "../../e2e-logtail.mjs";

// ── 族私有的量（只有这一族读；随块一起搬过来）──

let multiSpec = [];

export async function run() {
  step("故障注入判据⑦：三个文件一起排队、其中两个同名 ⇒ 一张都不许丢、内容不许串味", async () => {
    const dl = path.join(RUN_DIR, "recv", "B");
    fs.mkdirSync(dl, { recursive: true });
    const token = Math.random().toString(36).slice(2, 8);
    const photoName = `photo-${token}.bin`;
    const noteName = `note-${token}.bin`;
    // 同名的两张必须放在**不同目录**（同一路径放不下两个文件）：offer 的 name 取自路径的
    // file_name（`file.rs:358`），所以"同名不同内容"只能这样造。
    const layout = [
      { dir: "p1", name: photoName, bytes: 1024 * 1024, fill: 0xa1 },
      { dir: "p2", name: photoName, bytes: 64 * 1024, fill: 0xb2 },
      { dir: "p1", name: noteName, bytes: 256 * 1024, fill: 0xc3 },
    ];
    multiSpec = layout.map((l, i) => {
      const d = path.join(RUN_DIR, "src", l.dir);
      fs.mkdirSync(d, { recursive: true });
      const src = path.join(d, l.name);
      fs.writeFileSync(src, Buffer.alloc(l.bytes, l.fill));
      return {
        tid: eid("m", `${token}-${i}`),
        src,
        name: l.name,
        bytes: l.bytes,
        sha: createHash("sha256").update(fs.readFileSync(src)).digest("hex"),
      };
    });
    // lie：注入完全一样，只把**其中一张**的期望摘要换掉 ⇒ 那条多重集合判据必须红。
    // 用集合而不是"随便挑一张比对"，就是为了验证"每份内容各自对上了"，不是"对上了三份里的任意一份"。
    const wantShas = multiSpec.map((s) => s.sha).sort();
    if (LIE) wantShas[0] = LIE_SHA;
    for (let i = 0; ; i++) {
      try {
        seed(INSTANCES[0].db, (db) => {
          const ins = db.prepare(
            `INSERT INTO file_outbox(transfer_id,peer_id,group_id,local_path,name,size,status,attempts,next_attempt_at,created_at)
             VALUES(?1,?2,NULL,?3,?4,?5,'pending',0,0,?6)`,
          );
          for (const s of multiSpec) {
            db.prepare("DELETE FROM file_outbox WHERE transfer_id=?1").run(s.tid);
            ins.run(s.tid, S.peerTo, s.src, s.name, s.bytes, nowMs());
          }
        });
        break;
      } catch (e) {
        if (i >= 5) throw e;
        await sleep(300);
      }
    }
    const t0 = nowMs();
    let snap = null;
    await waitFor(() => {
      const aDb = openDb(INSTANCES[0].db, true);
      const rows = aDb
        .prepare(`SELECT id,status FROM file_transfers WHERE id IN (${multiSpec.map(() => "?").join(",")})`)
        .all(...multiSpec.map((s) => s.tid));
      const queued = aDb
        .prepare(`SELECT COUNT(*) c FROM file_outbox WHERE transfer_id IN (${multiSpec.map(() => "?").join(",")})`)
        .get(...multiSpec.map((s) => s.tid)).c;
      aDb.close();
      const landed = fs.readdirSync(dl).filter((f) => f.includes(token));
      const parts = landed.filter((f) => f.endsWith(".part"));
      const files = landed.filter((f) => !f.endsWith(".part"));
      if (rows.length === multiSpec.length && rows.every((r) => r.status === "done")
        && queued === 0 && files.length === multiSpec.length) {
        snap = { rows, queued, landed, parts };
      }
      return !!snap;
    }, 180_000, "三单（含两张同名）要在同一批里全部投递完成");
    console.log(
      `  · 实测：入队 3 单 → 全部终态 ${((nowMs() - t0) / 1000).toFixed(1)}s · `
      + `落地 ${JSON.stringify(snap.landed.sort())}`,
    );
    const files = snap.landed.filter((f) => !f.endsWith(".part"));
    const gotShas = files
      .map((f) => createHash("sha256").update(fs.readFileSync(path.join(dl, f))).digest("hex"))
      .sort();
    const photoLanded = files.filter((f) => f.includes(photoName.replace(".bin", "")));
    check("一张都不许丢：三单必须各自落到一行 done 且队列已清空",
      snap.rows.length === multiSpec.length && snap.rows.every((r) => r.status === "done")
      && snap.queued === 0,
      "3 行 done + outbox=0", JSON.stringify(snap.rows) + ` outbox=${snap.queued}`);
    check("同名不许互相覆盖：接收目录里这张名字必须出现两次（少一次就是静默丢数据）",
      photoLanded.length === 2, 2, `${photoLanded.length} → ${photoLanded.join(", ")}`);
    check("每一张都必须是完整、各自对得上的内容（不许交错、不许串味、不许被顶掉）",
      gotShas.join(",") === wantShas.join(","),
      multiSpec.map((s) => s.sha.slice(0, 8)).join(","), gotShas.map((h) => h.slice(0, 8)).join(","));
    check("不许留下 .part 半成品（串行里每一单都得收尾）",
      snap.parts.length === 0, "无 .part", snap.parts.join(", ") || "无");
    const bDb = openDb(INSTANCES[1].db, true);
    const bRows = bDb
      .prepare(`SELECT id,status,size FROM file_transfers WHERE id IN (${multiSpec.map(() => "?").join(",")})`)
      .all(...multiSpec.map((s) => s.tid));
    bDb.close();
    check("接收侧每一单各记一行、都是 done（不重复记账、不把三单并成一条）",
      bRows.length === 3 && bRows.every((r) => r.status === "done"),
      "3 行 done", JSON.stringify(bRows));
    check("接收侧每单记的字节数必须等于它自己那张源（串味在这里也会露出来）",
      bRows.every((r) => multiSpec.some((s) => s.tid === r.id && s.bytes === r.size)),
      "逐单相等", JSON.stringify(bRows.map((r) => `${r.id.slice(-1)}=${r.size}`))
      + ` 期望 ${JSON.stringify(multiSpec.map((s) => s.bytes))}`);
  });

  // 文档里一直标着“未覆盖”的那一格：**两个发送者同时把同名文件发给同一个接收者**。
  // 单发送者的 multi-file 轮是串行 flush，后一单的 offer 看得见前一单已 rename；
  // 这里两单在各自链路上并行 begin，begin 那一刻盘上两份都不存在 ⇒ 会拿到**同一个** final_path。
  // 收尾前的 `exists()` 复核若失效，POSIX 的 rename 会静默覆盖先落地的那份（两行台账都 done）。
  step("同名的两单来自两个发送者、同时到达同一个接收者 ⇒ 两份都必须留下来", async () => {
    await stopAll();
    // C 第一次拉起只建身份与库（与链式轮同口径：新库会广播 announce，先单独起再停机写库）。
    launch(INST_C);
    await waitFor(() => tcpOpen(INST_C.port), 60_000, "第三实例首启：TCP 可连");
    await waitFor(() => bootReady(INST_C.log, bootBaseOf.get(INST_C.n), BOOT_LINE),
      30_000, "第三实例首启：打出 boot 完成行");
    await stopAll();
    const idC = readIdentity(INST_C);
    const token = Math.random().toString(36).slice(2, 8);
    const name = `same-${token}.bin`;
    const recvC = path.join(RUN_DIR, "recv", "C");
    fs.mkdirSync(recvC, { recursive: true });
    const spec = [
      { inst: INSTANCES[0], dir: "c1", bytes: 8 * 1024 * 1024, fill: 0xd4 },
      { inst: INSTANCES[1], dir: "c2", bytes: 8 * 1024 * 1024, fill: 0xe5 },
    ].map((s, i) => {
      const d = path.join(RUN_DIR, "src", s.dir);
      fs.mkdirSync(d, { recursive: true });
      const src = path.join(d, name);
      fs.writeFileSync(src, Buffer.alloc(s.bytes, s.fill));
      return {
        ...s,
        tid: eid("x", `${token}-${i}`),
        src,
        sha: createHash("sha256").update(fs.readFileSync(src)).digest("hex"),
      };
    });
    const endpointOf = (inst) => `127.0.0.1:${inst.port}`;
    seed(INST_C.db, (db) => {
      const addFriend = db.prepare(
        `INSERT OR IGNORE INTO friends(device_id,nickname,avatar,x25519_pubkey,ed25519_pubkey,added_at)
         VALUES(?1,?2,NULL,?3,NULL,?4)`,
      );
      addFriend.run(S.idA.runtimeId, `e2e-${INSTANCES[0].label}`, S.idA.x25519Pub, nowMs());
      addFriend.run(S.idB.runtimeId, `e2e-${INSTANCES[1].label}`, S.idB.x25519Pub, nowMs());
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('routed_endpoints',?1)")
        .run(JSON.stringify([{ address: endpointOf(INSTANCES[0]) }, { address: endpointOf(INSTANCES[1]) }]));
      db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('downloads_dir',?1)").run(recvC);
    });
    for (const s of spec) {
      seed(s.inst.db, (db) => {
        db.prepare(
          `INSERT OR IGNORE INTO friends(device_id,nickname,avatar,x25519_pubkey,ed25519_pubkey,added_at)
           VALUES(?1,?2,NULL,?3,NULL,?4)`,
        ).run(idC.runtimeId, `e2e-${INST_C.label}`, idC.x25519Pub, nowMs());
        const cur = db.prepare("SELECT value FROM settings WHERE key='routed_endpoints'").get();
        const eps = JSON.parse(cur?.value || "[]");
        if (!eps.some((e) => e.address === endpointOf(INST_C))) {
          eps.push({ address: endpointOf(INST_C) });
        }
        db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('routed_endpoints',?1)")
          .run(JSON.stringify(eps));
        db.prepare("DELETE FROM file_outbox WHERE transfer_id=?1").run(s.tid);
        db.prepare(
          `INSERT INTO file_outbox(transfer_id,peer_id,group_id,local_path,name,size,status,attempts,next_attempt_at,created_at)
           VALUES(?1,?2,NULL,?3,?4,?5,'pending',0,0,?6)`,
        ).run(s.tid, idC.runtimeId, s.src, name, s.bytes, nowMs());
      });
    }
    for (const inst of [INST_C, INSTANCES[0], INSTANCES[1]]) launch(inst);
    for (const inst of [INST_C, INSTANCES[0], INSTANCES[1]]) {
      await waitFor(() => tcpOpen(inst.port), 60_000, `第三实例轮：${inst.label} 的 TCP 可连`);
      await waitFor(() => bootReady(inst.log, bootBaseOf.get(inst.n), BOOT_LINE), 30_000,
        `第三实例轮：${inst.label} 打出 boot 完成行`);
    }
    const t0 = nowMs();
    let rows = null;
    await waitFor(() => {
      const db = openDb(INST_C.db, true);
      const got = db
        .prepare(`SELECT id,status,size,path FROM file_transfers WHERE id IN (?,?)`)
        .all(spec[0].tid, spec[1].tid);
      db.close();
      if (got.length === 2 && got.every((r) => r.status === "done")) rows = got;
      return !!rows;
    }, 180_000, "两个发送者的同名单都要在 C 落 done");
    const outboxLeft = spec.map((s) => {
      const db = openDb(s.inst.db, true);
      const n = db.prepare("SELECT COUNT(*) c FROM file_outbox WHERE transfer_id=?1").get(s.tid).c;
      db.close();
      return n;
    });
    const landed = fs.readdirSync(recvC).filter((f) => f.includes(token));
    const parts = landed.filter((f) => f.endsWith(".part"));
    const files = landed.filter((f) => !f.endsWith(".part"));
    const gotShas = files
      .map((f) => createHash("sha256").update(fs.readFileSync(path.join(recvC, f))).digest("hex"))
      .sort();
    const wantShas = spec.map((s) => s.sha).sort();
    console.log(
      `  · 实测：两发送者同名单 ${((nowMs() - t0) / 1000).toFixed(1)}s · `
      + `落地 ${JSON.stringify(landed.sort())} · ${JSON.stringify(rows)}`,
    );
    check("两个发送者同时发的同名文件：C 必须两行都 done，且两边队列都清空",
      rows.length === 2 && rows.every((r) => r.status === "done") && outboxLeft.every((n) => n === 0),
      "2 行 done + outbox 0/0", `${JSON.stringify(rows.map((r) => r.status))} outbox=${outboxLeft}`);
    check("两条台账的 path 必须指向两个不同且真实存在的文件（同名不许共用一份）",
      new Set(rows.map((r) => r.path)).size === 2
      && rows.every((r) => r.path && fs.existsSync(r.path)),
      "2 个不同路径且都存在", JSON.stringify(rows.map((r) => r.path)));
    check("两份内容的多重集合必须等于两个源（任何一份被覆盖都会只剩一份）",
      gotShas.join(",") === wantShas.join(","),
      wantShas.map((h) => h.slice(0, 8)).join(","), gotShas.map((h) => h.slice(0, 8)).join(","));
    check("不许留下 .part 半成品", parts.length === 0, "无 .part", parts.join(", ") || "无");
    check("C 每单记的 size 必须等于对应发送者的源",
      rows.every((r) => spec.some((s) => s.tid === r.id && s.bytes === r.size)),
      "逐单相等", JSON.stringify(rows.map((r) => `${r.id.slice(-1)}=${r.size}`)));
  });
}
