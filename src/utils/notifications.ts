/**
 * 系统通知正文（纯函数，便于单测）。
 *
 * 抽出来是因为它同时受「条数」和「显示正文隐私开关」两个维度影响，
 * 分支一旦写错（例如隐私开关只挡了单条、没挡多条）会在锁屏上泄内容。
 */

export interface NotificationBodyInput {
  /** 通知是否显示消息正文（隐私开关）。 */
  showContent: boolean;
  /** 本次要通知的消息条数（>1 表示合并提示）。 */
  count: number;
  /** 发送者昵称（仅 showContent 时用到）。 */
  sender: string;
  /** 单条消息的正文预览（仅 showContent && count === 1 时用到）。 */
  preview: string;
}

export function notificationBody(input: NotificationBodyInput): string {
  if (input.showContent) {
    return input.count > 1
      ? `${input.sender} 等 ${input.count} 条新消息`
      : input.preview;
  }
  // 隐私：关掉正文后只提示「收到新消息」，锁屏 / 通知中心不泄内容
  return input.count > 1 ? `你收到 ${input.count} 条新消息` : "你收到一条新消息";
}
