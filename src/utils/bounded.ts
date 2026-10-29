/**
 * 按插入序淘汰的容量闸 —— 给"只加不删"的模块级集合兜底。
 *
 * ## 为什么需要它
 * store 与组件里有多张**模块生命周期**的 `Set` / `Map`：`pendingAcks`（等不到实体的 Ack
 * 就永久留着）、`notifMap`（用户直接划掉的通知永不回收）、`heightOverride`（每实测一条
 * 消息高度留一项）、预览缓存（值里还握着 objectURL）。它们的共同形状是"跟着使用时长单调
 * 增长"，而这类泄漏的表现非常晚才看得见 —— 不是崩，是几小时之后越用越卡、内存越吃越多。
 *
 * ## 为什么不各写一份
 * 仓里已经有正确先例（`utils/messageHeight.ts` 的 `*_MAX` + FIFO 淘汰、`useChatStore` 的
 * `recentInboundIds`），但每个新集合都得重写一遍淘汰循环 —— 而漏写的那一个正是本次审计
 * 抓到的那些。收在这里，加一道闸就是一次调用。
 *
 * ## 这里有两个策略，不是只有一个（DUP-13，2026-10-30 逐处定性）
 * `trimOldest`（丢最旧、热的留着）与 `clearWhenFull`（满了整张清）是**两件不同的事**，
 * 各自有一批调用点；把它们并成一个会真实改变"谁活着"。哪一个都不许被对方替换，
 * 新增集合时按"这张表里的条目还有没有独立生命"选一个，别抄隔壁的写法。
 * 明确**不属于**这个家的同形（判据按形状放行，别误收）：`utils/blobLru.ts` 的淘汰谓词是
 * **字节数**且带 `revoke(objectURL)` 副作用；`components/VirtualList.vue` 超上限是去
 * `measure()` 整体重测而不是删条目；`utils/messages.ts` 的 `selectCachedConversations`
 * 只"算出该留哪些"、并不拥有那个集合。
 *
 * ## 语义
 * `Map` / `Set` 的迭代顺序**就是插入顺序**（ECMAScript 规范保证），所以"从头部删到不超过
 * max"= FIFO 淘汰。注意这只对"插入后不再改动"的用法成立：`map.set(k, v)` 命中已有键
 * **不会**把它移到队尾，热用的老条目会先被淘汰。要 LRU 就在写入前自己 `delete(key)` 再 `set`
 * （`codeHighlight.ts` / `highlight.ts` / `groupSummaryCacheCore.ts` 就是这么做的：顺序由调用方
 * 维护，**丢东西这一步仍然只有这一个家**）；只写不读回来的集合直接调本函数就够了。
 */

/**
 * 把集合裁到 `max` 条以内（超出部分按插入序淘汰最旧的），返回被淘汰的条数。
 *
 * `max <= 0` 视为"不该留任何东西"，全部清空 —— 不静默忽略，因为传 0 通常是配置写错了，
 * 而静默不清等于这道闸根本不存在。
 */
export function trimOldest(
  coll: Map<unknown, unknown> | Set<unknown>,
  max: number,
): number {
  if (coll.size <= max) return 0;
  let dropped = 0;
  if (coll instanceof Map) {
    for (const k of coll.keys()) {
      if (coll.size <= Math.max(0, max)) break;
      coll.delete(k);
      dropped += 1;
    }
    return dropped;
  }
  for (const v of coll.values()) {
    if (coll.size <= Math.max(0, max)) break;
    coll.delete(v);
    dropped += 1;
  }
  return dropped;
}

/**
 * 第二种策略：**满了整张清**，返回是否清了（调用点基本用不到，留着给日志/测试）。
 *
 * ## 为什么这是另一个函数，而不是 `trimOldest` 的变体
 * 两者**丢的东西不一样**：`trimOldest` 丢最旧的几条、热的留着；`clearWhenFull` 把整张丢掉，
 * 包括刚要留下的那一类。对"按 key 重算得出"的纯缓存这是可接受的钝器（代价只是一次命中率断崖），
 * 而对"每条活着有意义"的集合就是行为变化 —— 所以**不许把已经用 `trimOldest` 的那五处换过来**，
 * 也不许反过来把这三处当成前者的写法。改动的判据是"这张表里的条目还有没有独立生命"。
 *
 * ## 判据为什么问在写入之前（`size >= max`）
 * 与这四处原本的写法逐字一致：先清再写 ⇒ 峰值容量正好是 `max`（清空后写入 1 条）。
 * 若挪到写入后再判，`clear()` 会连刚写的那条一起丢 ⇒ 缓存变成永远命中不了。
 *
 * `max <= 0` ⇒ 每次写入前都清（等价于"一条都不留"），与 `trimOldest` 同口径，不静默忽略。
 */
export function clearWhenFull(
  coll: Map<unknown, unknown> | Set<unknown>,
  max: number,
): boolean {
  if (coll.size < max) return false;
  coll.clear();
  return true;
}
