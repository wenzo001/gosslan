import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileFailReasonCodes, fileFailReasonText } from "./fileFailReason.ts";
import { zhCN, enUS } from "../i18n/locales.ts";

const ROOT = join(import.meta.dirname, "../..");

/** 假词典：只认一条，用来验证"查表 + 回落"这两条路径。 */
const fakeT = (key: string) => (key === "file.diskFull" ? "磁盘空间不足" : key);

test("已知失败码翻成可行动文案（而不是原始英文 io 消息）", () => {
  const text = fileFailReasonText("DISK_FULL", fakeT);
  assert.equal(text, "磁盘空间不足");
  assert.notEqual(
    text,
    "No space left on device (os error 28)",
    "盘满必须给出可行动文案，而不是把英文 io 错误原样上屏",
  );
});

test("未知 reason 原样返回（绝不空白、绝不 undefined）", () => {
  assert.equal(fileFailReasonText("文件传输未完成", fakeT), "文件传输未完成");
  assert.equal(fileFailReasonText("", fakeT), "");
  // 词典缺这条（后端加了码但前端忘了加文案）⇒ 回落成原始 reason，
  // 而不是把 key 本身印到界面上。
  const t = (k: string) => (k === "file.diskFull" ? "" : k);
  assert.equal(fileFailReasonText("DISK_FULL", t), "DISK_FULL");
});

test("失败码表与中英词典一致（每条都有文案、都不留死文案）", () => {
  const codes = fileFailReasonCodes();
  assert.ok(codes.length > 0, "失败码表空了 ⇒ 量具本身失效");
  for (const code of codes) {
    // 真实词典里必须真有这一条 ⇒ 走一遍真实映射。
    const zh = fileFailReasonText(code, (k) => zhCN[k] ?? k);
    const en = fileFailReasonText(code, (k) => enUS[k] ?? k);
    assert.notEqual(zh, code, `码 ${code} 在中文词典里没有文案`);
    assert.notEqual(en, code, `码 ${code} 在英文词典里没有文案`);
  }
});

/**
 * 消息气泡的原因码（`messages.fail_code`，DB v14→v15）是**另一条通道**上的同一件事：
 * 它不走 `file-failed` 事件，而是落库后随消息读回来 —— 所以两侧都必须有它，
 * 且**多出来的那一侧要能被看见**：
 *  · 后端有、前端表没有 ⇒ 那条失败在界面上只能回落到通用文案（用户看不见已有的原因）；
 *  · 前端有、后端数组没有 ⇒ 那是一行永远不会被命中的死文案（本仓判过"已失效的契约"）。
 *
 * 分母从 `error_codes.rs` 现解析（不手抄清单），并钉住常量名与字面量**逐字相同**：
 * 库里存的就是这个字符串，两侧一旦分叉，读回来就匹配不上。
 */
test("消息失败码两侧同源（后端数组 ⊆ 前端表，前端多出来的也要被看见）", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/error_codes.rs"), "utf8");
  const arr = rust.match(
    /pub const MESSAGE_FAIL_CODES:\s*\[&str;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/,
  );
  assert.ok(arr, "没解析到 MESSAGE_FAIL_CODES ⇒ 提取器失效（形状变了？）");
  const declared = Number(arr[1]);
  const names = arr[2]
    .split(",")
    .map((s) => s.trim().replace(/,.*$/, ""))
    .filter((s) => /^[A-Z0-9_]+$/.test(s));
  assert.equal(names.length, declared, `数组写了 ${declared} 格、实际解析到 ${names.length} 个`);

  // 每个常量的字面量必须与常量名逐字相同（库里存的就是这个串）。
  const values: string[] = [];
  for (const name of names) {
    const def = rust.match(new RegExp(`pub const ${name}: &str = "([^"]+)"`));
    assert.ok(def, `${name} 没有对应的 pub const 字面量 ⇒ 分母读错了一半`);
    assert.equal(def[1], name, `${name} 的名字与字面量分叉：库里存的是 "${def[1]}"`);
    values.push(def[1]);
  }
  assert.ok(values.length >= 4, `只解析到 ${values.length} 个消息失败码 ⇒ 量具空转`);
  // 阳性对照：提取器必须会说"没有"（否则下面两条恒绿）。
  assert.equal(values.includes("SEND_THIS_CODE_DOES_NOT_EXIST"), false);

  const tsCodes = fileFailReasonCodes();
  const missing = values.filter((c) => !tsCodes.includes(c));
  assert.deepEqual(missing, [], `后端会写进库、前端表里没有的码：\n${missing.join("\n")}`);
  // 反向那一格：前端只许认识后端真会写的码（SEND_ 前缀是本族的名字约定）。
  const orphans = (rustSide: string[]) => tsCodes.filter((c) => c.startsWith("SEND_") && !rustSide.includes(c));
  assert.deepEqual(orphans(values), [], "前端表里有、后端永远不会写的码（死文案）");
  // 上面那条判据自己也要被证明不是空转：多一个不存在的码必须被它抓出来。
  assert.deepEqual(
    orphans(values.filter((c) => c !== values[0])),
    [values[0]],
    "反向那格在少一个码时必须报出那一个（否则它就是恒绿的）",
  );
});

/**
 * 界面必须**两种状态都说得清**：有码 ⇒ 说原因；没码 ⇒ 只说"发送失败"。
 * 这条钉住那一句"没码不是 bug"的回落，别让它哪天变成把裸码念给用户。
 */
test("没有原因码时回落到通用文案，有码时接在后面", () => {
  const withCode = t2("msg.sendFailedWith", { reason: fileFailReasonText("SEND_PEER_DELETED", t2) });
  assert.ok(withCode.includes("好友"), `有码必须说得出为什么：${withCode}`);
  assert.ok(!withCode.includes("SEND_"), `裸码不许上屏：${withCode}`);
  assert.equal(t2("msg.sendFailed"), "发送失败");
  // 未知码走原始回落（宁可显示后端原文，也不显示空白）：
  assert.equal(fileFailReasonText("SEND_FUTURE_CODE", t2), "SEND_FUTURE_CODE");
});

function t2(key: string, params?: Record<string, string | number>): string {
  const raw = (zhCN as Record<string, string>)[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

/**
 * 消费侧必须真的接上（这一层跑不了 vue，所以按源码钉 —— 与 `designGuards` 那族同一种量具）。
 *
 * 为什么值得钉：`fail_code` 是**落库的一侧**，`fileFailReasonText` 是**查表的一侧**，
 * 中间那根线（failed 分支读这一列）没接上时，上面所有对账全绿而界面一个字都没变 ——
 * 那正是"编译过、门禁绿、功能为零"的假字段形状。
 */
test("失败气泡的 tooltip 真的读 fail_code 并查这张表（正控：撤掉那一支必须报出来）", () => {
  const src = readFileSync(join(ROOT, "src/composables/useMessageDisplay.ts"), "utf8");
  const RE = /case "failed":[\s\S]{0,600}?message\.value\.fail_code[\s\S]{0,200}?fileFailReasonText\([\s\S]{0,120}?\}/;
  assert.ok(RE.test(src), "failed 分支没有「读 fail_code → 查表 → 拼进 msg.sendFailedWith」这一串");
  assert.match(src, /t\("msg\.sendFailed"\)/, "没码时那一格回落（通用文案）不许被顺手删掉");
  // 正控：把原因那一半摘掉（退回本轮之前的写法），同一把尺子必须说"不"。
  const gutted = src.replace(/const code = message\.value\.fail_code;[\s\S]{0,220}?return t\("msg\.sendFailed"\);/, 'return t("msg.sendFailed");');
  assert.notEqual(gutted, src, "变异没落进源码 —— 这条正控不作数（锚点写法变了）");
  assert.equal(RE.test(gutted), false, "摘掉 fail_code 之后仍然匹配 ⇒ 这把尺子在空集上恒绿");
});

/**
 * 两侧对账：后端定义码、前端按码查表 —— 这是一份**跨语言契约**。
 *
 * 手抄清单会漂（后端加码忘了改前端 ⇒ 用户看到裸码 "DISK_FULL" 上屏）。
 * 所以分母从源码现解析：后端 `logging.rs` 里的 `FAIL_CODE_*` 常量 vs 前端表的键。
 * （`file-failed` 事件那一族走这里；落库的 `messages.fail_code` 在上面那条里对账。）
 */
test("前后端失败码逐条对账（后端加码必须同步前端表）", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/logging.rs"), "utf8");
  const rustCodes = [...rust.matchAll(/pub\(crate\) const FAIL_CODE_[A-Z_]+:\s*&str\s*=\s*"([A-Z_]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(rustCodes.length > 0, "后端没解析到任何失败码 ⇒ 判据失效（写法变了？）");
  const tsCodes = fileFailReasonCodes();
  const missing = rustCodes.filter((c) => !tsCodes.includes(c));
  assert.deepEqual(
    missing,
    [],
    `后端有、前端表没有的失败码 ⇒ 界面上会显示裸码：\n${missing.join("\n")}`,
  );
});
