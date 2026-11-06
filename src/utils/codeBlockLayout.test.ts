/**
 * 代码块预览的**结构契约**（能在单测里断言的部分）：
 *
 * 1. 头部（语言/行数）与 `pre` 是兄弟节点，`pre` 是唯一滚动容器 ⇒ 滚动时头部不动；
 * 2. `pre` 只有纵向滚动（长行 pre-wrap 折行），横向永不滚 ⇒ 不会撑破气泡宽度；
 * 3. 截断气泡把 `fill + scrollable` 传给 CodeBlock ⇒ 滚动收进代码区，外层不出现第二根滚动条；
 * 4. 发送后语言切换入口只在 `mine` 且 kind=code 时出现，并走现有 `chat.setMessageRender` 单一入口。
 *
 * 真正的 rect/触控读数在中英 UI 探针里另行记录（单测无法模拟触摸滚动）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

function read(...parts: string[]): string {
  return readFileSync(join(root, ...parts), "utf8");
}

test("CodeBlock：头部与 pre 同级，pre 才是滚动容器（头部不随滚动离开）", () => {
  const src = read("src", "components", "CodeBlock.vue");
  const toolbarAt = src.indexOf("height: 32px");
  const preAt = src.indexOf('<pre\n      class="code-pre');
  assert.ok(toolbarAt > 0 && preAt > toolbarAt, "pre 必须在头部之后、且不是头部的子节点");
  // 头部里面不能套 pre：命中的 `height: 32px` 那一段到 pre 之前不应出现 </div> 之外的 pre。
  assert.ok(!src.slice(toolbarAt, preAt).includes("<pre"), "头部内部不许再出现滚动容器");
  assert.match(src, /\n  <div\n    class="code-block[^"]*flex[^"]*flex-col/, "根节点必须是纵向 flex");
  assert.match(src, /\.code-pre--scroll\s*\{[^}]*overflow-y:\s*auto/s, "代码区自己纵向滚动");
  assert.match(src, /\.code-pre--scroll\s*\{[^}]*overscroll-behavior:\s*contain/s, "滚到尽头不把滚动传给消息列表");
  assert.match(src, /\.code-pre\s*\{[^}]*overflow-x:\s*hidden/s, "横向永不滚动，长行靠 pre-wrap");
});

test("MessageCodeBubble：截断态把 fill+scrollable 传给 CodeBlock（双层滚动条的反例断言）", () => {
  const src = read("src", "components", "message", "MessageCodeBubble.vue");
  const clampedBlock = src.slice(src.indexOf('v-if="clamped"'), src.indexOf("v-else"));
  assert.match(clampedBlock, /fill/, "截断态必须撑满固定高度");
  assert.match(clampedBlock, /scrollable/, "截断态必须让代码区自己滚");
  assert.match(clampedBlock, /overflow-hidden/, "外层必须裁掉溢出，避免第二根滚动条");
});

test("MessageCodeBubble：语言切换只暴露给发送方，并原样上报给父层", () => {
  const src = read("src", "components", "message", "MessageCodeBubble.vue");
  assert.match(src, /canSwitchLang/, "必须接 canSwitchLang");
  assert.match(src, /emit\(['"]switch-lang['"], \$event\)/, "必须把语言选择上报，不在气泡内私改");
});

test("MessageItem：发送后方能切换，且只走现有 setMessageRender 入口", () => {
  const src = read("src", "components", "MessageItem.vue");
  assert.match(
    src,
    /canSwitchCodeLang\s*=\s*computed\(\(\)\s*=>\s*mine\.value\s*&&\s*props\.message\.kind\s*===\s*"code"\)/,
    "非发送方/非代码消息不能出现切换入口",
  );
  assert.match(src, /chat\.setMessageRender\(/, "必须复用现有 render 更新入口");
  assert.match(src, /"code", value/, "切换语言时 mode 仍是 code，语言单独传");
});

test("Composer：取消代码块不清正文；语言选择器是独立子组件", () => {
  const src = read("src", "components", "chat", "MessageComposer.vue");
  const undo = src.slice(src.indexOf("function undoAutoCode()"), src.indexOf("function undoAutoCode()") + 400);
  assert.match(undo, /codeMode\.value = false/, "取消代码块只关模式");
  assert.ok(!/innerHTML\s*=/.test(undo), "取消代码块不得清空输入框（保留换行与原样字符）");
  assert.match(src, /<CodeLangMenu/, "语言选择走独立 CodeLangMenu 子组件");
});

/**
 * 守卫（2026-11-05）：语言下拉**必须**绑聊天区边界 + 限高内部滚动。
 *
 * 真实缺陷：弹层原先只按视口避让（Reka 的 `collisionBoundary` 默认空数组），
 * 16 个选项一列 ≈526px，在小窗/贴底时越过消息区底边，下半截选项点不到。
 * 运行时读数是 `scripts/check-ui-runtime.mjs --only=langdd`；这里守"写法不许退回"。
 *
 * 防空转：先切出真正的 `<DropdownMenuContent …>` 开标签再断言。若组件改名或标签被删，
 * 正则全文扫描会"查不到也不红"，所以标签定位失败本身就是一条红。
 */
test("CodeLangMenu：弹层绑聊天区边界并限高内部滚动（防回退成绝对定位无约束）", () => {
  const src = read("src", "components", "CodeLangMenu.vue");
  assert.ok(src.length > 1000, "锚点失效：CodeLangMenu.vue 读不到或被改名");

  const tagAt = src.indexOf("<DropdownMenuContent");
  assert.ok(tagAt > 0, "锚点失效：找不到 DropdownMenuContent 开标签");
  const tag = src.slice(tagAt, src.indexOf(">", tagAt));
  assert.match(tag, /collision-boundary/, "弹层必须绑定容器边界，不能只按视口避让");
  assert.match(tag, /collision-padding/, "边界内要留呼吸位");
  assert.match(tag, /sticky="always"/, "不许装 limitShift：触发器滚出容器时弹层必须被压回边界内");
  assert.match(tag, /code-lang-menu/, "限高样式必须真的挂在弹层上");
  assert.match(tag, /:style="menuStyle"/, "极窄容器要靠内联变量压 min-width");
  assert.ok(!/class="[^"]*absolute/.test(tag), "弹层不许退回绝对定位（它是 portal 到 body 的 fixed 层）");

  // 输入区（Composer）上方没有滚动容器 ⇒ 必须退到面板标记，不是视口。
  assert.ok(
    src.includes('closest<HTMLElement>("[data-lang-menu-boundary]")'),
    "找不到滚动祖先时要退到聊天面板",
  );
  assert.match(src, /measureMinWidth\(boundary\.value\)/, "打开时要按容器实测可用宽度");
  const chat = read("src", "components", "ChatWindow.vue");
  assert.match(chat, /data-lang-menu-boundary/, "聊天面板根节点必须带边界标记（否则输入区回退视口）");
  // 极窄时文字必须 truncate，而不是把弹层撑出去。
  assert.match(src, /<span class="min-w-0 truncate"/, "选项文字必须可省略");

  const cssAt = src.indexOf(".code-lang-menu {");
  assert.ok(cssAt < 0, "限高规则不许放回 scoped 块：弹层 class 与 data-v 落在不同节点，scoped 匹配不到");
  const css = read("src", "style.css");
  const cssAtGlobal = css.indexOf(".code-lang-menu {");
  assert.ok(cssAtGlobal > 0, "锚点失效：找不到全局 .code-lang-menu 样式块");
  const cssBlock = css.slice(cssAtGlobal, css.indexOf("}", cssAtGlobal));
  assert.match(
    cssBlock,
    /max-height:\s*var\(--reka-(dropdown-menu-content-available-height|popper-available-height)/,
    "限高必须吃 Reka 在**同一份边界**上算出的可用高度",
  );
  assert.match(
    cssBlock,
    /max-width:\s*var\(--reka-(dropdown-menu-content-available-width|popper-available-width)/,
    "横向也必须吃同一份边界的可用宽度",
  );
  assert.match(
    cssBlock,
    /min-width:\s*var\(--gosslan-lang-menu-min,\s*168px\)/,
    "极窄容器的 min-width 必须可被 CodeLangMenu 覆盖",
  );
  assert.match(cssBlock, /overflow-y:\s*auto/, "超出部分必须在弹层内部滚动");
  assert.match(cssBlock, /scrollbar-gutter:\s*stable/, "滚动条不许盖住文字/让文字横向跳");

  assert.match(src, /function resolveBoundary/, "边界必须是运行时解析的滚动容器，不许写死视口");
  assert.match(src, /boundary\.value = resolveBoundary\(triggerEl\.value\)/, "打开时要从触发器上溯定边界");
  assert.match(src, /scrollIntoView\(\{ block: "nearest"/, "打开时当前语言要滚进可见区");

  // 反例自证：把限高拿掉，下面这条必须识别出来（证明守卫不是查空气）。
  const mutated = css.replace(
    /max-height:\s*var\(--reka-(dropdown-menu-content-available-height|popper-available-height)[^;]*;/,
    "max-height: none;",
  );
  assert.notEqual(mutated, css, "反例自证：限高那一行没被替换到，锚点已漂");
  const mutatedAt = mutated.indexOf(".code-lang-menu {");
  assert.doesNotMatch(
    mutated.slice(mutatedAt, mutated.indexOf("}", mutatedAt)),
    /max-height:\s*var\(--reka-/,
    "反例自证：拿掉限高后守卫必须能识别（否则等于没守）",
  );

  // 反例自证（横向）：把 max-width 拿掉，极窄容器就会横向溢出容器。
  const mutatedW = css.replace(
    /max-width:\s*var\(--reka-(dropdown-menu-content-available-width|popper-available-width)[^;]*;/,
    "max-width: none;",
  );
  assert.notEqual(mutatedW, css, "反例自证：横向上限那一行没被替换到，锚点已漂");
  const mutatedWAt = mutatedW.indexOf(".code-lang-menu {");
  assert.doesNotMatch(
    mutatedW.slice(mutatedWAt, mutatedW.indexOf("}", mutatedWAt)),
    /max-width:\s*var\(--reka-/,
    "反例自证：拿掉横向上限后守卫必须能识别（否则等于没守）",
  );
});
