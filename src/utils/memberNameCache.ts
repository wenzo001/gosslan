/**
 * 「这个人上次叫什么」的本机缓存（用户 2026-10-14：「任务列表操作记录名字同步，
 * 有时候还会显示设备名，会变」里"**会变**"那一半）。
 *
 * ## 为什么需要它
 * 群成员表只存 `device_id`（`db.rs` 的 `group_members`），全库**没有 peers 表** ——
 * 在线节点的昵称只活在内存里（`chat.peers` 来自 `get_peers`）。于是非好友的群成员：
 * 上线时显示他自报的昵称，重启/离线后查无此名，界面就退化成"未知成员 abcd"。
 * 同一个人的名字在两块屏、两个时刻不一样，这正是他说的"名字同步、会变"。
 *
 * ## 为什么放本机而不是协议/库里
 * 昵称是**对方自报的展示信息**，本仓那条立场写得很清楚（`protocol.rs` 里 roster 签名
 * 刻意不含 nickname：它随改名变化、纯属展示）。把它写进群成员表等于让一个可伪造的
 * 自报值变成持久身份；而"上次叫什么"本来就是每台设备各自的显示缓存 ⇒ 与
 * `announcementDismiss.ts` 同一立场：本机记录、不跟群同步、不参与任何信任判断。
 *
 * ## 失败方向
 * 读失败 ⇒ 空表（最坏是"这次显示成未知成员"）；写失败 ⇒ 静默吞掉。
 * **抛错绝不允许往上冒**：这个缓存挂在聊天 store 的 peers 刷新路径上，
 * 它炸了会让整个消息面板挂载失败（同 `announcementDismiss` 文件头那条教训）。
 */

export const MEMBER_NAME_CACHE_KEY = "gosslan.memberNames.v1";

/**
 * 上限。240 ≈ 一个网络里"可能见过名字"的人数上界再宽一档：
 * 这条记录只用于显示，丢了最坏退成"未知成员"，所以宁可裁旧也不要无界增长
 * （本仓对"只加不删"的账不止一次被审计点名）。
 */
export const MEMBER_NAME_CACHE_MAX = 240;

/** `device_id -> 最后一次见到的昵称`。键的插入顺序 = 新旧顺序（见到过就重插）。 */
export type MemberNameCache = Record<string, string>;

type KVStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** 缓存里一条记录需要的最小形状：id + 自报昵称（其余字段一概不关心）。 */
type NamedEntry = { device_id: string; nickname?: string | null };

/** 读整份缓存：存储不可用 / 脏数据 / 非对象 ⇒ 空表（见文件头那条失败方向）。 */
export function readMemberNames(store: KVStore | null): MemberNameCache {
  if (!store) return {};
  let raw: string | null = null;
  try {
    raw = store.getItem(MEMBER_NAME_CACHE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: MemberNameCache = {};
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      // 只收"非空字符串"这一种形状：旧版本写过的对象/数字/空串一律丢掉，
      // 不让脏值在渲染层再被当成一个名字。
      if (typeof name === "string" && name.trim()) out[id] = name;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 把这一批在线节点的名字并进缓存。
 *
 * **没有变化时返回 `null`**（而不是同一份对象的拷贝）：调用方据此跳过写盘。
 * `refreshPeers` 是周期性/事件性反复跑的，如果每次都返回新对象就会每次写一遍存储 ——
 * 那条"只加不删/无谓重渲染"的同族问题在 `peerMerge` 里已经修过一次，这里同一立场。
 */
export function observeMemberNames(
  cache: MemberNameCache,
  peers: readonly NamedEntry[],
): MemberNameCache | null {
  let changed = false;
  const next: MemberNameCache = { ...cache };
  for (const p of peers) {
    const name = (p.nickname ?? "").trim();
    // 空昵称不覆盖上一次见到的名字（对方改名中间态、或老对端不带昵称）。
    if (!p.device_id || !name) continue;
    // 重插到队尾 = 记为"最近见过"；超过上限时从队首裁最老的。
    const isFresh = next[p.device_id] !== name;
    const needsMove = Object.keys(next).length >= MEMBER_NAME_CACHE_MAX && !(p.device_id in next);
    if (!isFresh && !needsMove) continue;
    delete next[p.device_id];
    next[p.device_id] = name;
    changed = true;
    if (Object.keys(next).length > MEMBER_NAME_CACHE_MAX) {
      const oldest = Object.keys(next)[0];
      delete next[oldest];
      changed = true;
    }
  }
  return changed ? next : null;
}

/** 写盘。失败静默（这是显示缓存，不是状态真相）。 */
export function writeMemberNames(store: KVStore | null, cache: MemberNameCache): void {
  if (!store) return;
  try {
    store.setItem(MEMBER_NAME_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 隐私模式/配额满：下次刷新还会再试，不该把异常抛给 peers 刷新链路。
  }
}
