/**
 * 聊天输入框四项交互（2026-11-04）的守卫：
 *   ① 多行自增高 5 行封顶；
 *   ② 粘贴图片先入框、发送才发；
 *   ③ 输入框内表情渲染成图片 token；
 *   ④「回到最新」纯圆无文字且水平居中。
 *
 * 前两项是纯函数真值表；后三项读组件源码做**静态接线守卫**。
 * 为什么后三项要读源码：这些是"回退后界面看起来仍然正常"的退化 ——
 * 例：粘贴又改回即时发送、表情又变回文字短码，肉眼回归很难发现。
 * 每条注释都写明"删掉修复会红"的反例锚点，避免守卫空转。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  // 锚点用 class 本身，不要用文件里第一次出现 `gosslan-back-to-latest`（注释里也有一次）。
  const marker = chatWindowSrc.indexOf('class="gosslan-back-to-latest');
  assert.ok(marker >= 0, "按钮必须存在（锚点缺失即失败）");
  const open = chatWindowSrc.lastIndexOf("<button", marker);
  const close = chatWindowSrc.indexOf("</button>", marker);
  assert.ok(open >= 0 && close > marker, "必须能截到按钮块");
  const block = chatWindowSrc.slice(open, close + "</button>".length);

  for (const cls of ["left-1/2", "-translate-x-1/2", "rounded-full", "h-9", "w-9"]) {
    assert.ok(block.includes(cls), `按钮必须是水平居中的纯圆：缺 ${cls}`);
  }
  assert.ok(block.includes(":aria-label=\"t('chat.backToLatest')\""), "无障碍标签必须走 i18n");

  // 无文字节点：剥掉注释与标签后只剩空白。若把 `{{ t('chat.backToLatest') }}`
  // 加回按钮正文，插值文本会留在 textOnly 里 ⇒ 这条会红。
  const textOnly = block.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, "");
  assert.equal(textOnly.trim(), "", "按钮内不允许出现文字节点");
});
