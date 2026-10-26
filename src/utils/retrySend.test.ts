/**
 * 「重发」必须**原地复用**同一条消息，不能新建第二条。
 *
 * ## 缺陷现场（2026-10-03 审计）
 * `MessageItem.vue::retrySend` 走 `chat.send(...)`，而 `send()` 每次都新建一条
 * `msg_id = tmp-${Date.now()}-...` 的乐观记录并 `enqueueMessage`。于是：
 *
 * ```
 * 列表里：① 发送失败的原文（status=failed，msg_id=tmp-A）
 *          ② 重发中的原文（status=sending，msg_id=tmp-B）
 * ```
 *
 * 而 ① **永远不会被删**：
 * · 全库没有任何删除类函数（`messages.ts` 导出的 19 个里没有 remove/delete/purge）；
 * · `appendLocalOnly`（`utils/messages.ts`）把 `tmp-*` 视为"只存在于内存"，
 *   每次 `loadMessages` 都会把它**重新追加**到快照尾部。
 *
 * ⇒ 用户点一次「重发」看到两条一样的文字，且失败那条永不消失；切会话重开也一样。
 *
 * ## 2026-10-25：单聊改成**真·原身份重投**（计划 D1）
 * 后端新增 `resend_message`：复用原 `msg_id` / `ts` / `seq`，重新密封后重新入队，
 * 接收端按 `msg_id` 去重 ⇒ 上一次其实送到了、只是 Ack 丢了的话，对方只会再回一次 Ack，
 * 界面上不会多出一条重复消息。前端只把**同一个 msg_id** 的气泡换回 sending/sent。
 *
 * 群消息那条（`resend_group_delivery`）按成员台账补发，同样不新建消息；
 * 只有升级前发出、没有台账的历史消息才退回"整条重发"（`send` 的 retryOfMsgId 分支）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("★ 单聊重发走 resend_message（复用原 msg_id），不再新建一条", () => {
  const item = read("components/MessageItem.vue");
  assert.match(
    item,
    /await chat\.resend\(msg\.conv_id, msg\.msg_id\)/,
    "单聊重发必须调 chat.resend(conv_id, msg_id) —— 走后端 resend_message 复用同一身份，" +
      "否则每次重发都是一条新消息、幂等在最需要的那一刻失效。",
  );
  const store = read("stores/useChatStore.ts");
  const at = store.indexOf("async function resend(");
  assert.ok(at > 0, "store 必须有 resend() —— 它是「原身份重投」的唯一前端入口");
  const body = store.slice(at, store.indexOf("\n  }", at));
  assert.match(body, /api\.resendMessage\(convId, msgId\)/, "resend() 必须调 resend_message");
  assert.match(
    body,
    /replaceMessage\(convId, msgId, next\)/,
    "成功后必须按**同一个 msg_id** 替换那条气泡（新 msg_id 会让旧气泡留在原地）",
  );
  assert.ok(
    !body.includes("enqueueMessage"),
    "resend() 里绝不能 enqueueMessage —— 那是「新建第二条」的唯一来源",
  );
});

test("★ 群消息重发按成员补发；只有无台账的历史消息才整条重发", () => {
  const item = read("components/MessageItem.vue");
  assert.match(
    item,
    /api\.resendGroupDelivery\(msg\.conv_id, msg\.msg_id\)/,
    "群消息重发必须先走 resend_group_delivery（按成员重置 cancelled 行）",
  );
  assert.match(
    item,
    /res\.outcome !== "no_ledger" && res\.outcome !== "unsupported"/,
    "只有 no_ledger / unsupported 才允许退回整条重发 —— 其余结论都必须当场说清楚",
  );
  assert.match(
    item,
    /await chat\.send\(msg\.conv_id, msg\.content, msg\.kind, undefined, msg\.msg_id\)/,
    "退回整条重发时必须把旧 msg_id 传下去（store 那一步会原地转 sending，" +
      "否则旧 failed 气泡留在原地、界面上两条一样的文字）",
  );
});

test("★ 重发路径不许 enqueueMessage（那正是「新建第二条」的来源）", () => {
  const store = read("stores/useChatStore.ts");
  // enqueueMessage 只能在新建分支里出现一次，且必须落在 retryOfMsgId 分支之外
  const enqueueAt = store.indexOf("enqueueMessage(optimistic)");
  const retryBranchAt = store.indexOf("if (retryOfMsgId)");
  assert.ok(retryBranchAt > 0 && enqueueAt > retryBranchAt, "enqueueMessage 应在重发分支之后");
  const branch = store.slice(retryBranchAt, enqueueAt);
  assert.ok(
    !branch.includes("enqueueMessage"),
    "重发分支里绝不能出现 enqueueMessage —— 那会新建一条乐观记录，" +
      "旧 failed 又不会被删 ⇒ 两条一样的文字。",
  );
});

test("单聊/群聊的 invoke 分流只有一份（重发与首次发送共用）", () => {
  const store = read("stores/useChatStore.ts");
  // 只看 sendToBackend 那个函数体内部：分流必须恰好一次
  const at = store.indexOf("async function sendToBackend(");
  assert.ok(at > 0, "必须有 sendToBackend 这个共用实现");
  const body = store.slice(at, store.indexOf("\n  }", at));
  const dm = [...body.matchAll(/api\.sendMessage\(/g)].length;
  const grp = [...body.matchAll(/api\.sendGroupMessage\(/g)].length;
  assert.equal(dm, 1, `sendToBackend 里 api.sendMessage 出现 ${dm} 次，应恰好 1 次`);
  assert.equal(grp, 1, `sendToBackend 里 api.sendGroupMessage 出现 ${grp} 次，应恰好 1 次`);
  // 且 send() 的两条路径（新建 / 整条重发兜底）都调它，不自己分流
  const calls = [...store.matchAll(/await sendToBackend\(/g)].length;
  assert.equal(
    calls,
    2,
    `send() 里有 ${calls} 处 await sendToBackend，应恰好 2 处（新建 + 整条重发）。` +
      `若某条路径自己写了 if (convId.startsWith("group:")) 分流，就是第二个家。`,
  );
});

/**
 * 钉住后端的两件事：
 * 1. `send_message` 仍不接受客户端指定 msg_id（首次发送的身份仍由 nonce+payload 派生）；
 * 2. `resend_message` 才是"复用稳定身份"的那一处 —— 它必须显式覆盖 `env.message_id`、
 *    用**库里的** ts/seq 重签，并且经 `requeue_message_for_resend` 一步入队+置 sending。
 *
 * 只写注释不写判据的话，把 `env.message_id = …` 删掉是个**编译通过、测试全绿**的改动，
 * 而它的后果恰好是最难查的那种：对端多出一条重复消息。
 */
test("后端 resend_message 显式复用原 msg_id / ts / seq", () => {
  const rust = readFileSync(join(ROOT, "..", "src-tauri/src/commands/chat.rs"), "utf8");
  const sendFn = rust.slice(rust.indexOf("pub async fn send_message("));
  const sig = sendFn.slice(0, sendFn.indexOf(") -> Result<MessageRecord, String>"));
  assert.ok(sig.length > 0, "没找到 send_message 的签名");
  assert.ok(
    !/\bmsg_id\b/.test(sig),
    "send_message 的签名里出现了 msg_id —— 首次发送的身份仍必须由 nonce+payload 派生；" +
      "原身份重投是 resend_message 的职责，两条路径不许混。",
  );

  const at = rust.indexOf("pub async fn resend_message(");
  assert.ok(at > 0, "后端必须有 resend_message");
  const body = rust.slice(at, rust.indexOf("\n// INV-EXCEPTION", at));
  assert.ok(body.length > 500, "resend_message 切片过短，边界没找对");
  assert.match(body, /env\.message_id = msg_id\.clone\(\)/, "必须把信封身份改回原 msg_id");
  assert.match(body, /let ts = msg\.ts;/, "必须复用库里那条消息的 ts");
  assert.match(body, /let seq = msg\.seq;/, "必须复用库里那条消息的 seq");
  assert.match(
    body,
    /env\.sender_sig = s\.identity\.sign_b64\(&env\.signing_bytes\(\)\)/,
    "改过 message_id / target 之后必须重签（两者都参与签名）",
  );
  assert.match(
    body,
    /db::requeue_message_for_resend\(/,
    "入队与置 sending 必须走同一个事务出口（先入队、最后才置 sending）",
  );
});

test("★ 点「重新发送」必须先过二次确认，确认后才动手并当场登记成后台任务", () => {
  // 2026-10-26 用户：「点了之后要有二次确认，确认后要在后台任务里看到这条重新发送」。
  // 旧行为是点一下红叉就静默开始 —— 图标原地不变、只有一句 toast，观感就是"没反应"。
  const item = read("components/MessageItem.vue");
  assert.match(item, /@retry="requestResend"/, "回执那颗重发键必须走 requestResend（弹确认），不许直连 retrySend");
  assert.match(item, /const confirmingResend = ref\(false\);/, "必须有一份确认态");
  assert.match(item, /:open="confirmingResend"/, "确认框挂在这份态上，且复用现成的 ConfirmDialog");
  const at = item.indexOf("async function confirmResend()");
  assert.ok(at > 0, "必须有 confirmResend —— 确认与动手之间要有那一步");
  const body = item.slice(at, item.indexOf("\n}", at));
  assert.match(body, /chat\.markResending\(props\.message\.msg_id\)/, "确认后才登记「重发中」⇒ 任务中心那一行靠它");
  assert.match(body, /await retrySend\(\)/, "登记之后才走真正的重发");
  assert.ok(!/\n\s*@retry="retrySend"/.test(item), "@retry 不许再有任何一处直连 retrySend");
});

test("★ 发送中的取消键：通道判据只有 utils/cancelSend 那一份，且按钮是 role=img 的兄弟节点", () => {
  // 用户：「发送中的话，它也是可以取消的」。此前取消口只藏在右键/长按菜单里。
  const receipt = read("components/message/MessageReceipt.vue");
  assert.match(receipt, /v-if="state === 'sending' && canCancelSend"/, "发送中且算得出取消通道才给键");
  assert.ok(receipt.includes('(e: "cancel"): void'), "组件要能把取消动作发给父层");
  const item = read("components/MessageItem.vue");
  // 按**元素**切块断言，不整文件 includes：`:can-cancel-send` 在同一个文件的右键/长按菜单元素上
  // 也有（那是另一个入口），整文件判据在"回执这一格被删掉"时仍然绿 —— 而用户看到的正是发送中拦不下来。
  const at = item.indexOf("<MessageReceipt");
  assert.ok(at > 0, "没找到 <MessageReceipt 的挂载点");
  const end = item.indexOf("/>", at);
  assert.ok(end > at, "回执挂载块没找到结尾（切片会退化成整份文件）");
  const mount = item.slice(at, end);
  assert.match(
    mount,
    /:can-cancel-send="canCancelSend"/,
    "取消通道由 MessageItem 用同一份 cancelSendChannelFor 算，不许在回执里再推一遍",
  );
  assert.match(mount, /@cancel="doCancelSend"/, "点击走的就是菜单里那个同一个 doCancelSend");
});
