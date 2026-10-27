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
 * 两侧对账：后端定义码、前端按码查表 —— 这是一份**跨语言契约**。
 *
 * 手抄清单会漂（后端加码忘了改前端 ⇒ 用户看到裸码 "DISK_FULL" 上屏）。
 * 所以分母从源码现解析：后端 `logging.rs` 里的 `FAIL_CODE_*` 常量 vs 前端表的键。
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
