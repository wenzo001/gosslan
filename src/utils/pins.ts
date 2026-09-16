/**
 * 消息置顶的**折叠**（纯函数，便于单测）。
 *
 * 与表情回应同构：置顶在协议层是一条条独立事件（`kind = "pin"`），
 * 「当前置顶了哪些」是折叠出来的**派生态**，不是存下来的状态 ——
 * 因为 `message_id` 绑定了 payload，同一条业务消息不可能带不同 content 重发。
 *
 * 收敛：每个 `target` 是一个 LWW 寄存器（值 = 是否置顶），
 * 版本号用 `(seq, msg_id)` 元组。**不能只看 seq** —— 它是 Lamport 时钟，
 * 两端离线后各发一条都可能拿到同一个 seq，只看它会让不同副本算出不同结果。
 */
import type { MessageRecord } from "@/types";

/** 解析置顶载荷；畸形或非置顶消息返回 null（坏数据不打断渲染）。 */
export function parsePin(rec: MessageRecord): { target: string; pinned: boolean } | null {
  if (rec.kind !== "pin") return null;
  try {
    const p = JSON.parse(rec.content) as { target?: unknown; pinned?: unknown };
    if (typeof p?.target !== "string" || !p.target) return null;
    if (typeof p?.pinned !== "boolean") return null;
    return { target: p.target, pinned: p.pinned };
  } catch {
    return null;
  }
}

/**
 * 折叠出**当前被置顶的 msg_id 列表**，按置顶动作的版本序**从新到旧**排列
 * （最近置顶的排最前，与钉钉/飞书的置顶条一致）。
 */
export function foldPinned(records: MessageRecord[]): string[] {
  const latest = new Map<string, { seq: number; msgId: string; pinned: boolean }>();
  for (const rec of records) {
    const p = parsePin(rec);
    if (!p) continue;
    const cur = latest.get(p.target);
    const newer = !cur || rec.seq > cur.seq || (rec.seq === cur.seq && rec.msg_id > cur.msgId);
    if (newer) latest.set(p.target, { seq: rec.seq, msgId: rec.msg_id, pinned: p.pinned });
  }
  return [...latest.entries()]
    .filter(([, v]) => v.pinned)
    .sort((a, b) => b[1].seq - a[1].seq || (b[1].msgId > a[1].msgId ? 1 : -1))
    .map(([target]) => target);
}

/** 某条消息当前是否被置顶（用于菜单里显示「置顶」还是「取消置顶」）。 */
export function isPinned(records: MessageRecord[], msgId: string): boolean {
  return foldPinned(records).includes(msgId);
}
