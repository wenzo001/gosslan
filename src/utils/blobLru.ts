// 按**累计字节数**封顶的 LRU —— 专给"值里握着 objectURL 的预览缓存"用。
//
// ## 为什么不是 `bounded.trimOldest`
// `utils/bounded.ts` 是**按条数**的 FIFO 闸，它文件头自己写明了这个边界（`:19`）：
// "将来若有人拿它保护会被反复覆盖的缓存，需要换成 LRU（get 时重插）"。
// 预览缓存恰好正是那一类，而且条数这个维度**管不住内存**：`IMAGE_PREVIEW_MAX_BYTES = 15 MiB`
// 是**单条**上限，取 K 条的最坏情况就是 K × 15 MiB（K=30 ⇒ 450 MiB）。
// 2026-10-10 的实测（docs/stability-roadmap.md N23）又补了另一半：缓存条目的 V8 侧成本
// 与喂进去的字节数**无关**（200 条只 +35 KB），大头那坨是 Blob 的外部内存，
// 所以"按条数封顶"连量都量不出意义 —— **要封顶只能按累计字节数**。
//
// ## 所有权：revoke 只归这一层
// `filePreview.ts` 文件头记着 2026-09-21 的真根因：同一个 cid/msg_id 的 objectURL 是
// **多视图共用的同一个字符串**（一张待办描述图会同时出现在任务卡、看板表单、任务详情），
// 任何消费者自行 `revokeObjectURL` 都会把别处的图一起打回裂图，而且缓存里那个死 URL
// 仍会被 `get` 命中、此后连重试都救不回来。⇒ 回收出口只有这里一个：
// **逐出 / delete / clear / 覆盖，四条路都 revoke**。
// （`invalidateFilePreview` 当年只 `cache.delete` 不 revoke，是确定性泄漏，本次一并修。）
//
// ## 可测性
// Node 里没有 DOM，`revoke` 与字节计量都**可注入**；纯账本逻辑与浏览器无关。

/** 一条缓存项至少要能被取出 url 与字节数。 */
export type BlobLruEntry = {
  /** 可 revoke 的 objectURL；纯失败/文本结果没有它。 */
  url?: string;
  /** 这条占多少字节；缺省按 0 计（失败结果、纯文本预览）。 */
  bytes?: number;
};

export type BlobLruOptions<T> = {
  /** 累计字节上限。非正数 ⇒ 一条都不留（不静默忽略，与 `trimOldest` 同口径）。 */
  maxBytes: number;
  /** 单条字节上限；**超过**（不是 ≥）则不入缓存。缺省不限。 */
  maxEntryBytes?: number;
  /** 释放一个 objectURL。浏览器里就是 `URL.revokeObjectURL`，测试里可注入。 */
  revoke: (url: string) => void;
  /** 自定义取 url。缺省读 `entry.url`。 */
  urlOf?: (value: T) => string | undefined;
  /** 自定义取字节。缺省读 `entry.bytes`。 */
  bytesOf?: (value: T) => number | undefined;
};

export type BlobLru<T> = {
  get(key: string): T | undefined;
  has(key: string): boolean;
  /** 放入一条。超单条上限 ⇒ 不入缓存且**不 revoke**（调用方还要用它）。 */
  put(key: string, value: T): void;
  /** 按 key 丢弃并 revoke；未命中是 no-op。 */
  delete(key: string): void;
  /** 全清并逐条 revoke。 */
  clear(): void;
  /** 当前缓存条数。 */
  size(): number;
  /** 当前累计字节数。 */
  bytes(): number;
};

/**
 * 建一个按累计字节封顶的 LRU。
 *
 * `Map` 的迭代顺序是插入序，但**`set` 命中已有键不会移到队尾** ⇒ 自己维护 LRU 序：
 * 命中 `get` 时先删再插（"重插到队尾"），这样 `keys()` 的第一项恒为最久未用。
 */
export function createBlobLru<T extends BlobLruEntry>(opts: BlobLruOptions<T>): BlobLru<T> {
  const { maxBytes, maxEntryBytes, revoke } = opts;
  const urlOf = opts.urlOf ?? ((v: T) => v.url);
  const bytesOf = opts.bytesOf ?? ((v: T) => v.bytes);

  const map = new Map<string, T>();
  /** 与 `map` 同步的累计字节账本（无 url 的条目按 0 计，不进这个数）。 */
  let total = 0;

  /** 这条占多少字节：没有 url 的条目一律 0 —— 没东西可 revoke，也就没东西占内存。 */
  const weigh = (v: T): number => {
    if (!urlOf(v)) return 0;
    const n = bytesOf(v);
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  };

  /** 摘掉一条并 revoke 它（唯一回收出口）。 */
  const drop = (key: string, value: T) => {
    map.delete(key);
    total -= weigh(value);
    const url = urlOf(value);
    if (url) revoke(url);
  };

  /** 从最久未用那头逐到不超上限为止。 */
  const enforce = () => {
    const cap = maxBytes > 0 ? maxBytes : 0;
    for (const key of map.keys()) {
      if (total <= cap) break;
      const value = map.get(key);
      if (value === undefined) continue;
      drop(key, value);
    }
  };

  return {
    get(key) {
      const hit = map.get(key);
      if (hit === undefined) return undefined;
      // 重插到队尾 = 标记为最近使用。
      map.delete(key);
      map.set(key, hit);
      return hit;
    },

    has(key) {
      return map.has(key);
    },

    put(key, value) {
      const w = weigh(value);
      // 两条拒收理由：① 自己声明了单条上限且超了；② 它**比整个累计上限还大** ——
      // 后者就算收下也会在 enforce 里被立刻逐出，而逐出是要 revoke 的。
      // ⚠️ 拒收时**一律不 revoke**：这条还没被缓存接管，url 仍归调用方所有。
      // 在这里 revoke 会把调用方手里那个正要拿去渲染的 url 当场弄死（裂图）。
      // 上限非正 ⇒ 夹到 0 ⇒ 任何有字节的条目都进不来（"一条都不留"），且不会被 revoke。
      const cap = maxBytes > 0 ? maxBytes : 0;
      const ceil = maxEntryBytes !== undefined ? Math.min(maxEntryBytes, cap) : cap;
      if (w > ceil) return;
      const prev = map.get(key);
      if (prev !== undefined) {
        // 覆盖：旧值要被换下去，先扣账再 revoke。
        map.delete(key);
        total -= weigh(prev);
        const prevUrl = urlOf(prev);
        if (prevUrl) revoke(prevUrl);
      }
      map.set(key, value);
      total += w;
      enforce();
    },

    delete(key) {
      const hit = map.get(key);
      if (hit === undefined) return;
      drop(key, hit);
    },

    clear() {
      for (const [key, value] of [...map.entries()]) drop(key, value);
    },

    size() {
      return map.size;
    },

    bytes() {
      return total;
    },
  };
}
