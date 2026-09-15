/**
 * 消息 kind 语义分类 —— **前端侧的唯一判定点**，与 Rust 的 `protocol::WIRE_KINDS`
 * 一一对应（`messageKinds.test.ts` 会读 `protocol.rs` 源码逐项比对，防止两边漂移）。
 *
 * 为什么前端也要有一份：消息落库、未读累计、通知、预览这些判定横跨 Rust/TS 两侧
 * （Rust 决定落库与 IPC，TS 决定渲染与通知）。这是 FFI 边界导致的**必要**重复，
 * 不是「第二套实现」——契约测试就是它的保险。
 */

export type KindClass = "bubble" | "silent" | "card";

/**
 * kind → 分类。
 *
 * **未知 kind 一律按 `bubble`**：与 Rust 侧回退到 `Bubble` 同语义 ——
 * 宁可多显示一条，也不要把不认识的内容静默吞掉（对端版本更新时不丢消息）。
 */
export function kindClass(kind: string): KindClass {
  if (SILENT_KINDS.includes(kind)) return "silent";
  if (CARD_KINDS.includes(kind)) return "card";
  return "bubble";
}

/** 静默事件：不进时间线、不计未读、不改预览、不弹通知。 */
export function isSilentKind(kind: string): boolean {
  return kindClass(kind) === "silent";
}

/**
 * 静默种类清单 —— **与 Rust 的 `WIRE_KINDS` 必须一致**，由契约测试锁死。
 * 这里显式列出（而不是从 `kindClass` 反推）是为了让测试能逐项比对。
 */
export const SILENT_KINDS: readonly string[] = ["reaction", "recall", "pin", "announcement_delete"];

/**
 * 群级沉淀物：**进时间线**（该计未读、该通知），但**不属于"聊天历史"** ——
 * 清空聊天记录不得删、清空边界不得拦。这两点是它与 bubble 的全部差别。
 */
export const CARD_KINDS: readonly string[] = ["announcement"];
