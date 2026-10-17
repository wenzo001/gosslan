import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transferDisplayKind,
  transferShowsProgress,
  transferStatusTextKey,
} from "./transferState.ts";

test("后端那六个状态各有自己的口径，不并成两类", () => {
  assert.equal(transferDisplayKind("active"), "active");
  assert.equal(transferDisplayKind("pending"), "queued");
  assert.equal(transferDisplayKind("done"), "done");
  assert.equal(transferDisplayKind("sent"), "done");
  assert.equal(transferDisplayKind("failed"), "failed");
  assert.equal(transferDisplayKind("cancelled"), "cancelled");
});

test("失败与取消退出活动进度，不再显示「发送中 84%」", () => {
  for (const status of ["failed", "cancelled", "done", "sent", "pending"]) {
    assert.equal(
      transferShowsProgress(status),
      false,
      `status=${status} 还在被当成本轮正在传输`,
    );
  }
  assert.equal(transferShowsProgress("active"), true);
});

test("认不出的状态不许当成已完成，并要说一句话", () => {
  assert.equal(transferDisplayKind("paused"), "unknown");
  assert.equal(transferShowsProgress("paused"), false);
  assert.equal(transferStatusTextKey("paused"), "send.unknownState");
  // 空状态串同样不许落进 done
  assert.equal(transferDisplayKind(""), "unknown");
});

test("等待、失败、取消各有文案；完成与无记录不说话", () => {
  assert.equal(transferStatusTextKey("pending"), "send.queued");
  assert.equal(transferStatusTextKey("failed"), "msg.sendFailed");
  assert.equal(transferStatusTextKey("cancelled"), "msg.canceled");
  assert.equal(transferStatusTextKey("done"), null);
  assert.equal(transferStatusTextKey("sent"), null);
  assert.equal(transferStatusTextKey(null), null);
  assert.equal(transferStatusTextKey(undefined), null);
});

test("新增的两个 key 在中英词典里都在（防裸 key 上屏）", () => {
  for (const file of ["src/i18n/locales/zh-cn.ts", "src/i18n/locales/en-us.ts"]) {
    const src = readFileSync(file, "utf8");
    for (const key of ["send.queued", "send.unknownState"]) {
      assert.ok(src.includes(`"${key}"`), `${file} 里缺 ${key}`);
    }
  }
});

test("composable 与气泡都走这一份口径，旧的那道 done 闸门不许长回来", () => {
  const composable = readFileSync("src/composables/useMessageFile.ts", "utf8");
  assert.ok(
    composable.includes('from "@/utils/transferState"'),
    "useMessageFile 没接 transferState ⇒ 进度闸门还是各自判的",
  );
  assert.equal(
    composable.includes('t.status === "done"'),
    false,
    "useMessageFile 里还留着「只有 done 才退出进度」那道旧闸门",
  );
  const bubble = readFileSync("src/components/message/MessageFileBubble.vue", "utf8");
  const progressBlock = bubble.slice(
    bubble.indexOf('<template v-if="progress !== null">'),
    bubble.indexOf("</template>", bubble.indexOf('<template v-if="progress !== null">')),
  );
  assert.ok(
    !progressBlock.includes("{{ statusText }}"),
    "状态文案还嵌在进度条里：进度一停，那句话也一起没了",
  );
  assert.ok(bubble.includes('v-if="statusText"'), "气泡没有独立渲染状态文案");
});
