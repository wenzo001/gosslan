import { ref } from "vue";

/**
 * 提交防重：双击、回车与失焦重入都只会放行一次。
 *
 * 这不是通用表单框架 —— 项目里的提交逻辑仍留在各自业务组件，只有"同一时刻
 * 只允许一个在途提交"这一条被抽出来（GroupCreateModal / ProfileSection 共用）。
 * `busy` 可直接绑到按钮 disabled；`run` 在已有在途提交时返回 undefined。
 */
export function useSubmitGuard() {
  const busy = ref(false);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (busy.value) return undefined;
    busy.value = true;
    try {
      return await fn();
    } finally {
      busy.value = false;
    }
  }

  return { busy, run };
}
