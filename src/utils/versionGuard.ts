/**
 * 前端构建版本 vs 后端 `APP_VERSION` 的启动对账。
 *
 * 为什么需要：安装器替换磁盘上的 `gosslan.exe` 时，如果旧进程还在跑，双击图标可能只是
 * 把旧进程唤到前台（单实例），用户继续用的是一个“内存里的旧构建”。正式包的资源虽然
 * 内嵌在 exe 里、同一个进程内前后端不会真的错配，但旧进程/半退出状态会表现为设置窗口
 * 塌成面板、日志窗口创建失败等。这里只做**不误报**的兜底：两版一致什么都不做，
 * 不一致才提示“完全退出后重新打开”。
 *
 * 判据：
 * - 两值都拿得到且规范化后不相等 ⇒ 错配；
 * - 任一值缺失/空白 ⇒ **不报**（拿不到后端版本时宁可沉默，也不把网络/权限抖动当错配）；
 * - 允许 `v5.17.2` 与 `5.17.2` 这类前缀差异（安装器/关于页的口径不同）。
 */
export interface VersionMismatch {
  frontend: string;
  backend: string;
}

function normalizeVersion(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/^v/i, "").trim();
  return s.length > 0 ? s : null;
}

export function detectVersionMismatch(
  frontend: string | null | undefined,
  backend: string | null | undefined,
): VersionMismatch | null {
  const f = normalizeVersion(frontend);
  const b = normalizeVersion(backend);
  if (f === null || b === null) return null;
  return f === b ? null : { frontend: f, backend: b };
}
