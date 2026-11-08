// Gosslan 首屏主题脚本（**内联进每个窗口的 HTML**，由 vite.config.ts 的
// `gosslan:inline-boot` 插件注入；不要写成模块 —— 它必须早于样式/模块脚本执行）。
//
// 三件事必须在「第一批像素」之前做完，否则用户会看到闪白/闪错外观：
//   ① 亮暗、主色与字体（键名与 utils/appearance.ts 的 APPEARANCE_STORAGE_KEY /
//      LEGACY_DARK_STORAGE_KEY、stores/useAppStore.ts 的 THEME_KEY 与 FONT_KEY、i18n/index.ts 的
//      STORAGE_KEY 保持一致 —— 由 appearance.test.ts 现解析两边比对）；
//   ② 语言（决定骨架里的 brand 文案与 <title>）；
//   ③ macOS 平台标记（标题栏拖拽区/左侧让位用，无关高度：两平台 caption 都是 40px）。

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
        // ------------------------------------------------------------------
        // 主题色可读性算法（utils/themePalette.ts 的**第二份实现**）
        //
        // 本脚本必须先于 bundle 执行，import 不到那个模块 —— 复制是平台约束。
        // 两边的输出（`seedTokens` 那 6 个 CSS 变量）由 themePalette.test.ts 逐例真跑对照，漂移即红。
        // 算法说明见 docs/design-language/theme-contrast.md：OKLCH 里沿 L 轴取「刚好达标的第一档」，
        // 每档同时过 APCA |Lc| 与 WCAG 比值双约束。改这里必须同步 themePalette.ts，反之亦然。
        function clamp(v, lo, hi) {
          return Math.min(hi, Math.max(lo, v));
        }
        function seedRgb(hex) {
          var s = String(hex || "").trim().replace(/^#/, "");
          if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
          if (!/^[0-9a-fA-F]{6}$/.test(s)) return seedRgb("#2f6bff");
          return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
        }
        function rgbHex(rgb) {
          var ch = function (v) {
            var n = clamp(Math.round(v), 0, 255);
            return (n < 16 ? "0" : "") + n.toString(16);
          };
          return "#" + ch(rgb[0]) + ch(rgb[1]) + ch(rgb[2]);
        }
        function s2l(v) {
          var c = v / 255;
          return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }
        function l2s(v) {
          var c = clamp(v, 0, 1);
          return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
        }
        function rgbOklch(rgb) {
          var r = s2l(rgb[0]);
          var g = s2l(rgb[1]);
          var b = s2l(rgb[2]);
          var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
          var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
          var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
          var L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
          var A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
          var B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
          var H = (Math.atan2(B, A) * 180) / Math.PI;
          if (H < 0) H += 360;
          return { L: L, C: Math.sqrt(A * A + B * B), H: H };
        }
        function oklchLinear(L, C, H) {
          var rad = (H * Math.PI) / 180;
          var a = C * Math.cos(rad);
          var b = C * Math.sin(rad);
          var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
          var m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
          var s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
          return [
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
          ];
        }
        function inGamut(L, C, H) {
          var c = oklchLinear(L, C, H);
          var eps = 1e-7;
          return c[0] >= -eps && c[0] <= 1 + eps && c[1] >= -eps && c[1] <= 1 + eps && c[2] >= -eps && c[2] <= 1 + eps;
        }
        function maxChroma(L, H) {
          if (L <= 0 || L >= 1) return 0;
          var lo = 0;
          var hi = 0.5;
          for (var i = 0; i < 26; i++) {
            var mid = (lo + hi) / 2;
            if (inGamut(L, mid, H)) lo = mid;
            else hi = mid;
          }
          return lo;
        }
        function oklchRgb(L, C, H) {
          var safeL = clamp(L, 0, 1);
          var safeC = Math.min(Math.max(C, 0), maxChroma(safeL, H));
          var c = oklchLinear(safeL, safeC, H);
          return [l2s(c[0]) * 255, l2s(c[1]) * 255, l2s(c[2]) * 255];
        }
        function oklchHex(L, C, H) {
          return rgbHex(oklchRgb(L, C, H));
        }
        var AP = {
          mainTRC: 2.4, sRco: 0.2126729, sGco: 0.7151522, sBco: 0.072175,
          normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
          blkThrs: 0.022, blkClmp: 1.414, scaleBoW: 1.14, scaleWoB: 1.14,
          loBoWoffset: 0.027, loWoBoffset: 0.027, deltaYmin: 0.0005, loClip: 0.1,
        };
        function apcaY(rgb) {
          var e = function (v) {
            return Math.pow(v / 255, AP.mainTRC);
          };
          return AP.sRco * e(rgb[0]) + AP.sGco * e(rgb[1]) + AP.sBco * e(rgb[2]);
        }
        function apcaLc(txt, bg) {
          var t = apcaY(txt);
          var b = apcaY(bg);
          t = t > AP.blkThrs ? t : t + Math.pow(AP.blkThrs - t, AP.blkClmp);
          b = b > AP.blkThrs ? b : b + Math.pow(AP.blkThrs - b, AP.blkClmp);
          if (Math.abs(b - t) < AP.deltaYmin) return 0;
          if (b > t) {
            var s = (Math.pow(b, AP.normBG) - Math.pow(t, AP.normTXT)) * AP.scaleBoW;
            return (s < AP.loClip ? 0 : s - AP.loBoWoffset) * 100;
          }
          var r = (Math.pow(b, AP.revBG) - Math.pow(t, AP.revTXT)) * AP.scaleWoB;
          return (r > -AP.loClip ? 0 : r + AP.loWoBoffset) * 100;
        }
        function wcagLum(rgb) {
          return 0.2126 * s2l(rgb[0]) + 0.7152 * s2l(rgb[1]) + 0.0722 * s2l(rgb[2]);
        }
        function wcagRatio(a, b) {
          var la = wcagLum(a);
          var lb = wcagLum(b);
          return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
        }
        function meets(fg, bg, t) {
          return Math.abs(apcaLc(fg, bg)) >= t.a && wcagRatio(fg, bg) >= t.w;
        }
        var T_SECONDARY = { a: 72, w: 4.55 };
        var T_BUTTON = { a: 78, w: 4.55 };
        function solveLightText(bg, C, H, t, lo, hi) {
          for (var L = lo; L <= hi; L += 0.002) if (meets(oklchRgb(L, C, H), bg, t)) return oklchHex(L, C, H);
          return oklchHex(hi, C, H);
        }
        function solveDarkText(bg, C, H, t, hi, lo) {
          for (var L = hi; L >= lo; L -= 0.002) if (meets(oklchRgb(L, C, H), bg, t)) return oklchHex(L, C, H);
          return oklchHex(lo, C, H);
        }
        function solveLightFill(H, C, t) {
          for (var L = 0.68; L >= 0.32; L -= 0.002) {
            if (meets([255, 255, 255], oklchRgb(L, C, H), t)) return { L: L, hex: oklchHex(L, C, H) };
          }
          return { L: 0.32, hex: oklchHex(0.32, C, H) };
        }
        function solveDarkFill(H, C, t, ink) {
          for (var L = 0.68; L <= 0.92; L += 0.002) {
            if (meets(ink, oklchRgb(L, C, H), t)) return { L: L, hex: oklchHex(L, C, H) };
          }
          return { L: 0.92, hex: oklchHex(0.92, C, H) };
        }
        function seedVars(seedHex, dark) {
          var rgbSeed = seedRgb(seedHex);
          var ok = rgbOklch(rgbSeed);
          var achromatic = ok.C < 0.004;
          var H = achromatic ? 0 : ok.H;
          var tC = achromatic ? 0 : clamp(ok.C * 0.02, 0.002, 0.006);
          var hex = function (L, C) {
            return oklchHex(L, C, H);
          };
          var rgb = function (L, C) {
            return oklchRgb(L, C, H);
          };
          var inkNeutral = dark ? rgb(0.19, tC) : [18, 18, 20];
          var fillC = Math.min(ok.C, 0.2);
          var fill;
          if (!dark) {
            var solved = solveLightFill(H, fillC, T_BUTTON);
            var L = achromatic ? solved.L : Math.min(Math.max(ok.L, 0.36), solved.L);
            fill = { L: L, hex: hex(L, fillC) };
          } else {
            var solvedDark = solveDarkFill(H, fillC, T_BUTTON, inkNeutral);
            var Ld = Math.max(Math.min(ok.L, 0.88), solvedDark.L);
            fill = { L: Ld, hex: hex(Ld, fillC) };
          }
          var accent = dark
            ? solveLightText(seedRgb(hex(0.304, tC)), Math.min(ok.C, 0.17), H, T_SECONDARY, 0.58, 0.97)
            : solveDarkText(seedRgb(hex(0.917, tC)), Math.min(ok.C, 0.17), H, T_SECONDARY, 0.58, 0.16);
          return {
            "--gosslan-primary": fill.hex,
            "--gosslan-primary-hover": dark ? hex(Math.min(0.92, fill.L + 0.035), fillC) : hex(Math.max(0.3, fill.L - 0.035), fillC),
            "--gosslan-primary-active": dark ? hex(Math.min(0.94, fill.L + 0.07), fillC) : hex(Math.max(0.28, fill.L - 0.07), fillC),
            "--gosslan-on-primary": dark ? hex(0.19, tC) : "#ffffff",
            "--gosslan-accent-ink": accent,
            "--gosslan-primary-light": dark ? hex(0.32, Math.min(fillC * 0.22, 0.045)) : hex(0.948, Math.min(fillC * 0.22, 0.04)),
          };
        }
        var el = document.documentElement;
        var mode = readBootLS("gosslan.appearance");
        if (mode !== "system" && mode !== "light" && mode !== "dark") {
          // 旧版本只存了 gosslan.dark 布尔值：迁移为显式模式（不静默丢弃用户偏好）
          var legacy = readBootLS("gosslan.dark");
          mode = legacy === "1" ? "dark" : legacy === "0" ? "light" : "system";
        }
        // 实际外观要在主色之后还要用到（亮/暗的最差底色不同），所以提到外层。
        var wantDark = false;
        bootStep(function () {
          // 问不到系统偏好时按浅色 —— 宁可少做一次深色，也不要瞎猜成深色闪一下。
          wantDark =
            mode === "dark" ||
            (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
          if (wantDark) el.classList.add("dark");
        });
        bootStep(function () {
          // 没有存过主色时也要跑：算法会从出厂蓝派生，保证首帧就是**校正后**的整套阶梯
          //（先按 style.css 的 color-mix 默认值渲染、等 bundle 起来再换，会闪一下未校正色）。
          var vars = seedVars(readBootLS("gosslan.themeColor") || "#2f6bff", wantDark);
          // 主色单独写一行（不靠下面的循环）：骨架的 `--boot-primary: var(--gosslan-primary, …)`
          // 是"换了主题色不闪蓝"的唯一落点，windowEntries.test.ts 按这个字面量确认它真的写了。
          el.style.setProperty("--gosslan-primary", vars["--gosslan-primary"]);
          for (var k in vars) {
            if (k !== "--gosslan-primary") el.style.setProperty(k, vars[k]);
          }
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
          // 应用显示名本地化：中文「小院儿」/ 英文 "Gosslan"（<title> 与骨架 brand 共用）。
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
