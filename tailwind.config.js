/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  // ⚠️ 这一栏必须排掉 `*.test.*`：Tailwind 扫的是**原始文本**，不做语义判断。
  // 判据夹具里那些"故意写坏的示例 class"（`z-[7]`、`pb-[calc(56px+8px)]`、
  // `text-[var(--gosslan-x)]`…）会被当成真在用过的样式，直接生成进生产 CSS ——
  // 2026-10-19 现数 13 条死规则，全部来自 `src/utils/designGuards.test.ts`。
  // 夹具只会越加越多，所以修的是这一栏，不是某个夹具的写法。
  // extglob `!(*.test)` 覆盖四种扩展名（`.vue/.ts/.tsx` 都排得掉）；现算核对：303 → 206 份，
  // 差的 97 份全是 `*.test.ts`，非测试文件少 0 份 ⇒ 生产样式一条也没被排掉。
  content: ["./index.html", "./src/**/!(*.test).{vue,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "var(--gosslan-primary)",
          hover: "var(--gosslan-primary-hover)",
          active: "var(--gosslan-primary-active)",
          light: "var(--gosslan-primary-light)",
        },
      },
      fontFamily: {
        gosslan: "var(--gosslan-font-family, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif)",
      },
      /**
       * 字号令牌：像素值与原来逐点一致，只把「散落的 text-[NNpx]」收成语义名。
       * `line-height: inherit` 是承重件 —— Tailwind 的任意字号只设 font-size，行高靠继承；
       * 若这里改用默认行高，整站排版会在替换后整体变紧。
       */
      fontSize: {
        micro: ["10px", { lineHeight: "inherit" }],
        caption: ["11px", { lineHeight: "inherit" }],
        meta: ["12px", { lineHeight: "inherit" }],
        body: ["13px", { lineHeight: "inherit" }],
        emphasis: ["14px", { lineHeight: "inherit" }],
        title: ["15px", { lineHeight: "inherit" }],
      },
    },
  },
  plugins: [
    /**
     * `desktop:` 变体 = 「本机不是移动布局」。
     *
     * 为什么要它：Tailwind 的 `md:`/`sm:` 只看视口宽度，而**移动端的视口宽度会说谎** ——
     * 安卓启动时系统权限弹框盖住 WebView 的首次布局，那一刻 `matchMedia` 读到的是
     * 兜底档位（980px 那档）⇒ 手机上 JS 判"移动"、CSS 判"桌面"，导航栏回来、
     * 底部安全区内边距被清零、抽屉按 980px 铺满（#27 现场）。
     * `is-mobile` 这个类由 `useAppStore.applyIsMobile()` 独家写（判据 = platform.ts 的
     * `resolveMobileLayout`，平台优先），CSS 只读它 —— 一处判、一处读，不留第二份口径。
     *
     * 用法是 `desktop:md:flex` 这种**叠加**：既要"桌面"也要"≥768px"，
     * 所以桌面窄窗口（拖到 500px）的行为与改造前一字不差。
     */
    function desktopVariant({ addVariant }) {
      addVariant("desktop", "html:not(.is-mobile) &");
    },
  ],
};
