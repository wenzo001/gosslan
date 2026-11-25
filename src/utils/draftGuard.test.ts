/**
 * 「编辑中的草稿不许被远端刷新覆盖」的判据（用户 2026-11-25 实测事故）。
 *
 * 事故复现路径：群信息面板输入群名 → 群里有人上线 → 后端推 `groups_updated`
 * → store 刷新群列表 → 面板的草稿被写回原名。
 *
 * 这里判两件事：
 *  A. 纯函数的三条语义（未编辑跟随 / 编辑中保留 / force 采纳）；
 *  B. 组件**确实走了**这个函数 —— 否则函数再对，面板里照样是直接赋值。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computed, nextTick, ref, watch } from "vue";
import { adoptRemoteDraft, isDraftDirty } from "./draftGuard.ts";

const SRC = join(import.meta.dirname, "..");

test("用户没动过草稿：远端一变就跟上（别人改群名界面上要看得到）", () => {
  const r = adoptRemoteDraft({ draft: "旧群名", baseline: "旧群名", remote: "新群名" });
  assert.equal(r.adopted, true);
  assert.equal(r.draft, "新群名");
  assert.equal(r.baseline, "新群名");
});

test("用户正在编辑（草稿≠基线）：远端刷新不许覆盖，只把基线前移", () => {
  const r = adoptRemoteDraft({ draft: "旧群名😀", baseline: "旧群名", remote: "旧群名" });
  assert.equal(r.adopted, false, "草稿必须原样留住");
  assert.equal(r.draft, "旧群名😀", "用户在输入框里打的 emoji 不能被吞掉");
  assert.equal(r.baseline, "旧群名", "基线跟着远端走（远端这次没变）");
});

test("编辑中远端又变了：仍然保留用户输入，基线走到最新远端值", () => {
  const r = adoptRemoteDraft({ draft: "我改的😀", baseline: "旧名", remote: "别人改的名" });
  assert.equal(r.adopted, false);
  assert.equal(r.draft, "我改的😀");
  assert.equal(r.baseline, "别人改的名");
});

test("force：打开面板 / 切换对象 / 保存成功时一律采纳远端（上一次的草稿不带走）", () => {
  const r = adoptRemoteDraft({
    draft: "上一个群没保存的草稿",
    baseline: "上一个群的旧名",
    remote: "这个群现在的名字",
    force: true,
  });
  assert.equal(r.adopted, true);
  assert.equal(r.draft, "这个群现在的名字");
  assert.equal(r.baseline, "这个群现在的名字");
});

test("用户把草稿改回基线：视为没编辑，下一次远端变化照常跟随", () => {
  const r = adoptRemoteDraft({ draft: "旧名", baseline: "旧名", remote: "别人的新名" });
  assert.equal(r.adopted, true);
  assert.equal(r.draft, "别人的新名");
});

test("空串是真值：清空公告的用户输入同样受保护（别被当成「没填」）", () => {
  const r = adoptRemoteDraft({ draft: "", baseline: "旧公告", remote: "旧公告" });
  assert.equal(r.adopted, false, "用户把公告清空也是编辑动作，不能被远端写回");
  assert.equal(r.draft, "");
  assert.equal(isDraftDirty(r.draft, r.baseline), true);
});

// ---------------- 根因复现：Vue 里"数组源 watch"到底什么时候触发 ----------------

test("根因：watch 源是新建数组时，群列表刷新一次（名字没变）也会执行回调", async () => {
  const open = ref(true);
  const groups = ref([{ id: "g1", name: "项目群" }]);
  const group = computed(() => groups.value.find((g) => g.id === "g1") ?? null);
  const draft = ref("项目群😀"); // 用户刚加的 emoji，还没点保存
  let hits = 0;
  const stop = watch(
    () => [open.value, group.value?.name] as const,
    ([isOpen, name]) => {
      hits += 1;
      if (isOpen) draft.value = name ?? "";
    },
    { immediate: true },
  );
  draft.value = "项目群😀"; // 用户输入（immediate 那次已回填）

  // 等价于 store 的 `groups.value = list`：整份替换，名字一个字没变
  groups.value = [{ id: "g1", name: "项目群" }];
  await nextTick();

  assert.equal(hits, 2, "数组源应当被触发（这就是事故的机制）");
  assert.equal(draft.value, "项目群", "旧写法把用户正在输入的 emoji 吞了 —— 根因复现");
  stop();
});

test("修复后：同样的刷新发生在单字段 watch + adoptRemoteDraft 上时，草稿原样留住", async () => {
  const groups = ref([{ id: "g1", name: "项目群" }]);
  const group = computed(() => groups.value.find((g) => g.id === "g1") ?? null);
  const draft = ref("项目群😀");
  const baseline = ref("项目群");
  const stop = watch(() => group.value?.name, (name) => {
    const r = adoptRemoteDraft({ draft: draft.value, baseline: baseline.value, remote: name ?? "" });
    draft.value = r.draft;
    baseline.value = r.baseline;
  });

  groups.value = [{ id: "g1", name: "项目群" }];
  await nextTick();
  assert.equal(draft.value, "项目群😀", "用户输入必须还在");

  // 别人真的改了群名：仍然保留用户草稿，基线跟进最新远端值
  groups.value = [{ id: "g1", name: "别人改的名字" }];
  await nextTick();
  assert.equal(draft.value, "项目群😀");
  assert.equal(baseline.value, "别人改的名字");
  stop();
});

// ---------------- 形状判据：组件必须真的走这道闸 ----------------

const panel = () => readFileSync(join(SRC, "components", "GroupMemberPanel.vue"), "utf8");

test("群信息面板的群名/公告草稿走 adoptRemoteDraft，而不是直接赋值", () => {
  const src = panel();
  assert.match(src, /import \{[^}]*adoptRemoteDraft[^}]*\} from "@\/utils\/draftGuard"/, "没有引入草稿闸门");
  assert.ok(src.includes("nameBaseline"), "群名没有基线 ⇒ 判不出用户是否在编辑");
  assert.ok(src.includes("announceBaseline"), "群公告没有基线 ⇒ 判不出用户是否在编辑");
  // 两处回填必须是"过闸后写回"，不能是 `xxxDraft.value = name ?? ""` 这种裸赋值
  const bareName = /nameDraft\.value\s*=\s*name\s*\?\?\s*""/.test(src);
  const bareAnnounce = /announceDraft\.value\s*=\s*text\s*\?\?\s*""/.test(src);
  assert.equal(bareName, false, "群名仍在直接覆盖草稿（reload 时会吞掉用户输入）");
  assert.equal(bareAnnounce, false, "群公告仍在直接覆盖草稿");
});

test("群名/公告的 watch 源里不许再塞 group.name（每次求值都是新数组，等于任何刷新都覆盖）", () => {
  const src = panel();
  assert.equal(
    /watch\(\s*\(\)\s*=>\s*\[props\.open,\s*group\.value\?\.name\]/.test(src),
    false,
    "watch 源把 open 和 name 塞进同一个数组：群列表一刷新就会触发回调覆盖草稿",
  );
  assert.equal(
    /watch\(\s*\(\)\s*=>\s*\[props\.open,\s*currentAnnouncement\.value\?\.text\]/.test(src),
    false,
    "群公告仍是同款数组源：公告列表一刷新就会覆盖草稿",
  );
  // 正控：两处"远端变化"的 watch 必须各自只看那一个字段
  assert.match(src, /watch\(\s*\(\)\s*=>\s*group\.value\?\.name,/, "群名没有独立的远端 watch");
  assert.match(src, /watch\(\s*\(\)\s*=>\s*currentAnnouncement\.value\?\.text,/, "公告没有独立的远端 watch");
});

test("机器人详情：编辑态遇到同一机器人的后台刷新不清草稿、也不退出编辑", () => {
  const src = readFileSync(join(SRC, "components", "BotDetailModal.vue"), "utf8");
  assert.match(src, /editing\.value\s*&&\s*sameBot/, "机器人详情编辑中仍会被 props 刷新重置");
});
