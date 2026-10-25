export {};

declare global {
  interface Window {
    /** 内联启动守卫捕到的第一个模块求值期异常。 */
    __gosslan_boot_error?: { kind: string; detail: string; at: number };
    /** 内联守卫的最后兜底错误卡（零依赖）。 */
    __gosslan_fail_boot?: (kind: string, detail: unknown) => void;
    /** 是否已经收到 `gosslan:app-ready`（防止错误卡在启动成功后误弹）。 */
    __gosslan_app_ready?: boolean;
    /** 是否已经显示过错误卡（避免内联兜底与 TS 版重复渲染）。 */
    __gosslan_boot_failed?: boolean;
  }
}
