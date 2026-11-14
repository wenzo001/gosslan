/**
 * 按 key 的「读失败」登记原语（2026-11-13 功能闭环审计 P2 #33）。
 *
 * 治什么：保留旧值的查询，读失败时必须把「旧值可能过期」说出来 —— 错误登记是这句话的
 * 机器可读半边（UI 消费它画错误档 + 重试）。正对照是 `groupReadsErrors`：失败按 key
 * 记原因、成功只清自己的 key、各路失败互相独立（INV-P36：读失败 ≠ 没有数据，
 * 也 ≠ 别的 key 一起失败）。
 *
 * 两个函数都返回新对象（Vue ref 替换语义，不就地改写）；`withoutReadError` 在无标记
 * 可清时返回**原引用** —— 成功刷新是热路径，不该每次都触发一轮依赖更新。
 */
export type ReadErrorFlags = Record<string, string>;

/** 记下某个 key 的读失败原因（覆盖同 key 的旧原因；其余 key 原样保留）。 */
export function withReadError(flags: ReadErrorFlags, key: string, reason: string): ReadErrorFlags {
  return { ...flags, [key]: reason };
}

/** 清掉某个 key 的失败登记（成功路径）；没有登记时返回原引用。 */
export function withoutReadError(flags: ReadErrorFlags, key: string): ReadErrorFlags {
  if (!(key in flags)) return flags;
  const next = { ...flags };
  delete next[key];
  return next;
}
