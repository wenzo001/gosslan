/**
 * 「蓝牙为什么不可用」的**唯一**判据（纯函数，可单测）。
 *
 * 2026-10-29 审计 FUN-03：`available()` 恒 false 有两种完全不同的原因，而界面只显示一句
 * 「蓝牙后端尚未编译（当前版本暂不支持）」——
 * - **本次构建没编进去**（`--features bluetooth` 不是默认 feature）：只有自编译者会遇到；
 * - **硬件/系统层面不可用**（没有适配器、被系统或权限挡住）：发布包里遇到的都是这一类。
 *
 * 对绝大多数用户说"当前版本暂不支持"是错的（发布包一定带着蓝牙），反过来对自编译者说
 * "设备不支持"也是错的。两个原因分开说，各自的下一步动作才写得出来。
 */
export type BleUnavailableReason = "compiled-out" | "no-adapter" | null;

export function bleUnavailableReason(
  bt: { featureCompiled?: boolean; available?: boolean } | null | undefined,
): BleUnavailableReason {
  if (!bt || bt.available) return null;
  // 只有明确读到"没编进去"才这么说；读不到（旧后端/字段缺）按硬件原因处理 ——
  // 发布包里那条才是常见的那一类。
  return bt.featureCompiled === false ? "compiled-out" : "no-adapter";
}
