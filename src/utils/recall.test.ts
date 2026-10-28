import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECALLABLE_KINDS, RECALL_WINDOW_MS, isRecallableKind, isWithinRecallWindow } from "./recall.ts";

const root = join(import.meta.dirname, "..", "..");

test("前端 5 分钟窗口与 protocol.rs 的唯一常量逐字对上", () => {
  const protocol = readFileSync(join(root, "src-tauri", "src", "protocol.rs"), "utf8");
  assert.match(
    protocol,
    /pub const RECALL_WINDOW_MS: i64 = 300_000;/,
    "后端撤回窗口常量搬家/改值时，前端对账必须同步",
  );
  assert.equal(RECALL_WINDOW_MS, 300_000);
});

test("isWithinRecallWindow：边界内放行，刚过界与 ts=0 不放行", () => {
  const now = 10_000_000;
  assert.equal(isWithinRecallWindow(now - 1, now), true);
  assert.equal(isWithinRecallWindow(now - RECALL_WINDOW_MS, now), true, "正好 5 分钟仍在窗口内");
  assert.equal(isWithinRecallWindow(now - RECALL_WINDOW_MS - 1, now), false);
  assert.equal(isWithinRecallWindow(0, now), false, "ts=0 的历史行不显示撤回入口");
});

test("MessageItem 接上窗口判据，且单聊不再被 isGroup 挡掉", () => {
  const item = readFileSync(join(root, "src", "components", "MessageItem.vue"), "utf8");
  assert.match(item, /function canRecallNow\(/, "撤回入口必须用函数现算（computed 不会随时钟重算）");
  assert.match(item, /isWithinRecallWindow\(props\.message\.ts\)/, "必须接 5 分钟判据");
  assert.match(item, /:can-recall="canRecallNow\(\)"/, "桌面右键菜单必须接新函数");
  assert.match(item, /v-if="canRecallNow\(\)"/, "移动端菜单必须接新函数");
  assert.match(
    item,
    /chat\.recallMessage\(convId, props\.message\.msg_id\)/,
    "确认撤回必须把 conv_id 交给统一分流（单聊/群）",
  );
  assert.doesNotMatch(
    item,
    /if \(!convId\.startsWith\("group:"\)\) return;/,
    "旧的“非群直接 return”会把单聊撤回静默吞掉",
  );
});

// ---------------- 撤回收用户内容（2026-10-28 负责人：5 分钟内所有文件格式都要能撤） ----------------

/**
 * 白名单两侧逐字对账（分母从 Rust 那一份**现解析**，不在这里手抄一遍）。
 *
 * 为什么要对账而不是各写各的：老端可能没拦、直接发来一条对文件消息的撤回，Rust 那侧
 * 必须再判一次；而前端若比后端宽，用户会看到一个"点了没反应"的撤回入口（后端拒绝），
 * 若比后端窄则文本族某一种悄悄没有入口。两边同一份清单是唯一稳态。
 */
test("RECALLABLE_KINDS 与 protocol.rs 的白名单逐项对上", () => {
  const protocol = readFileSync(join(root, "src-tauri", "src", "protocol.rs"), "utf8");
  const decl = protocol.match(
    /pub const RECALLABLE_KINDS: \[&str; (\d+)\] = \[([^\]]+)\];/,
  );
  assert.ok(decl, "protocol.rs 里找不到 RECALLABLE_KINDS（改名/搬家时这里必须同步）");
  const declaredLen = Number(decl[1]);
  const rustKinds = [...decl[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(
    declaredLen,
    rustKinds.length,
    "数组长度声明与实际项数不一致：这就是那种「加了一种却没人改长度」的漂移",
  );
  assert.deepEqual(
    [...RECALLABLE_KINDS].sort(),
    [...rustKinds].sort(),
    "前端可撤回清单与 Rust 不一致：两侧都要拦，清单必须同一份",
  );
  assert.ok(
    protocol.includes("pub fn is_recallable_kind("),
    "Rust 侧必须有唯一的类型判据（命令层不许各写一份 matches!）",
  );
});

test("isRecallableKind：用户内容（文本族 + 全部附件格式）放行，机器事件一律不放行", () => {
  // 2026-10-28：附件也进白名单（覆盖 image/file 两个 kind，视频/音频/文档同属 file）
  for (const kind of ["text", "code", "merge", "image", "file"]) {
    assert.equal(isRecallableKind(kind), true, `${kind} 是用户内容，必须能撤回`);
  }
  for (const kind of ["todo", "poll", "announcement", "pin", "recall", "system", ""]) {
    assert.equal(isRecallableKind(kind), false, `${kind} 不是用户写的内容，不该有撤回入口`);
  }
  assert.equal(isRecallableKind(undefined), false);
  assert.equal(isRecallableKind(null), false);
});

test("MessageItem 的撤回入口接了类型判据（否则机器事件也会出现「撤回」）", () => {
  const item = readFileSync(join(root, "src", "components", "MessageItem.vue"), "utf8");
  assert.match(
    item,
    /isRecallableKind\(props\.message\.kind\)/,
    "canRecallNow 必须接类型白名单：机器事件不该出现撤回入口",
  );
});
