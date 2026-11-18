import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("共享目录：默认折叠、可展开收起、整目录下载有并发上限与进度", () => {
  const src = read("src/components/ShareDirectory.vue");

  // 默认空集 = 全部折叠（深层目录第一次打开不会铺满整屏）
  assert.ok(
    src.includes("const expanded = ref<Set<string>>(new Set())"),
    "展开集合不是默认空 ⇒ 目录会默认全展开",
  );
  assert.ok(src.includes("function toggleDir("), "没有展开/收起");
  // 可见行必须按折叠态过滤，否则折叠只是视觉假象
  assert.ok(src.includes("const visibleEntries = computed"), "没有按折叠态过滤可见行");
  assert.ok(src.includes('v-for="e in visibleEntries"'), "列表没改用可见行");
  // 整目录下载：必须有并发上限（否则一次打满对端）与进度
  assert.ok(src.includes("async function downloadDir("), "没有整目录下载");
  assert.ok(src.includes("DIR_CONCURRENCY"), "整目录下载没有并发上限");
  assert.ok(src.includes("share.dirProgress"), "整目录下载没有进度");
  // 批量下载要静默，否则 N 个文件刷 N 条系统消息
  assert.ok(src.includes("downloadSharedFile(owner, f.path, true)"), "批量下载没有静默");
});

test("群文件面板：可定位到聊天，并给出聊天记录里的时间", () => {
  const panel = read("src/components/GroupFilesPanel.vue");
  const win = read("src/components/ChatWindow.vue");

  assert.ok(panel.includes('(e: "locate", msgId: string)'), "群文件面板没有定位意图");
  // 定位键必须与消息 msg_id 同源：群文件行恒为 `gfile-{transfer_id}`
  assert.ok(panel.includes("gfile-${f.transfer_id}"), "定位键与消息 msg_id 不一致");
  assert.ok(panel.includes("fmtDateTime(f.created_at)"), "时间没有完整时刻（无法核对）");
  assert.ok(panel.includes("fmtConversationTime(f.created_at, t)"), "没有显示聊天里的时间");
  // 父组件必须接住：关面板 + 复用既有定位（含逐页回溯）
  assert.ok(win.includes('@locate="(id) => { filesOpen = false; void locateMessage(id); }"'), "ChatWindow 没接住定位");
});
