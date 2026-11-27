export interface GroupFileActivity {
  group_id?: string;
  conv_id?: string;
}

export function groupFileActivityConvId(event: GroupFileActivity): string | null {
  if (event.conv_id?.startsWith("group:")) return event.conv_id;
  return event.group_id ? `group:${event.group_id}` : null;
}

/** 只有归属明确且等于当前群时才失效；无归属事件不再盲刷当前群。 */
export function groupFileActivityMatches(
  event: GroupFileActivity,
  currentGroupId: string | null,
): boolean {
  return !!currentGroupId && groupFileActivityConvId(event) === `group:${currentGroupId}`;
}
