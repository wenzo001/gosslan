/**
 * 无业务依赖的文本小工具。
 *
 * 为什么单独一个家（2026-11-13 组件复审 P2）：码点计数原先住在 `validation.ts`，
 * 而 `externalLinks.ts` 又手写了一遍 `[...s].length` —— 两处各数一次正是会漂的形状。
 * 把它抽到这个不 import 任何业务/schema 模块的叶子里，`validation` 与 `externalLinks`
 * 都调它；外链校验因此不必反向依赖整套 IPC validation 模块。
 */

/**
 * 长度口径的唯一实现：**Unicode 码点**（与 Rust 侧 `chars().count()` 同尺）。
 *
 * ⚠️ 不许在别处改写这一维：`.length` 数的是 UTF-16 单元，一个 emoji 算 2 ⇒
 * 与后端不同尺（同一串两边各数一次，报错的永远是"看起来更短"的那个）。
 * 输入框的计数器、schema 的判长、提示里的数字必须都走这里 —— 否则"上限 40"
 * 在三处分别是 40 / 20 / 40，而用户只看得见一个数字。
 *
 * 单一事实源由 `validation.test.ts` 的源码扫描守着：全仓生产码里 `[...x].length`
 * 只许出现在这一个函数里，别处再手写一遍即红。
 */
export function charCount(s: string): number {
  return [...s].length;
}