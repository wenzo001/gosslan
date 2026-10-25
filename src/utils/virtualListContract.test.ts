/**
 * 虚拟列表迁移契约：所有虚拟列表都用 @tanstack/vue-virtual，且列表身份不回退数组下标。
 * 这些是**源码形状**判据（真实滚动行为由 `--only=vlist/scrollrestore/mergeheight/msgovf` 探针守）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("消息列表已迁移到 TanStack，且 key 不回退数组下标", () => {
  const src = read("src/components/VirtualList.vue");
  assert.match(src, /useVirtualizer\(/, "必须用 TanStack Virtual");
  assert.match(src, /anchorTo:\s*"end"/, "聊天列表必须按 end 锚定（历史 prepend 不跳）");
  assert.match(src, /followOnAppend:\s*false/, "追加贴底由应用 pin 独占（库 follow 会与收敛窗口抢滚动条）");
  assert.match(src, /measureElement/, "动态高度必须走真实测量");
  assert.match(src, /:data-index="v\.index"/, "measureElement 要靠 data-index 找回行下标（漏了会全部测到第 0 行）");
  assert.match(
    src,
    /local_id \?\? it\?\.msg_id \?\? it\?\.id/,
    "key 必须优先持久本地 id，绝不回退数组下标",
  );
  assert.doesNotMatch(src, /:key="[^"]*\.index/, "v-for key 不许用数组下标");
});

test("LogViewer 仍是 TanStack 且保留最佳实践选项", () => {
  const src = read("src/components/LogViewer.vue");
  assert.match(src, /useVirtualizer\(/);
  assert.match(src, /getItemKey/);
  assert.match(src, /measureElement/);
  assert.match(src, /data-index/);
});

test("乐观消息把持久本地 id 传给后端（真实记录返回同一个值）", () => {
  const store = read("src/stores/useChatStore.ts");
  assert.match(store, /const localId = crypto\.randomUUID\(\)/);
  assert.match(store, /local_id: localId/);
  assert.match(
    store,
    /sendToBackend\(convId, content, kind, mentionIds, localId\)/,
    "首次发送必须把 localId 传给 invoke",
  );
  const api = read("src/api/index.ts");
  assert.match(api, /localId\?: string/);
  assert.match(api, /localId,/);
});

test("群发送内核保留客户端 localId（不是只给单聊接）", () => {
  const gf = read("src-tauri/src/commands/group_files.rs");
  assert.match(gf, /local_id: Option<String>/);
  assert.match(gf, /local_id\.as_deref\(\)/);
  const win = read("src-tauri/src/commands/window.rs");
  assert.match(win, /local_id: Option<&str>/);
  assert.match(win, /local_id: local_id\.map\(\|v\| v\.to_string\(\)\)/);
});
