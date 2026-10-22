/**
 * motion-v 的**唯一入口**。业务组件不得直接 `import "motion-v"`：
 * - 升级 / 回滚只改这一处；
 * - 便于统一补 `useReducedMotion()` 分支与 SSR/测试替身；
 * - 设计护栏会扫 `from "motion-v"` 的直接引用（只允许本文件）。
 *
 * 使用边界（`docs/design-guidelines.md` §11.3.6）：
 * 只承担 CSS 做不到的三类 —— 共享元素转场、列表 FLIP 重排、手势驱动的连续动画。
 * 常规 hover/press/浮层/页面转场继续用 CSS 令牌。
 */
export {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useSpring,
  useTransform,
} from "motion-v";
