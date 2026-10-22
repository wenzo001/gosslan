/**
 * 每会话输入草稿（内存态）。
 *
 * 为什么不是 store：草稿是**单窗口内、单输入框**的视图状态；不需要跨窗口共享，
 * 也不适合进 SQLite（重启后用户预期多半是回到干净的输入框）。放在模块级 Map 里，
 * 切换会话/切 tab 时不丢，刷新即清。
 *
 * 存 `innerHTML` 而不是 `innerText`：@提及 与表情都是 `contentEditable=false` 的
 * 原子 token，innerText 会丢掉 token 的 `data-mention-id`，恢复后变成普通文字。
 * 内容唯一的写入方是编辑器自己（粘贴已 preventDefault，不落外部 HTML）。
 */
const drafts = new Map<string, string>();
const MAX_DRAFTS = 100;

function trimOldest() {
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) return;
    drafts.delete(oldest);
  }
}

export function saveComposerDraft(convId: string | null | undefined, html: string): void {
  if (!convId) return;
  if (!html.trim()) {
    drafts.delete(convId);
    return;
  }
  // 重新插入到末尾，让"最近写过"的会话排在后面（淘汰顺序更合理）。
  drafts.delete(convId);
  drafts.set(convId, html);
  trimOldest();
}

export function getComposerDraft(convId: string | null | undefined): string {
  if (!convId) return "";
  return drafts.get(convId) ?? "";
}

export function clearComposerDraft(convId: string | null | undefined): void {
  if (convId) drafts.delete(convId);
}

/** 诊断/测试用：当前草稿条数。 */
export function composerDraftCount(): number {
  return drafts.size;
}
