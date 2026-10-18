/** 字节数格式化：1024 进制；小于 1KB 用整数，KB/MB 一位小数，GB/TB 两位小数。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit >= 2 ? 2 : 1)} ${units[unit]}`;
}
