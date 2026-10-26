import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NO_PROGRESS_TIMEOUT_MS,
  STALL_FLAG_TTL_MS,
  progressAdvanced,
  progressHasStalled,
  stallFlagAlive,
} from "./transferProgressWatch.ts";

test("没有第一个读数时不许判停滞（切会话/首帧那一下不能报假故障）", () => {
  assert.equal(progressHasStalled(1_000_000, 0), false);
  assert.equal(progressHasStalled(1_000_000, Number.NaN), false);
  assert.equal(progressHasStalled(1_000_000, -5), false);
  // 反向钉：一旦有真读数，同样的 now 就必须能判出来（否则上面那三条只是"函数永远返回 false"）
  assert.equal(progressHasStalled(1_000_000, 1), true);
});

test("阈值两侧差一毫秒都不许翻（这条判据的代价是用户会去按取消）", () => {
  const start = 10_000;
  assert.equal(progressHasStalled(start + NO_PROGRESS_TIMEOUT_MS - 1, start), false);
  assert.equal(progressHasStalled(start + NO_PROGRESS_TIMEOUT_MS, start), true);
  assert.equal(progressHasStalled(start + NO_PROGRESS_TIMEOUT_MS + 1, start), true);
});

test("相同的读数不算进展（否则后端重发同一个百分比就能把判据一直按住）", () => {
  assert.equal(progressAdvanced(0.84, 0.84), false, "同一个百分比重发不许重置计时");
  assert.equal(progressAdvanced(0.84, 0.85), true);
  assert.equal(progressAdvanced(null, 0.01), true, "第一个读数就是进展");
  assert.equal(progressAdvanced(0.5, null), false, "交出 null = 不再显示进度，不是一次进展");
  assert.equal(progressAdvanced(null, null), false);
});

test("无进展时限必须长于后端心跳看门狗那一档（两条判据打架时用户看到的是抖动）", () => {
  // 45_000 = 心跳 15s × 3（`transport.rs` 的入站帧看门狗）。
  // ⚠️ 这是**下限核对**，不是"与后端同值"的承诺：那个数是 Rust 侧的，跨语言没有共享常量，
  // 所以这里只能钉住"前端不许比后端更早开口"这一半，另一半靠 `file-stalled` 优先。
  assert.ok(
    NO_PROGRESS_TIMEOUT_MS > 45_000,
    `前端阈值 ${NO_PROGRESS_TIMEOUT_MS}ms 不得早于后端 45s 看门狗，否则停滞与停止会互相盖`,
  );
});

test("停滞标记有有效期：漏掉「已恢复」那条事件不能让它永远挂着（审计 D-5）", () => {
  const start = 100_000;
  assert.equal(stallFlagAlive(start + 1_000, start), true);
  assert.equal(stallFlagAlive(start + STALL_FLAG_TTL_MS - 1, start), true);
  assert.equal(stallFlagAlive(start + STALL_FLAG_TTL_MS, start), false);
  assert.equal(stallFlagAlive(start + STALL_FLAG_TTL_MS + 1, start), false);
  // 没有盖章时间的记录一律不算"停滞中"（宁可不显示警告，也不显示假的）
  assert.equal(stallFlagAlive(start, 0), false);
  assert.equal(stallFlagAlive(start, Number.NaN), false);
  // 下限核对：必须容得下心跳重发的节奏（15s），否则"持续性停滞"会在两次重发之间闪断
  assert.ok(
    STALL_FLAG_TTL_MS > 45_000,
    `TTL ${STALL_FLAG_TTL_MS}ms 至少要容 3 个心跳周期，否则持续停滞会闪断`,
  );
});

/* ---------------- 跨语言阈值的对账 ----------------
 * 注释里写一句「与后端同一口径」= 一张没有机器凭据的欠条：两侧各自改数字时没有任何一层会红，
 * 前端就会在后端还没放弃之前先宣布"没进展"（或者反过来，永远不报）。所以这里**两边都从源码现读**。 */
test("群历史「无进展」阈值必须等于后端一页期限的两倍（两侧都从源码现读）", () => {
  const rust = readFileSync(join(import.meta.dirname, "..", "..", "src-tauri", "src", "network", "group_history.rs"), "utf8");
  const vue = readFileSync(join(import.meta.dirname, "..", "components", "ChatWindow.vue"), "utf8");
  const page = /GROUP_HISTORY_PAGE_TIMEOUT_MS:\s*u64\s*=\s*([0-9_]+)/.exec(rust)?.[1];
  const front = /const GROUP_HISTORY_NO_PROGRESS_MS\s*=\s*([0-9_]+)/.exec(vue)?.[1];
  assert.ok(page, "读不到后端 GROUP_HISTORY_PAGE_TIMEOUT_MS —— 它搬家或改名了，这条对账必须跟着改");
  assert.ok(front, "读不到前端 GROUP_HISTORY_NO_PROGRESS_MS —— 同上");
  assert.equal(
    Number(front!.replace(/_/g, "")),
    2 * Number(page!.replace(/_/g, "")),
    "前端阈值必须是**两个**页期限：一个页期限之内后端自己还没放弃，抢着报'没进展'就是假故障",
  );
});

/* ---------------- 接线判据 ----------------
 * 上面四条判的是**纯函数对不对**。纯函数全绿、但没有任何一行代码去调它，
 * 这套观察就等于不存在（本仓为这一类坑写过规矩：逻辑判据全绿 ≠ 被接上）。
 * 所以这里钉的是**调用点**：谁调它、调了几次、以及取消那颗按钮真的接回父组件那唯一一份实现。
 * 读的是源码文本（`@/` 别名在 node:test 里解析不了，文本量具是这一族唯一能跑的形状）。 */
function readSrc(rel: string): string {
  return readFileSync(join(import.meta.dirname, "..", rel), "utf8");
}

test("这条观察必须真的接在每行的进度上（纯函数绿而没人调 = 功能为零）", () => {
  const composable = readSrc("composables/useMessageFile.ts");
  // 调用点恰好一处：多一处就是第二个计时器/第二个判据在并跑
  assert.equal(
    composable.split("progressHasStalled(").length - 1,
    1,
    "useMessageFile 必须**且只能**有一处调用 progressHasStalled()",
  );
  assert.equal(
    composable.split("progressAdvanced(").length - 1,
    1,
    "进展与否也只能由这一处判（否则相同百分比重发能不能重置计时会有两种答案）",
  );
  // 后端停滞必须仍然优先：这条新判据不许把带原因的「网络停滞」盖掉
  const stallFirst = composable.indexOf('chat.transferStallReason(');
  const mineFirst = composable.indexOf("progressStalledByClient.value)");
  assert.ok(stallFirst > 0 && mineFirst > stallFirst, "「无进展」那条必须排在后端停滞原因**之后**");
  // 计时器必须有出口：行被虚拟列表回收时不留下没人管的 interval
  assert.ok(composable.includes("onScopeDispose(stopProgressWatch)"), "缺 onScopeDispose ⇒ 回收行会攒计时器");
});

test("活动传输上必须有常驻取消，而且接回父组件那唯一一份实现", () => {
  const bubble = readSrc("components/message/MessageFileBubble.vue");
  assert.ok(bubble.includes(`(e: "cancel"): void;`), "气泡没有交回 cancel 这条事件");
  assert.ok(bubble.includes(`v-if="progress !== null"`), "取消按钮必须只在活动进度期间出现");
  assert.ok(bubble.includes(`@click.stop="emit('cancel')"`), "不许点取消顺带把整卡的「打开文件」也触发");
  const item = readSrc("components/MessageItem.vue");
  assert.ok(item.includes(`@cancel="doCancelSend"`), "取消必须走父组件那唯一一份 doCancelSend");
  // `doCancelSend` 全文件出现次数现算 = 4：1 处声明 + 3 个入口（长按/右键菜单的 `@cancel-send`、
  // 文件气泡常驻按钮的 `@cancel`、2026-10-26 起的文本回执 `@cancel`——用户口径「发送中的话也要能取消」，
  // 此前取消口只藏在菜单里，看不见就等于拦不下来）。
  // 入口数会长，**实现只能有一份**：所以下面两条分开钉 —— 总数变了要同步这里的数，
  // 而声明数不等于 1 就是真的长出了第二个家（那才是这一族以前"每个入口各写一遍、漏一个就挂在界面上"的形状）。
  assert.equal(
    item.split("doCancelSend").length - 1,
    4,
    "取消发送的入口 = 菜单 + 文件气泡 + 文本回执三处、共用同一份实现（实测出现次数变了就同步这里的数）",
  );
  assert.equal(
    item.split("function doCancelSend(").length - 1,
    1,
    "doCancelSend 的实现必须只有一份 —— 多加一个入口可以，多长一个家不行",
  );
});

