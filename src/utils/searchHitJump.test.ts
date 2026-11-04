import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ChatSearchGroup, ChatSearchMessage } from "@/types";
import { hitTargetAt, locateFailureReason } from "./chatSearch.ts";
import { readChatStoreSrc } from "../../scripts/chatStoreSrc.ts";

function hit(msgId: string): ChatSearchMessage {
  return {
    msg_id: msgId,
    sender_id: "u1",
    sender_name: "某人",
    kind: "text",
    content: "命中",
    ts: 1,
  };
}

function group(convId: string, msgIds: string[], total = msgIds.length): ChatSearchGroup {
  return {
    conv_id: convId,
    name: "会话",
    kind: "direct",
    avatar: null,
    total,
    latest_ts: 1,
    messages: msgIds.map(hit),
  };
}

const dialogSrc = readFileSync(
  new URL("../components/search/ChatSearchDialog.vue", import.meta.url),
  "utf8",
);
const layoutSrc = readFileSync(
  new URL("../layouts/ResponsiveLayout.vue", import.meta.url),
  "utf8",
);
const chatWindowSrc = readFileSync(
  new URL("../components/ChatWindow.vue", import.meta.url),
  "utf8",
);
const storeSrc = readChatStoreSrc(
  fileURLToPath(new URL("../stores/useChatStore.ts", import.meta.url)),
);

test("单条命中：点第 0 行跳到该会话的那条消息", () => {
  assert.deepEqual(hitTargetAt(group("c1", ["m1"]), 0), { convId: "c1", msgId: "m1" });
});

test("同会话多条命中：每一行各自定位到自己的 msg_id，不会都跳第一条", () => {
  const g = group("c1", ["m1", "m2", "m3"]);
  const targets = [0, 1, 2].map((i) => hitTargetAt(g, i));
  assert.deepEqual(targets, [
    { convId: "c1", msgId: "m1" },
    { convId: "c1", msgId: "m2" },
    { convId: "c1", msgId: "m3" },
  ]);
  // 三个目标必须互不相同——这正是「同会话不同关键词命中很多条」时用户要的行为。
  assert.equal(new Set(targets.map((t) => t?.msgId)).size, 3);
});

test("越界下标钳到边界，空组返回 null", () => {
  const g = group("c1", ["m1", "m2"]);
  assert.deepEqual(hitTargetAt(g, 99), { convId: "c1", msgId: "m2" });
  assert.deepEqual(hitTargetAt(g, -5), { convId: "c1", msgId: "m1" });
  assert.equal(hitTargetAt(null, 0), null);
  assert.equal(hitTargetAt(group("c1", []), 0), null);
});

test("定位结果映射成具名失败原因：找不到 ≠ 加载失败", () => {
  assert.equal(locateFailureReason("found"), null);
  assert.equal(locateFailureReason("not-found"), "missing");
  assert.equal(locateFailureReason("error"), "load-error");
});

test("命中行是可点击按钮：@click 必须走 openHit(hi) 且带自己的 data-msg", () => {
  assert.match(
    dialogSrc,
    /<button[\s\S]{0,800}?:data-hit="hi"[\s\S]{0,400}?:data-msg="m\.msg_id"[\s\S]{0,400}?@click="openHit\(hi\)"/,
    "右栏每一条命中必须是 <button>，点击直接 openHit(hi)（不是只在整列容器上绑一次）",
  );
  const openHit = dialogSrc.slice(
    dialogSrc.indexOf("function openHit"),
    dialogSrc.indexOf("function enterChat"),
  );
  assert.match(openHit, /hitTargetAt\(activeGroup\.value, idx\)/, "点击必须按行下标取 msg_id");
  assert.match(openHit, /emit\("open-conversation", target\)/, "点击必须把该行的 msg_id 交给父级");
});

test("「进入聊天」只进会话不定位：载荷 msgId 为空且不再调用 openHit", () => {
  const enterChat = dialogSrc.slice(dialogSrc.indexOf("function enterChat"));
  assert.match(
    enterChat.slice(0, 300),
    /emit\("open-conversation", \{ convId: g\.conv_id, msgId: "" \}\)/,
    "右上角入口必须用空 msgId 表达「进会话但不定位」",
  );
  assert.doesNotMatch(
    enterChat.slice(0, 300),
    /openHit\(/,
    "「进入聊天」不能再复用定位路径，否则两种入口语义无法区分",
  );
  assert.match(dialogSrc, /t\('search\.jumpToHit'\)/, "命中行要有「跳转到该消息」提示");
  assert.match(dialogSrc, /t\('search\.enterChatHint'\)/, "「进入聊天」要说明自己不定位");
});

test("父级：空 msgId 跳过定位；未加载的目标走 locateInLoaded 按需翻页", () => {
  assert.match(
    layoutSrc,
    /if \(!payload\.msgId\) return; \/\/ 「进入聊天」：只进会话，不定位/,
    "空 msgId 必须直接返回，不能当成定位失败去弹提示",
  );
  assert.match(
    layoutSrc,
    /toastLocateFailure\(await chat\.locateInLoaded\(payload\.convId, payload\.msgId\)\)/,
    "命中定位必须在 openConversation 之后调 locateInLoaded（它会逐页向前加载）",
  );
  assert.match(layoutSrc, /t\("search\.locateMissing"\)/, "找不到目标消息要给具名原因");
  assert.match(layoutSrc, /t\("search\.locateLoadFail"\)/, "翻页加载失败要给另一条具名原因");
});

test("按需加载与滚动高亮的下游实现仍在：locateInLoaded 翻页、ChatWindow 滚动+高亮", () => {
  const locate = storeSrc.slice(storeSrc.indexOf("async function locateInLoaded"));
  const locateBody = locate.slice(0, 2000);
  assert.match(
    locateBody,
    /await loadMoreMessages\(convId\)/,
    "目标不在已加载窗口时必须继续向前翻页，而不是直接返回 not-found",
  );
  assert.match(locateBody, /return "not-found"/);
  assert.match(locateBody, /return "error"/);

  const watcher = chatWindowSrc.slice(chatWindowSrc.indexOf("() => chat.locateRequest"));
  assert.match(watcher.slice(0, 500), /locateMessage\(req\.msgId\)/, "定位请求要落到具体消息");
  const locateMessage = chatWindowSrc.slice(chatWindowSrc.indexOf("async function locateMessage"));
  const locateMessageBody = locateMessage.slice(0, 2000);
  assert.match(locateMessageBody, /scrollToIndex\(idx, "top"\)/, "必须滚动到那条消息");
  assert.match(locateMessageBody, /highlightId\.value = id/, "必须短暂高亮以免找不到");
});
