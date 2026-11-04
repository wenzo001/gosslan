/**
 * `stallWatch` 的单测：覆盖"隐藏期间不判 / 恢复立即补一拍 / 隐藏不叠加 interval"。
 *
 * 用注入时钟与注入 interval，不依赖真实计时器 —— 断言的是**时钟语义**，
 * 不是"等 10 秒看看会不会弹"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStallWatch } from "./stallWatch.ts";
import { decideStall, UI_STALL_BANNER_MS } from "./uiStall.ts";
import type { InflightOp } from "./ipcTracker.ts";

/** 造一条在途操作（`startedAt` 是**原始墙钟**口径，和 `ipcTracker` 一致）。 */
function op(startedAt: number): InflightOp {
  return { id: 7, cmd: "send_message", label: "send_message", startedAt };
}

/** 装一套可手摇的时钟 + 可数的 interval。 */
function harness() {
  let raw = 0;
  let tickCount = 0;
  let intervalCalls = 0;
  let cleared = 0;
  let live = 0;
  let stored: (() => void) | null = null;
  const watch = createStallWatch({
    tick: () => { tickCount += 1; },
    clock: () => raw,
    setIntervalFn: (fn) => {
      intervalCalls += 1;
      live += 1;
      stored = fn;
      return 42;
    },
    clearIntervalFn: (id) => {
      assert.equal(id, 42, "只允许清掉自己起的那个 interval");
      cleared += 1;
      live -= 1;
    },
  });
  /** 按真实调用方式判定：op 的 startedAt 先过 `activeSince`，两端同一活动时钟。 */
  const judge = (startedAt: number) => decideStall(
    [op(watch.activeSince(startedAt))],
    watch.now(),
    0,
  );
  return {
    watch,
    /** 把墙钟拨到某个时刻（同时把到点的 interval 回调跑一遍：模拟浏览器按时投递）。 */
    at(next: number, fire = true) {
      raw = next;
      if (fire && stored) stored();
    },
    judge,
    ticks: () => tickCount,
    intervalCalls: () => intervalCalls,
    cleared: () => cleared,
    live: () => live,
  };
}

test("隐藏 10 分钟不产生停摆判定（判定时钟不因隐藏而前进）", () => {
  const h = harness();
  h.watch.start();
  h.at(2_000); // 前台 2 秒：age = 2s，远不到 10s
  assert.equal(h.judge(0), null, "前台 2 秒不该提示");

  h.watch.setHidden(true);
  assert.equal(h.live(), 0, "隐藏时必须真的停掉 interval，不留空转");
  const hiddenFrom = 2_000;
  // 隐藏期间：即使有延迟一拍的回调漏进来，也一拍都不该判。
  for (let t = hiddenFrom + 1_000; t <= hiddenFrom + 600_000; t += 1_000) {
    h.at(t);
    assert.equal(h.watch.now(), 2_000, `隐藏到第 ${(t - hiddenFrom) / 1000}s 时活动时钟必须停在隐藏那一刻`);
  }
  assert.equal(h.ticks(), 1, "隐藏期间只有前台那一次 tick；10 分钟里一次都不再判");
  assert.equal(h.judge(0), null, "隐藏 10 分钟不能算成一次停摆");
});

test("恢复后第一拍不会误判，且真卡够 10 秒仍然会判", () => {
  const h = harness();
  h.watch.start();
  h.at(2_000);
  h.watch.setHidden(true);
  h.at(2_000 + 600_000, false); // 隐藏 10 分钟（中间不投递，只看恢复瞬间）
  h.watch.setHidden(false);     // 恢复：立即补一次
  assert.equal(h.ticks(), 2, "恢复时必须立即补一拍，不能等下一个 1s");
  assert.equal(h.watch.now(), 2_000, "隐藏时长整段扣掉：活动时钟仍停在隐藏前");
  assert.equal(h.judge(0), null, "恢复第一拍 age 仍是 2s，不得误判");

  // 恢复后继续在前台：age 从隐藏前那 2s 继续累加，够 10s 就该提示（判定逻辑与阈值没变）。
  // 恢复时刻的墙钟是 602_000，再走 8s ⇒ 610_000。
  h.at(2_000 + 600_000 + 8_000);
  const v = h.judge(0);
  assert.equal(v?.seconds, 10, "恢复后真卡到 10s 仍必须提示");
  assert.equal(v?.escalated, false);
});

test("恢复之后新起的操作仍按真实可见年龄判定（activeSince 不会被历史隐藏拖负）", () => {
  const h = harness();
  h.watch.start();
  h.watch.setHidden(true);
  h.at(1_000 + 600_000);        // 隐藏 10 分钟
  h.watch.setHidden(false);     // 恢复
  const startedAt = 1_000 + 600_000; // 恢复瞬间发起的 IPC
  assert.equal(h.judge(startedAt), null, "刚发起不该提示");

  h.at(startedAt + 10_000);     // 前台真卡 10s
  assert.equal(h.judge(startedAt)?.seconds, 10, "历史 10 分钟隐藏不能把新操作的年龄抵消成负数");
});

test("连续隐藏/恢复不叠加 interval（任意时刻最多只有一个在跑）", () => {
  const h = harness();
  h.watch.start();
  h.watch.start();
  h.watch.start();
  assert.equal(h.intervalCalls(), 1, "重复 start 只能有一个 interval");
  assert.equal(h.live(), 1);

  for (let i = 0; i < 5; i += 1) {
    h.watch.setHidden(true);
    assert.equal(h.live(), 0, "隐藏时停表：不留空转");
    h.watch.setHidden(false);
    assert.equal(h.live(), 1, "恢复后重新起表，且只有一个");
    // i=0 时是第 2 个，之后每轮恢复恰好新起一个。
    assert.equal(h.intervalCalls(), 2 + i, "连续隐藏/恢复不叠加：每轮恢复只新起一个");
  }
  assert.equal(h.cleared(), 5, "5 轮隐藏各清掉自己那一个");

  h.watch.stop();
  h.watch.stop();
  assert.equal(h.cleared(), 6, "stop 幂等：只清一次");
  assert.equal(h.live(), 0, "停止后不留 interval");
  assert.equal(h.intervalCalls(), 6);
});

test("反复隐藏的累计时长按段相加（不会漏扣某一段）", () => {
  let raw = 0;
  let stored: (() => void) | null = null;
  const watch = createStallWatch({
    tick: () => {},
    clock: () => raw,
    intervalMs: 0,
    setIntervalFn: (fn) => {
      stored = fn;
      return 42;
    },
    // 测试里清掉自己起的假 interval（避免 node 真定时器吊住进程）。
    clearIntervalFn: () => {},
  });
  watch.start();
  raw = 1_000;
  assert.equal(stored !== null, true);
  assert.equal(watch.now(), 1_000);
  watch.setHidden(true);
  raw = 1_000 + 30_000;   // 隐藏 30s
  watch.setHidden(false);
  raw = 61_000;           // 可见 30s
  watch.setHidden(true);
  raw = 61_000 + 20_000;  // 再隐藏 20s
  watch.setHidden(false);
  raw = 81_000 + 5_000;   // 再可见 5s
  assert.equal(watch.now(), 1_000 + 30_000 + 5_000, "两段隐藏共 50s 都不该进判定时钟");
  // 与判据对齐：把起飞点定在"第一次恢复后的可见期"（raw 31_000 ⇒ 活动 1_000）。
  // 真实可见时长 = 30s（31k→61k）+ 5s（81k→86k）= 35s；若两段隐藏没被扣，
  // 这里会按原始墙钟算成 55s。判定逻辑与阈值本身没动。
  const startedAt = 31_000;
  const activeStart = watch.activeSince(startedAt);
  assert.equal(activeStart, 1_000, "隐藏前的累计只扣到那一段隐藏开始为止");
  assert.equal(decideStall([op(activeStart)], watch.now(), 0)?.seconds, 35);
  assert.ok(UI_STALL_BANNER_MS > 0);
  watch.stop();
});

test("默认 interval 实现不依赖 window（node 环境可直接 start/stop）", () => {
  const watch = createStallWatch({ tick: () => {}, intervalMs: 1_000 });
  assert.doesNotThrow(() => {
    watch.start();
    watch.start();
    watch.stop();
  }, "默认实现必须走 globalThis，不能在 node 里因 window 未定义而抛");
});
