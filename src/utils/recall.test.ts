import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECALL_WINDOW_MS, isWithinRecallWindow } from "./recall.ts";

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
