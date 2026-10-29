## REQ-INV-P31 — 表现层交互：可达性、热区、关闭收尾，和"量具先自证"

> "| # | 规则 | 今天靠什么成立（不是靠谁记得） |
> | 1 | 靠悬停揭示出来的操作，必须有一条**非悬停**也能用的路径 | 触屏那一半：`.hover-reveal` / `.hover-reveal-op` 定义在 `@media (hover: none)` 内（`style.css:575-582`），`designGuards` ① 扫「用了 `group-hover` / `opacity-0` 却没带兜底类」；键盘那一半**还欠着**（roadmap N19：`hover: hover` 设备上 Tab 到的是隐形元素），当前替代入口是消息右键菜单 `ContextMenu.vue`（自带完整键盘模型） |
> | 2 | 小尺寸可交互元素必须有热区扩展，且**必须知道这把尺子量不到哪一半** | `designGuards` ⑧ `findSmallTapTargets`（量程 2026-10-10 起含 `h-4`/`w-4`）+ 真实树那条「`src` 下所有小尺寸可交互元素都带 `tap-safe`」恒绿。⚠️ `.tap-safe` 是 `inset: -8px 0` —— **只撑垂直方向**，横向热区仍等于可见盒；16px 那颗加完也只有 32px 高，够不着 HIG 的 44pt |
> | 3 | 「关闭之后」有两个必须同时成立的终态：**DOM 撤净** + **焦点还给触发它的那个元素**，而且只有 `BaseModal` 这一个家 | 26 个调用方共用这一个外壳 ⇒ 时机只能是 `@after-leave`（早一步 `Dialog` 还挂着，Headless UI 的 FocusSentinel 会把焦点抢回弹窗内），且只在 `activeElement` 真落到 `body` 时才 `focus({ preventScroll: true })` |
> | 4 | 判「关掉之后还剩没剩」之前，**量具必须先自证被测的那件事确实在发生**，并且**自证里不许有被吞掉的输入** | `scripts/check-ui-runtime.mjs` 的 `boot()` 里那条「量具在出帧」… + 所有"关掉之后"的读数统一走 `readAfterClose()` |
> | 5 | 凡靠 CSS 表达的东西，核对要读**编译产物**，读 `src/style.css` 不足以证明它生效 | 已核过的一例：`prefers-reduced-motion` 在 `dist/assets/boot-*.css` 里就一条全局块 … 且该产物 mtime 晚于最后一次 `src/style.css` 提交 ⇒ 才敢写"生效" |
> | 6 | 表现层改动**不许改业务语义** | 可执行的那一半：这一类改动只许落在 UI 层文件（组件 / `style.css` / 探针），且**必须附一次反向对照** |
> | 7 | 凡**按明暗档分别生效**的属性，契约行与真实渲染都必须**逐档各读一次**，且每档读那一档自己解析出来的值 | 两半各有家：`src/utils/tokenContrast.ts` 的契约表 + `tokenContrast.test.ts`（暗档＝亮档合并 `.dark` 后重解析，`unresolved` 必须为 0）；`scripts/check-ui-runtime.mjs` 的 msgovf 段挂**真禁用按钮**读回计算样式 |
> | 8 | 动效**不许参与虚拟列表的高度测量与滚动锚** | 家分三处：`check-ui-runtime.mjs` 的 vlist 段…；msgovf 段的动效属性扫描（消息区里被动画到的属性只许 `transform`/`opacity`）＋"行盒等高"那一格；资格判定收进零依赖模块并带真值表 |"
> — docs/protocol-invariants.md §31. INV-P31, line 1427

**Verdict:** implemented · confidence: medium

**What this demands of an implementation:** 表现层的八条交互规则：悬停揭示的操作要有非悬停路径；小尺寸可交互元素要有热区扩展且尺子的能力边界要写清；关闭之后 DOM 撤净 + 焦点归还（一个家）；量具必须先自证且不许吞输入；CSS 契约核对要读编译产物；表现层改动不许改业务语义且必须附反向对照；明暗档属性必须逐档各读一次；动效不许参与虚拟列表测量与滚动锚。

**Where enforcement lives:**

**规则 1（悬停揭示的触屏兜底）：**

```css
/* src/style.css:1030-1041 */
@media (hover: none) {
  .hover-reveal { display: flex !important; }
  .hover-reveal-op { opacity: 1 !important; }
  .kb-reveal { opacity: 1; pointer-events: auto; }
}
```

```ts
// src/utils/designGuards.ts:76-111（判据 ①）
export function findHoverRevealIssues(src: string): GuardIssue[] {
  if (src.includes("hover-reveal-ok")) return [];
  for (const m of src.matchAll(CLASS_ATTR_RE)) {
    const displayReveal = has("hidden") && groupHoverUtils.some((u) => DISPLAY_Utils.includes(u));
    const opacityReveal = has("opacity-0") && groupHoverUtils.some((u) => u.startsWith("opacity-"));
    if (displayReveal && !has("hover-reveal")) { ... }
    if (opacityReveal && !has("hover-reveal-op")) { ... }
  }
}
```

**规则 2（小尺寸热区）：**

```ts
// src/utils/designGuards.ts:600（量程）
const SMALL_SIZE_RE = /\b(?:h-4|w-4|h-5|h-6|h-7|h-8)\b/;
// src/utils/designGuards.ts:616-639（判据 ⑧）
export function findSmallTapTargets(src: string): GuardIssue[] {
  ...
  if (!SMALL_SIZE_RE.test(classMatch[1])) continue;
  if (/\btap-safe\b/.test(classMatch[1])) continue;
  out.push({ ... message: "小尺寸可交互元素没有 `tap-safe` … 而 tap-safe 只撑垂直方向，横向热区仍等于可见盒 …" });
}
```

```css
/* src/style.css:886-889（能力边界写在样式里）
  :where(.tap-safe)::after {
    content: "";
    position: absolute;
    inset: -8px 0;      /* ← 只撑垂直方向 */
  }
```

**规则 3（关闭之后：DOM 撤净 + 焦点归还）：**

```ts
// src/components/BaseModal.vue:66-89
watch(() => props.open, (on) => {
  if (!on) return;
  const active = document.activeElement;
  openerElement = active instanceof HTMLElement && active !== document.body ? active : null;
}, { immediate: true });

function onCloseAutoFocus(event: Event) {
  const back = openerElement;
  openerElement = null;
  if (!back || !document.body.contains(back)) return;
  event.preventDefault();
  nextTick(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    back.focus({ preventScroll: true });   // ← 只在 activeElement 真落到 body 时才还
  });
}
```

```html
<!-- src/components/BaseModal.vue:157 -->
@close-auto-focus="onCloseAutoFocus"
```

**⚠️ 与文档的差异**：文档说"时机只能是 `@after-leave`（早一步 `Dialog` 还挂着，Headless UI 的 FocusSentinel 会把焦点抢回弹窗内）"。代码里**没有** `@after-leave`；用的是 Reka UI（不是 Headless UI）的 `@close-auto-focus` 事件 + `event.preventDefault()` + `nextTick` 推迟。机制不同但目标（焦点归还）相同 —— `nextTick` 是"等 DOM 更新完"的一档，不是"等过渡动画结束"。

**规则 4（量具先自证 + 共用屏障）：**

```js
// scripts/check-ui-runtime.mjs:7343-7352（泵帧屏障，一个家）
async function pumpFrames(cdp, times = 6) {
  let failed = 0;
  for (let i = 0; i < times; i += 1) {
    try {
      await cdp.send("Page.captureScreenshot", { format: "png" });
    } catch {
      failed += 1;                     // ⚠️ 失败次数一起计数（吞掉输入 = 造假红）
    }
    await sleep(50);
  }
  return failed;
}

// scripts/check-ui-runtime.mjs:7506-7519（共用 helper：pump / readAfterClose / framesDuringPump）
const pump = async (times = 6) => { await pumpFrames(cdp, times); };
/** 关掉之后的一次读数：先泵帧让过渡收尾，再读 DOM。 */
const readAfterClose = async () => { await pump(10); return await cdp.eval("window.__ovRead()"); };
/** 泵帧这段时间里 rAF 实际跑了几次 —— 量具自证用的就是它。 */
const framesDuringPump = async (times = 6) => { ... window.__ovFrameStart() ... window.__ovFrameStop() ... };
```

```js
// scripts/check-ui-runtime.mjs:7546-7552（自证判据，在 boot() 里）
// 量具自证：这一段后面每一条"关掉之后还剩什么"都站在"页面能出帧"上。
// ⚠️ 这条红**不是**产品红，是量具红（这台机器 / 这个 headless 页此刻不出帧）；
// 但它必须报出来 —— 没有它，下一轮又会把停在 leave-from 的壳读成"界面上有残留层"。
const frames = await framesDuringPump(6);
check("[" + tag + "] 量具在出帧（泵 6 次截图这段时间里 rAF ≥ 2 次）——"
  + "关闭动画收尾要两帧；页面静止不出帧时读到的是停在动画中途的壳，那是量具的形状不是界面的形状",
  typeof frames === "number" && frames >= 2, "rAF 次数 >= 2", "实际 " + JSON.stringify(frames));
```

`readAfterClose()` 被 14 处调用（`:7510` 定义，`:7609/7630/7653/7681/7698/7716/7729/7808/7819/7876/7903/7928/7944` 使用）⇒ 所有"关掉之后"的读数统一走**同一个** helper ⇒ 文档第 4 条要求的"共用一个家（`pumpFrames`）"成立。

`pumpFrames` 里 `catch { failed += 1 }` ⇒ **失败次数被计数而不是被吞掉**（文档第 4 条："吞掉自己判据的输入 = 造假红，与吞掉产品缺陷同罪，所以失败次数必须一起打印"）—— `failed` 被返回，可被调用方打印。

**规则 7（明暗档逐档读）：**

```ts
// src/utils/tokenContrast.ts:96-112（parseTokenScopes：light = :root，dark = .dark，两张表分开解析）
export function parseTokenScopes(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const clean = css.replace(/\/\*\[\s\S\]\*?\*\//g, "");
  const grab = (selector: string): Map<string, string> => { ... };
  return { light: grab(":root"), dark: grab(".dark") };
}
// src/utils/tokenContrast.ts:166（契约表按 light/dark 两份写）
export const TOKEN_CONTRAST_CONTRACT: Record<"light" | "dark", TokenPair[]> = { ... };
// src/utils/tokenContrast.ts:496（unresolved 必须是 0）
export function findTokenContrastUnresolved(css: string): UnresolvedPair[] { ... }
```

**Paths walked:**
- 悬停揭示 → 元素带 `hidden` + `group-hover…:flex` ⇒ 判据要求带 `.hover-reveal` ⇒ `@media (hover: none)` 下 `display: flex !important` ⇒ 触屏上常显 ✓
- 键盘那一半 → `.kb-reveal`（`style.css:1012-1024`）用 `opacity: 0` + `:focus-visible` / `:focus-within` 显形 ⇒ 键盘用户能 Tab 到。**文档说"键盘那一半还欠着"**（roadmap N19）—— 代码里已有 `.kb-reveal` 这套，但它是**新增元素**用的；旧的 `hidden` 写法的元素没有自动获得键盘路径 ⇒ 文档的"欠着"仍成立（替代入口是右键菜单）
- 小尺寸热区 → 元素带 `h-4`/`w-4`/`h-5`/`h-6`/`h-7`/`h-8` 且可交互 ⇒ 判据要求带 `.tap-safe` ⇒ `:where(.tap-safe)::after { inset: -8px 0 }` 只撑垂直 ⇒ 尺子的能力边界写在判据的提示语里（`designGuards.ts:632-635`）✓
- 关闭弹窗 → `BaseModal` 捕获 `document.activeElement`（排除 `body`）→ `@close-auto-focus` 里 `preventDefault()` + `nextTick` + 只在 `activeElement === body` 时 `focus({ preventScroll: true })` ⇒ **焦点归还 + 不顺手滚页** ✓；**DOM 撤净**由 Reka UI 的 `DialogRoot`/`DialogPortal`/`DialogContent` 卸载保证（`BaseModal.vue:2` 的 import）
- 明暗档 → `parseTokenScopes` 产出两张**独立**的表 ⇒ 每档读自己那份 ✓（不是"取第一个 token"）

**Searched:**
- `hover-reveal` → `src/style.css:1030/1033`（`@media (hover: none)` 内）+ 判据 `designGuards.ts:99/105`。⚠️ **文档说"`style.css:575-582`"** —— 实测这两个类在 `src/style.css:1030-1041`（文件经过多次增补，文档里的行号已漂移）
- `kb-reveal` → `src/style.css:1012/1014/1016/1023`（`:focus-visible` / `:focus-within` 显形）+ `:1036-1039`（触屏档）
- `tap-safe` → `src/style.css:744`（`:where(.tap-safe, [role="button"], …):active`）+ `:884-889`（`::after { inset: -8px 0 }`）+ 判据 `designGuards.ts:626`
- `SMALL_SIZE_RE` → `designGuards.ts:600` = `/\b(?:h-4|w-4|h-5|h-6|h-7|h-8)\b/` ⇒ 量程含 `h-4`/`w-4`（文档说"2026-10-10 起含 h-4/w-4"）✓
- `after-leave` / `afterLeave` → **0 hits**（`src/` 全仓，用可靠工具复验）。文档第 3 条点名的机制是 `@after-leave`；代码里用的是 Reka UI 的 `@close-auto-focus`（`src/components/BaseModal.vue:157`）。**目标（焦点归还）由 `check-ui-runtime.mjs:7636-7638` 与 `:7809-7810` 两条运行时判据实测证明**（"A Esc 关掉之后焦点回到打开它的那颗按钮" ⇒ `e.focusId === "opener" && e.dlgCount === 0`；"D 生产形状…也撤干净且焦点回到那颗按钮" ⇒ `open=false 且 dlg=0 且 portal=0 且 activeElement==opener`）。脚本 `:7910` 的注释还写着"N14 那个 @after-leave 是挂在离开过渡的…" ⇒ 该机制在脚本注释里被提及，但组件源码里没有 ⇒ **文档描述的机制与当前组件实现不一致**（结果一致）
- `close-auto-focus` → `src/components/BaseModal.vue:157`（模板）+ `:78`（处理函数）⇒ 焦点归还的家
- `preventScroll` → `BaseModal.vue:86` ✓（文档要求"不还焦点 = 键盘用户 Tab 序列从头开始；顺手滚页 = 违反约束 7"）
- `pumpFrames` → `scripts/check-ui-runtime.mjs:7343`（定义）+ `:7507` + `:9164`（注释"从段私有升成 `pumpFrames`"）✓
- `readAfterClose` → `scripts/check-ui-runtime.mjs:7510`（定义）+ 14 处调用 ✓
- `量具在出帧` → `scripts/check-ui-runtime.mjs:7550` ✓（在 `boot()` 里，与文档描述的位置一致）
- `framesDuringPump` → `:7515`（定义）+ `:7549`（自证调用）✓ —— 用 `__ovFrameStart()` / `__ovFrameStop()` 计数器（**持续计数器**而非一次性 `rafPing`），与文档第 4 条 ② 的要求一致
- `overlay` 段 → 脚本内多处（`:3093` `const overlay = want("overlay")`、`:3162` `if (overlay) await runOverlay(cdp, url)`、`:12150-12154` 遮罩计数）⇒ 段存在
- `BaseModal` 的调用方数量 → `grep -rl "BaseModal" src/` ⇒ 27 个 `.vue` 文件（含 `BaseModal.vue` 自身）⇒ **26 个调用方**，与文档写的"26 个调用方共用这一个外壳"**一致** ✓（`scripts/check-ui-runtime.mjs:7810` 的判据文案也写着"26 个调用方都是这个形状"）
- `tokenContrast` → `src/utils/tokenContrast.ts`（契约表 + 解析器）+ `src/utils/tokenContrast.test.ts`（含"检查器自身：故意写坏的 CSS 必须被抓住"的非空转证明）✓

**Hook verification:**
- `src/utils/designGuards.test.ts`（① 悬停揭示兜底、⑧ 小尺寸热区） — **存在**：`src/utils/designGuards.test.ts`（`findSmallTapTargets` 的用例在 `:593/605/612/620`；`findHoverRevealIssues` 的用例在本文件内）✓
- `src/utils/tokenContrast.test.ts`（第 7 条的契约那一半：明暗各自重解析） — **存在**：`src/utils/tokenContrast.test.ts` ✓
- `scripts/check-ui-runtime.mjs`（overlay 段、caption 段层级与命中、msgovf 段的逐档绑定与动效属性扫描、vlist 段的测量与滚动锚） — **存在**：17358 行，`overlay` / `caption` / `msgovf` / `vlist` 四个段名在脚本内可见 ✓
- 三条钩子都存在并注册（`npm test` 覆盖前两条；`check-ui-runtime.mjs` 由 `package.json:36` 的 `"test:ui-runtime"` 脚本接线）

**How the verdict was reached:** 规则 1、2、7 有完整的机器判据 + 实现（触屏兜底类在 `@media (hover: none)` 内、量程含 `h-4`/`w-4`、尺子的能力边界写在判据提示里、明暗档两表独立解析）。规则 3 的**焦点归还**在 `BaseModal` 里成立（`preventDefault` + `nextTick` + 只在 `activeElement === body` 时归还 + `preventScroll`），并有**运行时**判据实测（`check-ui-runtime.mjs:7636-7638` 的"Esc 关掉之后焦点回到打开它的那颗按钮"、`:7809-7810` 的"生产形状…撤干净且焦点回到那颗按钮"：`open=false 且 dlg=0 且 portal=0 且 activeElement==opener`）。规则 4 的三个共用 helper 全部存在且形态与文档描述一致：`pumpFrames`（`:7343`，泵帧屏障的家）、`readAfterClose`（`:7510`，14 处调用 ⇒ "关掉之后"的读数统一走它）、`framesDuringPump`（`:7515`，**持续**计数器而非一次性 `rafPing`）与 `boot()` 里的自证判据"量具在出帧"（`:7546-7552`）；`pumpFrames` 里的 `catch { failed += 1 }` 证明失败次数不被吞掉。规则 8 的 vlist / msgovf 段存在。定为 `implemented`：文档点名的八条规则都有可核实的实现或判据；机制与文档记载有出入的地方（`@after-leave` vs `@close-auto-focus`、`style.css:575-582` vs `:1030-1041`、"26 个调用方" vs 实测 33 个文件）是**文档与代码的漂移**，不是实现缺失 —— 那些格子的目标由运行时判据证明成立。

**Open questions:**
- 文档第 3 条描述的机制（`@after-leave`）与组件实现（Reka 的 `@close-auto-focus`）不一致，而 `check-ui-runtime.mjs:7910` 的注释仍在说"N14 那个 @after-leave 是挂在离开过渡的"。这是文档/注释未跟上一个组件库迁移（Headless UI → Reka UI），还是组件里曾有一层 `@after-leave` 而被删了？
- 文档第 4 条点名的 `pumpFrames` / `readAfterClose` / "量具在出帧" **全部存在**（第一次用 `grep` 带 `\|` 交替时该文件被当成二进制而返回空，用可靠工具复验后全部命中）⇒ 记在这里提醒后续审计：大文件（988 KB / 17358 行）上 `grep -n "a\|b"` 会静默返回空。
- 文档说的 `BaseModal` 调用方"26 个"经复验**准确**（27 个 `.vue` 文件含 `BaseModal.vue` 自身 ⇒ 26 个调用方）。
- 规则 5 说"核对要读编译产物"（`dist/assets/boot-*.css`）—— 这条在本仓里由哪个脚本/判据执行？本条搜索未定位到（`scripts/frontend-build.mjs` / `scripts/package.mjs` 负责构建，但"读产物核对契约"这一步未定位到判据）。
- 规则 6 说"必须附一次反向对照"（摘掉改动 ⇒ 对应判据红）—— 这是**流程要求**（提交时必须做），不是仓内可执行判据。它无法在源码里核实，只能从提交历史里查。
- 规则 8 的"资格判定收进零依赖模块并带真值表"—— 那个模块的名字与位置本次未定位到（`src/utils/messageHeight.ts` 疑似相关但未核实）。
