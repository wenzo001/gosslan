// 附件预览加载：把已完成的 image/code 文件读成前端可渲染形态。
//
// 图片走原始字节 → Blob → objectURL（绝不把 Base64 字符串塞进 Vue）；
// 代码走原始字节 → TextDecoder → 字符串交给 CodeBlock。
// 按 msg_id 缓存并做 in-flight 去重，避免 VirtualList 滚动反复读同一文件。
//
// ⚠️ **objectURL 的生命周期归本模块的缓存所有，消费者不得 `revokeObjectURL`**
// （2026-09-21 的真根因）：同一个 cid/msg_id 的 URL 是**缓存里大家共用的同一个字符串**
// （一张待办描述图会同时出现在聊天时间线的任务卡、看板表单、任务详情三处）。
// 任何一处卸载/换图时 revoke，都会把其它视图的图一起打回裂图 —— 更糟的是缓存里那个 URL
// 已经死了却仍被命中（`cache.get` 直接返回它），此后连退避重试也救不回来，只能重启应用。
// 要回收内存请走缓存自己的出口（`blobLru` 的逐出 / `dropFilePreview` / `clearFilePreviews`），
// 不要由消费者就地 revoke。
//
// ## 容量：按**累计字节数**封顶，不按条数（2026-10-10 负责人决策 + N23 实测）
// 条数这个维度管不住内存：`IMAGE_PREVIEW_MAX_BYTES` 是**单条**上限，取 K 条的最坏情况是 K × 15 MiB。
// 实测（`docs/stability-roadmap.md` N23）又证了缓存条目的 V8 侧成本与喂进去的字节数无关
// （200 条只 +35 KB），大头那坨是 Blob 的外部内存 ⇒ 只能按字节封顶。
// **初始上限 60 MiB**：这是负责人 2026-10-10 一次答完五项里的原话（见 CHANGELOG 该日小节
// 「预览缓存按累计字节封顶初始 60 MiB」），管的就是**这一份内存缓存**，不是磁盘。
// 单条上限仍是 15 MiB（= `IMAGE_PREVIEW_MAX_BYTES`，与后端 `read_file_preview` 同一口径，有对账判据）。
// ⚠️ 别把它当成"磁盘预览缓存"的口径混用：磁盘侧的清理是另一套（存储清理），与此无关。
//
// ## 逐出会改变可观察行为
// 被逐出的图**要重读一次才出来**（这就是负责人点头时明知的取舍）。所以上限取 60 MiB
// 而不是更小：按单条 15 MiB 算，最坏情况也放得下 4 张大图，正常截图（百 KB 级）能放几百条。

import { api } from "@/api";
import { previewFailureResult, type PreviewResult } from "@/utils/mediaAvailability";
import { createBlobLru } from "@/utils/blobLru";
import { createSingleFlight } from "@/utils/singleFlight";
import { bubbleImageBytes } from "@/utils/imageThumbnail";
import { imageMime } from "@/utils/imageMime";

export type { PreviewResult };

/** 累计字节上限：60 MiB（负责人 2026-10-10 决策，见文件头）。 */
export const PREVIEW_CACHE_MAX_BYTES = 60 * 1024 * 1024;

/** 让某条消息的预览缓存失效（传输刚完成 / 文件刚落盘时调用）。
 *
 * 为什么必须有：收到的图片可能是"消息先到、字节后到"——在途时读预览只会得到
 * 「仍在接收」。若不让缓存失效，即使文件已经落盘，气泡也不会重读（真机：
 * 图片时好时坏，点几次/等一会儿/重发才出来）。
 *
 * ⚠️ **必须走 `cache.delete`（会 revoke）**，不能只把条目从 Map 里抹掉：
 * 后者正是 2026-09-21 到本次修复之间一直存在的**确定性泄漏** ——
 * 每次失效都丢掉最后一个指向那条 objectURL 的引用，而 Blob 那坨字节永不释放。
 */
export function invalidateFilePreview(msgId: string) {
  cache.delete(msgId);
  inflight.remove(msgId);
  clearNegative(msgId);
  clearNegative(`thumb:${msgId}`);
  // 缩略图那份也要一起失效：字节刚落盘时气泡拿的是缩略图，只让原图失效的话
  // 气泡会继续用"失效前那一份"（甚至是在途失败时留下的回退），表现为
  // "原图好了但气泡还是不出来" —— 正是这条失效机制当年要修的那个缺陷的缩略图版。
  dropThumbPreview(msgId);
}

/** 丢掉某条消息的预览缓存并释放 objectURL（删消息 / 清会话时调用）。 */
export function dropFilePreview(msgId: string) {
  cache.delete(msgId);
  inflight.remove(msgId);
  clearNegative(msgId);
}

/** 释放**全部**预览缓存（清空数据 / 退出登录这类入口调用）。 */
export function clearFilePreviews() {
  cache.clear();
  inflight.reset();
  negativeUntil.clear();
}

/** 代码预览上限：超过则回退文件卡片并提示，避免把巨大文件读进前端。 */
const CODE_MAX_BYTES = 512 * 1024;
/**
 * 图片预览上限：远大于常见截图/照片，仍远低于协议 MAX_FRAME。**这一族只有一个家** ——
 * 收藏预览（`favoritePreview.ts`）与合并转发卡片（`MergeCardModal.vue`）都从这里取，
 * 不再各抄一份 15 MiB。后端 `read_file_preview` / `read_favorite_preview` 的
 * `.min(15 * 1024 * 1024)` 与它同值，由 `imageBytes.test.ts` 现读两侧对账
 * ——「与后端同一口径」这句注释从此有机器凭据，不再只靠人眼。
 */
export const IMAGE_PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

/**
 * 两份预览共用的那条 LRU。
 *
 * 字节计量用「喂进去的原始字节数」而不是 `Blob.size`：后者在 Node 单测里不存在，
 * 而且这里要的是"这条占了多少内存"的**上界估计**，原始字节数正是那个上界
 * （objectURL 保住的就是这坨字节）。`bytes` 只在图片条目上给，代码预览与失败结果
 * 不带 url、按 0 字节计（`blobLru` 的 `weigh` 对无 url 条目返回 0）。
 */
const cache = createBlobLru<PreviewResult & { bytes?: number }>({
  maxBytes: PREVIEW_CACHE_MAX_BYTES,
  maxEntryBytes: IMAGE_PREVIEW_MAX_BYTES,
  revoke: (url) => URL.revokeObjectURL(url),
});

const inflight = createSingleFlight<PreviewResult>();

/**
 * 短暂的“负缓存”：同一张图/同一个 cid 在一次可恢复失败后，10 秒内不再打 IPC。
 *
 * 为什么需要：群历史恢复后时间线里可能一次出现几十条图片/文件消息，字节还没到齐时
 * 每条气泡都会按 400ms→… 退避重试；虚拟列表来回滚动还会把旧节点重新挂载。没有这层闸，
 * 一次缺文件会放大成几十条并发 IPC 与事件，正好是用户报的“事件爆炸”。
 *
 * 与 `cache` 的区别：这里只记“刚刚确定拿不到”，**不带 UI 结果**；文件落盘/重新同步时
 * `invalidateFilePreview` 会把它清掉，所以不会把“后来到了”的字节永久挡在门外。
 */
const NEGATIVE_TTL_MS = 10_000;
const NEGATIVE_MAX_ENTRIES = 2000;
const negativeUntil = new Map<string, number>();

function negativeBlocked(key: string): boolean {
  const until = negativeUntil.get(key);
  if (!until) return false;
  if (Date.now() < until) return true;
  negativeUntil.delete(key);
  return false;
}

function markNegative(key: string) {
  if (negativeUntil.size >= NEGATIVE_MAX_ENTRIES) negativeUntil.clear();
  negativeUntil.set(key, Date.now() + NEGATIVE_TTL_MS);
}

function clearNegative(key: string) {
  negativeUntil.delete(key);
}

/** 气泡缩略图缓存的字节上限。 */
const THUMB_CACHE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * **气泡缩略图**的独立缓存（与上面那份原图缓存分开，键前缀 `thumb:`）。
 *
 * ## 为什么不和原图共用一份
 * `ImageLightbox`（点大图那条路径）调的是**同一个** `loadFilePreview(msgId, "image", ...)`。
 * 如果把缩略图塞进那份缓存，点开大图看到的会是一张 416px 宽的糊图 ——
 * 这是用户明确要的"点大图仍清晰"的**反面**。所以两份分开：
 *   · `loadFilePreview`  = 原图（点大图用，也仍是气泡的**回退**）
 *   · `loadThumbPreview` = 缩略图（只服务 208px 的气泡）
 * 键加 `thumb:` 前缀只是为了让诊断时一眼分得清，真正的隔离靠两份独立的 LRU 实例。
 *
 * ## 容量
 * 缩略图都很小（一张约 10–40 KB，见 `imageThumb.THUMB_MIN_SOURCE_BYTES` 的取值理由），
 * 所以给它的额度可以小得多 —— 8 MiB 已经够放几百张。它是"看过的会话"的短命缓存，
 * 真正的长命缓存是原图那份。
 */
const thumbCache = createBlobLru<PreviewResult & { bytes?: number }>({
  maxBytes: THUMB_CACHE_MAX_BYTES,
  revoke: (url) => URL.revokeObjectURL(url),
});
const thumbInflight = createSingleFlight<PreviewResult>();

/**
 * 加载某条图片消息的**气泡缩略图**。
 *
 * 与 `loadFilePreview` 的关系：先照常读原图（走它那份缓存与在途去重），再试着压成
 * 缩略图。压不动（GIF / 小图 / 解码失败 / 环境没有 canvas）就**原样返回原图** ——
 * 这条路径永远给出可渲染的 `url`，与改造前行为一致。
 *
 * ⚠️ 为什么在**这里**压而不是在组件里：字节本来就在手上（刚读完），在这里压省掉
 * "把原图 objectURL 交给组件、组件再 fetch 回来解码"那一整趟；而且虚拟列表滚动时
 * 同一个 msgId 只会压一次（有缓存），不会每挂载一行就重压一遍。
 */
export function loadThumbPreview(msgId: string, name: string): Promise<PreviewResult> {
  const key = `thumb:${msgId}`;
  const hit = thumbCache.get(key);
  if (hit) return Promise.resolve(hit);

  return thumbInflight.run(key, async (): Promise<PreviewResult> => {
    const orig = await loadFilePreview(msgId, "image", name);
    // 原图都拿不到（在途/已清理/过大）：原样把失败态透传，气泡据此显示骨架或失败态。
    if (!orig.url) return orig;
    try {
      // 从 objectURL 取回字节再压。**必须**确认拿到的是这份原图的字节：
      // `loadFilePreview` 命中缓存时返回的是同一条，`fetch` 一个 blob: URL
      // 走的是进程内的反射，不再读磁盘。
      const raw = await (await fetch(orig.url)).arrayBuffer();
      const { bytes, mime, thumbnailed } = await bubbleImageBytes(new Uint8Array(raw), name);
      if (!thumbnailed) return orig;
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const r: PreviewResult & { bytes?: number } = { url, bytes: bytes.length };
      thumbCache.put(key, r);
      return r;
    } catch {
      // 任何一步失败都回退原图（`bubbleImageBytes` 自己已经兜了绝大多数，
      // 这里兜的是 fetch 那一步）。
      return orig;
    }
  });
}

/** 丢掉某条消息的缩略图缓存（原图失效时一并调用）。 */
export function dropThumbPreview(msgId: string) {
  thumbCache.delete(`thumb:${msgId}`);
  thumbInflight.remove(`thumb:${msgId}`);
}

/** 加载指定 file 消息的预览；失败/超限返回 `{}` 或 `{failure}`，调用方据此回退文件卡片并按词典键上屏。 */
export function loadFilePreview(
  msgId: string,
  subtype: "image" | "code",
  name: string,
): Promise<PreviewResult> {
  const hit = cache.get(msgId);
  if (hit) return Promise.resolve(hit);
  if (negativeBlocked(msgId)) return Promise.resolve({});

  const max = subtype === "code" ? CODE_MAX_BYTES : IMAGE_PREVIEW_MAX_BYTES;
  return inflight.run(msgId, async (): Promise<PreviewResult> => {
    try {
      const raw = await api.readFilePreview(msgId, max);
      // 后端 raw bytes 在 macOS(WKWebView) 上经 JSON 序列化回传为 number[]，
      // 其余平台是 ArrayBuffer。必须统一归一成字节再消费：
      //  - new Blob([number[]]) 会被强转成 "137,80,78,…" 字符串 → 图片损坏、无法预览；
      //  - new TextDecoder().decode(number[]) 直接抛 TypeError → 代码预览同样崩。
      // new Uint8Array 同时接受 ArrayBuffer 与 number[]（ArrayLike<number>），一处归一。
      const bytes = new Uint8Array(raw);
      if (subtype === "image") {
        const url = URL.createObjectURL(new Blob([bytes], { type: imageMime(name) }));
        // ⚠️ `bytes.length` 必须带上：不带的话这条按 0 字节计，上限就形同不存在
        // （本模块的整个封顶逻辑都挂在这个数上）。
        const r: PreviewResult & { bytes?: number } = { url, bytes: bytes.length };
        cache.put(msgId, r);
        clearNegative(msgId);
        return r;
      }
      const r: PreviewResult = { text: new TextDecoder().decode(bytes) };
      cache.put(msgId, r);
      clearNegative(msgId);
      return r;
    } catch (e) {
      const msg = String(e);
      console.error(`[filePreview] ${subtype} preview failed (msgId=${msgId}, name=${name}): ${msg}`);
      const r: PreviewResult = previewFailureResult(msg);
      // 只在**确定性**失败时缓存（已被清理 / 文件过大）。
      // "仍在接收"这类未知失败不进长期缓存，但进 10 秒负缓存挡住重试风暴；
      // 文件落盘时 `invalidateFilePreview` 会清掉它（真机 2026-09-14 的“要重发才出来”
      // 就是当时完全没有失效/负缓存边界造成的两个极端）。
      if (r.failure) cache.put(msgId, r);
      else markNegative(msgId);
      return r;
    }
  });
}

/** 按内容指纹（sha256）加载待办描述图片的预览。
 *
 * ⚠️ **失败不缓存**：待办图片的字节是「任务定义先到、文件后到」——
 * 看板在定义一到就渲染缩略图，此刻字节往往还没落地（读不到 → 报「内容不存在」）。
 * 若把这次失败按 cid 缓存，文件落盘后也不会重读（与聊天图片同源的坑，见 `loadFilePreview`）。
 * 每次调用都重新读；`TodoImageThumb` 负责用退避重试把"后到"的字节追回来。
 */
export function loadContentPreview(cid: string, name: string): Promise<PreviewResult> {
  const hit = cache.get(cid);
  if (hit) return Promise.resolve(hit);
  if (negativeBlocked(`content:${cid}`)) return Promise.resolve({});

  return inflight.run(cid, async (): Promise<PreviewResult> => {
    try {
      const raw = await api.readContentPreview(cid, IMAGE_PREVIEW_MAX_BYTES);
      const bytes = new Uint8Array(raw);
      const url = URL.createObjectURL(new Blob([bytes], { type: imageMime(name) }));
      const r: PreviewResult & { bytes?: number } = { url, bytes: bytes.length };
      cache.put(cid, r);
      clearNegative(`content:${cid}`);
      return r;
    } catch (e) {
      const msg = String(e);
      console.error(`[filePreview] content preview failed (cid=${cid}, name=${name}): ${msg}`);
      // 确定性失败（文件过大）可以缓存；「内容不存在/路径越权」是暂时态，
      // 不写长期缓存，但同样进 10 秒负缓存，避免群历史恢复时整屏图片一起重试。
      if (msg.includes("文件过大")) return { failure: "tooLarge" };
      markNegative(`content:${cid}`);
      return {};
    }
  });
}
