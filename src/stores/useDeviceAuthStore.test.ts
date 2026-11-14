/**
 * 设备认证前端**接线守卫**（#1/#8）：纯逻辑核心（代际守卫、恒发披露）已在
 * `utils/deviceAuth.test.ts` 行为级单测；这里钉住「核心真的被接上了」那几根线 ——
 * store 无法在 node 里实例化（依赖 `@/api` 别名与 Tauri runtime），故按本仓既有形状
 * （events.test.ts / storeContract.test.ts）做源码级接线判据，并带反例自证防空转。
 *
 * 钉三件事：
 *  ① 确认页订阅 `data-cleared` 并 `store.clear()` —— 清数据后旧确认页必须消失（#8）；
 *  ② store 批准/刷新捕获代际并凭 `guardConsume/guardRefresh` 对账 —— 旧异步结果不复活已清事务（#8）；
 *  ③ store 用复合键（rp_origin+client_id+request_id）调后端 —— 防跨 RP 撞键（#8）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const STORE = join(ROOT, "src", "stores", "useDeviceAuthStore.ts");
const MODAL = join(ROOT, "src", "components", "DeviceAuthConfirmModal.vue");

/** 折叠空白：接线判据不该被排版差异（换行/缩进）绊倒。 */
const norm = (s: string) => s.replace(/\s+/g, " ");

/** 纯函数：喂 store/modal 源码，返回接线违规（便于反例夹具直接喂）。 */
export function deviceAuthWiringViolations(storeSrc: string, modalSrc: string): string[] {
  const bad: string[] = [];
  const store = norm(storeSrc);
  const modal = norm(modalSrc);

  // ① 清数据 → 清确认页（#8）。删掉这根线，清完数据旧确认页仍挂着。
  if (!/api\.onDataCleared\(\(\) => store\.clear\(\)\)/.test(modal)) {
    bad.push("确认页未订阅 data-cleared → store.clear()（清数据后旧确认页不会消失，#8）");
  }
  // ② 代际对账（#8）：捕获代际 + 消费/刷新都凭代际。
  if (!/const captured = guard\.generation/.test(store)) {
    bad.push("store 异步操作未捕获代际（guard.generation），旧结果会复活已清事务（#8）");
  }
  if (!/guardConsume\(guard, captured\)/.test(store)) {
    bad.push("store 批准/拒绝未凭代际消费（guardConsume(guard, captured)）（#8）");
  }
  if (!/guardRefresh\(guard, captured, p\)/.test(store)) {
    bad.push("store 刷新未凭代际回填（guardRefresh(guard, captured, p)）（#8）");
  }
  // ③ 复合键调后端（#8）：批准必须带 rp_origin+client_id+request_id，而不是裸 request_id。
  if (!/api\.deviceAuthApprove\(cur\.rp_origin, cur\.client_id, cur\.request_id, allowNickname\)/.test(store)) {
    bad.push("store 批准未用复合键调后端（rp_origin+client_id+request_id）（#8）");
  }
  // 可重试（#1）：批准失败不得清 pending —— guardConsume 必须在 await 之后（成功才消费），
  // 且 approve 里不许出现无条件 clear/guardClear（那会把失败也清掉，丢掉可重试态）。
  const approveBody = store.slice(store.indexOf("async function approve"), store.indexOf("async function deny"));
  if (/guardClear\(|store\.clear\(|pending\.value = null/.test(approveBody)) {
    bad.push("store approve 里出现无条件清空 —— 批准失败必须保留可重试态（#1）");
  }
  return bad;
}

// ---------------- 反例自证：故意断线，判据必须各抓得住 ----------------

const GOOD_STORE = `
  async function approve(allowNickname) {
    const cur = guard.pending;
    const captured = guard.generation;
    const out = await api.deviceAuthApprove(cur.rp_origin, cur.client_id, cur.request_id, allowNickname);
    guardConsume(guard, captured);
    return out;
  }
  async function refreshPending() {
    const captured = guard.generation;
    const p = await api.deviceAuthGetPending(cur.rp_origin, cur.client_id, cur.request_id);
    guardRefresh(guard, captured, p);
  }
  async function deny() {}
`;
const GOOD_MODAL = `onMounted(() => { void api.onDataCleared(() => store.clear()).then((un) => scope.onDispose(un)); });`;

test("接线守卫反例自证：断线即红，接好即绿", () => {
  // 正控：接好 ⇒ 0 违规。
  assert.deepEqual(deviceAuthWiringViolations(GOOD_STORE, GOOD_MODAL), []);
  // ① 断 data-cleared 线。
  assert.ok(deviceAuthWiringViolations(GOOD_STORE, "onMounted(() => {});").length > 0, "data-cleared 断线必须被抓");
  // ② 断代际捕获。
  assert.ok(
    deviceAuthWiringViolations(GOOD_STORE.replaceAll("const captured = guard.generation;", ""), GOOD_MODAL).length > 0,
    "代际捕获断线必须被抓",
  );
  // ③ 退回裸 request_id（撞键缺陷）。
  assert.ok(
    deviceAuthWiringViolations(
      GOOD_STORE.replace("api.deviceAuthApprove(cur.rp_origin, cur.client_id, cur.request_id, allowNickname)", "api.deviceAuthApprove(cur.request_id, allowNickname)"),
      GOOD_MODAL,
    ).length > 0,
    "复合键退回裸 request_id 必须被抓",
  );
  // ④ 批准失败也清（丢可重试态，#1 反例）。
  assert.ok(
    deviceAuthWiringViolations(GOOD_STORE.replace("guardConsume(guard, captured);", "guardClear(guard);"), GOOD_MODAL).length > 0,
    "approve 无条件清空必须被抓（#1 可重试）",
  );
});

test("设备认证前端真实接线成立（#1/#8）", () => {
  const violations = deviceAuthWiringViolations(readFileSync(STORE, "utf8"), readFileSync(MODAL, "utf8"));
  assert.deepEqual(violations, [], `设备认证前端接线违规：\n${violations.join("\n")}`);
});

/**
 * 拒绝可观察 / 首绑状态标签接线（P1）：钉住 store 真的依据 rp_notified 判重试、确认页真的
 * 显示重试入口、设置页真的用 statusKey 区分新状态。纯逻辑本身在 utils/deviceAuth.test.ts 行为级单测，
 * 这里只防「逻辑写了但没接上」。
 */
test("拒绝可观察与状态标签接线成立（P1）", () => {
  const store = norm(readFileSync(STORE, "utf8"));
  const modal = norm(readFileSync(MODAL, "utf8"));
  const section = norm(
    readFileSync(join(ROOT, "src", "components", "settings", "AuthorizedAppsSection.vue"), "utf8"),
  );
  assert.match(store, /deviceAuthDenyNeedsRetry\(/, "store 未接上重试判定纯函数");
  assert.match(store, /denyNeedsRetry/, "store 缺少重试态");
  assert.match(store, /rp_notified/, "store 未读后端 rp_notified 字段");
  assert.match(modal, /store\.denyNeedsRetry/, "确认页未据重试态显示入口");
  assert.match(modal, /deviceAuth\.denyNotNotified/, "确认页缺少「本机已拒绝」提示文案 key");
  assert.match(modal, /deviceAuth\.denyRetry/, "确认页缺少重试按钮文案 key");
  assert.match(section, /deviceAuthStatusKey\(b\.status\)/, "设置页未用 statusKey 区分新绑定状态");
});