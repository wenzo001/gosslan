// 全局浮层互斥注册表：同一时刻只允许一个浮层（消息右键菜单、好友右键菜单、
// 「已读成员」弹层、表情面板…）处于展开态。
//
// 为什么必须全局互斥：这类浮层原先各自维护展开状态，而右键触发的是 `contextmenu`、
// **不会触发 `click`**——于是"靠 document click 关闭"的浮层收不到通知，
// 先右键 A 再右键 B 就会出现两个菜单同时挂在屏幕上。
//
// 为什么放在 utils 且不引 vue：这段是纯状态机，可以在 `node --test` 下直接单测；
// vue 的 esm-bundler 构建在裸 node 里跑不起来（依赖 __VUE_OPTIONS_API__ 等打包期全局量），
// 所以响应式封装单独放在 `composables/useExclusivePopup.ts`。

type Listener = () => void;

let activeKey: string | null = null;
const listeners = new Set<Listener>();

/** 当前展开的浮层标识；`null` 表示当前没有任何浮层展开。 */
export function activePopupKey(): string | null {
  return activeKey;
}

/** 声明自己成为当前展开的浮层；其余已展开的浮层会收到通知并自行收起。 */
export function claimPopup(key: string): void {
  if (activeKey === key) return;
  activeKey = key;
  notify();
}

/** 释放：只有当前展开者是自己时才清空，避免把别人的展开态误清掉。 */
export function releasePopup(key: string): void {
  if (activeKey !== key) return;
  activeKey = null;
  notify();
}

/** 订阅展开态变化，返回取消订阅函数（组件卸载时调用）。 */
export function subscribePopup(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  // 复制一份再遍历：监听者可能在回调里退订
  for (const l of [...listeners]) l();
}
