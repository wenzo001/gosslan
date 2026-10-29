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
