/**
 * 导出失败的**口径判据**（2026-11-19 真机事故的回归锁）。
 *
 * ## 事故原样
 *
 * 用户在生产包里点「导出已授权应用」，输了口令、选了保存位置，界面弹：
 *
 *     导出失败 · 读写密钥包失败，请检查文件与磁盘空间
 *
 * 而**磁盘是满的**（用户原话：「但是磁盘是有空间的」）。真因是：本机
 * `rp_device_bindings` 一条绑定都没有 ⇒ 导出**一个字节都还没写**就被后端拒了，
 * 而那条空态被塞进了 `RP_KEY_BACKUP_IO`（真·文件读写失败那一格）⇒
 * 界面把「没有可导出的应用」说成了「去清磁盘」。
 *
 * ## 这本判据钉住什么
 *
 * 1. **三种原因三种码**（空态 / 密钥库打不开 / 真·文件 IO），各有各的「下一步」；
 * 2. **界面文案不许把空态说成磁盘问题**（中英两册都查 —— 英文界面曾经漏过一次）；
 * 3. **空态在点之前就说清楚**：本机没有可导出的应用时，导出按钮直接禁用并给出原因，
 *    不让用户输完口令、选完路径才撞墙；
 * 4. **可导出口径前后端同源**：后端只导 `active`/`revoked`，前端算「有没有东西可导」
 *    必须用同一组状态（否则前端说「有 1 条可导」、后端说「没有可导的」）。
 *
 * 只看源码形状与词典，不执行 UI。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { enUS, zhCN } from "../i18n/locales.ts";
import { ERROR_CODE_RULES } from "./errors.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 导出失败的三种原因（不含口令类 —— 那几格早就有自己的码）。 */
const EXPORT_FAILURE_CODES = [
  "RP_KEY_BACKUP_NOTHING_TO_EXPORT",
  "RP_KEY_BACKUP_KEYSTORE_UNAVAILABLE",
  "RP_KEY_BACKUP_STORE_READ_FAILED",
] as const;

test("导出失败的三种原因各有各的码，中英两册都说得出「下一步」", () => {
  for (const code of EXPORT_FAILURE_CODES) {
    assert.ok(code in ERROR_CODE_RULES, `前端没接 ${code} ⇒ 界面会退回通用文案`);
    const key = ERROR_CODE_RULES[code];
    assert.ok(key in zhCN, `中文词典缺 ${key}`);
    assert.ok(key in enUS, `英文词典缺 ${key}`);
    // ⚠️ 反例自证：把空态说成磁盘问题的那句话**不许**出现在这三格上。
    // （事故当天 `RP_KEY_BACKUP_IO` 那格写的是「请检查文件与磁盘空间」，
    //   空态被塞进去 ⇒ 用户去清磁盘。）
    for (const [locale, dict] of [
    ["zh", zhCN],
    ["en", enUS],
    ] as const) {
      const text: string = dict[key];
      assert.ok(
        !/磁盘|disk|free space/i.test(text),
        `${locale}/${code} 的文案还在说磁盘：${text}（空态不是磁盘问题）`,
      );
      assert.ok(text.trim().length > 0, `${locale}/${code} 是空文案`);
    }
  }
});

test("后端：空态那一格报「没有可导出的应用」，不是「读写失败」", () => {
  const rust = read("src-tauri/src/commands/rp_key_backup.rs");
  const at = rust.indexOf("if bindings.is_empty()");
  assert.ok(at > 0, "找不到空态分支 ⇒ 导出命令里没有这一格");
  // 只取**这一格**（到它的收尾大括号为止）：取太宽会把后面「真·文件 IO」那一格
  // 一起扫进来 ⇒ 判据会误红（第一次写这条判据时正是这么红的）。
  const end = rust.indexOf("\n        }", at);
  assert.ok(end > at, "空态分支的收尾大括号不见了");
  // 注释里会提到别的码（说明「以前错在哪」），判据只看**代码** ⇒ 先剥掉注释行。
  const branch = rust
    .slice(at, end)
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    branch.includes("RP_KEY_BACKUP_NOTHING_TO_EXPORT"),
    "空态必须报 RP_KEY_BACKUP_NOTHING_TO_EXPORT",
  );
  assert.ok(
    !branch.includes("RP_KEY_BACKUP_IO"),
    "空态不许报 RP_KEY_BACKUP_IO —— 那一格是「真·文件读写失败」",
  );
});

test("界面：本机没有可导出的应用时，导出按钮禁用并给出原因（不让用户撞墙）", () => {
  const sec = read("src/components/settings/RpKeyBackupSection.vue");
  // 按钮跟着「有没有东西可导」走。
  assert.match(
    sec,
    /:disabled="!canStartExport"/,
    "导出按钮没有跟着可导条数禁用 ⇒ 用户会输完口令才撞上失败",
  );
  // 原因写在按钮旁边（禁用而不解释 = 让用户猜）。
  assert.match(
    sec,
    /deviceAuth\.backup\.nothingToExport/,
    "空态没有给出原因文案（按钮被禁用但用户不知道为什么）",
  );
  // 那句原因必须两册都有。
  assert.ok("deviceAuth.backup.nothingToExport" in zhCN, "中文词典缺空态原因");
  assert.ok("deviceAuth.backup.nothingToExport" in enUS, "英文词典缺空态原因");
});

test("可导出口径前后端同源：只有 active / revoked 能进导出包", () => {
  const rust = read("src-tauri/src/commands/rp_key_backup.rs");
  const fnAt = rust.indexOf("fn is_exportable_status");
  assert.ok(fnAt > 0, "后端的可导出口径函数不见了 ⇒ 前端那份会默默漂");
  const rustStatuses = new Set(
    [...rust.slice(fnAt, fnAt + 400).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
  );
  assert.deepEqual(
    [...rustStatuses].sort(),
    ["active", "revoked"],
    "后端的可导出口径变了（中间态不许进导出包）",
  );

  const sec = read("src/components/settings/RpKeyBackupSection.vue");
  const compAt = sec.indexOf("exportableCount");
  assert.ok(compAt > 0, "组件里没有 exportableCount ⇒ 前端算不出有没有东西可导");
  const vueStatuses = new Set(
    [...sec.slice(compAt, compAt + 400).matchAll(/status === "([a-z_]+)"/g)].map((m) => m[1]),
  );
  assert.deepEqual(
    [...vueStatuses].sort(),
    [...rustStatuses].sort(),
    "前后端口径不一致：前端说「有东西可导」而后端说「没有可导的」",
  );
});
