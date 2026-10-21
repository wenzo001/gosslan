/**
 * 同一个键的异步任务只跑一次，其余调用共用同一份 Promise； settles 后自动摘除。
 *
 * 为什么单独成文件：消息原图、待办内容图、收藏图三处预览原来各抄一遍这六行
 * （`inflight.get` → 建 Promise → `finally` 里 delete → `inflight.set`）。
 * 手抄的风险在**摘除那一步**：谁漏抄 `finally`，那个键就把第一次的结果永久钉住 ——
 * 预览类的失败一旦钉住，字节落盘后也不会重读（真机 2026-10-14 那条「图片时好时坏」就是这个形状）。
 */
export interface SingleFlight<T> {
  /** 有在途的同键任务就复用它的 Promise；否则跑 `make` 并挂成在途。 */
  run(key: string, make: () => Promise<T>): Promise<T>;
  /** 主动摘除某个键（缓存失效 / 丢弃条目时必须一起调，否则在途那份会盖掉重读）。 */
  remove(key: string): void;
  /** 清空全部在途记录。 */
  reset(): void;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key, make) {
      const fly = inflight.get(key);
      if (fly) return fly;
      const p = (async () => {
        try {
          return await make();
        } finally {
          // 先摘再落：`make` 里若又发起同键任务，这里不该把它一起删掉。
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
    remove(key) {
      inflight.delete(key);
    },
    reset() {
      inflight.clear();
    },
  };
}
