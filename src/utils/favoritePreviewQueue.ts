interface PreviewId {
  id: string;
}

export function favoritePreviewCandidates<T extends PreviewId>(
  rows: readonly T[],
  thumbs: Readonly<Record<string, string>>,
  seen: ReadonlySet<string>,
): T[] {
  return rows.filter((row) => !thumbs[row.id] && !seen.has(row.id));
}

/**
 * 筛选域切换时只清“还没发 IPC”的队列项；在途请求仍计在 inFlight 中，
 * 不能为了队列好看把并发计数假装归零。
 */
export function resetFavoritePreviewQueue<T extends PreviewId>(
  queue: readonly T[],
  seen: ReadonlySet<string>,
  inFlight: ReadonlySet<string>,
): { queue: T[]; seen: Set<string> } {
  const nextSeen = new Set(seen);
  for (const row of queue) {
    if (!inFlight.has(row.id)) nextSeen.delete(row.id);
  }
  return { queue: [], seen: nextSeen };
}
