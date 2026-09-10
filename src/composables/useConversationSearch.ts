import { computed, ref, watch, type Ref } from "vue";
import { api } from "@/api";
import type { Conversation, SearchResult } from "@/types";

/** 搜索防抖时长（ms）。 */
const DEBOUNCE_MS = 300;

/**
 * 会话列表搜索：名称匹配即时生效，消息内容匹配走后端 searchMessages（防抖 + 竞态保护）。
 * 同一时刻可能有多个在途请求，只接受最新一次的结果（seq 比对）。
 */
export function useConversationSearch(conversations: Ref<Conversation[]>) {
  const keyword = ref("");
  const results = ref<SearchResult[]>([]);
  const isSearching = ref(false);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  watch(keyword, (kw) => {
    if (timer) clearTimeout(timer);
    const trimmed = kw.trim();
    if (!trimmed) {
      results.value = [];
      isSearching.value = false;
      return;
    }
    isSearching.value = true;
    const mine = ++seq;
    timer = setTimeout(async () => {
      try {
        const r = await api.searchMessages(trimmed);
        if (mine === seq) results.value = r;
      } catch {
        if (mine === seq) results.value = [];
      }
      if (mine === seq) isSearching.value = false;
    }, DEBOUNCE_MS);
  });

  /** 名称匹配优先，其次补上内容命中的会话（去重）。 */
  const filtered = computed<Conversation[]>(() => {
    const kw = keyword.value.trim().toLowerCase();
    if (!kw) return conversations.value;
    const matchedIds = new Set(results.value.map((r) => r.conv_id));
    const out = conversations.value.filter((c) => c.name.toLowerCase().includes(kw));
    for (const c of conversations.value) {
      if (matchedIds.has(c.id) && !out.some((r) => r.id === c.id)) out.push(c);
    }
    return out;
  });

  /** 会话的搜索命中摘要：截取关键词前后的内容，过长加省略号。 */
  function snippet(convId: string): string | null {
    const r = results.value.find((x) => x.conv_id === convId);
    if (!r) return null;
    const kw = keyword.value.trim().toLowerCase();
    const content = r.match_content;
    const idx = content.toLowerCase().indexOf(kw);
    if (idx < 0) return content.slice(0, 60);
    const start = Math.max(0, idx - 20);
    const end = Math.min(content.length, idx + kw.length + 40);
    let s = content.slice(start, end);
    if (start > 0) s = "…" + s;
    if (end < content.length) s = s + "…";
    return s;
  }

  /** 命中消息的 msg_id —— 供"点进去直接跳到那一条"用；无命中返回 null。 */
  function hitMsgId(convId: string): string | null {
    return results.value.find((r) => r.conv_id === convId)?.match_msg_id ?? null;
  }

  return { keyword, results, isSearching, filtered, snippet, hitMsgId };
}
