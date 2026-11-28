import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isStickerMeta, parseFileMeta } from "./fileMeta.ts";
import { previewBody } from "./messages.ts";
import { stickerBubbleBox } from "./imageAspect.ts";
import { buildMergePayload, parseMergePayload } from "./mergeCard.ts";
import { t } from "../i18n/index.ts";
import type { MessageRecord } from "../types.ts";

const stickerContent = JSON.stringify({
  name: "a.gif",
  path: "/private/a.gif",
  size: 10,
  subtype: "image",
  sticker: true,
  sha256: "abc",
  w: 320,
  h: 180,
});

test("sticker 标记只接受布尔 true，且不改变 image subtype", () => {
  const meta = parseFileMeta(stickerContent);
  assert.equal(meta?.subtype, "image");
  assert.equal(isStickerMeta(meta), true);
  assert.equal(isStickerMeta(parseFileMeta(JSON.stringify({ subtype: "image", sticker: "true" }))), false);
});

test("sticker 会话预览与引用摘要使用表情标签", () => {
  assert.equal(previewBody("image", stickerContent), t("sticker.preview"));
  assert.equal(previewBody("image", JSON.stringify({ subtype: "image" })), t("msg.image"));
});

test("sticker 几何保持原比例且不裁切", () => {
  assert.deepEqual(stickerBubbleBox(320, 180), { width: 168, height: 95, cover: false });
  assert.deepEqual(stickerBubbleBox(180, 320), { width: 95, height: 168, cover: false });
  assert.deepEqual(stickerBubbleBox(), { width: 168, height: 168, cover: false });
  assert.deepEqual(stickerBubbleBox(192, 32), { width: 168, height: 28, cover: false });
  assert.deepEqual(stickerBubbleBox(4096, 1), { width: 168, height: 1, cover: false });
});

test("合并转发保留 sticker 标记但剥掉本机路径", () => {
  const message: MessageRecord = {
    id: 1,
    msg_id: "m1",
    conv_id: "c1",
    sender_id: "d1",
    receiver_id: "d2",
    kind: "image",
    content: stickerContent,
    ts: 1,
    seq: 1,
    status: "sent",
  };
  const merged = parseMergePayload(buildMergePayload([message], "chat", () => "A"));
  assert.ok(merged);
  const meta = parseFileMeta(merged.items[0].content);
  assert.equal(meta?.sticker, true);
  assert.equal(meta?.path, undefined);
  assert.equal(meta?.sha256, "abc");
});

test("表情面板接线：直发、最新排序、右键/长按管理与 reaction 隔离", () => {
  const picker = readFileSync(new URL("../components/EmojiPicker.vue", import.meta.url), "utf8");
  assert.match(picker, /mode\?: "compose" \| "react"/);
  assert.match(picker, /\(e: "send-sticker", stickerId: string\)/);
  assert.match(picker, /v-for="sticker in visibleStickers"/);
  assert.match(picker, /<ContextMenuRoot/);
  assert.match(picker, /<ContextMenuItem/);
  assert.match(picker, /@pointerdown="startLongPress/);
  assert.match(picker, /moveCustomStickerToFront/);
  assert.match(picker, /deleteCustomSticker/);
  assert.doesNotMatch(picker, /withEmojiUse\([^\n]*sticker|last_used_at|lastUsedAt/);
  assert.doesNotMatch(picker, /URL\.revokeObjectURL/, "对象 URL 必须由 filePreview 缓存统一回收");
  assert.match(picker, /v-if="mode === 'compose'"/);
  assert.match(picker, /\{ immediate: true \}/, "Popover 首次以 open=true 挂载时也必须加载表情库");
  assert.match(picker, /stickerPreviewError/);
  assert.match(picker, /sticker\.previewFail/);

  const item = readFileSync(new URL("../components/MessageItem.vue", import.meta.url), "utf8");
  assert.match(item, /message\.kind === 'image' && isSticker/);
  assert.match(item, /appearance="sticker"/);
});
