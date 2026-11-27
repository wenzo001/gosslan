export const REALTIME_REFRESH_MS = 150;

export interface TrailingRefresh {
  schedule: () => void;
  cancel: () => void;
}

/** 尾沿合并：突发 N 次只执行一次，取消不会伪造已完成。 */
export function createTrailingRefresh(run: () => void | Promise<void>): TrailingRefresh {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, REALTIME_REFRESH_MS);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
