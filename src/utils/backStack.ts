/**
 * 分层返回的**纯逻辑**（Android 系统返回键 / 桌面后退导航）。
 *
 * 与 `composables/useBackLayer.ts` 的分工：这里只管"层栈 + 历史条目计数"的决策，
 * 不碰 `window`/`history`——通过 `HistoryPort` 注入，于是可以在 `node:test` 里
 * 用假端口把每条边界的真值表钉住（真机上的返回键行为很难自动化验证）。
 *
 * 语义（每条都有测试）：
 * - 每压一层 → 压一条历史条目；返回键（`onPop`）= 只关**最上面**那层；
 * - UI 主动关闭栈顶那层 → 把对应历史条目**回退掉**（否则返回键要多按几次才有反应）；
 * - 但**只有端口真的退了**才减计数、才预吃 pop —— 端口会拒退（压入之后发生过导航，
 *   那条同 URL 条目已经是合法的"后退到上一级"目标，退掉它等于把刚推进的页面撤销）；
 * - UI 主动关闭**非栈顶**那层（少见）→ 只摘登记、保留条目，避免关错层；
 * - `onPop` 时没有层 → 什么都不做，交给系统（Android 上就是退出应用）；
 * - 端口压条目失败（自定义协议下 pushState 与 hash 都不可用）→ 记 0 条，返回键行为退化为现状；
 * - 端口用 hash 退化落点压条目 → **吃掉它自己引发的那次 pop**（否则刚压入的层立刻被关掉）。
 */

/** 历史操作端口：让纯逻辑与浏览器 API 解耦。 */
export interface HistoryPort {
  /**
   * 压一条同 URL 的历史条目，返回**落点**：
   * `"pushState"`（正常）/ `"hash"`（自定义协议下 pushState 抛错后的退化方案）/ `null`（失败，不压）。
   *
   * ⚠️ 为什么要把"怎么压的"告诉纯逻辑：退化的 `location.hash = …` **本身会触发一次 `popstate`**
   * （Chromium 实测：设置 hash 会同时触发 `hashchange` 与 `popstate`；两边都要听就会重复处理）。
   * 不告诉它就等于把"我们刚压的那一层"立刻当成"用户按了返回"关掉 —— 症状正是
   * 「弹窗一出现就消失 / 点了没反应」，而且**只在 pushState 不可用的平台**上出现。
   */
  push(state: unknown): "pushState" | "hash" | null;
  /**
   * 回退**这一层**压入的那条历史条目，返回**到底退没退**：
   * `true` = 条目已回退，随后会有一次 `popstate`（调用方要把那一次预吃掉）；
   * `false` = 端口拒绝退（见 `composables/useBackLayer.ts`：压入之后发生过导航，
   * 这条条目现在是合法的"后退到上一级"目标），**不会有任何 popstate**。
   *
   * ⚠️ 为什么要带 `layerId`：一个栈里可以同时开着多层（弹窗套灯箱）。端口必须知道
   * "现在要退的是哪一层的条目"，才能拿那一层压入时的 URL 与当前 URL 比 —— 只记"最后一次
   * 压入的 URL"会在第一层被拒退之后让第二层拿不到判据，退错条目。
   *
   * ⚠️ 为什么返回值要如实回报：无条件当成"退了"就会既减条目计数、又预吃一次 pop，
   * 于是用户下一次真按返回键被静默吞掉。用户 2026-10-23 报的「加好友页点发起聊天
   * 没反应、还停在通讯录」是同一处的另一面 —— 那次 `back()` 把刚推进的聊天页退掉了。
   */
  back(layerId: number): boolean;
}

interface Layer {
  id: number;
  close: () => void;
}

export interface BackStack {
  /** 压入一层；返回"释放"函数（UI 侧关闭时调用，幂等）。 */
  push(close: () => void): () => void;
  /** 收到 popstate：关掉最上面那层。返回是否处理了（false = 交给系统）。 */
  onPop(): boolean;
  /** 当前层数（诊断/测试用）。 */
  depth(): number;
  /** 当前已压入且未回退的历史条目数（诊断/测试用）。 */
  pushedCount(): number;
}

export function createBackStack(port: HistoryPort): BackStack {
  let stack: Layer[] = [];
  let seq = 0;
  let pushed = 0;
  /** UI 主动关闭时我们自己触发的 `back()` 会再抛一次 pop —— 吃掉那一次。 */
  let ignoreNextPop = false;

  return {
    push(close: () => void): () => void {
      const id = ++seq;
      stack.push({ id, close });
      const landed = port.push({ gosslanBackLayer: id });
      if (landed) pushed++;
      // ⚠️ 退化落点（hash）会**自己**引发一次 popstate，必须提前吃掉那一次 —— 否则它会把
      //    刚压入的这层立刻关掉（弹窗一出现就消失）。见 `HistoryPort.push` 的说明。
      if (landed === "hash") ignoreNextPop = true;
      let released = false;
      return () => {
        if (released) return; // 幂等：重复释放不能多退历史条目
        released = true;
        const wasTop = stack.length > 0 && stack[stack.length - 1].id === id;
        stack = stack.filter((l) => l.id !== id);
        if (wasTop && pushed > 0) {
          // 端口**拒绝**回退时（压入之后发生过导航，这条条目现在是合法的"后退到上一级"目标）：
          // 既不能减计数，也不能预吃一次 pop —— 根本没有 pop 会来。
          if (port.back(id)) {
            pushed--;
            ignoreNextPop = true;
          }
        }
      };
    },

    onPop(): boolean {
      if (ignoreNextPop) {
        ignoreNextPop = false;
        return true; // 是我们自己退条目引发的，已消费
      }
      if (pushed > 0) pushed--;
      const top = stack[stack.length - 1];
      if (!top) return false; // 没有层：交给系统（Android 退出应用）
      stack.pop();
      top.close();
      return true;
    },

    depth: () => stack.length,
    pushedCount: () => pushed,
  };
}
