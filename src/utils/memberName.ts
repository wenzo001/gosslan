/**
 * 「这个 device_id 该显示成什么名字」的唯一判据（纯函数，可在 Node 单测）。
 *
 * ## 为什么要单列一家（用户 2026-10-14：「任务列表操作记录名字同步，有时候还会显示设备名，会变」）
 * 原来有两份各写一遍的顺序：`useChatStore.nicknameOf()`（聊天正文 / @ / 回执条走它）和
 * `useMemberProfile.memberProfile().name`（群任务面板、详情弹窗、成员面板走它）。
 * 两者都是「自己 → 好友备注 → 在线自报 → 兜底」，但**兜底那一支不一样**：
 * 前者返回裸 `device_id`（界面上就是一串设备标识，正是他说的"显示设备名"），
 * 后者对自己返回 `t("common.me")`。同一个人、同一屏，两处可以不同形 ——
 * 这类"同一判据两个家"本仓已经吃过多次，这次连差异都写在注释里了（`useMentionContext.ts`）。
 *
 * ## 为什么做成纯函数
 * store 里要拿 Pinia 实例才能跑，真实渲染又要 WebView ⇒ 判据放进 store 就测不动。
 * 与 `utils/imageThumb.ts`（决策/执行分两册）同一手法：这里只判"该显示什么"，
 * 取数（查哪张表）留给调用方注入。
 *
 * ⚠️ 第五个来源（`snapshotNickname`）必须有**真实的写入点**才算存在：那份缓存由
 * `utils/memberNameCache.ts` 在 peers 刷新时写入并落本机存储。没有写入点的时候
 * 不许在这里摆一个空字段假装有——那是假字段（编译过、门禁绿、功能是零）。
 */

/** 取数由调用方给：每一项都是"这个 id 在这一层里查到的昵称"，`undefined`/空串 = 这层没有。 */
export type MemberNameSource = {
  /** 本机 device_id（用来认出"这是我"）。 */
  selfId: string;
  /** 本机昵称。 */
  selfNickname?: string | null;
  /** 好友表里的备注（本机给对方起的，最优先）。 */
  friendNickname?: string | null;
  /** 在线节点自报的昵称（只有对方此刻在线才有）。 */
  peerNickname?: string | null;
  /**
   * 本机最后一次见到的这个名字（`utils/memberNameCache` 那份缓存）。
   * 它管的正是"对方此刻不在线，也别把我的名字忘掉"这一格。
   */
  snapshotNickname?: string | null;
};

/** 兜底文案需要的两个词，由调用方从 i18n 传进来（这里不 import i18n，纯函数要能在 Node 跑）。 */
export type MemberNameText = {
  /** 「我」。 */
  me: string;
  /** 「未知成员」那一支的前缀。 */
  unknownMember: string;
};

/**
 * id 尾巴保留几位。与群任务编号那条「超过 4 位只显后四位」（INV-P29）同一审美口径，
 * 也让"未知成员 abcd"在一屏里不至于把布局撑开。
 */
export const MEMBER_ID_TAIL_LEN = 4;

/** 取 id 的后若干位（不足则原样）；只做**呈现**用，绝不当身份键。 */
export function memberIdTail(id: string): string {
  return id.length > MEMBER_ID_TAIL_LEN ? id.slice(-MEMBER_ID_TAIL_LEN) : id;
}

/** 空白/空串都不算"有名字"——对方自报一个空格昵称不该把兜底吃掉。 */
function present(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return s;
}

/**
 * 判出显示名。**永不返回裸 device_id**（这是这条改动存在的全部理由）。
 *
 * 顺序：本机自己 → 好友备注 → 在线自报 → 最后一次见到的名字 → 「未知成员 + id 后四位」。
 * 空 id 返回空串（调用方本来就靠这一点区分"没有发送者"）。
 */
export function resolveMemberName(id: string, src: MemberNameSource, text: MemberNameText): string {
  if (!id) return "";
  if (id === src.selfId) return present(src.selfNickname) || text.me;
  const alias = present(src.friendNickname);
  if (alias) return alias;
  const reported = present(src.peerNickname);
  if (reported) return reported;
  // 人不在线时别再问一遍"他是谁"：把上次见到的名字拿来用（"会变"的那一半就在这格）。
  const lastSeen = present(src.snapshotNickname);
  if (lastSeen) return lastSeen;
  return `${text.unknownMember} ${memberIdTail(id)}`;
}
