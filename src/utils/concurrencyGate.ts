/**
 * 极小的并发闸：最多 N 个任务同时在飞，其余排队。
 *
 * 为什么单独成模块（审计 P1 #18）：聊天侧附件预览没有任何并发上限 —— 首屏挂载
 * 10–30 个 `MessageItem`，每个都带 `useMessageFile` 的 `immediate` watch ⇒ 30 条
 * `read_file_preview` 同时进来，而单条最多 15 MiB（macOS WKWebView 还要按 number[]
 * 序列化回传）。收藏页早就有 `PREVIEW_CONCURRENCY = 3` 的闸，聊天侧没有 ⇒ 两套口径。
 *
 * 语义刻意最简单：**入闸与出闸对称**，任务抛错也释放槽位；排队者按 FIFO 依次拿到
 * 别人刚腾出的槽位（释放时直接把槽位交给队首，计数不变）。
 */
export function createGate(max: number) {
  if (!Number.isInteger(max) || max < 1) throw new Error(`并发上限必须是正整数：${max}`);
  let inUse = 0;
  const waiters: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (inUse < max) {
      inUse++;
    } else {
      await new Promise<void>((resolve) => waiters.push(resolve));
      // 队首被唤醒时，槽位已经由释放者直接转交 ⇒ 这里不再 ++。
    }
    try {
      return await task();
    } finally {
      const next = waiters.shift();
      if (next) next();
      else inUse--;
    }
  };
}
