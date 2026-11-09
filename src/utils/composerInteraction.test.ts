/**
 * 聊天输入框四项交互（2026-11-04）的守卫：
 *   ① 多行自增高 5 行封顶；
 *   ② 粘贴图片先入框、发送才发；
 *   ③ 输入框内表情渲染成图片 token；
 *   ④「回到最新」纯圆无文字且水平居中；
 *   ⑤ 单行输入框与多行主输入框的高度只允许三档（sm 36 / md 40 / lg 44）。
 *
 * 前两项是纯函数真值表；后四项读组件源码做**静态接线守卫**。
 * 为什么后三项要读源码：这些是"回退后界面看起来仍然正常"的退化 ——
 * 例：粘贴又改回即时发送、表情又变回文字短码，肉眼回归很难发现。
 * 每条注释都写明"删掉修复会红"的反例锚点，避免守卫空转。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  COMPOSER_LINE_HEIGHT,
  COMPOSER_MAX_LINES,
  COMPOSER_VERTICAL_PADDING_PX,
  clampComposerHeight,
  composerMaxHeight,
} from "./composerLayout.ts";
import { pastedImageRejection } from "./composerAttachments.ts";
import { tsFnBody } from "./tsSource.ts";

const srcDir = join(import.meta.dirname, "..");
const composerSrc = readFileSync(join(srcDir, "components/chat/MessageComposer.vue"), "utf8");
const chatWindowSrc = readFileSync(join(srcDir, "components/ChatWindow.vue"), "utf8");
const backToLatestSrc = readFileSync(join(srcDir, "components/chat/BackToLatestButton.vue"), "utf8");

test("输入框 5 行封顶后高度恒定（删掉 clamp 会红）", () => {
  assert.equal(COMPOSER_MAX_LINES, 5);
  const lineHeight = 14 * COMPOSER_LINE_HEIGHT;
  const max = composerMaxHeight(14);
  assert.equal(max, Math.round(lineHeight * COMPOSER_MAX_LINES + COMPOSER_VERTICAL_PADDING_PX));

  const contentHeights = Array.from(
    { length: 8 },
    (_, index) => Math.round((index + 1) * lineHeight + COMPOSER_VERTICAL_PADDING_PX),
  );
  const clamped = contentHeights.map((height) => clampComposerHeight(height, max));

  // 1→5 行逐步变高（平滑撑高），第 5 行恰好到封顶值。
  for (let lines = 2; lines <= COMPOSER_MAX_LINES; lines += 1) {
    assert.ok(clamped[lines - 1] > clamped[lines - 2], `${lines} 行应比 ${lines - 1} 行高`);
  }
  assert.equal(clamped[COMPOSER_MAX_LINES - 1], max);

  // 6→8 行恒定（内部滚动，不再变高）。
  for (let lines = COMPOSER_MAX_LINES + 1; lines <= 8; lines += 1) {
    assert.equal(clamped[lines - 1], max, `${lines} 行必须仍封顶`);
    assert.ok(contentHeights[lines - 1] > max, `${lines} 行内容确实超过了封顶值（反例前提）`);
  }
});

test("粘贴图片格式/体积校验给出具名原因（删掉校验会红）", () => {
  const maxBytes = 8 * 1024 * 1024;
  assert.equal(pastedImageRejection("image/png", 1024, maxBytes), null);
  assert.equal(pastedImageRejection("IMAGE/WEBP", 1024, maxBytes), null);
  assert.equal(pastedImageRejection("image/gif", maxBytes, maxBytes), null);
  // 反例前提：没有这道校验时下面两种都会返回 null，界面就会静默吞掉。
  assert.equal(pastedImageRejection("image/svg+xml", 1, maxBytes), "unsupported");
  assert.equal(pastedImageRejection("image/png", maxBytes + 1, maxBytes), "too-large");
});

test("粘贴图片只入框、按发送才 emit（回退成粘贴即发会红）", () => {
  const pasteBody = tsFnBody(composerSrc, "async function onPaste(");
  assert.ok(pasteBody.length > 0, "onPaste 必须存在（锚点缺失即失败，不空转）");
  assert.ok(pasteBody.includes("enqueuePastedImage"), "粘贴图片应加入待发送列表");
  // 反例锚点：如果哪天把图片改回"粘贴即 send-image"，这一条会直接红。
  assert.ok(!pasteBody.includes('emit("send-image"'), "粘贴阶段不能直接发送图片");

  const sendBody = tsFnBody(composerSrc, "function send(");
  assert.ok(sendBody.length > 0, "send 必须存在（锚点缺失即失败）");
  assert.ok(sendBody.includes('emit("send-image", file)'), "发送阶段才把待发送图片交出去");
  assert.ok(
    composerSrc.includes("const canSend = computed(() => hasDraft.value || pendingImages.value.length > 0);"),
    "纯图片也要能点发送键",
  );
  assert.ok(
    composerSrc.includes('v-if="pendingImages.length > 0"') &&
      composerSrc.includes("removePendingImage(image)"),
    "待发送图片必须有可删除的缩略预览",
  );
});

test("输入框表情渲染成图片 token（改回纯文字短码会红）", () => {
  const insertBody = tsFnBody(composerSrc, "function insertEmoji(");
  assert.ok(insertBody.includes("createEmojiToken(e)"), "插入表情必须走图片 token 构造");

  const tokenBody = tsFnBody(composerSrc, "function createEmojiToken(");
  assert.ok(tokenBody.includes("emoji-img"), "token 内必须渲染表情图片");
  assert.ok(tokenBody.includes("span.dataset.emoji = displayName"), "必须保留 [名字] 文本供发送");

  const serializeBody = tsFnBody(composerSrc, "function serializeDraft(");
  assert.ok(serializeBody.includes('classList.contains("emoji-token")'), "序列化必须识别表情 token");
  assert.ok(serializeBody.includes("el.dataset.emoji"), "序列化必须读回 [名字]");

  const syncBody = tsFnBody(composerSrc, "function syncDraftState(");
  assert.ok(syncBody.includes('querySelector(".emoji-token")'), "只有表情时也要判定为有草稿");
});

test("回到最新按钮纯圆无文字且水平居中（回退成文字胶囊会红）", () => {
  // 2026-11-05 按钮从 ChatWindow 抽成组件（可见性改由几何现算）。
  // 判据搬到组件里，**同时**断言 ChatWindow 真的在用这个组件 —— 否则这条检查会退化成
  // "扫一个已经没人渲染的文件"，空转还永远是绿的。
  // 2026-11-05 玻璃口径落地：悬浮件从「面板实底」改成 `.frost`（glass-2），
  // 锚点随类名一起搬；判据（纯圆 / 水平居中 / 无文字 / 热区不扩）一个字都没放宽。
  const marker = backToLatestSrc.indexOf('class="frost absolute bottom-4 left-1/2');
  assert.ok(marker >= 0, "按钮必须存在（锚点缺失即失败）");
  const open = backToLatestSrc.lastIndexOf("<button", marker);
  const close = backToLatestSrc.indexOf("</button>", marker);
  assert.ok(open >= 0 && close > marker, "必须能截到按钮块");
  const block = backToLatestSrc.slice(open, close + "</button>".length);

  for (const cls of ["left-1/2", "-translate-x-1/2", "rounded-full", "h-9", "w-9"]) {
    assert.ok(block.includes(cls), `按钮必须是水平居中的纯圆：缺 ${cls}`);
  }
  assert.ok(block.includes(":aria-label=\"visible ? t('chat.backToLatest') : undefined\""), "无障碍标签必须走 i18n");

  // 反例锚点 ①：热区只覆盖按钮本体。`tap-safe` 在 `@media (pointer: coarse)` 下用
  // `::after { inset: -8px 0 }` 把命中区扩到 44px —— 用户点图片时会先打到按钮。
  assert.ok(!block.includes("tap-safe"), "按钮本体不许挂 tap-safe（会扩热区）");
  assert.ok(!block.includes("::after"), "按钮不许用 ::after 扩热区");
  assert.ok(!block.includes("inset"), "按钮不许用 inset 扩热区");
  // 反例锚点 ②：不可见时必须 `pointer-events: none`（只隐藏不关命中区，等于还在抢热区）。
  assert.ok(block.includes("pointer-events-none"), "不可见档必须 pointer-events: none");
  assert.ok(block.includes("pointer-events-auto"), "可见档必须恢复 pointer-events");

  // ChatWindow 的接线（删掉就红）：可见性来自 VirtualList 的 `offBottom`，点击后才贴底。
  assert.ok(chatWindowSrc.includes("<BackToLatestButton"), "ChatWindow 必须渲染这个组件");
  assert.ok(
    chatWindowSrc.includes(':visible="showBackToLatest"'),
    "可见性必须绑 showBackToLatest（几何现算），不能回到 nearBottom",
  );
  assert.ok(chatWindowSrc.includes('@off-bottom="showBackToLatest = $event"'), "必须有 offBottom 接线");
  assert.ok(!chatWindowSrc.includes('v-if="!nearBottom"'), "旧的 nearBottom 门控必须删掉");

  // 无文字节点：剥掉注释与标签后只剩空白。若把 `{{ t('chat.backToLatest') }}`
  // 加回按钮正文，插值文本会留在 textOnly 里 ⇒ 这条会红。
  const textOnly = block.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "");
  assert.equal(textOnly.trim(), "", "按钮内不允许出现文字节点");
});

test("输入框高度收敛为三档（单行 36/40、多行 44；出现 h-7/h-8 会红）", () => {
  // 高度归外壳/工具条行所有的输入，逐条登记理由；不登记就会因"没有档位"判红。
  const heightOwnedByShell = new Set([
    "components/ConversationList.vue", // 输入在 h-9 搜索壳内
    "components/search/ChatSearchDialog.vue", // 输入在 h-9 搜索壳内
    "components/LogViewer.vue", // 透明内联筛选，行高由工具条决定
  ]);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".vue") ? [full] : [];
    });

  const offenders: string[] = [];
  let inspected = 0;
  for (const file of walk(srcDir)) {
    const rel = file.slice(srcDir.length + 1).replaceAll("\\", "/");
    if (heightOwnedByShell.has(rel)) continue;
    // 剥掉注释，避免把注释里的 `h-7 = 28px` 或示例 `<input>` 当成真实控件。
    const src = readFileSync(file, "utf8")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of src.matchAll(/<(input|textarea)\b[\s\S]*?>/g)) {
      const tag = match[0];
      const type = (tag.match(/\btype="([^"]*)"/) ?? [])[1] ?? "text";
      // 非文本输入没有文字行高约束，不参与档位；`:type` 动态表达式按文本输入处理。
      if (["checkbox", "radio", "color", "file", "hidden", "range"].includes(type)) continue;
      // 多行 textarea 自增高/可拖拽，属于多行口径，不按单行三档约束。
      if (match[1] === "textarea") continue;
      const cls = (tag.match(/class="([^"]*)"/) ?? [])[1] ?? "";
      const heights = cls.match(/\b(?:min-)?h-\S+/g) ?? [];
      inspected += 1;
      const onTier = heights.length === 1 && (heights[0] === "h-9" || heights[0] === "h-10");
      if (!onTier) {
        const line = src.slice(0, match.index).split("\n").length;
        offenders.push(`${rel}:${line} 高度=${heights.join(",") || "(无)"}`);
      }
    }
  }

  // 反例自证：扫描空转（例如改了目录结构、注释误命中）会先在这里红，不会假绿。
  assert.ok(inspected >= 12, `至少要扫到 12 个单行文本输入，实际 ${inspected}`);
  assert.deepEqual(offenders, [], `只允许 h-9(36)/h-10(40)：\n${offenders.join("\n")}`);

  // 多行主输入框仍取 lg 档 44px；2026-11-09 起 44px 落在**行容器**上（编辑区按内容高走、
  // 单行在行里垂直居中）。判据跟着锚点一起搬家，反例自证也搬：摘掉行容器的 min-h-11 必须红。
  const hasTouch44 = (src: string) =>
    /class="flex min-h-11 items-center"/.test(src) && src.includes("gosslan-composer-editor");
  assert.ok(hasTouch44(composerSrc), "主输入框必须保留 lg 档 44px（min-h-11 落在行容器上）");
  assert.ok(!/gosslan-composer-editor min-h-10/.test(composerSrc), "不得回退到 40px 旧档");
  const noRow44 = composerSrc.replace('class="flex min-h-11 items-center"', 'class="flex items-center"');
  assert.notEqual(noRow44, composerSrc, "锚点没命中：输入行容器的类名绑定变了");
  assert.ok(!hasTouch44(noRow44), "把 44px 触控档从行容器摘掉必须判红");
});
