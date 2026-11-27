interface KindMessage {
  msg_id: string;
  kind: string;
}

/** 在原数组中对齐可见消息；Ack 只替换目标行，其它行与总列表引用不动。 */
export function reconcileRenderedMessages<T extends KindMessage>(
  rendered: T[],
  source: readonly T[],
  isRendered: (row: T) => boolean,
): void {
  const next = source.filter(isRendered);
  if (rendered.length !== next.length) rendered.splice(0, rendered.length, ...next);
  else for (let i = 0; i < next.length; i += 1) rendered[i] = next[i];
}
