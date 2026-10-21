// Gosslan 首屏主题脚本（**内联进每个窗口的 HTML**，由 vite.config.ts 的
// `gosslan:inline-boot` 插件注入；不要写成模块 —— 它必须早于样式/模块脚本执行）。
//
// 三件事必须在「第一批像素」之前做完，否则用户会看到闪白/闪错外观：
//   ① 亮暗、主色与字体（键名与 utils/appearance.ts 的 APPEARANCE_STORAGE_KEY /
//      LEGACY_DARK_STORAGE_KEY、stores/useAppStore.ts 的 THEME_KEY 与 FONT_KEY、i18n/index.ts 的
//      STORAGE_KEY 保持一致 —— 由 appearance.test.ts 现解析两边比对）；
//   ② 语言（决定骨架里的 brand 文案与 <title>）；
//   ③ macOS 平台标记（骨架标题栏高度 28px vs 38px）。

      // 首屏主题：必须在样式/脚本资源就位**之前**决定亮暗与主色，
      // 否则 WebView 会先按浅色渲染再切深色（用户看到"闪一下白"）。
      // 键名必须是 TS 侧那几个常量的当前值（appearance.ts 的两条、useAppStore 的 THEME_KEY 与 FONT_KEY、
      // i18n 的 STORAGE_KEY）；这里只能用字面量，由 appearance.test.ts 现解析两边比对。
      //
      // 外观三态：显式 light / dark 直接生效；"system"（或旧数据）跟随系统偏好。
      // ⚠️ 这段是 utils/appearance.ts 里 readStoredAppearance() + resolveDark() 的**第二份实现**：
      //    本脚本由 vite 的 gosslan:inline-boot 插件内联进 HTML，必须早于 bundle 执行，
      //    所以它 import 不到那个模块 —— 复制是平台约束，不是偷懒。
      //    两边一致由 appearance.test.ts 逐例真跑本脚本对照，不靠这段注释提醒。
      (function () {
        // 逐键兜底（§6.82）：这五枚键各读各的，一枚抛错（Safari 隐私模式是**按键**抛的）只当"没这个键"，
        // 不许把后面的主色/字体/语言一起带走。本脚本内联进 HTML、import 不到 utils/safeStorage 那个家，
        // 所以这里是同一语义的第二份实现；键名仍是裸字面量，由 appearance.test.ts 现解析两边比对。
        function readBootLS(k) {
          try {
            return localStorage.getItem(k);
          } catch (e) {
            return null;
          }
        }
        // 逐件事兜底（§6.87）：外层那圈 try 原来罩着**整段**，而 `mode` 的默认值是 "system" ⇒
        // 从没在设置里选过亮暗的大多数首帧都要走 `window.matchMedia`。那一抛（旧 WebView 没有这个 API、
        // 受限环境里访问它就抛），主色、字体、`<html lang>`、`<title>`、macOS 标记**一起不做**，
        // 症状是"深色没闪，但整屏出厂蓝 + 系统字体 + 英文标题 + 38px 骨架标题栏"，而没有任何一层报错。
        // 与逐键兜底同一条道理：一件事失败只当"没做这件事"，不许带走别的事。
        function bootStep(fn) {
          try {
            fn();
          } catch (e) {
            /* 这一件事没做成，其余照旧 */
          }
        }
        var el = document.documentElement;
        var mode = readBootLS("gosslan.appearance");
        if (mode !== "system" && mode !== "light" && mode !== "dark") {
          // 旧版本只存了 gosslan.dark 布尔值：迁移为显式模式（不静默丢弃用户偏好）
          var legacy = readBootLS("gosslan.dark");
          mode = legacy === "1" ? "dark" : legacy === "0" ? "light" : "system";
        }
        bootStep(function () {
          // 问不到系统偏好时按浅色 —— 宁可少做一次深色，也不要瞎猜成深色闪一下。
          var wantDark =
            mode === "dark" ||
            (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
          if (wantDark) el.classList.add("dark");
        });
        bootStep(function () {
          var c = readBootLS("gosslan.themeColor");
          // 只写主色这一件事：hover/active/浅底三档由 style.css 用 color-mix 现派生，
          // 所以首屏就已经是完整的一套主题色（以前这里还得把派生档一个个补上，
          // 补漏的那个窗口里按钮已换色而 hover/浅底还是出厂蓝）。
          if (c) el.style.setProperty("--gosslan-primary", c);
        });
        bootStep(function () {
          // 用户选过字体就一起写上（与 stores/useAppStore.ts 的 FONT_KEY 同一个键，
          // 由 appearance.test.ts 现解析两边比对）。默认档存的是空串 ⇒ 这里不动，
          // 让 style.css 的 --gosslan-font-family 默认值生效（那条默认栈只有那一个家）。
          var f = readBootLS("gosslan.fontFamily");
          if (f) el.style.setProperty("--gosslan-font-family", f);
        });
        bootStep(function () {
          // 语言首帧：跟随系统语言（与 src/i18n 的 detectSystemLocale 同一口径，
          // 由 appearance.test.ts 逐例对照，改动请同步）。
          // 显式偏好（gosslan.locale）优先；否则 zh* → 中文，其余（含 en*）→ 英文。
          var lang = "en-US";
          var prefLang = readBootLS("gosslan.locale");
          if (prefLang === "zh-CN" || prefLang === "en-US") {
            lang = prefLang;
          } else {
            var sys = navigator.languages && navigator.languages.length ? navigator.languages : [];
            var hit = "";
            for (var i = 0; i < sys.length; i++) {
              var tag = (sys[i] || "").toLowerCase();
              if (tag.indexOf("zh") === 0) { hit = "zh-CN"; break; }
              if (tag.indexOf("en") === 0) { hit = "en-US"; break; }
            }
            if (!hit) {
              // 列表里一个都没命中时还要看 navigator.language —— 与 detectSystemLocale 的
              // 兜底同一步：有些 WebView 只暴露 language，而 languages 全是非中英时中文单值仍要认。
              var one = (navigator.language || "").toLowerCase();
              hit = one.indexOf("zh") === 0 ? "zh-CN" : "en-US";
            }
            lang = hit;
          }
          el.lang = lang;
          // 应用显示名本地化：中文「相闻」/ 英文 "Gosslan"（<title> 与骨架 brand 共用）。
          // 每个窗口的标题由它自己的 HTML 用 data-title-zh / data-title-en 声明
          // （主窗口「相闻」、设置窗口「相闻 · 设置」、日志窗口「相闻 · 运行日志」）——
          // 三个窗口共用这一份脚本，不需要各自写分支。
          var zh = el.getAttribute("data-title-zh");
          var en = el.getAttribute("data-title-en");
          if (zh || en) document.title = lang === "zh-CN" ? zh || en : en || zh;
        });
        bootStep(function () {
          // macOS 标记：首屏骨架需要按平台取标题栏高度（原生 macOS caption 是 28px，
          // 而 Windows/Linux 用 38px 的自绘 caption）——骨架先于 app.init 运行，
          // 所以这里自己判一次。平台判定只认 `Macintosh`（不要用 `Mac OS X`，本项目既有约定）。
          if (/Macintosh/.test(navigator.userAgent)) el.classList.add("is-mac");
        });
      })();
