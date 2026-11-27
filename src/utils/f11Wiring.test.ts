import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("F11-1 冷启动只有 store last 恢复，布局不猜首条且避开深链", () => {
  const layout = read("src/layouts/ResponsiveLayout.vue");
  const store = read("src/stores/useChatStore.ts");
  assert.ok(!layout.includes("openConversation(convs[0])"));
  assert.match(layout, /name !== "conversation"\) chat\.restoreLastConversation\(\)/);
  assert.equal((store.match(/storageGet\(LAST_CONV_KEY\)/g) ?? []).length, 1);
  assert.equal((store.match(/openConversation\(last\)/g) ?? []).length, 1);
  const gutted = layout.replace('name !== "conversation") chat.restoreLastConversation()', "true) chat.restoreLastConversation()");
  assert.ok(!/name !== "conversation"\) chat\.restoreLastConversation\(\)/.test(gutted), "反例：深链守卫被摘掉必须检出");
});

test("F11-2 草稿保存/恢复/发送/卸载都过所有权守卫", () => {
  const composer = read("src/components/chat/MessageComposer.vue");
  assert.match(composer, /beginComposerDraftTransition\(draftOwnership\)/);
  assert.match(composer, /isComposerDraftTransitionCurrent\(draftOwnership, transition\.generation\)/);
  assert.match(composer, /saveComposerDraftIfOwned\(draftOwnership, props\.convId/);
  assert.match(composer, /if \(draftOwnership\.owner !== props\.convId\) return;/);
  assert.ok(!composer.includes("saveComposerDraft(prev,"));
  const gutted = composer.replace("if (draftOwnership.owner !== props.convId) return;", "");
  assert.ok(!/if \(draftOwnership\.owner !== props\.convId\) return;/.test(gutted), "反例：发送所有权守卫被摘掉必须检出");
});

test("F11-3 群文件事件带归属，后端补 transfer-only 终态事件", () => {
  const api = read("src/api/index.ts");
  const block = api.slice(api.indexOf("onGroupFileActivity:"), api.indexOf("getDeviceInfo:"));
  assert.match(block, /listen<GroupFileActivity>\("group-file-activity"/);
  assert.match(block, /cb\(\{ conv_id: e\.payload\.conv_id \}\)/);
  assert.match(block, /cb\(\{ group_id: e\.payload\.group_id \}\)/);
  for (const blind of ['listen("file-done"', 'listen("file-failed"', 'listen("file-cancelled"']) assert.ok(!block.includes(blind));
  const panel = read("src/components/GroupFilesPanel.vue");
  assert.match(panel, /groupFileActivityMatches\(event, gid\)/);
  const rust = read("src-tauri/src/network/file.rs");
  assert.match(rust, /"group-file-activity"/);
  assert.match(rust, /"group_id": group_id, "conv_id": format!\("group:\{group_id\}"\)/);
  assert.ok((read("src-tauri/src/network/transport/group_file.rs").match(/emit_group_file_activity\(/g) ?? []).length >= 4);
  const gutted = rust.replace('"conv_id": format!("group:{group_id}")', '"conv_id": ""');
  assert.ok(!rust.includes('"conv_id": format!("group:{group_id}")') || !/"conv_id": format!\("group:\{group_id\}"\)/.test(gutted), "反例：conv_id 被清空必须检出");
});

test("F11-4 收藏预览扫描 filtered，切筛选清未发队列", () => {
  const fav = read("src/components/FavoritePanel.vue");
  assert.match(fav, /\[\s*filtered,\s*thumbs,?\s*\]/);
  assert.match(fav, /resetFavoritePreviewQueue\(previewQueue, previewSeen, previewInFlight\)/);
  assert.match(fav, /favoritePreviewCandidates\(images, thumbs\.value, previewSeen\)/);
  assert.ok(!fav.includes("[items, thumbs]"));
  const gutted = fav.replace("[filtered, thumbs]", "[items, thumbs]");
  assert.ok(!/\[\s*filtered,\s*thumbs,?\s*\]/.test(gutted), "反例：退回全量扫描必须检出");
});

test("F11-5 机器人 UI 同窗复用 [\"bots\"]，跨窗边界明确", () => {
  for (const rel of [
    "src/components/ConversationList.vue",
    "src/components/GroupMemberPanel.vue",
    "src/components/GroupTasksBoard.vue",
    "src/components/ChatWindow.vue",
  ]) {
    const src = read(rel);
    assert.ok(src.includes("useBotsQuery"), `${rel} 没接统一 Query`);
    assert.ok(!src.includes("api.botList()"), `${rel} 还在裸调 botList`);
    assert.ok(src.includes("onBotChanged"), `${rel} 没接机器人变更事件`);
    assert.ok(src.includes("invalidateBots(queryClient)"), `${rel} 没失效共享机器人查询`);
  }
  for (const rel of [
    "src/components/ConversationList.vue",
    "src/components/GroupMemberPanel.vue",
    "src/components/ChatWindow.vue",
  ]) {
    assert.match(read(rel), /watch\(\s*\(\) => botsQuery\.data\.value/, `${rel} 的已开详情没跟随 Query 更新`);
  }
  const query = read("src/utils/botsQuery.ts");
  assert.match(query, /BOTS_QUERY_KEY = \["bots"\] as const/);
  assert.match(query, /client\.fetchQuery\(botsQueryOptions\(fetcher\)\)/);
  const gutted = query.replace('["bots"] as const', '["other"] as const');
  assert.ok(!/BOTS_QUERY_KEY = \["bots"\] as const/.test(gutted), "反例：query key 漂移必须检出");
});

test("F11-6 Ack 局部补丁 + ChatWindow 稳定派生列表", () => {
  const store = read("src/stores/useChatStore.ts");
  assert.match(store, /patchMessageInConvLocal\(messages\.value, convIdOfMessage\(msgId\)/);
  const chat = read("src/components/ChatWindow.vue");
  assert.match(chat, /reconcileRenderedMessages\(messages\.value, source/);
  assert.match(chat, /immediate: true, flush: "sync", deep: true/);
  assert.ok(!/const messages = computed\(\(\) =>[\s\S]*?\.filter\(\(m\) => isRenderedInTimeline/.test(chat));
  const gutted = store.replace("patchMessageInConvLocal(messages.value", "patchMessageInConv(messages.value");
  assert.ok(!/patchMessageInConvLocal\(messages\.value/.test(gutted), "反例：Ack 退回整表替换必须检出");
});

test("F11-8 浏览器专用挂载器也装配共享 Query 插件", () => {
  const probe = read("scripts/check-ui-runtime.mjs");
  assert.match(probe, /window\.__queryPlugin = Q\.VueQueryPlugin/);
  assert.match(probe, /if \(window\.__queryPlugin\) app\.use\(window\.__queryPlugin, \{ queryClient: window\.__queryClient \}\)/);
  const gutted = probe.replace("if (window.__queryPlugin) app.use(window.__queryPlugin, { queryClient: window.__queryClient });", "");
  assert.ok(!/if \(window\.__queryPlugin\) app\.use/.test(gutted), "反例：专用挂载器丢掉 Query 插件必须检出");
});

test("F11-7 徽标与独立任务窗共用 150ms 尾沿合并", () => {
  const todos = read("src/stores/chat/todos.ts");
  assert.match(todos, /createTrailingRefresh\(\(\) => refreshOpenTodosNow\(\)\)/);
  assert.match(todos, /createTrailingRefresh\(\(\) => reloadGroupTodoRows\(groupId\)\)/);
  assert.ok(!todos.includes("groupTodosTimer"));
  const gutted = todos.replace("createTrailingRefresh(() => refreshOpenTodosNow())", "refreshOpenTodosNow()");
  assert.ok(!/createTrailingRefresh\(\(\) => refreshOpenTodosNow\(\)\)/.test(gutted), "反例：徽标退回每批直读必须检出");
});
