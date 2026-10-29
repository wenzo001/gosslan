import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clearWhenFull, trimOldest } from "./bounded.ts";

test("trimOldest：没超容量时不动它、返回 0", () => {
  const m = new Map<string, number>([["a", 1], ["b", 2]]);
  assert.equal(trimOldest(m, 5), 0);
  assert.deepEqual([...m.keys()], ["a", "b"]);
  const s = new Set([1, 2, 3]);
  assert.equal(trimOldest(s, 3), 0);
  assert.equal(s.size, 3);
});

test("trimOldest：超容量时按插入序淘汰最旧的，留下的必须是最新的几条", () => {
  const m = new Map<string, number>([
    ["old", 1],
    ["mid", 2],
    ["new", 3],
  ]);
  assert.equal(trimOldest(m, 2), 1);
  assert.deepEqual([...m.keys()], ["mid", "new"]);
  assert.equal(trimOldest(m, 1), 1);
  assert.deepEqual([...m.keys()], ["new"]);
});

test("trimOldest：Map 删的是**键**而不是迭代出来的 [k,v] 对", () => {
  // 这条钉的是一个很容易写出来的错实现：`for (const x of coll) coll.delete(x)`。
  // Map 迭代给的是 `[key, value]` 数组，拿它当键 delete 什么都删不掉 ⇒
  // 循环条件永远不满足 ⇒ 要么白转一圈、要么（配 while 的版本）死循环。
  const m = new Map<number, string>([
    [1, "a"],
    [2, "b"],
    [3, "c"],
  ]);
  assert.equal(trimOldest(m, 1), 2);
  assert.deepEqual([...m.entries()], [[3, "c"]]);
});

test("trimOldest：Set 走的是值（Set 的键就是值）", () => {
  const s = new Set(["a", "b", "c", "d"]);
  assert.equal(trimOldest(s, 2), 2);
  assert.deepEqual([...s], ["c", "d"]);
});

test("trimOldest：max<=0 清空而不是静默放过（传 0 多半是配置写错）", () => {
  const m = new Map<string, number>([["a", 1]]);
  assert.equal(trimOldest(m, 0), 1);
  assert.equal(m.size, 0);
  const s = new Set([1, 2]);
  assert.equal(trimOldest(s, -5), 2);
  assert.equal(s.size, 0);
});

test("trimOldest：等值不删（size === max 是允许的稳态，不是每次都动手）", () => {
  const s = new Set([1, 2]);
  assert.equal(trimOldest(s, 2), 0);
  s.add(3);
  assert.equal(trimOldest(s, 2), 1);
  assert.deepEqual([...s], [2, 3]);
});

// ---------------- clearWhenFull：第二种策略（满了整张清） ----------------

test("clearWhenFull：没满不动它、返回 false", () => {
  const m = new Map<string, number>([["a", 1], ["b", 2]]);
  assert.equal(clearWhenFull(m, 5), false);
  assert.equal(m.size, 2);
});

test("clearWhenFull：等值就动手（size === max ⇒ 整张清），与 trimOldest 的稳态正好差一格", () => {
  // 这不是疏忽：这四五个调用点原本写的就是 `if (size >= max) clear()`，判在写入**前**。
  // 挪成 `>` 会让峰值容量变成 max+1 ⇒ 上限悄悄失真。要改判据就得连那些点一起改，别只改这里。
  const m = new Map<string, number>([
    ["a", 1],
    ["b", 2],
  ]);
  assert.equal(clearWhenFull(m, 2), true);
  assert.equal(m.size, 0);
});

test("clearWhenFull：max<=0 每次清，不静默忽略（与 trimOldest 同口径）", () => {
  const s = new Set([1]);
  assert.equal(clearWhenFull(s, 0), true);
  assert.equal(clearWhenFull(s, -3), true);
  assert.equal(s.size, 0);
});

test("两个策略不是同一个函数：同一张表跑出来的活口不同（这就是不许互换的凭据）", () => {
  const seed = () =>
    new Map<string, number>([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", 5],
    ]);
  const trimmed = seed();
  trimOldest(trimmed, 3);
  const cleared = seed();
  clearWhenFull(cleared, 3);
  assert.deepEqual([...trimmed.keys()], ["c", "d", "e"], "丢最旧 ⇒ 热的留着");
  assert.deepEqual([...cleared.keys()], [], "整张清 ⇒ 热的也没了");
});

// ---------------- 判据：计数型的闸只有这一个家（按形状扫，不抄名字清单） ----------------

const SRC = join(import.meta.dirname, "..");

function productionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...productionTsFiles(p));
    else if (/\.(ts|vue)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

/** 手写的计数闸 = 「和上限比 size」那一句的上下 4 行里出现 `clear()`/`delete(`。 */
const GATE_LIMIT = /(?:^|[^.\w])\w+(?:\.\w+)*\.size\s*(?:>=|>)\s*[\w.]+/;
const GATE_ACTION = /\.(?:clear|delete)\s*\(/;

function handRolledGates(text: string): number[] {
  const lines = text.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!GATE_LIMIT.test(lines[i])) continue;
    const window = lines.slice(Math.max(0, i - 4), i + 5).join("\n");
    if (GATE_ACTION.test(window)) hits.push(i + 1);
  }
  return hits;
}

const prodFiles = productionTsFiles(SRC);

test("扫描集合本身要够大，并且确实看得见家与调用者（缺席型判据的前置：量具先得是活的）", () => {
  const rel = prodFiles.map((f) => f.slice(SRC.length + 1).replaceAll("\\", "/"));
  assert.ok(rel.length >= 200, `只扫到 ${rel.length} 个生产 TS/Vue 文件 ⇒ 遍历器坏了，下面的判据全是空集恒绿`);
  for (const must of ["utils/bounded.ts", "stores/useChatStore.ts", "utils/highlight.ts"]) {
    assert.ok(rel.includes(must), `遍历器没看见 ${must} ⇒ 这条判据没有覆盖面`);
  }
});

test("家的两个出口各只有一个定义（第二份 trimOldest / clearWhenFull 当场红）", () => {
  for (const name of ["trimOldest", "clearWhenFull"]) {
    const definers = prodFiles
      .filter((f) => readFileSync(f, "utf8").includes(`export function ${name}(`))
      .map((f) => f.slice(SRC.length + 1).replaceAll("\\", "/"));
    assert.deepEqual(definers, ["utils/bounded.ts"], `「${name}」长出了第二份定义或家改过名`);
  }
});

test("生产码里不许再出现手写的计数闸（收完 DUP-13 之后这个集合就该是空的）", () => {
  const offenders: string[] = [];
  for (const f of prodFiles) {
    const hits = handRolledGates(readFileSync(f, "utf8"));
    if (hits.length > 0) {
      offenders.push(`${f.slice(SRC.length + 1).replaceAll("\\", "/")}:${hits.join(",")}`);
    }
  }
  assert.deepEqual(offenders, [], "又抄了一遍淘汰循环 ⇒ 用 utils/bounded.ts 的 trimOldest / clearWhenFull");
});

test("量具自己得认得出两种手写形状，并且不冤枉家与那两个「看着像但不是闸」的格子", () => {
  // 正控：少了这条，上面那条"空集"可能只是匹配器根本不看任何东西。
  const trimCopy = 'if (m.size > MAX) {\n  const oldest = m.keys().next().value;\n  m.delete(oldest);\n}';
  const clearCopy = "if (cache.size >= max) cache.clear();";
  assert.equal(handRolledGates(trimCopy).length, 1, "匹配器认不出「满则删最旧」⇒ 全仓扫的那条是空转");
  assert.equal(handRolledGates(clearCopy).length, 1, "匹配器认不出「满则整张清」⇒ 同上");
  // 反控一：家自己的判据是反着写的（`<= max` / `< max`），不该被自己钉住。
  const home = readFileSync(join(SRC, "utils/bounded.ts"), "utf8");
  assert.deepEqual(handRolledGates(home), [], "家被判成手写闸 ⇒ 判据会把唯一正确的写法也一起禁掉");
  // 反控二：`VirtualList` 那句超上限是去整体重测、`GroupTasksBoard` 那句比的是单张图的字节数，
  // 都不是"从集合头部丢条目" ⇒ 必须不被匹配（否则下一次合法改动会被迫来加白名单）。
  assert.deepEqual(
    handRolledGates("if (virtualizer.value.itemSizeCache.size > MAX_MEASURED_KEYS) {\n  virtualizer.value.measure();\n}"),
    [],
    "整体重测不是容量闸，不该被判",
  );
  assert.deepEqual(
    handRolledGates("if (meta.size > MAX_TODO_IMAGE_BYTES) {\n  return app.toastError();\n}"),
    [],
    "单条目的字节数是投料上限，不是容器闸，不该被判",
  );
});

