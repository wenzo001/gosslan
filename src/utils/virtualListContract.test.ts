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

test("ChatWindow 只把字号传给 layoutKey（主题是纯绘制变化，不许清测量缓存）", () => {
  const chat = read("src/components/ChatWindow.vue");
  assert.match(chat, /:layout-key="app\.chatStyle\.fontSize"/, "layoutKey 必须只含字号");
  assert.doesNotMatch(chat, /layout-key="[^"]*app\.dark/, "主题不得进入 layoutKey（会触发全量重测）");
  const list = read("src/components/VirtualList.vue");
  assert.match(list, /watch\(\s*\(\) => props\.layoutKey/, "VirtualList 仍必须监听真实度量变化");
  assert.match(list, /virtualizer\.value\.measure\(\)/, "真实度量变化要清测量缓存");
});

test("LogViewer 仍是 TanStack 且保留最佳实践选项", () => {
  const src = read("src/components/LogViewer.vue");
  assert.match(src, /useVirtualizer\(/);
  assert.match(src, /getItemKey/);
  assert.match(src, /measureElement/);
  // `data-index` 在 2026-10-29 跟着行模板搬进唯一的家 `LogRows.vue`（审计 DUP-05：
  // 原先两个外壳各抄一份逐字相同的行）。断言的是"这个属性还在行元素上"，与它住哪个文件无关。
  assert.match(read("src/components/LogRows.vue"), /data-index/);
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

test("自适应缓冲：rangeExtractor 存在，且测量回到绘制前（不延到下一帧）", () => {
  const src = read("src/components/VirtualList.vue");
  assert.match(src, /rangeExtractor,/, "必须挂 rangeExtractor（按像素/速度扩展预渲染）");
  assert.match(src, /useAnimationFrameWithResizeObserver:\s*roBatched/, "测量批次必须由 roBatched 控制");
  assert.match(src, /let roBatched = false/, "平时必须逐条、绘制前测量");
  assert.match(src, /function armSettleHold\(\) \{\s*setRoBatched\(true\)/s, "只有收敛窗口内合批");
  assert.match(src, /setRoBatched\(false\)/, "收敛窗口结束必须恢复逐条测量");
  assert.match(src, /computeListBuffer/, "缓冲必须走纯函数，便于真值表");
});

test("P0 回归锁：追加不再被当成切会话，贴底只由 conversationKey 切换触发", () => {
  const src = read("src/components/VirtualList.vue");
  assert.doesNotMatch(src, /isSwap\s*&&\s*!pinned/, "追加不得无条件置 pinned");
  assert.match(src, /convSwitch/, "切会话判据必须是 conversationKey 变化");
  assert.match(src, /pendingJump = null/, "切会话必须作废旧会话的待落定");
  const chat = read("src/components/ChatWindow.vue");
  assert.match(chat, /:conversation-key=/);
});

test("图片按载荷 w/h 预留，且预览 URL 到达前不先渲染文件卡", () => {
  const meta = read("src/utils/fileMeta.ts");
  assert.match(meta, /out\.w = /);
  assert.match(meta, /out\.h = /);
  const height = read("src/utils/messageHeight.ts");
  assert.match(height, /imageBubbleHeight/);
  const item = read("src/components/MessageItem.vue");
  assert.match(item, /:width="fileMeta\?\.w"/);
  assert.match(item, /:height="fileMeta\?\.h"/);
  assert.match(item, /fileMeta\?\.subtype === 'image' && fileMeta\?\.w && fileMeta\?\.h/);
  const bubble = read("src/components/message/MessageImageBubble.vue");
  assert.match(bubble, /imageBubbleHeight\(props\.width, props\.height\)/);
});

test("代码高亮移出首帧：Worker + 纯文本兜底 + 主题全局一份", () => {
  const block = read("src/components/CodeBlock.vue");
  assert.match(block, /requestHighlight/, "必须异步请求高亮");
  assert.match(block, /escHtml\(props\.code\)/, "首帧必须是转义纯文本");
  assert.doesNotMatch(block, /highlightAuto/, "CodeBlock 不再同步跑 highlightAuto");
  assert.doesNotMatch(block, /component :is="'style'"/, "主题不许每个实例各挂一份");
  const worker = read("src/workers/highlight.worker.ts");
  assert.match(worker, /highlightCode/, "Worker 必须复用纯计算模块");
  const theme = read("src/styles/hljs-theme.css");
  assert.match(theme, /\.dark \.hljs-keyword/, "暗色 token 必须由静态 CSS 覆盖");
  const css = read("src/style.css");
  assert.match(css, /@import "\.\/styles\/hljs-theme\.css"/, "主题 CSS 必须进主样式表（CSP 不许运行时 style）");
  assert.doesNotMatch(block, /codeTheme/, "不许再运行时注入主题");
});

test("翻页失败可见且可重试（不再是 unhandled rejection）", () => {
  const store = read("src/stores/useChatStore.ts");
  assert.match(store, /historyLoadErrors/);
  assert.match(store, /throw e;/, "失败必须抛给调用方");
  const chat = read("src/components/ChatWindow.vue");
  assert.match(chat, /retryHistory/);
  assert.match(chat, /await chat\.loadMoreMessages\(convId\)/);
  const zh = read("src/i18n/locales/zh-cn.ts");
  const en = read("src/i18n/locales/en-us.ts");
  for (const key of ["chat.history.loading", "chat.history.loadFail"]) {
    assert.ok(zh.includes(`"${key}"`), `zh 缺 ${key}`);
    assert.ok(en.includes(`"${key}"`), `en 缺 ${key}`);
  }
});

test("贴底跟随只有我们自己：库的 end 锚定关掉，测量回调同步跟总高增量", () => {
  const src = read("src/components/VirtualList.vue");
  assert.match(src, /scrollEndThreshold:\s*-1/, "必须关掉库的 wasAtEnd 同步写（否则每次 RO 各写一次）");
  assert.match(src, /setScrollTop\(el\.scrollTop \+ delta\)/, "贴底时测量回调要同步跟 delta");
  assert.match(src, /item\.start \+ item\.size <= offset/, "非贴底只补完全在视口上方的行");
});

test("阅读位置按消息锚点恢复（不是只回同一像素）", () => {
  const restore = read("src/utils/scrollRestore.ts");
  assert.match(restore, /anchorKey\?: string/);
  assert.match(restore, /anchorOffset\?: number/);
  const list = read("src/components/VirtualList.vue");
  assert.match(list, /function getAnchor\(\)/);
  assert.match(list, /function scrollToAnchor\(/);
  assert.match(list, /typeof j\.offset === "number"/, "applyJump 必须尊重锚点行内偏移");
  assert.match(list, /item\.start \+ item\.size <= offset/, "只补整行完全在视口上方的行");
  const chat = read("src/components/ChatWindow.vue");
  assert.match(chat, /getAnchor\(\)/, "离开时必须保存锚点");
  assert.match(chat, /scrollToAnchor\(saved\.anchorKey/, "恢复必须按消息 key 落位");
  assert.match(chat, /onMounted\(\(\) => \{\s*if \(restoreScroll\.value\)/s, "子组件晚挂载要重试");
});
