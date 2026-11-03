/**
 * 消息通知标题的唯一口径（审计 2026-11-03 第 2 项）：群消息 = 「群名 · 发送者昵称」，
 * 单聊 = 发送者昵称。抽成纯函数是为了中英文环境都能测（名字本身不翻译，分隔符两语同形），
 * 也是为了让"群里收到却只显示昵称、看不出哪个群"这条真机抱怨只有一个家可以修。
 *
 * 群名拿不到（群已退/清单未加载）时**回落成发送者昵称**，不显示空群名或 `group:` 前缀 ——
 * 通知是用户第一眼看到的东西，宁可少一层信息也不许出现机器串。
 */
export function notifyTitle(
  convId: string,
  senderNickname: string,
  groupName: string | null | undefined,
): string {
  if (convId.startsWith("group:") && groupName && groupName.trim()) {
    return `${groupName} · ${senderNickname}`;
  }
  return senderNickname;
}
