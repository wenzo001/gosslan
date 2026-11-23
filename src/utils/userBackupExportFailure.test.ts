/**
 * 整库备份导出失败的**口径判据**（2026-11-23 真机事故的回归锁）。
 *
 * ## 事故原样
 *
 * 用户在生产包 7.2.6 点「选择位置并导出」，弹：
 *
 *     导出备份失败 · 读写密钥包失败，请检查文件与磁盘空间
 *
 * 而用户确认磁盘充足。根因：整库导出有 5 个步骤（快照 → 明文化 → 读字节 → 加密 →
 * 写目的地），原先全部塞进 `RP_KEY_BACKUP_IO` 一个码 ⇒ 界面永远只说「查磁盘」，
 * 到底是"快照写不进系统盘"还是"导出目标不可写"完全分不出来，也没有任何日志留痕。
 *
 * ## 这本判据钉住什么
 *
 * 1. **三个步骤三种码**：快照（USER_BACKUP_SNAPSHOT_FAILED）/ 加密（SEAL）/
 *    写目的地（WRITE），各有各的「下一步」；
 * 2. **失败必须留痕**：每个失败分支都要 `logger.error`（真机排障的唯一入口）；
 * 3. **界面文案双向齐全**：中英两册都有这三条 rule；
 * 4. **快照码的文案必须点名"数据目录所在磁盘"**：真机最容易误查的就是导出目标盘。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const CODES = ["USER_BACKUP_SNAPSHOT_FAILED", "USER_BACKUP_SEAL_FAILED", "USER_BACKUP_WRITE_FAILED"];

test("后端：三个码各有定义、导出命令按步骤分别使用", () => {
  const codes = read("src-tauri/src/error_codes.rs");
  const cmd = read("src-tauri/src/commands/user_backup.rs");
  for (const c of CODES) {
    assert.ok(codes.includes(`pub const ${c}: &str`), `error_codes.rs 缺 ${c}`);
    assert.ok(cmd.includes(`error_codes::${c}`), `导出命令没用 ${c}（又并回一个码就失去可诊断性）`);
  }
  // 快照码必须覆盖 vacuum / 打开快照 / 读字节三处，写码只出现在写目的地。
  const snapshotUses = cmd.split("error_codes::USER_BACKUP_SNAPSHOT_FAILED").length - 1;
  assert.ok(snapshotUses >= 3, `快照码只用了 ${snapshotUses} 处（应覆盖生成/打开/读字节）`);
});

test("后端：每个失败分支都有 logger.error 留痕", () => {
  const cmd = read("src-tauri/src/commands/user_backup.rs");
  const errLogs = cmd.split("logger.error(\"backup\"").length - 1;
  assert.ok(errLogs >= 4, `备份导出失败留痕只有 ${errLogs} 处（真机排障无入口）`);
});

test("前端：三个码都映射到规则文案，且中英双语齐全", () => {
  const errors = read("src/utils/errors.ts");
  const zh = read("src/i18n/locales/zh-cn.ts");
  const en = read("src/i18n/locales/en-us.ts");
  const map: Record<string, string> = {
    USER_BACKUP_SNAPSHOT_FAILED: "errors.rule.userBackupSnapshot",
    USER_BACKUP_SEAL_FAILED: "errors.rule.userBackupSeal",
    USER_BACKUP_WRITE_FAILED: "errors.rule.userBackupWrite",
  };
  for (const [code, key] of Object.entries(map)) {
    assert.ok(errors.includes(`${code}: "${key}"`), `errors.ts 没映射 ${code}`);
    assert.ok(zh.includes(`"${key}":`), `zh 缺 ${key}`);
    assert.ok(en.includes(`"${key}":`), `en 缺 ${key}`);
  }
  // 快照码文案必须点名数据目录/系统盘——真机最常误查的是导出目标盘。
  assert.match(zh, /userBackupSnapshot"[^\n]*数据目录/, "zh 快照文案没点名数据目录");
});
