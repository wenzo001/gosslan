/**
 * 消息载荷解析结果的缓存（审计 P2 #27）。
 *
 * `msg_id` 绑定 payload（`SHA-256(sender_id + nonce + payload)`），同一条消息的 content
 * 在协议上**不可能变** ⇒ 解析结果就是它的纯函数，按 id 缓存永不陈旧。
 *
 * 为什么需要：reaction / pin / remind / todo 四个折叠函数在每批消息到达时**全量重扫**
 * 整个会话，每条每次都要 `JSON.parse` —— 1000 条的会话每来一条新消息就多 4000 次解析。
 * 缓存把"每条消息一生只解析一次"变成事实。
 *
 * ⚠️ 仍然要存一份 content：协议保证 id↔content 一一对应，但夹具/构造数据里同一个 id
 * 配不同 content 很常见（测试复用 `m1`），只认 id 会让第二次读到第一份的解析结果。
 * 比对用字符串全等（引擎对同一字符串常量是引用比较，命中时几乎零成本）。
 *
 * 只缓存**成功**解析：畸形载荷的失败在数据不变时也不会变好，缓存它只会多一层 `has()`。
 */
import { clearWhenFull } from "./bounded.ts";

export interface PayloadParseCache<T> {
  get(msgId: string, content: string): T | undefined;
  set(msgId: string, content: string, value: T): void;
}

/**
 * `max` 只是**内存上限**，不是正确性边界：满了整表清空（这是缓存不是事实源）。
 * 这道闸用 `utils/bounded.ts` 的 `clearWhenFull` —— 选"整张清"而不是 `trimOldest` 的理由
 * 写在那个文件里（id↔content 一一对应 ⇒ 每条都能重算，谁活着没有独立意义）。
 * 2000 条 ≈ 一屏会话的全部载荷，再大就把内存换成第二条 LRU 实现。
 */
export function createPayloadParseCache<T>(max = 2000): PayloadParseCache<T> {
  const map = new Map<string, { content: string; value: T }>();
  return {
    get: (msgId, content) => {
      const hit = map.get(msgId);
      return hit && hit.content === content ? hit.value : undefined;
    },
    set: (msgId, content, value) => {
      clearWhenFull(map, max);
      map.set(msgId, { content, value });
    },
  };
}
