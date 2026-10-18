/**
 * 时间格式化的单一入口：三个手写实现（日志、诊断、导出文件名）收敛到 dayjs。
 * 这里同时钉住「消费点确实用统一入口」，防止以后再长回 `new Date()` + padStart。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fmtClock, fmtDateStamp, fmtDateTime } from "./time.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// 本地时间构造：断言不随测试机器时区变化。
const localTs = new Date(2026, 9, 18, 13, 45, 9).getTime();

test("fmtDateTime / fmtClock / fmtDateStamp：固定形状，不随 WebView 区域设置变化", () => {
  assert.equal(fmtDateTime(localTs), "2026-10-18 13:45:09");
  assert.equal(fmtClock(localTs), "13:45:09");
  assert.equal(fmtDateStamp(localTs), "20261018");
});

test("接线判据：三个消费点走 utils/time，不再手写 new Date / toLocaleTimeString / padStart", () => {
  const log = read("components/LogViewer.vue");
  assert.match(log, /from "@\/utils\/time"/);
  assert.ok(!log.includes("String(n).padStart(2, \"0\")"), "LogViewer 又长回手写补零");

  const diag = read("components/DevDiagPanel.vue");
  assert.match(diag, /fmtClock\(ts\)/);
  assert.ok(!diag.includes("toLocaleTimeString()"), "诊断面板又用了随区域设置变化的本地化格式");

  const storage = read("components/settings/StorageSection.vue");
  assert.match(storage, /fmtDateStamp\(/);
  assert.ok(!storage.includes("getMonth() + 1"), "导出文件名又长回手写日期戳");
});
