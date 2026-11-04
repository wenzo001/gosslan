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
