/**
 * 每会话输入草稿（内存镜像 + `localStorage` 落盘）。
 *
 * 为什么落盘（用户 2026-11-04 硬要求）：渲染层停摆时自愈会 `reload` 主窗口，reload 会
 * 清空 JS 内存 —— 只有内存 Map 的话草稿会一起消失。落盘后 reload 回来还能填回，
 * 这是"可恢复"的底线。
 *
 * 为什么**按输入事件同步写**、不用定时器：渲染层一旦冻住，定时器回调正好不会跑，
 * 最后几百毫秒的输入就丢了。输入事件是同步的，事件到手立刻写。
 *
 * 键按会话区分（`gosslan.composer.draft.<convId>`），读回时**再校验一次会话**：
 * payload 里的 `convId` 必须与请求的一致，否则当作没有 —— 防止串到别的会话。
 *
 * 存 `innerHTML` 而不是 `innerText`：@提及 与表情都是 `contentEditable=false` 的
 * 原子 token，innerText 会丢掉 token 的 `data-mention-id`，恢复后变成普通文字。
 * 内容唯一的写入方是编辑器自己（粘贴已 preventDefault，不落外部 HTML），
 * 白名单重建在**恢复**时做一次（见 `MessageComposer.restoreDraft`）。
 */
import { trimOldest } from "./bounded.ts";
import { safeStorageBackend, type StorageLike } from "./safeStorage.ts";

const drafts = new Map<string, string>();
const MAX_DRAFTS = 100;

/** `localStorage` 里最多保留多少个会话的草稿（超出按"最近写过"淘汰，防 5 MB 配额吃满）。 */
const PERSIST_MAX = 20;
const PAYLOAD_V = 1;

export const DRAFT_PREFIX = "gosslan.composer.draft.";
export const DRAFT_INDEX_KEY = "gosslan.composer.drafts";

/** 只要求 Web Storage 的三个方法：测试可以传一个最小假存储。 */
export type DraftStore = StorageLike;

interface DraftPayload {
  v: number;
  convId: string;
  html: string;
  at: number;
}

/**
 * 默认后端走 `safeStorage` 那个家（§6.80/§6.81）：生产码里只有它允许摸 `localStorage`。
 * 隐私模式/被禁用/配额满时它只吞成 `null`/`false`，不会把输入打断。
 */
function resolve(store?: DraftStore | null): DraftStore | null {
  return store === undefined ? safeStorageBackend : store;
}

function readIndex(store: DraftStore): string[] {
  try {
    const raw = store.getItem(DRAFT_INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(store: DraftStore, ids: string[]): void {
  try {
    store.setItem(DRAFT_INDEX_KEY, JSON.stringify(ids));
  } catch {
    // 配额满时索引写不进去：草稿本身可能已经写进去了，读回不依赖索引（按 key 直读）。
  }
}

/** 记一次"最近写过"并淘汰超出上限的会话（只淘汰 localStorage 副本，内存 Map 不动）。 */
function touchIndex(store: DraftStore, convId: string): void {
  const current = readIndex(store);
  // 已经是"最近写过"的那一条 ⇒ 索引没变化，省一次 JSON 写（每个按键都会走这里）。
  if (current[current.length - 1] === convId) return;
  const ids = current.filter((id) => id !== convId);
  ids.push(convId);
  while (ids.length > PERSIST_MAX) {
    const evicted = ids.shift();
    if (evicted) {
      try {
        store.removeItem(DRAFT_PREFIX + evicted);
      } catch {
        // 淘汰失败只影响配额，不影响正确性。
      }
    }
  }
  writeIndex(store, ids);
}

function drop(store: DraftStore, convId: string): void {
  try {
    store.removeItem(DRAFT_PREFIX + convId);
  } catch {
    // 见上：删不掉只会多占一点配额。
  }
  writeIndex(
    store,
    readIndex(store).filter((id) => id !== convId),
  );
}

/**
 * 落盘一条草稿。空内容 = 删除（用户把输入框清空后，reload 不该再填回旧文字）。
 *
 * 调用方（`MessageComposer`）在**每次 input 事件**里同步调用它，不经过任何定时器。
 */
export function saveComposerDraft(
  convId: string | null | undefined,
  html: string,
  store?: DraftStore | null,
): void {
  if (!convId) return;
  if (!html.trim()) {
    drafts.delete(convId);
    const st = resolve(store);
    if (st) drop(st, convId);
    return;
  }
  // 重新插入到末尾，让"最近写过"的会话排在后面（淘汰顺序更合理）。
  drafts.delete(convId);
  drafts.set(convId, html);
  trimOldest(drafts, MAX_DRAFTS);
  const st = resolve(store);
  if (!st) return;
  const payload: DraftPayload = { v: PAYLOAD_V, convId, html, at: Date.now() };
  try {
    st.setItem(DRAFT_PREFIX + convId, JSON.stringify(payload));
  } catch {
    // 配额满/隐私模式：内存态仍在，本会话不丢；落盘能力缺失只影响 reload 后的恢复。
    return;
  }
  touchIndex(st, convId);
}

/** 读回草稿。内存命中优先，其次 `localStorage`；**会话不一致或空内容一律当没有**。 */
export function getComposerDraft(
  convId: string | null | undefined,
  store?: DraftStore | null,
): string {
  if (!convId) return "";
  const mem = drafts.get(convId);
  if (mem !== undefined) return mem;
  const st = resolve(store);
  if (!st) return "";
  let raw: string | null;
  try {
    raw = st.getItem(DRAFT_PREFIX + convId);
  } catch {
    return "";
  }
  if (!raw) return "";
  try {
    const p = JSON.parse(raw) as Partial<DraftPayload> | null;
    if (
      !p ||
      p.v !== PAYLOAD_V ||
      p.convId !== convId ||
      typeof p.html !== "string" ||
      !p.html.trim()
    ) {
      // 旧格式 / 被改过 / 串了会话：清掉，绝不填回。
      drop(st, convId);
      return "";
    }
    drafts.set(convId, p.html);
    return p.html;
  } catch {
    // 坏 JSON 同样清掉（留着只会在下一次读回时继续报错）。
    drop(st, convId);
    return "";
  }
}

export function clearComposerDraft(
  convId: string | null | undefined,
  store?: DraftStore | null,
): void {
  if (!convId) return;
  drafts.delete(convId);
  const st = resolve(store);
  if (st) drop(st, convId);
}
