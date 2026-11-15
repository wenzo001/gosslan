/**
 * 双边撤销（RP 通知撤销）的**接线判据**：后端形状 → mock 契约 → 前端三态呈现。
 *
 * 为什么需要它：撤销这条链横跨两种语言（Rust 客户端 / Node mock），中间没有任何编译错误
 * 能保证双方对得上 —— 客户端把体形发成 `{key_id}` 而 mock 读 `{kid}`，两边都能编译，
 * 运行时才发现「撤销通知永远 404」，而用户看到的是「本机已撤销」照样提示成功。
 *
 * 只看源码形状，不执行 UI，也不发真实网络请求。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const RUST_CMD = "src-tauri/src/commands/device_auth.rs";
const RUST_META = "src-tauri/src/device_auth.rs";
const MOCK = "scripts/device-auth-rp-mock.mjs";

test("后端：撤销结果有两个字段，本地撤销与通知状态分开", () => {
  const rust = read(RUST_CMD);
  assert.match(
    rust,
    /pub struct DeviceAuthRevokeOutcome \{[\s\S]*?pub revoked: bool,[\s\S]*?pub rp_notified: bool,/,
    "撤销结果必须同时回「本地是否撤销」与「RP 是否收到通知」——只有一个布尔值没法表达「本地已撤、对方没收到」",
  );
  // 顺序硬约束：先本地、后通知。只在**命令函数体**里比顺序：
  // notify_rp_revoke 的定义在文件更靠前的位置，拿全文下标比会误判。
  const cmdAt = rust.indexOf("pub async fn device_auth_revoke(");
  assert.ok(cmdAt > 0, "找不到 device_auth_revoke");
  const body = rust.slice(cmdAt, rust.indexOf("\n}\n", cmdAt));
  const localAt = body.indexOf("revoke_binding");
  const notifyAt = body.indexOf("notify_rp_revoke");
  assert.ok(localAt > 0 && notifyAt > 0, "撤销与通知两处都要在命令体里");
  assert.ok(localAt < notifyAt, "必须先本地撤销再通知 RP（反了就会出现「通知失败 ⇒ 撤销没生效」）");
});

test("契约：客户端发的体形，mock 收得下（两边名字必须对上）", () => {
  const rust = read(RUST_CMD);
  const mock = read(MOCK);

  // ① 客户端请求体：{client_id, kid}
  const bodyFn = rust.match(/fn revoke_notify_body\([^)]*\) -> serde_json::Value \{([\s\S]*?)\n\}/);
  assert.ok(bodyFn, "找不到 revoke_notify_body（客户端体形没有单一事实源）");
  const bodySrc = bodyFn![1];
  assert.match(bodySrc, /"client_id"/, "撤销通知体必须带 client_id");
  assert.match(bodySrc, /"kid"/, "撤销通知体必须带 kid（RP 靠它定位要撤哪一把）");
  assert.doesNotMatch(bodySrc, /secret_key|seed|assertion/, "撤销通知体里出现私钥/断言 ⇒ 撤销把私钥又发了一次");

  // ② mock 侧必须认这两个字段名。
  assert.match(mock, /body\.kid\b/, "mock 的撤销端点不认 client_id 发的 kid ⇒ 通知永远 404");
  assert.match(mock, /body\.client_id\b|"client_id"/, "mock 侧没有 client_id 的处理");

  // ③ metadata 字段名两端一致。
  assert.match(read(RUST_META), /pub revocation_endpoint: String,/, "后端 metadata 没有 revocation_endpoint 字段");
  assert.match(mock, /revocation_endpoint:/, "mock 的 metadata 没有公布 revocation_endpoint ⇒ 客户端永远不通知");

  // ④ mock 广告的路径必须等于它真正处理的那条路由。
  //    两处都是硬编码字符串，改一处不改另一处 ⇒ 客户端 POST 到一个没人接的地址。
  const advertised = mock.match(/revocation_endpoint:\s*`\$\{ORIGIN\}([^`]*)`/);
  assert.ok(advertised, "mock 的 revocation_endpoint 不是 `${ORIGIN}<path>` 形状");
  const path = advertised[1];
  assert.ok(
    mock.includes(`url.pathname === "${path}"`),
    `mock 广告了撤销路径 ${path}，但没有一条路由按这个路径分派`,
  );
});

test("契约：幂等键两端同名，且客户端每次撤销都用同一个键", () => {
  const rust = read(RUST_CMD);
  const mock = read(MOCK);
  assert.match(rust, /header\("Idempotency-Key", idempotency_key\)/, "撤销请求必须带 Idempotency-Key 头");
  assert.match(mock, /idempotency-key/i, "mock 没有读 Idempotency-Key ⇒ 重试会被当成两次撤销");
  assert.match(
    read(RUST_META),
    /pub fn revoke_idempotency_key\(/,
    "撤销幂等键必须是确定性派生的（不能随机生成：重试必须合并）",
  );
});

test("前端：三种结局分开提示，不能一律说「已撤销」", () => {
  const store = read("src/stores/useDeviceAuthStore.ts");
  assert.match(
    store,
    /async function revoke\([^)]*\): Promise<DeviceAuthRevokeOutcome>/,
    "store 必须把撤销结果回给界面（不回就分不出「对方没收到」）",
  );

  const sec = read("src/components/settings/AuthorizedAppsSection.vue");
  assert.match(sec, /out\.revoked/, "界面必须区分「本机没有这条绑定」");
  assert.match(sec, /out\.rpNotified/, "界面必须区分「本机已撤、对方没收到通知」");
  assert.match(sec, /deviceAuth\.revokeLocalOnly/, "缺「本机已撤、对方没收到」的提示 ⇒ 用户以为彻底解绑了");
  assert.match(sec, /deviceAuth\.revokeNotFound/, "缺「本机没有这条记录」的提示");

  const api = read("src/api/index.ts");
  assert.match(
    api,
    /invoke<DeviceAuthRevokeOutcome>\("device_auth_revoke"/,
    "门面的返回类型还是旧的话，界面拿不到 rpNotified",
  );
});

test("重试：本地早已撤销时仍要能再通知一次 RP", () => {
  // 后端：`revoke_binding` 只改 active 的行 ⇒ 已撤销的行 UPDATE 返回 0 行。
  // 若把那当成「没东西可撤」就跳过通知，用户将永远补发不了这次撤销。
  const rust = read(RUST_CMD);
  assert.match(
    rust,
    /was_revoked/,
    "命令体没有区分「这次改动的」与「本来就是撤销态」⇒ 重试路径被吞掉",
  );
  assert.match(
    rust,
    /changed \|\| was_revoked/,
    "撤销态判定必须把两种情况并起来（否则重发时本地状态会被报成没撤销）",
  );

  // 前端：撤销态的行仍要有一个「重发通知」入口，否则用户没有补发的办法。
  const sec = read("src/components/settings/AuthorizedAppsSection.vue");
  assert.match(
    sec,
    /b\.status === 'revoked'/,
    "撤销态的绑定没有重发入口 ⇒ 第一次通知失败后用户无路可走",
  );
  assert.match(sec, /deviceAuth\.revokeRenotify/, "缺「重发撤销通知」按钮文案");
});
