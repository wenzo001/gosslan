/**
 * 乐观更新的并发安全回滚**编排**原语（2026-11-13 功能闭环审计 P2）。
 *
 * 与 `optimistic.ts` 的分工：那里是"判据的判据"（纯函数，不碰 state）；这里是把判据用起来
 * 的编排层——对当前态施加 forward/inverse。两者不重复：本文件不重写 settle/canRollback 那套。
 *
 * ## 治什么
 * 旧写法捕获整份旧快照（`const prev = list.value`），失败时 `list.value = prev`。
 * 若同一集合上另一项操作**先成功**、本操作**后失败**，整份恢复会把先成功的变更一起盖掉。
 *
 * ## 怎么治
 * 1. **按项逆操作**：回滚不恢复快照，而是对**当前态**施加本次改动的逆操作（`inverse`）。
 *    并发期间别的实体/字段的新事实因此得以保留。
 * 2. **generation 守卫**：权威刷新（后端 refresh）递增 generation；乐观操作开始时捕获它，
 *    晚到的失败若发现 generation 已前进（后端已收敛更新），则**跳过逆操作**——后端状态优先于
 *    晚到的失败结果（审计最佳实践 #3）。
 *
 * forward/inverse 的具体业务语义由各调用点提供；超时/错误类型仍是调用方决策。
 */

/** 每集合一个 generation 计数器：权威刷新时 `bump()`，乐观操作捕获 `value`。 */
export interface Generation {
  readonly value: number;
  bump(): void;
}

export function createGeneration(): Generation {
  let v = 0;
  return {
    get value() {
      return v;
    },
    bump() {
      v += 1;
    },
  };
}

/**
 * 先对当前态施加 `apply`（乐观上屏），再调 `call`；失败时对**当前态**施加 `inverse` 回滚。
 * 给了 `gen` 时：失败那一刻若 `gen.value` 已不同于捕获值（权威刷新已超越），跳过逆操作。
 * 错误照常上抛（调用方负责 toast）。成功不施加逆操作。
 */
export async function optimisticMutate<T, R>(
  state: { value: T },
  apply: (current: T) => T,
  inverse: (current: T) => T,
  call: () => Promise<R>,
  gen?: Generation,
): Promise<R> {
  const captured = gen?.value;
  state.value = apply(state.value);
  try {
    return await call();
  } catch (e) {
    if (gen === undefined || gen.value === captured) {
      state.value = inverse(state.value);
    }
    throw e;
  }
}