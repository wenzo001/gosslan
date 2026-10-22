import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("渲染切换接线：命令/LWW 事件/原作者菜单/契约图四处齐全", () => {
  const api = read("src/api/index.ts");
  assert.match(api, /"set_message_render"/, "前端必须 invoke set_message_render");
  assert.match(api, /onMessageRenderChanged/, "必须监听 message-render-changed");

  const store = read("src/stores/useChatStore.ts");
  assert.match(store, /function onMessageRenderChanged\(/, "store 必须消费渲染事件");
  assert.match(store, /setMessageRender\(/, "store 必须暴露 setMessageRender");

  const item = read("src/components/MessageItem.vue");
  assert.match(item, /const renderTo = computed/, "原作者入口必须按 kind/检测结果给出目标模式");
  assert.match(item, /chat\.setMessageRender\(/, "菜单动作必须调用统一命令");

  const menu = read("src/components/message/MessageContextMenu.vue");
  assert.match(menu, /canRender\?/, "右键菜单必须有 canRender");
  assert.match(menu, /emit\('render'\)/, "右键菜单必须发 render 事件");

  const map = read("docs/ARCHITECTURE-MAP.html");
  assert.match(map, /\["set_message_render"/, "契约图必须登记 set_message_render");
});
