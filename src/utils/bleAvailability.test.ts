import test from "node:test";
import assert from "node:assert/strict";
import { bleUnavailableReason } from "./bleAvailability.ts";

/**
 * 三格：编进去了但硬件不可用、压根没编进去、以及"可用/读不到"两格返回 null。
 * 这条判据存在的理由见模块头（同一句文案套在两种原因上，两边的用户都被误导）。
 */
test("蓝牙不可用时，两种原因必须分开说", () => {
  assert.equal(
    bleUnavailableReason({ featureCompiled: true, available: false }),
    "no-adapter",
    "发布包（编进去了）不可用 ⇒ 是硬件/系统原因，不能说『当前版本暂不支持』",
  );
  assert.equal(
    bleUnavailableReason({ featureCompiled: false, available: false }),
    "compiled-out",
    "自编译没带 feature ⇒ 才该说『这一版没编进去』",
  );
});

test("可用时、以及读不到读数时都不该报原因", () => {
  assert.equal(bleUnavailableReason({ featureCompiled: true, available: true }), null);
  assert.equal(bleUnavailableReason(null), null);
  // 旧后端没有 featureCompiled 字段：按硬件原因处理（发布包里的常见那一类）
  assert.equal(bleUnavailableReason({ available: false }), "no-adapter");
});

/**
 * 用户 2026-11-20：「检测到蓝牙硬件有问题，功能就应该直接不可用、不可交互，也不用申请权限」。
 *
 * 单测只能证明"原因分得对"，证不了"界面有没有按它拦"。这三条读源码把接线钉住：
 * 硬件不可用时 ①启动路径不空转 → ②两个开关注入点都不弹权限框。
 */
test("硬件不可用：不拉起、不申请权限（三处前置接线）", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

  const store = read("stores/useAppStore.ts");
  assert.ok(
    store.includes("if (ch.available === false) return;"),
    "ensureBluetoothOn 没有硬件不可用短路 ⇒ 启动时仍会发两次注定失败的调用",
  );

  const add = read("components/AddFriendModal.vue");
  assert.ok(
    add.includes("if (next && ch.available !== false)"),
    "「添加好友」在硬件不可用时仍会申请权限（那个系统弹框解决不了没有硬件）",
  );

  const net = read("components/settings/NetworkSection.vue");
  assert.ok(
    net.includes("if (btStatus.value?.available === false)"),
    "网络设置在硬件不可用时仍会申请权限",
  );
});
