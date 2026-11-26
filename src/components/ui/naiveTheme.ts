import type { GlobalThemeOverrides } from "naive-ui";

/**
 * naive-ui 的全局 token 映射（官方 `NConfigProvider` 方式，2026-11-26）。
 *
 * 原则：
 * 1. **不写死色值** —— 一律引用本仓语义变量（`--gosslan-*`）。换主题色、亮/暗切换时，
 *    CSS 变量已经是唯一来源，naive 的 token 跟着走，不需要在 JS 里再维护第二套色板；
 * 2. 只映射**真正用到**的那几组：naive 目前只提供 Scrollbar（以及将来的 InfiniteScroll），
 *    给一堆用不上的 token 只会增加漂移面；
 * 3. 滚动条的颜色变量 `--gosslan-os-thumb[-hover]` 在 `style.css` 的 `:root` / `.dark`
 *    各有一档 —— naive 的 `scrollbarColor` 与滑块 CSS 读的是同一个变量，不存在两套色。
 *
 * 主题宽度取 16px 是为了**滑块最小长度**：naive 的 `yBarSize` 公式是
 * `比例长度 + 1.5 × theme.width`，8px 带宽下几万像素的长列表滑块只有 12px，抓不住。
 * 视觉宽度由 `.gosslan-os--thin/normal/thick` 的 `--n-scrollbar-width` 覆盖，
 * 与这里的 16px 解耦，位置计算不受影响。
 */
export const naiveThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: "var(--gosslan-primary)",
    primaryColorHover: "var(--gosslan-primary-hover)",
    primaryColorPressed: "var(--gosslan-primary-active)",
    primaryColorSuppl: "var(--gosslan-primary-hover)",
    bodyColor: "var(--gosslan-bg)",
    cardColor: "var(--gosslan-panel)",
    modalColor: "var(--gosslan-panel)",
    popoverColor: "var(--gosslan-panel)",
    inputColor: "var(--gosslan-bg)",
    textColorBase: "var(--gosslan-text)",
    textColor1: "var(--gosslan-text)",
    textColor2: "var(--gosslan-text-2)",
    borderColor: "var(--gosslan-border)",
    dividerColor: "var(--gosslan-divider)",
    borderRadius: "var(--gosslan-radius-md)",
    fontFamily: "inherit",
    scrollbarColor: "var(--gosslan-os-thumb)",
    scrollbarColorHover: "var(--gosslan-os-thumb-hover)",
    scrollbarWidth: "16px",
    scrollbarHeight: "16px",
    scrollbarBorderRadius: "999px",
  },
  Scrollbar: {
    width: "16px",
    height: "16px",
    borderRadius: "999px",
    color: "var(--gosslan-os-thumb)",
    colorHover: "var(--gosslan-os-thumb-hover)",
  },
};
