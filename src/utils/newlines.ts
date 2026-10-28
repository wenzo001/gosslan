/**
 * 换行计数 —— 三份逐字相同的私有实现收成一份（审计 P2 #36）。
 *
 * 消费者都是"把字符下标换回源码行号"的护栏（templateBranches / a11yLabels /
 * designGuards）：它们各自 `include_str!` 读同一批 .vue，行号一旦算错，报错会指到
 * 隔壁那行 —— 而三份副本没有理由，却各自可能被改坏。零依赖：Node 单测可直接 import。
 */
export function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}
