/**
 * 分层返回的纯逻辑单测。
 *
 * 为什么值得测：真机上的 Android 返回键行为**没有自动化验证手段**（本项目也没有
 * 设备测试环境），而这块逻辑一旦出错，症状是"返回键要按好几下才有反应"或
 * "按返回把不该关的层关了" —— 都属于用户会立刻骂、但代码看不太出来的问题。
 * 这里用假 HistoryPort 把每条边界钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackStack, type HistoryPort } from "./backStack.ts";

/**
 * 假端口：记录压入的条目，`back()` 立刻回调（真实浏览器是异步 popstate）。
 * `refuseBack` 模拟端口**拒绝**回退：压入之后发生过导航，那条同 URL 条目现在是合法的
 * "后退到上一级"目标 —— 退掉它等于把刚推进的页面撤销（用户 2026-10-23 报的
 * 「加好友页点发起聊天没反应」就是这个形状）。
 */
function makePort(landing: "pushState" | "hash" | null = "pushState", refuseBack = false) {
  const entries: unknown[] = [];
  /** 端口被要求退的是**哪一层**的条目（多层同时开着时必须按层判）。 */
  const popped: number[] = [];
  /** 被通知「忘掉 URL」的层（非栈顶释放时）。 */
  const forgotten: number[] = [];
  const port: HistoryPort = {
    push(state) {
      if (landing === null) return null;
      entries.push(state);
      return landing;
    },
    back(layerId) {
      popped.push(layerId);
      if (refuseBack) return false;
      entries.pop();
      return true;
    },
    forget(layerId) {
      forgotten.push(layerId);
    },
  };
  return { port, entries, popped, forgotten };
}

test("压一层 / 返回一次：只关最上面那层", () => {
  const { port, entries } = makePort();
  const back = createBackStack(port);
  const closed: string[] = [];
  back.push(() => closed.push("a"));
  back.push(() => closed.push("b"));
  assert.equal(back.depth(), 2);
  assert.equal(entries.length, 2, "每层压一条历史条目");
  assert.equal(back.pushedCount(), 2);

  assert.equal(back.onPop(), true);
  assert.deepEqual(closed, ["b"], "先关最上面那层");
  assert.equal(back.depth(), 1);
  assert.equal(back.pushedCount(), 1, "返回键消费掉一条条目（历史条目本身由浏览器回退）");

  assert.equal(back.onPop(), true);
  assert.deepEqual(closed, ["b", "a"]);
  assert.equal(back.depth(), 0);
});

test("没有层时返回键交给系统（Android 才应该退出应用）", () => {
  const { port } = makePort();
  const back = createBackStack(port);
  assert.equal(back.onPop(), false, "没有层 ⇒ 不处理，交给系统退出");
});

test("UI 主动关闭栈顶层：把历史条目退回去（不能让返回键多按几下）", () => {
  const { port, entries } = makePort();
  const back = createBackStack(port);
  const release = back.push(() => {});
  assert.equal(entries.length, 1);

  release();
  assert.equal(entries.length, 0, "UI 关闭后历史条目也要回退");
  assert.equal(back.depth(), 0);
  // 我们自己 back() 触发的 popstate 必须被吃掉，不能误关下一层
  const closed: string[] = [];
  back.push(() => closed.push("under"));
  assert.equal(back.onPop(), true, "（吃掉自己触发的那次）");
  assert.deepEqual(closed, [], "不能让下层被误关");
  assert.equal(back.depth(), 1, "下层仍在");
});

test("端口拒退（压入之后发生过导航）：条目留下、计数不动，下一次真返回键不被吞", () => {
  // 真实形状：加好友弹窗（栈顶）里点「发起聊天」→ 路由已经推进 /chats/x，
  // 弹窗那层的同 URL 条目于是变成"后退回通讯录"的目标，端口必须拒绝退掉它。
  const { port, entries } = makePort("pushState", true);
  const back = createBackStack(port);
  const closed: string[] = [];
  const release = back.push(() => closed.push("dialog"));
  assert.equal(entries.length, 1);

  release();
  assert.equal(entries.length, 1, "条目留下（那是合法的后退目标，不是垃圾）");
  assert.equal(back.pushedCount(), 1, "计数不能减：历史里确实还有一条我们的条目");
  assert.equal(back.depth(), 0, "层已经摘掉");

  // 之后在新页面上再开一层（灯箱），再按真返回键 —— 那一次 pop 不能被"预吃"掉。
  back.push(() => closed.push("lightbox"));
  assert.equal(back.onPop(), true);
  assert.deepEqual(closed, ["lightbox"], "端口没退 ⇒ 没有 pop 会来，不能预吃下一次真返回键");
  // 再按一次：消费掉留下的那条条目，没有层可关 ⇒ 交给系统（移动端就是后退一级 / 退出）
  assert.equal(back.onPop(), false);
  assert.equal(back.pushedCount(), 0);
});

test("释放是幂等的：重复释放不多退历史条目", () => {
  const { port, entries } = makePort();
  const back = createBackStack(port);
  const release = back.push(() => {});
  release();
  release();
  release();
  assert.equal(entries.length, 0);
});

test("关闭非栈顶层：只摘登记，不关错层、也不乱退条目", () => {
  const { port, entries } = makePort();
  const back = createBackStack(port);
  const closed: string[] = [];
  const releaseBottom = back.push(() => closed.push("bottom"));
  back.push(() => closed.push("top"));
  assert.equal(entries.length, 2);

  releaseBottom();
  assert.equal(back.depth(), 1, "只摘掉下面那层");
  assert.equal(entries.length, 2, "非栈顶关闭不动历史条目（留一条空条目，后续静默消费）");
  assert.equal(back.onPop(), true);
  assert.deepEqual(closed, ["top"], "返回键仍关的是栈顶那层");
});

test("端口压条目失败时：层照常能关，只是没有历史条目（退化为现状）", () => {
  const entries: unknown[] = [];
  const port: HistoryPort = {
    push: () => null,
    back() {
      entries.pop();
      return true;
    },
    forget() {},
  };
  const back = createBackStack(port);
  const closed: string[] = [];
  back.push(() => closed.push("a"));
  assert.equal(back.pushedCount(), 0);
  // 这种环境下 popstate 不会由我们触发；直接调用时也应关掉层
  assert.equal(back.onPop(), true);
  assert.deepEqual(closed, ["a"]);
});

test("hash 落点：它自己引发的那次 pop 必须被吃掉（否则刚压入的层立刻被关）", () => {
  // 真实机制：`location.hash = …` 会同时触发 hashchange 与 **popstate**（Chromium 实测）。
  // 退化落点下若不预先吃掉这次 pop，压入即被弹掉 —— 症状是「弹窗一出现就消失」。
  const { port } = makePort("hash");
  const back = createBackStack(port);
  const closed: string[] = [];

  back.push(() => closed.push("dialog"));
  assert.equal(back.depth(), 1, "层还在");
  assert.equal(back.pushedCount(), 1);

  // 模拟「设置 hash 引发的那次 popstate」到达
  assert.equal(back.onPop(), true);
  assert.deepEqual(closed, [], "这一次 pop 被吃掉，不能关掉刚压入的层");
  assert.equal(back.depth(), 1, "层依然在");

  // 之后用户真按返回：这一次才该关
  assert.equal(back.onPop(), true);
  assert.deepEqual(closed, ["dialog"]);
  assert.equal(back.depth(), 0);
});

/**
 * 端口要按**层**判"这条条目还能不能退"（浏览器侧记着每一层压入时的 URL），所以纯逻辑
 * 必须把是哪一层报给它。弹窗套弹窗 + 中间发生过导航时，只报"最后一次压入的那一层"
 * 会让第二层拿不到判据、退错条目。
 */
test("释放时把「退的是哪一层」报给端口", () => {
  const { port, entries, popped } = makePort();
  const back = createBackStack(port);
  const releaseBottom = back.push(() => {});
  const releaseTop = back.push(() => {});

  releaseBottom();
  assert.deepEqual(popped, [], "关非栈顶层：不该让端口退任何条目");

  const topId = (entries[entries.length - 1] as { gosslanBackLayer: number }).gosslanBackLayer;
  releaseTop();
  assert.deepEqual(popped, [topId], "关栈顶层：端口收到的必须是那一层的 id");
});

test("关闭非栈顶层：必须让端口忘掉那一层的 URL（否则 Map 里留下永不复查的记录）", () => {
  const { port, entries, forgotten } = makePort();
  const back = createBackStack(port);
  const releaseBottom = back.push(() => {});
  const releaseTop = back.push(() => {});
  const bottomId = (entries[0] as { gosslanBackLayer: number }).gosslanBackLayer;
  const topId = (entries[1] as { gosslanBackLayer: number }).gosslanBackLayer;

  releaseBottom();
  assert.deepEqual(forgotten, [bottomId], "非栈顶释放 ⇒ 报的是被摘掉那一层的 id");
  releaseTop();
  assert.deepEqual(forgotten, [bottomId], "栈顶释放走 back()，不该再报 forget（那条记忆由 back 自己清）");
  assert.notEqual(bottomId, topId);
});

test("正常落点（pushState）不会多吃一次 pop", () => {
  const { port } = makePort("pushState");
  const back = createBackStack(port);
  const closed: string[] = [];
  back.push(() => closed.push("a"));
  assert.equal(back.onPop(), true);
  assert.deepEqual(closed, ["a"], "第一次 pop 就该关掉层（没有被误吞）");
});
