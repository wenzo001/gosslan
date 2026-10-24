import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isApkName } from "./fileKind.ts";

test("isApkName：只认真正的 .apk（大小写/空白容忍，压缩包不算）", () => {
  assert.equal(isApkName("gosslan.apk"), true);
  assert.equal(isApkName(" GOSSLAN.APK "), true);
  assert.equal(isApkName("a.apk.zip"), false);
  assert.equal(isApkName("a.apk.txt"), false);
  assert.equal(isApkName("apk"), false);
  assert.equal(isApkName(""), false);
});

test("Android APK 安装接线：前端分流 + Kotlin MIME + Manifest 权限", () => {
  const root = join(import.meta.dirname, "..", "..");
  const localFile = readFileSync(join(root, "src/utils/localFile.ts"), "utf8");
  assert.match(localFile, /isApkName\(name\)/, "Android 入口必须先按名字判 apk");
  assert.match(localFile, /isApkName\(path\)/, "路径也要兜底判 apk");
  assert.match(
    localFile,
    /openFileNative\(path, owner\)/,
    "apk 必须交给系统打开器（并带上消息归属 owner），不走另存为",
  );

  const kotlin = readFileSync(
    join(
      root,
      "src-tauri/gen/android/app/src/main/java/com/gosslan/app/OpenWith.kt",
    ),
    "utf8",
  );
  assert.match(
    kotlin,
    /application\/vnd\.android\.package-archive/,
    "Kotlin 必须把 apk 映射成安装器 MIME，不能只靠 MimeTypeMap",
  );

  const manifest = readFileSync(
    join(root, "src-tauri/gen/android/app/src/main/AndroidManifest.xml"),
    "utf8",
  );
  assert.match(
    manifest,
    /android\.permission\.REQUEST_INSTALL_PACKAGES/,
    "Android 8+ 安装外部 apk 需要声明 REQUEST_INSTALL_PACKAGES",
  );
});
