/**
 * RP 绑定密钥导出/恢复的**接线判据**：命令注册 → 门面 → 组件 → 设置页挂载 → 口令下限同源。
 *
 * 为什么需要它：这条链任何一段断掉，用户看到的都是"点了没反应"或"导出了但恢复不了"，
 * 而中间没有任何编译错误（命令没注册只是 invoke 时 reject）。仓库对分享链路已有同形判据
 * （`shareWiring.test.ts`），这里按同一口径钉一遍。
 *
 * 只看源码形状，不执行 UI。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("后端：三条命令已注册，且分册被 include 进命令模块", () => {
  const lib = read("src-tauri/src/lib.rs");
  for (const cmd of [
    "device_auth_export_bindings",
    "device_auth_preview_import",
    "device_auth_apply_import",
  ]) {
    assert.match(
      lib,
      new RegExp(`commands::${cmd},`),
      `${cmd} 没注册 ⇒ 前端 invoke 必然 reject（点了没反应）`,
    );
  }
  assert.match(
    read("src-tauri/src/commands.rs"),
    /include!\("commands\/rp_key_backup\.rs"\);/,
    "命令文件没被 include 进 commands 模块 ⇒ 整文件是死代码",
  );
});

test("前端：门面三条 + 组件经门面调用（不裸 invoke）", () => {
  const api = read("src/api/index.ts");
  for (const [sig, why] of [
    ['invoke<RpKeyExportSummary>("device_auth_export_bindings"', "导出入口缺失"],
    ['invoke<RpKeyImportReport>("device_auth_preview_import"', "预览入口缺失（没有预览就会静默覆盖）"],
    ['invoke<RpKeyImportReport>("device_auth_apply_import"', "导入入口缺失"],
  ] as const) {
    assert.ok(api.includes(sig), `${why}（缺 ${sig}）`);
  }

  const sec = read("src/components/settings/RpKeyBackupSection.vue");
  assert.match(sec, /api\.deviceAuthExportBindings\(/, "组件必须经门面导出");
  assert.match(sec, /api\.deviceAuthPreviewImport\(/, "必须先预览");
  assert.match(sec, /api\.deviceAuthApplyImport\(/, "确认后才写库");
  assert.doesNotMatch(sec, /\binvoke\(/, "组件里裸 invoke ⇒ 绕开错误口径与类型");

  // 2026-11-17：第三方三块收进「第三方接入」tab，由 IntegrationsSection 聚合 ——
  // 判据跟着分两层：聚合页必须挂这块，两个外壳都必须挂聚合页（拆任一层就红）。
  const integrations = read("src/components/settings/IntegrationsSection.vue");
  assert.match(integrations, /<RpKeyBackupSection \/>/, "第三方接入页没挂导出/恢复入口");
  for (const surface of ["src/components/SettingsWindow.vue", "src/components/SettingsPanel.vue"]) {
    assert.match(read(surface), /<IntegrationsSection \/>/, `${surface} 没挂第三方接入 tab`);
  }
});

test("口令下限只有一份：前端提示与后端常量对账", () => {
  const rust = read("src-tauri/src/rp_key_backup.rs");
  const m = rust.match(/pub const MIN_PASSPHRASE_CHARS: usize = (\d+);/);
  assert.ok(m, "后端 MIN_PASSPHRASE_CHARS 消失 ⇒ 前端那份会默默漂");
  const rustMin = Number(m[1]);

  const sec = read("src/components/settings/RpKeyBackupSection.vue");
  const n = sec.match(/const MIN_PASS = (\d+);/);
  assert.ok(n, "组件里没有 MIN_PASS（口令下限没有单一事实源）");
  assert.equal(
    Number(n[1]),
    rustMin,
    `前端口令下限 ${n[1]} 与后端 ${rustMin} 不一致：用户按提示输入仍会被后端拒`,
  );
});
