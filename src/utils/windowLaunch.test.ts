/**
 * 「打开独立窗口」的单飞 + 防抖判据 + 接线守卫。
 *
 * 为什么这两层都要守（用户 2026-09-12 实测）：
 *   - 连点设置会**开出第二个窗口**、还会让窗口先闪成主聊天界面 —— 后端单例/串行是主修，
 *     前端这一层负责"别把请求打爆"，两层都要在；
 *   - 这类退化**看起来完全正常**（点一下照样能开），只有连点时才会暴露，
 *     所以除了单测，还要静态盯住"两个开窗函数确实走了 `launchAuxWindow`"。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  raceWithTimeout,
  shouldLaunchWindow,
  WINDOW_LAUNCH_MIN_INTERVAL_MS,
  WINDOW_LAUNCH_TIMEOUT_CODE,
  WINDOW_LAUNCH_TIMEOUT_MS,
} from "./windowLaunch.ts";

const srcDir = join(import.meta.dirname, "..");

// ---------------- 判据本身 ----------------

test("第一次点击（从未发起过、也没有在飞）应当发起", () => {
  assert.equal(shouldLaunchWindow(1_000, false, 0), true);
});

test("正在打开时再点：合并进那一次，不再发起", () => {
  // 距上次发起已经过了很久，但仍然不应该再发一次 —— 合并优先于时间判据
  assert.equal(shouldLaunchWindow(999_999, true, 1_000), false);
});

test("刚点过（不足最小间隔）视为连点，忽略", () => {
  const now = 10_000;
  assert.equal(shouldLaunchWindow(now, false, now - 1), false, "1ms 后连点应被吃掉");
  assert.equal(
    shouldLaunchWindow(now, false, now - (WINDOW_LAUNCH_MIN_INTERVAL_MS - 1)),
    false,
    "差 1ms 到间隔也应被吃掉",
  );
});

test("超过最小间隔后（关掉再开）正常放行", () => {
  const now = 10_000;
  assert.equal(shouldLaunchWindow(now, false, now - WINDOW_LAUNCH_MIN_INTERVAL_MS), true);
  assert.equal(shouldLaunchWindow(now, false, now - 5_000), true);
});

test("间隔设为 0 时只剩'单飞'在起作用（证明时间判据不是唯一防线）", () => {
  assert.equal(shouldLaunchWindow(1_000, false, 999, 0), true);
  assert.equal(shouldLaunchWindow(1_000, true, 0, 0), false);
});

// ---------------- 接线守卫：两个开窗按钮必须走统一入口 ----------------

test("桌面端开窗必须走 launchAuxWindow（单飞 + 防抖 + pending 状态）", () => {
  const layout = readFileSync(join(srcDir, "layouts", "ResponsiveLayout.vue"), "utf8");

  for (const [label, invokeName] of [
    ["settings", "openSettingsWindow"],
    ["logs", "openLogWindow"],
  ] as const) {
    assert.match(
      layout,
      new RegExp(`launchAuxWindow\\("${label}",\\s*\\(\\)\\s*=>\\s*api\\.${invokeName}\\(\\)\\)`),
      `ResponsiveLayout 打开 ${label} 窗口必须走 launchAuxWindow("${label}", …) —— ` +
        `直接在按钮里 invoke 会退化成"连点就发多次 IPC"，也就是用户报的连点问题`,
    );
  }

  // 反向：不能再有绕过 launcher 的裸调用（两条命令都必须出现在 launchAuxWindow 的参数里）
  const rawCalls = layout.match(/api\.open(SettingsWindow|LogWindow)\(\)/g) ?? [];
  assert.equal(rawCalls.length, 2, `裸调用 open*Window 应恰好 2 处（都在 launcher 里），实际 ${rawCalls.length}`);
});

test("两个窗口的 pending 状态接到了按钮上（冷启动那一下用户能看到「点到了」）", () => {
  const layout = readFileSync(join(srcDir, "layouts", "ResponsiveLayout.vue"), "utf8");
  const rail = readFileSync(join(srcDir, "components", "NavRail.vue"), "utf8");

  assert.match(layout, /useWindowOpening\("settings"\)/, "ResponsiveLayout 要订阅 settings 的打开状态");
  assert.match(layout, /useWindowOpening\("logs"\)/, "ResponsiveLayout 要订阅 logs 的打开状态");
  assert.match(layout, /:settings-opening="settingsOpening"/, "窄导航要拿到 settings 的 pending 状态");
  assert.match(layout, /:logs-opening="logsOpening"/, "窄导航要拿到 logs 的 pending 状态");
  assert.match(rail, /:aria-busy="settingsOpening"/, "设置按钮要有 aria-busy 反馈");
  assert.match(rail, /:aria-busy="logsOpening"/, "日志按钮要有 aria-busy 反馈");
});

test("外部链接与群任务窗口也必须走 launchAuxWindow（不得在按钮里裸 invoke）", () => {
  const layout = readFileSync(join(srcDir, "layouts", "ResponsiveLayout.vue"), "utf8");
  const chatWindow = readFileSync(join(srcDir, "components", "ChatWindow.vue"), "utf8");

  // 外链窗口：label 固定 "link"（复用同一窗口，第二次打开是 navigate）。
  assert.match(
    layout,
    /launchAuxWindow\("link",\s*\(\)\s*=>\s*api\.openLinkWindow\(/,
    `ResponsiveLayout 打开外链窗口必须走 launchAuxWindow("link", …)`,
  );
  // 群任务窗口：label 是**固定**的 "tasks"（一扇窗换内容）。动态 `todo-<groupId>` 会让
  // "不传参数预热"做不到 —— 预热那一刻不知道该建哪一扇（Rust 侧有交叉核对守卫）。
  assert.match(
    chatWindow,
    /launchAuxWindow\("tasks",\s*\(\)\s*=>\s*api\.openGroupTodosWindow\(/,
    `ChatWindow 打开群任务窗口必须走 launchAuxWindow("tasks", …)（固定 label 才有秒开）`,
  );

  // 反向：不得有绕过 launcher 的裸调用（每条命令只应出现一次，且在 launcher 参数里）。
  const rawLink = layout.match(/api\.openLinkWindow\(/g) ?? [];
  assert.equal(rawLink.length, 1, `api.openLinkWindow 裸调用应恰好 1 处（在 launcher 里），实际 ${rawLink.length}`);
  const rawTodos = chatWindow.match(/api\.openGroupTodosWindow\(/g) ?? [];
  assert.equal(rawTodos.length, 1, `api.openGroupTodosWindow 裸调用应恰好 1 处（在 launcher 里），实际 ${rawTodos.length}`);

  // pending 状态：外链视图的按钮要能看到"正在打开"。
  assert.match(layout, /useWindowOpening\("link"\)/, "ResponsiveLayout 要订阅 link 的打开状态");
  assert.match(layout, /:opening="linksOpening"/, "链接列表要拿到 link 的 pending 状态");
  assert.match(chatWindow, /:tasks-opening="tasksOpening"/, "聊天头要拿到群任务窗口的 pending 状态");
});


// ---------------- 开窗超时兜底（2026-11-19「点了没反应」）----------------

/** 可控假定时器：手动 fire() 触发超时，并记录 clear 次数以证明无 timer 泄漏。 */
function fakeTimer() {
  let cb: (() => void) | null = null;
  let cleared = 0;
  return {
    set(fn: () => void, _ms: number) { cb = fn; return 1; },
    clear(_id: unknown) { cleared += 1; },
    fire() { cb?.(); },
    get cleared() { return cleared; },
  };
}

test("raceWithTimeout：正常 resolve 透传且清理定时器", async () => {
  const timer = fakeTimer();
  await assert.doesNotReject(raceWithTimeout(Promise.resolve("ok"), WINDOW_LAUNCH_TIMEOUT_MS, timer));
  assert.equal(timer.cleared, 1, "成功路径要清掉超时定时器，不留泄漏");
});

test("raceWithTimeout：原 Promise reject 原样透传且清理定时器", async () => {
  const timer = fakeTimer();
  const err = new Error("boom");
  await assert.rejects(raceWithTimeout(Promise.reject(err), WINDOW_LAUNCH_TIMEOUT_MS, timer), (e) => e === err);
  assert.equal(timer.cleared, 1, "失败路径也要清掉定时器");
});

test("raceWithTimeout：永不 settle 的 Promise 会超时 reject（拆掉兜底此条必红）", async () => {
  const timer = fakeTimer();
  const never = new Promise<void>(() => {});
  const pending = raceWithTimeout(never, WINDOW_LAUNCH_TIMEOUT_MS, timer);
  timer.fire(); // 模拟时间到
  await assert.rejects(pending, (e: Error) => e.message.includes(WINDOW_LAUNCH_TIMEOUT_CODE));
});

test("raceWithTimeout：超时后原 Promise 才 resolve，不得二次 settle", async () => {
  const timer = fakeTimer();
  let resolveLate!: (v: string) => void;
  const late = new Promise<string>((r) => { resolveLate = r; });
  const pending = raceWithTimeout(late, WINDOW_LAUNCH_TIMEOUT_MS, timer);
  timer.fire();
  await assert.rejects(pending, (e: Error) => e.message.includes(WINDOW_LAUNCH_TIMEOUT_CODE));
  resolveLate("late"); // 晚到的成功不能改变已 settle 的结果，也不必再清定时器
  assert.equal(timer.cleared, 0, "超时路径不额外 clear（定时器已触发）");
});

test("接线守卫：launchAuxWindow 必须给 open() 加超时兜底（否则 opening 永久粘死）", () => {
  const src = readFileSync(join(srcDir, "composables", "useWindowLauncher.ts"), "utf8");
  assert.match(
    src,
    /raceWithTimeout\(\s*open\(\),\s*WINDOW_LAUNCH_TIMEOUT_MS,/,
    "launchAuxWindow 必须用 raceWithTimeout 包住 open()，否则 IPC 永不 settle 时 opening 永久卡 true、后续点击全被吞",
  );
  // 反例自证：如果直接裸 await open()（无超时），这条守卫必须红。
  assert.equal(
    /await open\(\);/.test(src),
    false,
    "不能再出现裸 await open()（无超时兜底）",
  );
});
