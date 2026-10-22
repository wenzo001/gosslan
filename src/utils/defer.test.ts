/**
 * 「输入框优先」这一族的守卫。
 *
 * 前半是**去抖语义真值表**。这一格原来是自己写的 `debounce`，2026-10-19 换成已装的
 * `@vueuse/core`（`useDebounceFn`），四条语义照钉不误 —— 它们是 `useAppStore.persistSoon`
 * 的落库出口和搜索框打字共同吃的契约：尾沿只执行一次并取最后一次参数、`cancel` 丢弃待执行、
 * `flush` 立即执行且之后不再补、无待执行时 `flush` 是空操作。库升级把哪一条改了，
 * 这里要当场红，而不是等"丢了一次设置写入"再复盘。
 *
 * 后半是**静态接线守卫** —— 它读各输入框组件的源码，
 * 确认"原值绑输入框、延迟镜像喂派生渲染"这个结构没有被改回去。
 * 加这层守卫的原因：接线退化后界面**看起来完全正常**（功能都对），
 * 只有按住 Ctrl+V 连发粘贴时才卡；靠人眼回归是发现不了的。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { useDebounceFn } from "@vueuse/core";
import { shouldRunThrottled, sleep } from "./defer.ts";

const srcDir = join(import.meta.dirname, "..");

/** 用假定时器驱动：`setTimeout` 只在测试里被替换，去抖实现本身不做特判。 */
function withFakeTimers<T>(fn: (clock: { tick(ms: number): void }) => T): T {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  globalThis.setTimeout = ((cb: () => void, ms?: number) => {
    const id = ++seq;
    timers.set(id, { at: now + (ms ?? 0), cb });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as typeof clearTimeout;
  try {
    return fn({
      tick(ms: number) {
        now += ms;
        for (const [id, t] of [...timers]) {
          if (t.at <= now) {
            timers.delete(id);
            t.cb();
          }
        }
      },
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}

test("连发调用只在停手后执行一次，且用最后一次的参数", () => {
  withFakeTimers((clock) => {
    const seen: string[] = [];
    const d = useDebounceFn((v: string) => seen.push(v), 100);
    // 模拟按住 Ctrl+V：10 次连发，间隔 20ms
    for (let i = 0; i < 10; i++) {
      d(`paste-${i}`);
      clock.tick(20);
    }
    assert.deepEqual(seen, [], "连发期间不应执行（否则每次粘贴都会重算派生渲染）");
    // 最后一次调用发生在 now=180（窗口在 280 到点）；此刻 now=200
    clock.tick(79);
    assert.deepEqual(seen, [], "未到窗口不应执行");
    clock.tick(1);
    assert.deepEqual(seen, ["paste-9"], "窗口结束只执行一次，且是最后一次的参数");
  });
});

test("间隔大于窗口时每次都执行（不会吞掉正常打字）", () => {
  withFakeTimers((clock) => {
    let n = 0;
    const d = useDebounceFn(() => n++, 50);
    d();
    clock.tick(60);
    d();
    clock.tick(60);
    assert.equal(n, 2);
  });
});

test("cancel 丢弃待执行；flush 立刻执行且之后不重复", () => {
  withFakeTimers((clock) => {
    const seen: string[] = [];
    const d = useDebounceFn((v: string) => seen.push(v), 100);
    d("a");
    d("b");
    d.cancel();
    clock.tick(500);
    assert.deepEqual(seen, [], "cancel 后连定时器都不该留下");
    d("c");
    d.flush();
    assert.deepEqual(seen, ["c"], "flush 立刻执行待执行的那一次");
    clock.tick(500);
    assert.deepEqual(seen, ["c"], "flush 之后原定时器必须已被清掉，不能重复执行");
  });
});

test("无待执行时 flush 是空操作（不会凭空多写一次库）", () => {
  withFakeTimers((clock) => {
    let n = 0;
    const d = useDebounceFn(() => n++, 100);
    d.flush();
    clock.tick(500);
    assert.equal(n, 0);
    d();
    clock.tick(100);
    assert.equal(n, 1);
    d.flush();
    assert.equal(n, 1, "执行完再 flush 不该再来一次");
  });
});

// ---------------- 接线守卫：输入框必须"原值即时、派生延迟" ----------------

function read(rel: string): string {
  return readFileSync(join(srcDir, rel), "utf8");
}

/**
 * 断言：输入框绑原值 + 建了延迟镜像 + **派生渲染不再读原值**。
 *
 * 最后一条是重点：只检查"有没有调 refDebounced"是不够的（那样建了镜像却仍读原值
 * 也能骗过测试）。这里把原值的**写入**（`ref.value = ...`，如"打开弹窗时清空关键词"）
 * 排除掉，剩下的读引用一律不允许出现。
 */
function assertDeferredInput(rel: string, rawRef: string) {
  const src = read(rel);
  assert.match(
    src,
    new RegExp(`v-model="${rawRef}"`),
    `${rel}: 输入框应绑原值 \`${rawRef}\`（DOM 立即更新，零响应式成本）`,
  );
  assert.match(
    src,
    new RegExp(`refDebounced\\(\\s*${rawRef}\\b`),
    `${rel}: 必须为 \`${rawRef}\` 建延迟镜像并把派生渲染接过去 —— ` +
      `否则连发粘贴时每个字符都会重算/重渲染，输入框会一顿一顿`,
  );
  // 去掉赋值语句后，组件里不应再有对原值的读取
  const withoutWrites = src.replace(new RegExp(`${rawRef}\\.value\\s*=[^=]`, "g"), "WRITE");
  const reads = withoutWrites.match(new RegExp(`${rawRef}\\.value`, "g")) ?? [];
  assert.equal(
    reads.length,
    0,
    `${rel}: 派生渲染仍直接读 \`${rawRef}.value\`（${reads.length} 处）—— 应改读延迟镜像，` +
      `否则延迟镜像等于没建（功能不变，但连发粘贴依旧卡）`,
  );
}

test("过滤型输入框都接了延迟镜像（连发粘贴不卡）", () => {
  // 加好友搜索：过滤 peers 列表
  assertDeferredInput("components/AddFriendModal.vue", "keyword");
  // 转发搜索：过滤会话列表
  assertDeferredInput("components/message/ForwardModal.vue", "keyword");
  // 日志过滤：每次重算命中行 + 每行 4 处高亮（上千行 v-html）
  assertDeferredInput("components/LogViewer.vue", "filter");
});

test("会话列表：输入不改列表，回车才搜索（用户 2026-09-12 明确要求）", () => {
  const list = read("components/ConversationList.vue");
  assert.match(list, /v-model="keyword"/, "搜索框绑原值");
  // ① 输入不再驱动会话列表过滤：列表恒为全量
  assert.match(
    list,
    /const listConversations = computed\(\(\) => chat\.conversations\)/,
    "会话列表必须是全量、不随输入变化（用户：『在上面输入，列表就不要有变化了』）",
  );
  assert.ok(!list.includes('v-for="c in filtered"'), "不得再用过滤结果渲染会话列表");
  assert.ok(!list.includes("api.searchMessages"), "列表不再查消息内容（搜消息全在弹窗里做）");
  assert.match(list, /@keydown\.enter\.prevent="onSearchEnter"/, "回车仍然要打开搜索弹窗");
  // ② 联系人页的姓名过滤仍走延迟镜像（连发粘贴不卡）
  assert.match(list, /const \{ keyword, query \} = useSearchKeyword\(\)/, "输入状态来自 useSearchKeyword");
  const composable = read("composables/useSearchKeyword.ts");
  assert.match(
    composable,
    /refDebounced\(\s*keyword\b/,
    "仍要为联系人姓名过滤建延迟镜像（否则粘贴时整列重渲染）",
  );
  assert.match(composable, /return \{ keyword, query \}/, "必须把延迟值暴露出来");
});

test("搜索弹窗：有 loading 态；清空关键词回到初始空态", () => {
  const dlg = read("components/search/ChatSearchDialog.vue");
  assert.match(
    dlg,
    /v-(?:else-)?if="searching"/,
    "搜索在途必须有可见的 loading（用户：『感觉显示得比较慢，当前状态没有提示』）",
  );
  assert.match(
    dlg,
    /v-if="!keyword\.trim\(\)"/,
    "关键词为空时要回到初始空态（而不是留着上一次的结果）",
  );
  assert.match(dlg, /useImeEnterGuard/, "回车要过输入法守卫（拼音候选里回车是选字）");
});

test("日志过滤的派生渲染读延迟值，不读原值", () => {
  const src = read("components/LogViewer.vue");
  const derived = src.slice(src.indexOf("const matched = computed"));
  assert.ok(
    derived.includes("deferredFilter.value") || derived.includes("query.value"),
    "LogViewer 的 matched/trimmedFilter 必须读延迟值；改成 filter.value 就会每字符重建上千行",
  );
  assert.match(
    src,
    /const trimmedFilter = computed\(\(\) => deferredFilter\.value/,
    "高亮用的 trimmedFilter 也必须读延迟值（否则高亮与命中集合不一致）",
  );
});

test("高频写入的设置项不每次都落库（IPC 风暴守卫）", () => {
  const src = read("stores/useAppStore.ts");
  const countOf = (s: string, needle: string) => s.split(needle).length - 1;
  // 钉"出现次数"而不是"存在性"：把去抖退回手写 setTimeout，`persistSoon` 这个名字还在，
  // 只查存在的判据照样绿 —— 而丢的那次写入只有关窗时才看得见。
  assert.equal(
    countOf(src, "const persistSoon = useDebounceFn("),
    1,
    "去抖持久化只许有一个定义点（换成自研计时器 ⇒ 这条红）",
  );
  assert.equal(
    countOf(src, "persistSoon.flush()"),
    2,
    "落库出口必须仍是两条：beforeunload + visibilitychange。少一条 = 关窗/切后台时丢掉最后一次设置写入",
  );
  const setter = src.slice(src.indexOf("function setThemeColor"));
  assert.ok(
    setter.slice(0, 400).includes("persistSoon"),
    "setThemeColor 由颜色选择器连续触发，必须走去抖持久化而不是每次都 persistSettings()",
  );
  // 反空转：上面两条要抓得住"退回手写计时器"那一行
  const oldShape = "const persistSoon = debounce(() => void persistSettings(), 300);";
  assert.equal(countOf(oldShape, "const persistSoon = useDebounceFn("), 0, "定义点那条抓不到退回写法 ⇒ 是空转");
  assert.equal(countOf("persistSoon();", "persistSoon.flush()"), 0, "flush 那条抓不到少一个出口 ⇒ 是空转");
});

// ---------------- `shouldRunThrottled`（事件驱动的刷新节流） ----------------
//
// 用途：`peers-updated` 最多 3/s，而它触发的拓扑刷新变化很慢。每个事件都发一次 IPC
// 就是白白的 IPC 风暴（每次都要跨进程、过主线程消息循环），攒起来就是"顿"。

test("从未执行过（last = 0）一律放行", () => {
  assert.equal(shouldRunThrottled(1000, 0, 1000), true);
});

test("距上次不足间隔就不执行，够间隔才执行", () => {
  assert.equal(shouldRunThrottled(1500, 1000, 1000), false, "差 500ms 应被节流");
  assert.equal(shouldRunThrottled(1999, 1000, 1000), false, "差 999ms 仍被节流");
  assert.equal(shouldRunThrottled(2000, 1000, 1000), true, "差 1000ms 放行");
  assert.equal(shouldRunThrottled(9999, 1000, 1000), true, "差得越多越放行");
});

/**
 * 「至少隔 N 毫秒才放行」这一族只有一个家。
 *
 * 为什么要钉：这一族原来有五份手写实现 —— 同一个「间隔 + 什么时候把 last 推到 now」
 * 各写一遍（`useChatStore` 的抖动甚至两份完全一样的复制），而边界方向（`<` 还是 `>=`、
 * `last === 0` 算不算是首次）各人各写。常量虽然同源，**规则**却会各漂各的：改一处
 * 节流语义，另一处照旧，且不会有任何东西变红。2026-10-19 全部并到 `shouldRunThrottled`。
 *
 * ⚠️ 白名单里那几处**形状像但不是限流闸** —— 它们要的是「最近 N 毫秒之内」（窗口内判定）、
 * 「超过 N 就过期」（年龄判定），语义与「放行不放行」相反。硬套那个家会把意思写反。
 */
const NOT_A_GATE = new Map<string, string>([
  ["utils/ime.ts", "输入法组合结束后的窗口内判定（要的是「还在 N ms 之内」）"],
  ["utils/recall.ts", "撤回窗口：要的是「还在 5 分钟内」的窗口判定，不是限流放行"],
  ["components/TitleBar.vue", "双击标题栏检测：同样是「窗口之内」，不是限流"],
  ["components/VirtualList.vue", "「最近往上滚过」⇒ 暂停贴底（窗口判定）"],
  ["utils/messages.ts", "在线状态 TTL 清扫（过期判定）"],
  ["utils/todos.ts", "完成后满 N 天归档（年龄判定）"],
  ["components/AddFriendModal.vue", "冷却只决定按钮置灰与文案，解除由定时器负责，不认领额度"],
]);

test("手写时间差闸门不许长回第二份：间隔规则只有 defer 那一个家", () => {
  const GATE = /(?:\bnow\b|Date\.now\(\))\s*-\s*[^\n]*?(?:<=|>=|<|>)\s*[\w.]+/;
  // 正控：先证明这个 matcher 认得出被替换掉的那几种写法（否则「白名单外 0 处」是空转）
  for (const probe of [
    "if (now - lastShakeAt < SHAKE_MS) return;",
    "if (now - historyReloadAt >= 1500) {",
    "return Date.now() - lastSeen < ms;",
    "return Date.now() - (cooldown.value[id] ?? 0) < COOLDOWN_MS;",
  ]) {
    assert.ok(GATE.test(probe), `matcher 认不出这条形状 ⇒ 下面的判定不作数：${probe}`);
  }
  const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter(
    (p) => p.endsWith(".vue") || (p.endsWith(".ts") && !p.endsWith(".test.ts")),
  );
  const found: string[] = [];
  for (const r of files) {
    const rel = r.split("\\").join("/");
    if (rel === "utils/defer.ts") continue; // 家本身
    const text = readFileSync(join(srcDir, r), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    if ([...text.matchAll(new RegExp(GATE.source, "g"))].length > 0) found.push(rel);
  }
  // 分母下限：现存白名单有 6 处，认出来的比这还少 ⇒ 扫描面或 matcher 自己坏了
  assert.ok(found.length >= NOT_A_GATE.size, `只认出 ${found.length} 处时间差比较，低于白名单 ${NOT_A_GATE.size} 处 ⇒ 判据本身可能已失效`);
  const outside = found.filter((r) => !NOT_A_GATE.has(r));
  assert.deepEqual(
    outside,
    [],
    `这些文件手写了「至少隔 N 才放行」的闸门，该改走 shouldRunThrottled：${outside.join(", ")}`,
  );
  // 反向：那个家必须真的被用起来，否则「没有第二份」会因为大家压根没做这件事而成立
  const users = files.filter(
    (r) => !r.endsWith("defer.ts") && readFileSync(join(srcDir, r), "utf8").includes("shouldRunThrottled("),
  );
  assert.ok(
    users.length >= 3,
    `只有 ${users.length} 份生产文件用那个家（拓扑刷新/连点/抖动/群历史/草稿提示）⇒ 这条判据可能只是空扫`,
  );
});

test("sleep 到点才 resolve（不到点不许提前醒）", async () => {
  let done = false;
  const run = withFakeTimers(async (clock) => {
    const pr = sleep(500).then(() => {
      done = true;
    });
    clock.tick(499);
    await Promise.resolve();
    assert.equal(done, false, "499ms 就 resolve ⇒ 重试间隔实际短了一档");
    clock.tick(1);
    await pr;
    assert.equal(done, true, "到点后必须 resolve（否则 await 它的调用永久挂住）");
  });
  await run;
});

/**
 * 「等一会儿」这一族只有一个家 —— 现扫生产码里手抄的 `new Promise(... setTimeout ...)`。
 *
 * 为什么值得钉：这类复制不会报错，只会让同一件事有两种写法（`MergeCardModal` 曾自带私有
 * `sleep`、`useAppStore` 的蓝牙重试是内联的一份），将来要统一改重试节拍就得逐处找。
 * 库里没有对应物可换：`@vueuse/core` 14.4.0 与 `@vueuse/shared` 的 `index.d.ts` 里
 * grep `sleep` 各 0 命中（2026-10-20 现查），所以这一格是自研但**收在一个家**。
 */
test("手抄 sleep 不许长回第二份：等待这一族只有 defer 那一个家", () => {
  const SLEEP = /new Promise<[\s\S]{0,60}?=>\s*setTimeout\(/g;
  const INLINE = /new Promise\(\s*\(r\)\s*=>\s*setTimeout\(/g;
  // 正控：这两条就是本轮删掉的两种真写法，matcher 认不出 ⇒ 「0 处」是空扫
  for (const probe of [
    "function sleep(ms: number) {\n  return new Promise((r) => setTimeout(r, ms));\n}",
    "await new Promise((r) => setTimeout(r, 2000));",
  ]) {
    assert.ok(
      new RegExp(INLINE.source).test(probe) || new RegExp(SLEEP.source).test(probe),
      `matcher 认不出手抄 sleep ⇒ 下面的判定不作数：${probe}`,
    );
  }
  const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter(
    (p) => p.endsWith(".vue") || (p.endsWith(".ts") && !p.endsWith(".test.ts")),
  );
  const found: string[] = [];
  for (const r of files) {
    const rel = r.split("\\").join("/");
    if (rel === "utils/defer.ts") continue;
    const text = readFileSync(join(srcDir, r), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    if ([...text.matchAll(INLINE)].length + [...text.matchAll(SLEEP)].length > 0) found.push(rel);
  }
  assert.deepEqual(found, [], `这些文件手抄了 Promise+setTimeout 的等待，该改走 utils/defer 的 sleep：${found.join(", ")}`);
  // 反向：那个家必须真的被用起来，否则「没有第二份」会因为大家压根不等待而成立
  const users = files.filter(
    (r) => !r.endsWith("defer.ts") && /\bsleep\(/.test(readFileSync(join(srcDir, r), "utf8")),
  );
  assert.ok(users.length >= 2, `只有 ${users.length} 份生产文件真在用 sleep ⇒ 这条判据可能只是空扫`);
});
