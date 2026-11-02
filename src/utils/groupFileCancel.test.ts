import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { groupFileCancelSide, type GroupFileCancelSide } from "./groupFileCancel.ts";
import type { GroupFileEntry } from "@/types";

const panel = readFileSync(
  fileURLToPath(new URL("../components/GroupFilesPanel.vue", import.meta.url)),
  "utf8",
);

function entry(over: Partial<GroupFileEntry> = {}): GroupFileEntry {
  return {
    transfer_id: "t1",
    name: "a.bin",
    size: 10,
    sender_id: "me",
    created_at: 1,
    local_state: "local",
    local_path: null,
    delivered: 0,
    total: 0,
    ...over,
  };
}

test("发送侧：还有成员没送达才可取消整单", () => {
  assert.equal(groupFileCancelSide(entry({ delivered: 1, total: 3 }), "me"), "send");
  assert.equal(groupFileCancelSide(entry({ delivered: 3, total: 3 }), "me"), null);
});

test("接收侧：只有正在接收的行有取消对象", () => {
  const recv = (local_state: GroupFileEntry["local_state"]) =>
    groupFileCancelSide(entry({ sender_id: "peer", local_state }), "me");
  assert.equal(recv("receiving"), "receive");
  assert.equal(recv("remote"), null);
  assert.equal(recv("failed"), null);
  assert.equal(recv("local"), null);
});

test("拿不到自己的 id 时不给入口（宁可没有，不许猜错侧）", () => {
  assert.equal(groupFileCancelSide(entry({ delivered: 0, total: 2 }), null), null);
  assert.equal(groupFileCancelSide(entry({ sender_id: "peer", local_state: "receiving" }), ""), null);
});

test("面板真的把判据接成了入口：按钮走门面 cancelFileTransfer 并失效清单", () => {
  assert.match(
    panel,
    /groupFileCancelSide\(/,
    "面板必须用 groupFileCancelSide 判入口，不在模板里另写一套状态判断",
  );
  assert.match(
    panel,
    /api\.cancelFileTransfer\(/,
    "取消必须走 api 门面（守卫钉过：面板里不得裸 invoke）",
  );
  assert.match(
    panel,
    /invalidateGroupFiles\(/,
    "取消后必须失效群文件清单缓存，否则行会停在传输中",
  );
  const side: GroupFileCancelSide = "send";
  assert.ok(side);
});
