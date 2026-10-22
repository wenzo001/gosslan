import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryHistory, createRouter } from "vue-router";
import { MAIN_ROUTES } from "./mainRoutes.ts";

/**
 * 主窗口路由契约（纯表驱动，不需要 `window`）。
 *
 * 这些用例只回答两件事：路径是否解析到**唯一且存在**的页面身份；
 * 旧深链是否还有明确落点。页面行为本身由组件/浏览器探针覆盖。
 */
function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes: MAIN_ROUTES });
}

const FORMAL = [
  ["/chats", "chats"],
  ["/chats/peer-1", "conversation"],
  ["/contacts", "contacts"],
  ["/contacts/requests", "requests"],
  ["/contacts/peer-1", "friend"],
  ["/favorites", "favorites"],
  ["/favorites/fav-1", "favorite"],
  ["/links", "links"],
  ["/me/links", "me-links"],
  ["/me", "me"],
  ["/me/profile", "profile"],
  ["/me/settings", "settings"],
  ["/me/settings/general", "settings-section"],
  ["/me/logs", "logs"],
  ["/search", "search"],
] as const;

test("每条正式路径都解析到唯一页面身份", () => {
  const router = makeRouter();
  for (const [path, name] of FORMAL) {
    const resolved = router.resolve(path);
    assert.equal(resolved.name, name, `${path} 应解析为 ${name}，实际 ${String(resolved.name)}`);
    assert.notEqual(resolved.name, "RouteView");
  }
});

test("详情路径的路径参数原样保留（对象身份只走 params）", () => {
  const router = makeRouter();
  assert.deepEqual(router.resolve("/chats/peer-1").params, { convId: "peer-1" });
  assert.deepEqual(router.resolve("/contacts/peer-2").params, { friendId: "peer-2" });
  assert.deepEqual(router.resolve("/favorites/fav-3").params, { favId: "fav-3" });
  assert.deepEqual(router.resolve("/me/settings/chatStyle").params, { key: "chatStyle" });
});

test("旧深链有明确重定向，不会掉进 catch-all 被静默吞成聊天页", async () => {
  const cases = [
    ["/profile", "/me/profile"],
    ["/settings", "/me/settings"],
    ["/settings/general", "/me/settings/general"],
    ["/logs", "/me/logs"],
  ] as const;
  for (const [from, to] of cases) {
    const router = makeRouter();
    await router.push(from);
    assert.equal(router.currentRoute.value.path, to, `${from} 应重定向到 ${to}`);
  }
});

test("未知路径回落到聊天列表（catch-all 的唯一职责）", async () => {
  const router = makeRouter();
  await router.push("/no/such/page");
  assert.equal(router.currentRoute.value.name, "chats");
});

test("正式路由都带完整 meta，且子页深度严格大于父页", () => {
  const named = new Map<string, { depth: number; pane: string; tab: string }>();
  for (const record of MAIN_ROUTES) {
    if (!record.name || !record.meta) continue;
    const depth = Number(record.meta.depth);
    assert.ok(Number.isFinite(depth), `${String(record.name)} 缺 depth`);
    assert.ok(["list", "detail"].includes(String(record.meta.pane)), `${String(record.name)} 缺 pane`);
    assert.ok(typeof record.meta.tab === "string", `${String(record.name)} 缺 tab`);
    assert.ok(!named.has(String(record.name)), `路由名重复：${String(record.name)}`);
    named.set(String(record.name), {
      depth,
      pane: String(record.meta.pane),
      tab: String(record.meta.tab),
    });
  }
  const parentChild = [
    ["chats", "conversation"],
    ["contacts", "friend"],
    ["contacts", "requests"],
    ["favorites", "favorite"],
    ["me", "profile"],
    ["me", "settings"],
    ["settings", "settings-section"],
    ["me", "logs"],
  ] as const;
  for (const [parent, child] of parentChild) {
    const p = named.get(parent);
    const c = named.get(child);
    assert.ok(p && c, `${parent}/${child} 必须都在路由表里`);
    assert.ok(c.depth > p.depth, `${child} 的 depth 必须大于 ${parent}`);
    assert.equal(c.tab, p.tab, `${child} 必须与 ${parent} 同属一个一级 tab`);
  }
});

test("收藏是普通一级 tab：列表 list、详情 detail（底栏只在列表显示）", () => {
  const router = makeRouter();
  assert.equal(router.resolve("/favorites").meta.pane, "list");
  assert.equal(router.resolve("/favorites").meta.depth, 0);
  assert.equal(router.resolve("/favorites/fav-1").meta.pane, "detail");
  assert.equal(router.resolve("/favorites/fav-1").meta.depth, 1);
});

test("移动端整页覆盖层保持 overlay + detail，返回不改底层 tab", () => {
  const router = makeRouter();
  for (const path of ["/search", "/me/profile", "/me/settings", "/me/settings/general", "/me/logs"]) {
    const resolved = router.resolve(path);
    assert.equal(resolved.meta.overlay, true, `${path} 应是 overlay`);
    assert.equal(typeof resolved.meta.tab, "string");
  }
  assert.equal(router.resolve("/search").meta.overlay, true);
  assert.equal(router.resolve("/me/settings/general").meta.depth, 2);
});
