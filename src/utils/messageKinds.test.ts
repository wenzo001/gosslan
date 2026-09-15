import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SILENT_KINDS, isSilentKind, kindClass } from "./messageKinds.ts";

const here = dirname(fileURLToPath(import.meta.url));
const protocolRs = readFileSync(join(here, "../../src-tauri/src/protocol.rs"), "utf8");

test("未知 kind 回退 bubble（宁可多显示，不静默吞）", () => {
  assert.equal(kindClass("未来才有的新类型"), "bubble");
  assert.equal(kindClass(""), "bubble");
});

test("已知 kind 的分类", () => {
  assert.equal(kindClass("text"), "bubble");
  assert.equal(kindClass("system"), "bubble");
  assert.equal(kindClass("reaction"), "silent");
  assert.ok(isSilentKind("reaction"));
  assert.ok(!isSilentKind("text"));
});

/**
 * **跨语言契约**：Rust 的 `WIRE_KINDS` 与 TS 的 `SILENT_KINDS` 必须一致。
 *
 * 两侧判定的后果不同（Rust 决定落库/未读，TS 决定渲染/通知），一旦漂移就会出现
 * 「服务端算静默、前端照常弹通知」这类分裂行为 —— 而且只在真机跑起来才看得见。
 * 直接读源码比对，让它变成编译/测试期就能发现的问题。
 */
test("跨语言契约：kind 分类与 protocol.rs 的 WIRE_KINDS 一致", () => {
  const table = protocolRs.slice(
    protocolRs.indexOf("pub const WIRE_KINDS"),
    protocolRs.indexOf("];", protocolRs.indexOf("pub const WIRE_KINDS")),
  );
  assert.ok(table.includes("WIRE_KINDS"), "应能在 protocol.rs 找到 WIRE_KINDS 表");

  const entries = [...table.matchAll(/\("([^"]+)",\s*KindClass::(\w+)\)/g)].map(
    (m) => [m[1], m[2]] as const,
  );
  assert.ok(entries.length >= 6, `解析出的 kind 太少（${entries.length}），表格式可能变了`);

  const rustSilent = entries.filter(([, c]) => c === "Silent").map(([k]) => k).sort();
  const tsSilent = [...SILENT_KINDS].sort();
  assert.deepEqual(tsSilent, rustSilent, "TS 与 Rust 的静默种类清单必须一致");

  // 逐个 kind 的分类也要对得上（不只是静默那一列）
  for (const [kind, cls] of entries) {
    const expected = cls === "Silent" ? "silent" : "bubble";
    assert.equal(kindClass(kind), expected, `${kind} 的分类两侧不一致`);
  }
});
