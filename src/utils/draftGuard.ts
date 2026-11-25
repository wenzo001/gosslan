/**
 * 「用户正在改的草稿」与「远端刚推来的值」谁说话算数（用户 2026-11-25）。
 *
 * 事故形状：群信息面板里给群名加了个 emoji、还没点保存；群里有人上线，
 * 后端推 `groups_updated` → store 刷新群列表 → 面板里那条
 * `watch(() => [open, group.name])` 触发（getter 每次都返回**新数组**，
 * 于是任何一次群列表刷新都会触发，哪怕名字一个字没变）→ 草稿被写回原名。
 * 同类还有群公告、机器人资料、本机昵称：只要「输入草稿由响应式源 watch 回填」，
 * 就都可能把用户正在打的字吞掉。
 *
 * 三条规则，顺序即优先级：
 *   1. `force`（刚打开面板 / 切了群 / 保存成功）⇒ 一律采纳远端；
 *   2. 草稿 === 基线（用户没动过）⇒ 跟随远端 —— 别人改了名字，界面上要看得到；
 *   3. 草稿 !== 基线（用户改过）⇒ **保留用户的输入**，只把基线前移到远端新值
 *      （基线跟着远端走，用户保存或被强制重置后仍然对得齐）。
 *
 * 这是纯函数：调用方自己持有 `draft` / `baseline` 两个 ref，把结果写回即可。
 */

export type DraftAdoptInput<T> = {
  /** 输入框里当前的值（用户可能已经改了一半）。 */
  draft: T;
  /** 上一次与远端对齐时的值；`draft !== baseline` 即"用户改过、还没保存"。 */
  baseline: T;
  /** 远端/响应式源刚落下来的权威值。 */
  remote: T;
  /** 强制采纳（打开面板、切换对象、保存成功）。 */
  force?: boolean;
};

export type DraftAdoptResult<T> = {
  /** 回填给输入框的值。 */
  draft: T;
  /** 新的基线。 */
  baseline: T;
  /** 是否采纳了远端值（false = 因为用户在编辑而保住了草稿）。 */
  adopted: boolean;
};

export function adoptRemoteDraft<T>({
  draft,
  baseline,
  remote,
  force = false,
}: DraftAdoptInput<T>): DraftAdoptResult<T> {
  if (force || Object.is(draft, baseline)) {
    return { draft: remote, baseline: remote, adopted: true };
  }
  // 用户在编辑：值不动，但基线要跟上远端 —— 否则"用户改回原样"和"远端又变一次"
  // 两件事会被误判成一直 dirty（保存按钮状态、下一次收敛都会偏）。
  return { draft, baseline: remote, adopted: false };
}

/** 草稿是否被用户改过（UI 用：脏标记 / 保存按钮状态）。 */
export function isDraftDirty<T>(draft: T, baseline: T): boolean {
  return !Object.is(draft, baseline);
}
