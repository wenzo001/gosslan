import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createSingleFlight } from "./singleFlight.ts";

const SRC = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

function prodFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...prodFiles(full));
    } else if (/\.(ts|vue)$/.test(name) && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

test("同一个键并发只跑一次：后到的调用共用同一份 Promise", async () => {
  const fly = createSingleFlight<number>();
  let runs = 0;
  let release!: (v: number) => void;
  const gate = new Promise<number>((res) => {
    release = res;
  });
  const make = () => {
    runs += 1;
    return gate;
  };
  const a = fly.run("k", make);
  const b = fly.run("k", make);
  assert.equal(runs, 1, "同键并发把任务又发了一遍");
  assert.equal(a, b, "第二个调用没拿到同一份 Promise");
  release(7);
  assert.equal(await a, 7);
});

test("跑完后同键必须能重跑（否则第一次失败就永久钉死这个键）", async () => {
  const fly = createSingleFlight<number>();
  assert.equal(await fly.run("k", async () => 1), 1);
  let second = 0;
  assert.equal(await fly.run("k", async () => (second += 1, 2)), 2);
  assert.equal(second, 1, "第二次调用复用了已结束的那份，make 根本没跑");
});

test("抛错也必须摘除在途记录：下一次调用要重新发起", async () => {
  const fly = createSingleFlight<number>();
  await assert.rejects(fly.run("k", async () => {
    throw new Error("第一次就是坏的");
  }), /第一次就是坏的/);
  assert.equal(await fly.run("k", async () => 5), 5, "失败被永久缓存住了");
});

test("remove 只摘那一个键，reset 清全部", async () => {
  const fly = createSingleFlight<string>();
  let pending!: (v: string) => void;
  const gate = new Promise<string>((res) => {
    pending = res;
  });
  const p = fly.run("a", () => gate);
  fly.run("b", async () => "b-done");
  fly.remove("a");
  pending("a-done");
  assert.equal(await p, "a-done");
  // a 被 remove 后仍可再次发起；reset 不影响已经结束的条目
  fly.reset();
  assert.equal(await fly.run("a", async () => "a-again"), "a-again");
});

test("公共层不许再手抄单飞：这六行在 src/utils 下只有一个家", () => {
  // 只量**公共层**这一维：utils 是别人要复用的地方，那里出现第二份实现就等于下一个需求又抄一遍。
  // store 里还有两处同形状的表（useChatStore 的 groupTodoRowsInflight / loadingMore），
  // 它们不在这一维上 —— 是否要挪进 helper 得先证明行为等价，已登记成下一批，不在这里糊过去。
  const offenders: string[] = [];
  const wired = new Map<string, number>();
  for (const f of prodFiles(SRC)) {
    const code = readFileSync(f, "utf8");
    const rel = f.slice(SRC.length + 1);
    if (/new Map<string, Promise</.test(code) && rel !== "singleFlight.ts") {
      offenders.push(rel);
    }
    const runs = code.match(/(?:Inflight|inflight)\.run\(/g);
    if (runs) wired.set(rel, runs.length);
  }
  assert.deepEqual(offenders, [], "src/utils 下又出现一份手写的 inflight 表 ⇒ 该走 utils/singleFlight.ts");
  // store 那一族只并得进**同形状**的那一格：`ensureGroupTodoRows` 走 helper，
  // `loadMoreMessages` 因两处被注释保护的偏离**保留**自带表（理由写在那格注释里）。
  // ⇒ 判据钉的是"同形状那格没被谁退回手抄"，不是"store 里一个 Map 都不许有"。
  const store = readFileSync(`${SRC.replace(/\/utils$/, "")}/stores/useChatStore.ts`, "utf8");
  assert.match(store, /const groupTodoRowsInflight = createSingleFlight<void>\(\);/,
    "补读那一格被退回手写 Map ⇒ 又长出第五份单飞");
  assert.match(store, /const loadingMore = new Map<string, Promise<void>>\(\);/,
    "翻页那格的偏离是刻意的：删掉这张表前先去读它上面那段 ⚠️ 注释");
  // 接线判据按**次数**数，不按存在性：四个预览入口都得真的走 helper。
  const total = [...wired.values()].reduce((a, b) => a + b, 0);
  // 2026-10-26 新增第 5 处：代码高亮（Worker 请求同键去重）。预览入口仍是 4 处，
  // 所以这里数的是「所有走 helper 的地方」，新增消费者必须同批改这个分母。
  assert.equal(total, 5, `走 helper 的地方应有 5 处（4 预览 + 1 高亮），实测 ${total}（${[...wired]}）`);
});
