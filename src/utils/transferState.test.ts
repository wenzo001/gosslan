import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transferDisplayKind,
  transferShowsProgress,
  transferStatusTextKey,
  transferStatusTone,
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

test("状态行的视觉档位：停滞与失败不许长得一模一样（审计 D-4）", () => {
  assert.equal(transferStatusTone("failed"), "error");
  // 取消也归 error 档只为了"和成功拉开"。文案仍然是「已取消」—— 颜色不许拿来回改语义
  //（R-34 的教训：把用户主动取消说成失败，比不加颜色更糟）。
  assert.equal(transferStatusTone("cancelled"), "error");
  assert.equal(transferStatusTone("认不出的状态"), "error", "未知按坏的对待，不许静默灰掉");
  assert.equal(transferStatusTone("active"), "muted", "在动就是普通说明");
  assert.equal(transferStatusTone("active", { notProgressing: true }), "warn");
  assert.equal(
    transferStatusTone("pending", { notProgressing: true }),
    "muted",
    "排队那一档不该抢着报警（没在动是它的正常形态）",
  );
  assert.equal(
    transferStatusTone("done", { notProgressing: true }),
    "muted",
    "已完成不许被 warn 盖住",
  );
  assert.equal(transferStatusTone(undefined), "muted", "没有传输记录时不表达任何档位");
});

test("这个档位必须真的接到气泡上（判据全绿而没人用它 = 功能为零）", () => {
  const composable = readFileSync("src/composables/useMessageFile.ts", "utf8");
  assert.equal(
    composable.split("transferStatusTone(").length - 1,
    1,
    "分类调用点必须恰好一处：多一处就是第二个判据在并跑",
  );
  assert.ok(composable.includes("fileStatusTone,"), "composable 没把档位交出去");
  const item = readFileSync("src/components/MessageItem.vue", "utf8");
  assert.ok(item.includes(':status-tone="fileStatusTone"'), "档位没接到气泡");
  // 模板里引用了名字还不够：这个 composable 是**解构**用的，没在解构清单里就会出现
  // "模板写好了、属性取不到"的形状（实测 vue-tsc：Property 'fileStatusTone' does not exist）。
  assert.ok(item.includes("fileStatusTone,"), "MessageItem 没从 useMessageFile 解构出这个档位");
  const bubble = readFileSync("src/components/message/MessageFileBubble.vue", "utf8");
  assert.ok(bubble.includes(':class="statusToneClass"'), "状态行还在用固定灰色");
  assert.ok(
    bubble.includes("text-[var(--gosslan-warning-ink)]") &&
      bubble.includes("text-[var(--gosslan-danger-ink)]"),
    "warn / error 两档没有各自的取色 ⇒ 这个档位只是装饰",
  );
});
