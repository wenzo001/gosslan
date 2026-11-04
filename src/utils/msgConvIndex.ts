/**
 * `msg_id → conv_id` 反查表的纯核心（审计 2026-11-04）。
 *
 * 为什么单独成文件：`stores/chat/messaging.ts` 的运行时依赖都走 `@/` 别名，
 * `node --experimental-strip-types` 的单测解析不了；把这张表的容量逻辑挪成
 * 一个只依赖相对路径的纯模块，才能用真实计数验证"超上界就淘汰"。
 *
 * 语义：`msg_id` 全局唯一且消息不换会话，所以条目本身不受消息内容变化影响；
 * 但**条目的生命周期必须封顶**——会话缓存是整块逐出的（`MAX_CACHED_CONVS`），
 * 逐出后反向表里这些 id 没有任何删除点，不封顶就跟运行时长单调增长。
 */
import { trimOldest } from "./bounded.ts";

export interface MsgConvIndex {
  /** 当前条目数（探针/测试读它，生产代码不依赖）。 */
  readonly size: number;
  clear(): void;
  /** 把一整会话的 id 记进来，然后按插入序压回 `max`。 */
  remember(convId: string, list: ReadonlyArray<{ msg_id: string }>): void;
  get(msgId: string): string | null;
}

export function createMsgConvIndex(max: number): MsgConvIndex {
  const map = new Map<string, string>();
  return {
    get size() {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
    remember(convId: string, list: ReadonlyArray<{ msg_id: string }>): void {
      for (const m of list) map.set(m.msg_id, convId);
      trimOldest(map, max);
    },
    get(msgId: string): string | null {
      return map.get(msgId) ?? null;
    },
  };
}
