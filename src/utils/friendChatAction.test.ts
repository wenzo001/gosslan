import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

test("添加好友页：已是好友那一行变成「发起聊天」并接到父层开聊", () => {
  const modal = readFileSync(join(root, "src/components/AddFriendModal.vue"), "utf8");
  assert.match(
    modal,
    /\(e: "chat", peerId: string\): void/,
    "AddFriendModal 必须声明 chat 事件",
  );
  assert.match(
    modal,
    /@click="emit\('chat', p\.device_id\)"/,
    "已是好友那一行必须发 chat(peerId)，不能只显示静态「已加好友」",
  );
  assert.match(modal, /t\("conv\.startChat"\)/, "按钮文案必须是「发起聊天」");

  const layout = readFileSync(join(root, "src/layouts/ResponsiveLayout.vue"), "utf8");
  assert.match(layout, /@chat="openChatFromFriend"/, "父层必须接住 chat 事件");
  assert.match(
    layout,
    /function openChatFromFriend\(peerId: string\)/,
    "父层必须有关掉弹窗并开聊的入口",
  );
  assert.match(layout, /app\.mobileView = "chat"/, "移动端必须切到聊天视图");
  assert.match(
    layout,
    /router\.push\(\{ name: "conversation", params: \{ convId: peerId \} \}\)/,
    "必须把 URL 落到该会话",
  );
  assert.match(layout, /chat\.openConversation\(peerId\)/, "必须真的打开该 peer 的会话");
});
