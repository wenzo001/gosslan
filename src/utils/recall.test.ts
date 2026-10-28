import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RECALLABLE_KINDS,
  RECALL_WINDOW_MS,
  isRecallableKind,
  isWithinRecallWindow,
  recallTargetOf,
  recalledRowKey,
} from "./recall.ts";

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

// ---------------- 群主特权撤回（2026-10-28 拍板，见 docs/adr/0023） ----------------

/** 从 protocol.rs 现解析一个 `&str` 数组常量：条目允许是裸标识符（如 `KIND_ANNOUNCEMENT`），
 *  那种要顺着 `pub const KIND_x: &str = "…"` 再解一次 —— 手抄名字清单是本仓反复付账的漂法。 */
function parseRustStrArray(src: string, name: string): string[] {
  const decl = src.match(new RegExp(`pub const ${name}: \\[&str; (\\d+)\\] = \\[([^\\]]+)\\];`));
  assert.ok(decl, `protocol.rs 里找不到 ${name}（改名/搬家时这里必须同步）`);
  const items = [...decl[2].matchAll(/(?:"([^"]+)"|([A-Z_][A-Z0-9_]*))/g)].map((m) => {
    if (m[1] !== undefined) return m[1];
    const constName = m[2] as string;
    const resolved = src.match(new RegExp(`pub const ${constName}: &str = "([^"]+)";`));
    assert.ok(resolved, `${name} 里的 ${constName} 解析不到字面量`);
    return resolved[1];
  });
  assert.equal(
    Number(decl[1]),
    items.length,
    `${name} 声明的长度与实际项数不一致：这就是"加了一种却没人改长度"那种漂移`,
  );
  return items;
}

test("两档共用同一份可撤分母 —— 协议里不许再有第二份清单", () => {
  const protocol = readFileSync(join(root, "src-tauri", "src", "protocol.rs"), "utf8");
  const db = readFileSync(join(root, "src-tauri", "src", "db.rs"), "utf8");
  // 曾经有一份 `CREATOR_RECALLABLE_KINDS = 5 + 三张卡`，建立在「卡片有独立真源」这个假前提上：
  // 看板取数是 messages WHERE kind IN ('todo','todo_update')、公告栏是
  // kind IN ('announcement','announcement_delete')（两处 SQL 现读），库里没有独立的 todos / 公告表
  // ⇒ 撤卡 = 本体一起没，与负责人原话相反。这一格钉的是「那个前提不再被写成第二份清单」。
  assert.doesNotMatch(
    protocol,
    /CREATOR_RECALLABLE_KINDS/,
    "协议里不该再有第二份可撤分母（两处清单迟早各说各话，且那份的前提已被证伪）",
  );
  for (const table of ["group_todos", "group_announcements", "group_polls"]) {
    assert.ok(
      !db.includes("CREATE TABLE IF NOT EXISTS " + table),
      `${table} 出现了 —— 卡片有了独立真源，那时才该把三张卡放回分母（连同这条判据一起改）`,
    );
  }
  const rust = parseRustStrArray(protocol, "RECALLABLE_KINDS");
  assert.deepEqual(
    [...RECALLABLE_KINDS].sort(),
    [...rust].sort(),
    "前端可撤回清单与 Rust 不一致：两侧都要拦，清单必须同一份",
  );
});

test("recallTargetOf：只认载荷里那条 target，解不出来按没有处理", () => {
  assert.equal(recallTargetOf('{"target":"m-1"}'), "m-1");
  assert.equal(recallTargetOf('{"target":42}'), "", "非字符串不许当成 id 用");
  assert.equal(recallTargetOf("{}"), "");
  assert.equal(recallTargetOf("not-json"), "", "猜出来的 target 会把另一条消息标成已撤回");
  assert.equal(recallTargetOf(undefined), "");
});

test("recalledRowKey：撤的人不是作者才说「群主撤回了」，索引缺失退回通用文案", () => {
  assert.equal(recalledRowKey("owner-a", "peer-b"), "msg.recalledByOwner");
  assert.equal(recalledRowKey("peer-b", "peer-b"), "msg.recalled", "作者自撤不该被说成群主干的");
  assert.equal(recalledRowKey(undefined, "peer-b"), "msg.recalled", "索引缺失宁可少说一句");
  assert.equal(recalledRowKey("", "peer-b"), "msg.recalled");
});

test("接线：群主档入口、提示行两式文案、跨人确认话术各有一处出口", () => {
  const item = readFileSync(join(root, "src", "components", "MessageItem.vue"), "utf8");
  assert.ok(
    /return isGroupOwnerHere\.value && isRecallableKind\(props\.message\.kind\)/.test(item),
    "canRecallNow 的群主那一半必须接**同一份**分母（两档只差「不看作者、不看时限」）",
  );
  assert.ok(
    /previewBody\(props\.message\.kind, props\.message\.content, 40\)/.test(item),
    "跨人撤回的摘要必须走 utils/messages 的 previewBody —— 直接切 content 会把 image/file 载荷里的"
      + "**本机绝对路径**贴进确认弹窗",
  );
  assert.match(
    item,
    /const isGroupOwnerHere = computed\(\(\) => \{[\s\S]{0,400}?chat\.groups\.find\([\s\S]{0,120}?\.creator[\s\S]{0,60}app\.device\?\.device_id/,
    "群主判定必须读本地 groups.creator（与 canPublishAnnouncement 同一份口径）",
  );
  assert.match(item, /return isGroupOwnerHere\.value &&/, "canRecallNow 必须真的用上群主那一档");
  assert.match(
    item,
    /t\(recalledTextKey\)/,
    "已撤回提示行必须按撤回者选文案（恒显「消息已撤回」= 谁撤的看不出来）",
  );
  assert.match(
    item,
    /:body="recallConfirmBody"/,
    "跨人撤回必须走区分确认（作者 + 摘要 + 不可恢复）",
  );
  assert.match(
    item,
    /t\("msg\.recallConfirmOwner", \{ name, snip \}\)/,
    "确认话术必须真把作者与摘要带进去",
  );

  const win = readFileSync(join(root, "src", "components", "ChatWindow.vue"), "utf8");
  assert.match(
    win,
    /const recallSources = computed\(\(\) => \{[\s\S]{0,320}?for \(const m of chat\.messages\[chat\.activeConv/,
    "「谁撤的」索引必须读**原始**那份消息（messages 把静默的 recall 事件行滤掉了，读它就是永远空）",
  );
  assert.match(
    win,
    /:recaller-id="recallSources\[item\.msg_id\]"/,
    "索引必须传给消息行，否则提示行永远只会说通用那句",
  );
});
