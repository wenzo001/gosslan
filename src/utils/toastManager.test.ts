/**
 * 「×N」重复计数的判据。
 *
 * 两条都必须在，缺一条就回到发布前审查抓到的那两个坑：
 *   1. 行为：条关闭 → 释放计数 → 同 key 再从 ×1 起算（删掉释放实现即红）；
 *   2. 接线：`ToastList` 必须挂在库**真实发出**的 `update:open` 上，不许退回不存在的 `@close`
 *      （删掉那条绑定即红；锚点保证扫描不是空转）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pushToast, releaseToastCount, toastCountOf } from "./toastManager.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("push → release → push：同一条 toast 的计数必须重新从 ×1 起算（删掉释放逻辑必红）", () => {
  const text = "发送失败 · 对方不是好友";
  const id = `error:${text}`;

  pushToast(text, "error");
  assert.equal(toastCountOf(id), 1, "首条必须是 ×1");
  pushToast(text, "error");
  assert.equal(toastCountOf(id), 2, "连续同 key 才累加");

  // 模拟条被关闭（到点 / 手动按钮 / Esc / 滑动）。
  releaseToastCount(id);
  assert.equal(toastCountOf(id), 0, "关闭后必须释放；不清零就是「×N 永不清零」回归");

  pushToast(text, "error");
  assert.equal(toastCountOf(id), 1, "关闭后再出现必须从 ×1 起算，不能接着 ×3");
  releaseToastCount(id);
});

test("接线判据：ToastList 绑的是库真实发出的 update:open，且只在其为 false 时释放（退回 @close 必红）", () => {
  const file = path.join(SRC, "components", "ToastList.vue");
  const src = fs.readFileSync(file, "utf8");

  // 锚点：先证明扫到的确实是渲染 toast 的那段模板，不是空文件。
  assert.ok(src.includes("<ToastRoot"), "没扫到 ToastRoot ⇒ 下面几条可能在查空气");
  assert.ok(
    /import\s*\{[^}]*releaseToastCount[^}]*\}\s*from\s*"@\/utils\/toastManager"/.test(src),
    "ToastList 必须从 toastManager 引入释放函数",
  );
  // 库的 ToastRoot emits 里**没有** close；用它等于永不释放。
  assert.equal(/@close="releaseToastCount/.test(src), false, "ToastRoot 没有 close 事件，不许退回它");
  assert.ok(src.includes("@update:open"), "必须监听库真实发出的 update:open");
  assert.ok(
    /function onOpenChange\(id: string, open: boolean\) \{\s*if \(!open\) releaseToastCount\(id\);\s*\}/.test(src),
    "`update:open` 只在 false（条关闭）时释放计数，true 时不许清",
  );
  assert.ok(src.includes("onOpenChange(toast.id, open)"), "模板必须把当前 toast 的 id 与事件值传进处理器");
});
