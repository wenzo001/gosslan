/**
 * 开放接口（scope / 交付）的接线判据。
 *
 * 钉住三件最容易悄悄坏掉的事：
 * ① **默认全关** —— scope 必须用户逐项点头才有；
 * ② **形状** —— 交付载荷没有正文、没有公钥，没勾的 scope 连键都没有；
 * ③ **跨语言同口径** —— 后端 allowlist、前端映射、mock 三处必须一致。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { grantedScopes } from "./deviceAuth.ts";

const RUST_PROTOCOL = "src-tauri/src/device_auth.rs";
const RUST_CMD = "src-tauri/src/commands/device_auth.rs";
const MOCK = "scripts/device-auth-rp-mock.mjs";
const COMPONENT = "src/components/DeviceAuthConfirmModal.vue";
const STORE = "src/stores/useDeviceAuthStore.ts";
const API = "src/api/index.ts";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("scope 三重收窄：请求 ∩ 勾选 ∩ allowlist", () => {
  const requested = ["friends.read", "events.metadata"];
  // 勾了 allowlist 之外的 → 不给。
  assert.deepEqual(grantedScopes(requested, ["groups.read"]), []);
  // 没勾 → 不给。
  assert.deepEqual(grantedScopes(requested, []), []);
  // 勾了但没请求 → 不给。
  assert.deepEqual(grantedScopes(["friends.read"], ["events.metadata"]), []);
  // 两个都勾 → 都给，且保持请求顺序。
  assert.deepEqual(grantedScopes(requested, ["events.metadata", "friends.read"]), [
    "friends.read",
    "events.metadata",
  ]);
});

test("allowlist 三处同口径：后端 / 前端映射各两项，且不含正文与群列表", () => {
  const rust = read(RUST_PROTOCOL);
  const scopeLine = rust.match(/pub const ALLOWED_SCOPES: \[&str; (\d+)\] = \[([^\]]+)\]/);
  assert.ok(scopeLine, "后端没有 ALLOWED_SCOPES");
  const rustScopes = [...scopeLine[2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rustScopes, ["friends.read", "events.metadata"]);

  const frontend = read("src/utils/deviceAuth.ts");
  const mapLine = frontend.match(
    /DEVICE_AUTH_SCOPE_KEYS: Record<string, string> = \{([\s\S]*?)\n\};/,
  );
  assert.ok(mapLine, "前端没有 DEVICE_AUTH_SCOPE_KEYS");
  const feScopes = [...mapLine[1].matchAll(/"([^"]+)":\s*"deviceAuth\.scope\./g)].map((m) => m[1]);
  assert.deepEqual(
    feScopes,
    rustScopes,
    "前端映射与后端 allowlist 必须一致（前端映射多一项 = 可能交付后端不认的 scope）",
  );

  // 刻意不做的东西不能偷偷出现在 allowlist 里。
  for (const forbidden of ["groups.read", "events.content", "chat.send"]) {
    assert.ok(
      !rustScopes.includes(forbidden),
      `${forbidden} 不在裁决范围内（正文外送 / 群列表 / 免确认直发）`,
    );
  }
});

test("后端：scope 只对本次事务有效，且默认全关", () => {
  const cmd = read(RUST_CMD);
  // 批准时的 scope 缺省 = 空 ⇒ 什么都不交付（fail closed）。
  assert.match(
    cmd,
    /allowed_scopes: Option<Vec<String>>/,
    "approve 命令没有 allowed_scopes 参数",
  );
  assert.match(
    cmd,
    /let granted_scopes = allowed_scopes\.unwrap_or_default\(\);/,
    "allowed_scopes 缺省必须是空（fail closed），不能缺省成「全给」",
  );
  // scope 不落库：交付只在这一次回写里带出去。
  assert.match(
    cmd,
    /if let Some\(d\) = data \{\s*body\["data"\] = d;/,
    "交付数据必须挂在决策回写体上",
  );
});

test("后端：交付载荷没有正文、没有公钥（形状判据，不靠值恰好为空）", () => {
  const cmd = read(RUST_CMD);
  const block = cmd.match(/fn build_delivery_data\([\s\S]*?\n\}/);
  assert.ok(block, "找不到 build_delivery_data");
  const body = block[0];
  // 事件只挑七个字段：conv/sender/kind/ts/seq + 通知性两位（mentions_me/notifies）。
  // **不能**整条消息序列化。
  assert.match(body, /"conv_id": m\.conv_id/);
  assert.match(body, /"sender_id": m\.sender_id/);
  assert.match(body, /"kind": m\.kind/);
  assert.match(body, /"ts": m\.ts/);
  assert.match(body, /"seq": m\.seq/);
  assert.ok(
    !/"content"|m\.content/.test(body),
    "交付数据里出现了正文 —— 正文不外送（裁决 2026-11-15）",
  );
  // 通知性两位：@ 了我 / 会弹通知（用户要的是「通知类消息」，光有元信息不够）。
  assert.match(body, /"mentions_me": m\.mentions_me/, "事件载荷缺 mentions_me");
  assert.match(body, /"notifies": m\.notifies/, "事件载荷缺 notifies");
  // 好友只给 device_id + 昵称。
  assert.match(body, /"device_id": f\.device_id/);
  assert.match(body, /"nickname": f\.nickname/);
  assert.ok(
    !/public_key|ed25519/.test(body),
    "好友载荷里出现了公钥 —— 只给 device_id + 昵称",
  );
});

test("前端：确认页默认全关，且只把勾选的交出去", () => {
  const comp = read(COMPONENT);
  assert.match(
    comp,
    /const scopeChecks = ref<string\[\]>\(\[\]\);/,
    "scope 勾选初始必须为空（默认全关，不预勾）",
  );
  assert.match(
    comp,
    /scopeChecks\.value = \[\];/,
    "新事务到达时必须清空上一笔的勾选（scope 是本次事务的授权）",
  );
  assert.match(
    comp,
    /store\.approve\(allowNickname\.value, granted\.value\)/,
    "批准时必须传「用户实际勾选的」而不是「RP 请求的全部」",
  );
  assert.match(
    comp,
    /const granted = computed\(\(\) => grantedScopes\(requestedScopes\.value, scopeChecks\.value\)\)/,
    "交付集合必须是三重收窄的结果",
  );
});

test("前端：门面与 store 把 scope 一路传到后端", () => {
  const api = read(API);
  assert.match(api, /allowedScopes: string\[\] = \[\]/, "门面的 allowedScopes 缺省必须是空");
  assert.match(api, /allowedScopes,/, "门面没有把 allowedScopes 传给后端");

  const store = read(STORE);
  assert.match(
    store,
    /allowedScopes: string\[\] = \[\]/,
    "store 的 allowedScopes 缺省必须是空（fail closed）",
  );
  assert.match(store, /api\.deviceAuthApprove\(/, "store 没有调 approve");
  assert.match(store, /allowedScopes,/, "store 没有把 allowedScopes 传下去");
});

test("mock：支持 sync 动作与 scope，且不把 sync 降级成 link", () => {
  const mock = read(MOCK);
  assert.match(mock, /supported_actions: \["link", "authenticate", "sync"\]/, "mock 没公布 sync 动作");
  assert.match(mock, /requested_scopes/, "mock 的事务没有 scope 字段");
  assert.match(
    mock,
    /\["link", "authenticate", "sync"\]\.includes\(body\.action\)/,
    "mock 不认 sync 动作（会被悄悄降级成 link，联调看到的现象与真实契约不符）",
  );
  // sync 与 authenticate 同样要求已有绑定。
  assert.match(
    mock,
    /tx\.action === "authenticate" \|\| tx\.action === "sync"/,
    "mock 的 sync 没有校验已有绑定",
  );
});
