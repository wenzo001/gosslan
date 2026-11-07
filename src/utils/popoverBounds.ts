/**
 * 浮层贴边边界（唯一来源，2026-11-07）。
 *
 * 用户 2026-11-07 报「群任务的标签下拉，标签一多就顶出窗口，最下面的项点不到」，
 * 并要求**全站所有**「从触发器展开、内容可能变长」的浮层统一：
 * 最大高度 = 触发器到窗口可视边缘的可用空间，放不下就内部滚动，不裁切、不外溢。
 *
 * 落点分两层，缺一不可：
 * - **这里**只给 Reka 传 `collisionPadding`：floating-ui 用它扣掉安全边距，
 *   并据此写出 `--reka-popper-available-height`（各组件别名都指向这个变量）。
 * - **`style.css`** 的 `.gosslan-menu` / `.gosslan-pop-clamp` 读同一个变量做 `max-height`
 *   与内部滚动，并留 `100vh - 2 * POPOVER_EDGE` 的兜底。
 *
 * 不要把边界改成会滚动的祖先容器：那会让限高按容器而不是窗口算，
 * 容器被滚出可视区时弹层跟着"顶出去"。聊天区里的代码语言下拉是历史例外
 * （它有自己的运行时判据 `--only=langdd`，见 CodeLangMenu 注释）。
 */
export const POPOVER_EDGE = 8;

/** CSS 侧的 token 名，供不经过 Reka props 的自绘浮层在需要时读同一档。 */
export const POPOVER_EDGE_TOKEN = "--gosslan-pop-edge";

/**
 * 自绘 @成员下拉的高度上限（2026-11-07 审查 M-6：`max-h-44` 也收进本文件）。
 *
 * 它锚在输入卡**上方**（`bottom-full`），不能吃 `.gosslan-pop-clamp` 的
 * `100dvh` 兜底 —— 那会向上顶出窗口而不是内部滚动。固定 11 行 × 16px：
 * 足够看清候选，又不会盖住半屏消息。改这一档就改这里，别在组件里写 `max-h-44`。
 */
export const MENTION_POP_MAX_H = 176;
