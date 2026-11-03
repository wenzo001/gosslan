import { test } from "node:test";
import assert from "node:assert/strict";
import { foldReactions, hasMyReaction, parseReaction } from "./reactions.ts";
import type { MessageRecord } from "../types";

function rx(
  msg_id: string,
  sender: string,
  target: string,
  emoji: string,
  add: boolean,
  seq: number,
): MessageRecord {
  return {
    id: 0,
    msg_id,
    conv_id: "group:g1",
    sender_id: sender,
    receiver_id: "g1",
    kind: "reaction",
    content: JSON.stringify({ target, emoji, add }),
    ts: 0,
    seq,
    status: "delivered",
  };
}

test("parseReaction：畸形载荷返回 null，不抛错", () => {
  const bad = (content: string): MessageRecord => ({
    id: 0, msg_id: "x", conv_id: "c", sender_id: "a", receiver_id: "b",
    kind: "reaction", content, ts: 0, seq: 1, status: "sent",
  });
  assert.equal(parseReaction(bad("{")), null);
  assert.equal(parseReaction(bad("{}")), null);
  assert.equal(parseReaction(bad('{"target":"","emoji":"[赞]","add":true}')), null);
  assert.equal(parseReaction(bad('{"target":"m1","emoji":"","add":true}')), null);
  assert.equal(parseReaction(bad('{"target":"m1","emoji":"[赞]","add":"yes"}')), null);
  // 非回应消息一律 null
  assert.equal(parseReaction({ ...bad("{}"), kind: "text" }), null);
});

test("折叠：不同人点同一表情聚合成一个 chip", () => {
  const recs = [
    rx("r1", "a", "m1", "[赞]", true, 1),
    rx("r2", "b", "m1", "[赞]", true, 2),
  ];
  const chips = foldReactions(recs, "a").get("m1")!;
  assert.equal(chips.length, 1);
  assert.equal(chips[0].count, 2);
  assert.equal(chips[0].mine, true);
});

test("折叠：取消（add=false）后不再计入", () => {
  const recs = [
    rx("r1", "a", "m1", "[赞]", true, 1),
    rx("r2", "a", "m1", "[赞]", false, 2),
  ];
  assert.equal(foldReactions(recs, "a").get("m1"), undefined);
});

test("折叠：LWW 只认最新一条，与到达顺序无关", () => {
  const add = rx("r1", "a", "m1", "[赞]", true, 1);
  const remove = rx("r2", "a", "m1", "[赞]", false, 2);
  // 先加后删 → 无
  assert.equal(foldReactions([add, remove], "a").get("m1"), undefined);
  // 乱序到达（先看到删、再看到加）→ 仍应无（比的是版本号，不是到达顺序）
  assert.equal(foldReactions([remove, add], "a").get("m1"), undefined);
});

test("折叠：同一 seq 时用 msg_id 决胜（seq 不是全序）", () => {
  // 两端离线后各发一条，都可能拿到同一个 seq —— 只看 seq 会让不同副本算出不同结果
  const lower = rx("aaa", "a", "m1", "[赞]", true, 7);
  const higher = rx("zzz", "a", "m1", "[赞]", false, 7);
  assert.equal(foldReactions([lower, higher], "a").get("m1"), undefined, "msg_id 大的赢");
  assert.equal(foldReactions([higher, lower], "a").get("m1"), undefined, "换顺序结果不变");
  // 反过来：msg_id 大的那条是 add，则应保留
  const keepA = rx("aaa", "a", "m1", "[赞]", false, 7);
  const keepB = rx("zzz", "a", "m1", "[赞]", true, 7);
  assert.equal(foldReactions([keepA, keepB], "a").get("m1")![0].count, 1);
});

test("折叠：多人多表情互不干扰，target 各自独立", () => {
  const recs = [
    rx("r1", "a", "m1", "[赞]", true, 1),
    rx("r2", "b", "m1", "[踩]", true, 2),
    rx("r3", "a", "m2", "[赞]", true, 3),
  ];
  const all = foldReactions(recs, "b");
  assert.equal(all.get("m1")!.length, 2);
  assert.equal(all.get("m2")!.length, 1);
  assert.equal(all.get("m1")!.find((c) => c.emoji === "[踩]")!.mine, true);
  assert.equal(all.get("m1")!.find((c) => c.emoji === "[赞]")!.mine, false);
});

test("折叠：非回应消息被忽略；空输入返回空表", () => {
  assert.equal(foldReactions([], "a").size, 0);
  const text: MessageRecord = { ...rx("t1", "a", "m1", "[赞]", true, 1), kind: "text", content: "hi" };
  assert.equal(foldReactions([text], "a").size, 0);
});

test("折叠：判死/取消/已撤回的回应不冒充「已点」，排队中的仍显示", () => {
  // 判死那一行从没交给对方：显示成"已点"就是乐观层的谎（5.16.93）。
  for (const status of ["failed", "cancelled", "recalled"]) {
    const rec = { ...rx("r1", "a", "m1", "[赞]", true, 1), status };
    assert.equal(foldReactions([rec], "a").get("m1"), undefined, `${status} 不许计入`);
    // 但同一格若还有一条更早的真实成功，折叠仍以它为准
    const older = rx("r0", "b", "m1", "[赞]", true, 0);
    assert.equal(foldReactions([older, rec], "a").get("m1")![0].count, 1);
  }
  // `sending`（含排队等对方上线）正是乐观投影的可见形态 ⇒ 必须显示
  const queued = { ...rx("r2", "a", "m1", "[赞]", true, 2), status: "sending" };
  const chips = foldReactions([queued], "a").get("m1")!;
  assert.equal(chips[0].count, 1);
  assert.equal(chips[0].mine, true);
});

test("hasMyReaction：用于决定点击时是 add 还是 remove", () => {
  const recs = [rx("r1", "a", "m1", "[赞]", true, 1)];
  assert.equal(hasMyReaction(recs, "m1", "[赞]", "a"), true);
  assert.equal(hasMyReaction(recs, "m1", "[赞]", "b"), false);
  assert.equal(hasMyReaction(recs, "m1", "[踩]", "a"), false);
});
