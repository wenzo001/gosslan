/**
 * 全局「正在传输」面板的纯计算（UI 审计 D-18 的界面那一半）。
 *
 * 为什么单独抽出来：气泡侧 `useMessageFile` 只按 id 取**一条**，而全局面板要的是
 * 「所有还在动的行」的聚合。这份口径如果写在组件里，`npm test` 就钉不住它
 * （本仓的组件测试不跑 DOM）⇒ "聚合进度算错"只会在真机上被看见。
 *
 * 状态分类复用 `transferState.transferDisplayKind`，不另立第二份状态表：
 * 后端加一态只改 `STATUS_KINDS` 一处，这里跟着走。
 */
import { transferDisplayKind } from "./transferState.ts";

/** 面板只需要这三个字段；`TransferInfo` 结构上满足它（测试不必造整行）。 */
export interface TransferLike {
  status: string;
  size?: number;
  progress?: number;
}

/**
 * 把进度夹回 0..1。
 *
 * 后端给的是 f64，越界不是不可能（续传时先写了半块再回填）。界面不能因为一个
 * 越界值画出 140% 的条，也不能让 `NaN` 把聚合除成 `NaN`。
 */
export function clampProgress(value: number | undefined | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * 还在动：`active`（真在传）与 `queued`（排着）。
 *
 * ⚠️ 终态一个都不算 —— 包括 `done`/`sent`。审计里那条抱怨的原话是
 * 「切到别的会话就完全看不到那个文件还在传」，所以药丸只在**还有事在做**时出现；
 * 传完之后留一个悬浮块反而是噪声（气泡里已经有结果）。
 */
export function isLiveTransfer(status: string): boolean {
  const kind = transferDisplayKind(status);
  return kind === "active" || kind === "queued";
}

export function liveTransfers<T extends TransferLike>(list: readonly T[]): T[] {
  return list.filter((item) => isLiveTransfer(item.status));
}

/**
 * 面板里的行序：**真在传的排前面**，同档按进度从多到少。
 *
 * 不按文件名/时间排：用户点开面板是为了看「哪个快好了、哪个卡着」，
 * 把已经 99% 的那条压在三行排队后面等于让他自己找。
 */
export function sortLiveTransfers<T extends TransferLike>(list: readonly T[]): T[] {
  const rank = (item: T) => (transferDisplayKind(item.status) === "active" ? 0 : 1);
  return [...list].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return clampProgress(b.progress) - clampProgress(a.progress);
  });
}

/**
 * 聚合进度：**按字节加权**，不是按条数平均。
 *
 * 一个 2GB 的视频传到 50% + 一张 20KB 的图排队，条数平均会说 25%，
 * 而用户真正在等的是那个视频。大小未知（后端还没拿到 total）按 1 计：
 * 既避开除零，也不让"未知"支配总数。
 */
export function aggregateTransferProgress(list: readonly TransferLike[]): {
  count: number;
  percent: number;
} {
  const live = liveTransfers(list);
  if (live.length === 0) return { count: 0, percent: 0 };
  let total = 0;
  let done = 0;
  for (const item of live) {
    const size = typeof item.size === "number" && Number.isFinite(item.size) && item.size > 0
      ? item.size
      : 1;
    total += size;
    done += size * clampProgress(item.progress);
  }
  // `total` 不可能是 0（每个 item 至少贡献 1），但仍然不用 `|| 1` 兜底：
  // 那会把"算法坏了"伪装成"0%"。
  return { count: live.length, percent: Math.round((done / total) * 100) };
}
