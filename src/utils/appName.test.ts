/**
 * 应用名的**单一事实源**判据：中文「小院儿」/ 英文 "Gosslan"。
 *
 * 为什么需要它：这个名字散落在 7 处平台资源里（i18n 词典、tauri.conf 的 productName、
 * macOS 的 Info.plist + 两份 InfoPlist.strings、Android 的 values / values-zh、NSIS 语言包）。
 * 任何一处漏改，现象都是"某个平台某语言下名字不对"，而且**没有任何编译错误**。
 * 2026-10-23 全量改名时就出现过注释与资源脱节，本判据把这类漂移钉死。
 *
 * ## 为什么要断言 productName 仍是 "Gosslan"
 *
 * 它是**可执行文件与 macOS .app 目录名**（也是 Windows 安装目录与卸载锚点）。
 * 用户 2026-11-15 的要求是「搜『小院儿』和搜『gosslan』都能找到」—— 在 macOS 上
 * "找得到 gosslan" 恰恰靠这个目录名（Spotlight 同时索引文件名与 CFBundleDisplayName）。
 * 所以它**不该**被改成中文；改它还会让升级锚点断裂（旧版认不出新版）。
 *
 * ## 不判什么
 *
 * 真机上的搜索结果（Spotlight / 开始菜单 / 启动器）**判不了**，本文件只钉"资源写对了"。
 * 各平台能搜到什么、哪些做不到，写在 `docs/notes/app-name-and-searchability-2026-11-15.md`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
// 正则转义全仓只有一份（`escapeRe.test.ts` 会把内联副本抓出来）。
import { escapeRe } from "./escapeRe.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

function walk(rel: string): string[] {
  const abs = join(ROOT, rel);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    const p = join(abs, name);
    if (statSync(p).isDirectory()) out.push(...walk(join(rel, name)));
    // 键一律 posix 化：Windows 的 join 给反斜杠 ⇒ 「排除测试文件自身」的字符串比较失配，
    // 判据会把自己扫进去（2026-11-18 Windows 实测）；POSIX 上 replaceAll 是无操作。
    else if (/\.(ts|vue|rs|js|html|plist|nsh|xml)$/.test(name)) out.push(join(rel, name).replaceAll("\\", "/"));
  }
  return out;
}

test("应用名资源：中文「小院儿」/ 英文 Gosslan，七处平台资源一致", () => {
  // ① 应用内文案（所有界面文案都从这里取）
  assert.match(read("src/i18n/locales/zh-cn.ts"), /"app\.name": "小院儿"/, "中文词典的 app.name 不是小院儿");
  assert.match(read("src/i18n/locales/en-us.ts"), /"app\.name": "Gosslan"/, "英文词典的 app.name 不是 Gosslan");

  // ② 首屏静态标题默认中文：应用中文优先（html lang=zh-CN），首帧不该先闪英文名；
  //    切语言由内联启动脚本按 data-title-* 覆盖。
  assert.match(
    read("index.html"),
    /<title>小院儿<\/title>/,
    "index.html 的静态 <title> 不是小院儿（首帧会先闪英文名）",
  );

  // ③ 安装包 / 可执行文件 / macOS .app 目录名。搜 "gosslan" 在 macOS 上就靠它。
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as { productName?: string };
  assert.equal(
    conf.productName,
    "Gosslan",
    "productName 是 exe 名与 mac .app 目录名（也是升级锚点）—— 改成中文会让『搜 gosslan』失效并可能断升级",
  );

  // ③ macOS / iOS 显示名：默认中文，英文由 en.lproj 覆盖
  assert.match(
    read("src-tauri/Info.plist"),
    /<key>CFBundleDisplayName<\/key>\s*<string>小院儿<\/string>/,
    "Info.plist 的 CFBundleDisplayName 不是小院儿",
  );
  assert.match(
    read("src-tauri/infoplist/zh-Hans.lproj/InfoPlist.strings"),
    /"CFBundleDisplayName" = "小院儿";/,
    "中文 InfoPlist.strings 的显示名不是小院儿",
  );
  assert.match(
    read("src-tauri/infoplist/en.lproj/InfoPlist.strings"),
    /"CFBundleDisplayName" = "Gosslan";/,
    "英文 InfoPlist.strings 的显示名不是 Gosslan",
  );

  // ④ Android：默认（英文）一份、values-zh 覆盖一份
  assert.match(
    read("src-tauri/gen/android/app/src/main/res/values/strings.xml"),
    /<string name="app_name">"Gosslan"<\/string>/,
    "Android 默认 app_name 不是 Gosslan（英文系统会显示错名）",
  );
  assert.match(
    read("src-tauri/gen/android/app/src/main/res/values-zh/strings.xml"),
    /<string name="app_name">"小院儿"<\/string>/,
    "Android values-zh 的 app_name 不是小院儿（中文系统会显示英文名）",
  );
});

test("Windows：开始菜单同时留两个名字，桌面仍只有一个图标", () => {
  const hooks = read("src-tauri/nsis/hooks.nsh");

  // 别名必须挂在「本地化名与锚点名不同」的条件里，且只建在 $SMPROGRAMS。
  assert.match(
    hooks,
    /\$\{If\} \$R8 != "\$\{PRODUCTNAME\}"\s*\n\s*!insertmacro Gosslan_CreateShortcutIfMissing "\$SMPROGRAMS" "\$\{PRODUCTNAME\}"/,
    "开始菜单缺英文名别名 ⇒ 搜 gosslan 找不到（或英文安装时多建一份同名快捷方式）",
  );

  // 桌面**不许**建别名：5.16.95 曾因两份快捷方式回归（win_shortcut.rs 的对账只处理桌面）。
  const desktopAlias = /Gosslan_CreateShortcutIfMissing "\$DESKTOP" "\$\{PRODUCTNAME\}"/.test(hooks);
  assert.equal(desktopAlias, false, "桌面不许建英文名别名 —— 桌面保持单个图标");

  // 卸载要把两个名字都清掉，否则留一个孤儿快捷方式指向已删除的 exe。
  for (const name of [`"\${PRODUCTNAME}"`, `"小院儿"`]) {
    assert.match(
      hooks,
      new RegExp(`Gosslan_DeleteOwnedShortcut "\\$SMPROGRAMS" ${escapeRe(name)}`),
      `卸载没清开始菜单里的 ${name} 快捷方式`,
    );
  }
});

test("活代码里不再出现旧名（旧名字面量只许出现在本判据文件里当检索针）", () => {
  // 排除本文件自身（它必须持有旧名字面量当检索针，否则这条判据没有牙齿）。
  const files = [...walk("src"), ...walk("src-tauri/src"), "src-tauri/Info.plist", "index.html"].filter(
    (f) => f !== "src/utils/appName.test.ts",
  );
  // 不留任何豁免：活代码、注释、资源里出现旧名就是漏改（用户 2026-11-18：全部修改或去掉）。
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(join(ROOT, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("小院儿")) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, [], `旧名残留（改名要连注释一起改）：\n${hits.join("\n")}`);

  // 阳性对照：同一个扫描器必须能在同一批文件里读到新名，否则上面「零命中」是假的。
  const control = files.filter((f) => readFileSync(join(ROOT, f), "utf8").includes("小院儿")).length;
  assert.ok(control >= 3, `只扫到 ${control} 个文件含「小院儿」⇒ 扫描器/路径坏了，上面的零命中不可信`);
});
