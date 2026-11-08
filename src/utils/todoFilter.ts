/**
 * 群任务面板「打开时该选哪个标签」的判定（纯函数，唯一真源）。
 *
 * 用户 2026-11-08：标签顺序固定「全部 → 我的 → 我创建 → 已归档」，默认选「我的」；
 * 「我的」里一条都没有时落到「全部」；只在**打开时**判一次，用户手动切过之后不许再拉回。
 *
 * 为什么单独拎出来：判定有四个前提（面板开着、数据真到齐、还没判过、读没失败），
 * 写在组件 watcher 里时漏掉任何一个都只会表现为"选中态偶尔闪一下 / 偶尔不落回全部"，
 * 静默且难复现。这里把前提摊平成入参，组件只负责把真值填进来。
 */
export type TodoFilter = "all" | "mine" | "created" | "archived";

export interface DefaultFilterInput {
  /** 面板是否开着。关着时数据变化（同步、收到新任务）不许提前判定 —— 那不是"打开时"。 */
  open: boolean;
  /** 数据是否真到齐（`rowsState === ready`；加载中与读失败都不算）。 */
  dataReady: boolean;
  /**
   * 「我是谁」是否已知（`myId` 非空）。
   *
   * 缺这一条会把"身份还没读回来"当成"「我的」里一条都没有"：`isAssignedToMe` 对空 `myId`
   * 恒为 false ⇒ `mineCount = 0` ⇒ 一旦判过就锁在「全部」，之后身份到位也不再重判
   * （2026-11-09 用户在 5.20.0 发布版上看到的就是这个：默认没落在「我的」）。
   */
  selfKnown: boolean;
  /** 「我的」里的任务条数。 */
  mineCount: number;
  /** 本次打开是否已经判过（判过即锁，用户手动切过也不再被拉回）。 */
  settled: boolean;
}

/**
 * 返回应当落到的标签；`null` 表示"这次不改"（前提没满足，或已经判过）。
 *
 * ⚠️ `mineCount === 0` 才退回 `all`；「全部」也为空时不在这里判 —— 交给列表既有空态，
 * 否则会把"这次没数据"误当成"默认页签选错了"。
 */
export function decideDefaultFilter(i: DefaultFilterInput): TodoFilter | null {
  if (!i.open || !i.dataReady || !i.selfKnown || i.settled) return null;
  return i.mineCount === 0 ? "all" : "mine";
}
