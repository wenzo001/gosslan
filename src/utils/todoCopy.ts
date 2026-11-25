/**
 * 「复制任务」按钮的正文口径（用户 2026-11-20 起：标题 + 空行 + 描述）。
 *
 * 2026-11-25 用户补充：**标题和描述一模一样时不要重复复制** —— 只复制标题。
 * 这段文本是要被直接拿去用的（粘贴到别处 / 交给工具），同一句话出现两遍
 * 既是噪声，也会让人误以为"下面那段是补充说明"。
 *
 * 比较用 `trim()` 之后的值：描述末尾多了个换行、标题前后多了空格，都算"一模一样"；
 * 但只要描述比标题多出任何正文（哪怕标题只是它的前缀），就仍然两段都复制 ——
 * 那是有信息量的，不能为了去重把内容砍掉。
 */
export function todoCopyText(title: string, description?: string | null): string {
  const desc = (description ?? "").trim();
  if (!desc) return title;
  if (desc === title.trim()) return title;
  return `${title}\n\n${desc}`;
}
