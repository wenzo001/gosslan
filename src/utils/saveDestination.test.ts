/**
 * 「另存为」对话框返回值的归一化与取消判定。
 *
 * ⚠️ 这个文件**曾经**是 `saveDestination.ts` 的逐字节副本（`diff` 无输出、0 条用例），
 * 却计入"测试文件"总数 ⇒ 清单守卫以为那个模块有覆盖，实际是 0。2026-10-29 审计 TST-01。
 * 现在是真的用例：两条形状（桌面字符串 / Android SAF 对象）+ 取消的两种表现。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isDialogCancelled, saveDestinationOf } from "./saveDestination.ts";

test("saveDestinationOf：桌面给字符串、Android SAF 给 { file } 对象，两种都要认", () => {
  assert.equal(saveDestinationOf("/tmp/a.png"), "/tmp/a.png", "桌面端 save() 返回路径字符串");
  assert.equal(
    saveDestinationOf({ file: "content://com.android.providers/x/y" }),
    "content://com.android.providers/x/y",
    "Android SAF 返回对象；不认它就会把 map 传给后端报 invalid type",
  );
});

test("saveDestinationOf：取消与畸形形状一律 null（不许把垃圾当路径发下去）", () => {
  for (const v of [null, undefined, "", {}, { file: "" }, { file: 42 }, { file: null }, [], 0, false]) {
    assert.equal(saveDestinationOf(v), null, `输入 ${JSON.stringify(v)} 必须归一成 null`);
  }
});

test("isDialogCancelled：桌面返回 null / Android reject(File picker cancelled) 都算取消", () => {
  assert.equal(isDialogCancelled(new Error("File picker cancelled")), true);
  assert.equal(isDialogCancelled("File picker cancelled"), true);
  assert.equal(isDialogCancelled(new Error("cancel")), true);
  // 反控：真错误不能被当成"用户取消"悄悄吞掉
  assert.equal(isDialogCancelled(new Error("permission denied")), false);
  assert.equal(isDialogCancelled(null), false);
  // 只认 Error / 字符串：鸭子类型对象不算（避免把 {message:"cancel"} 这种载荷吞掉）
  assert.equal(isDialogCancelled({ message: "cancel" }), false);
});
