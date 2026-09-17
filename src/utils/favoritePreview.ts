// 收藏**副本**的图片预览：按收藏 id 读字节 → Blob → objectURL。
//
// 为什么不复用 `utils/filePreview`：那条链路是按 `msg_id` 反查 `messages` 表里的 path
// （后端 `read_file_preview` / `media_present` 都以 msg_id 为入口）。而收藏恰恰要在
// **原消息被删、原文件被存储清理之后**仍然可用 —— 那时按 msg_id 已经找不到任何文件，
// 只有收藏自己的副本路径还有效。所以这里按收藏 id 走 `read_favorite_preview`。
//
// 缓存策略与 filePreview 完全一致（含"只缓存确定性失败"）：同一个面板反复滚动/开关，
// 不该每次都把图片从磁盘读一遍；而"仍在读取中"这类未知失败**不能**缓存，
// 否则用户永远看到失败态。

import { api } from "@/api";
import { imageMime } from "@/utils/filePreview";
import { previewFailureResult, type PreviewResult } from "@/utils/mediaAvailability";

export type { PreviewResult };

/** 图片预览上限：与消息预览同值，避免"气泡里能看、收藏里看不了"这种不一致。 */
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

const cache = new Map<string, PreviewResult>();
const inflight = new Map<string, Promise<PreviewResult>>();

/** 加载某个收藏副本的图片预览。失败/超限返回 `{note}`，调用方据此回退成文件卡片。 */
export function loadFavoritePreview(id: string, name: string): Promise<PreviewResult> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  const fly = inflight.get(id);
  if (fly) return fly;

  const p = (async (): Promise<PreviewResult> => {
    try {
      const raw = await api.readFavoritePreview(id, IMAGE_MAX_BYTES);
      // 后端 raw bytes 在 macOS(WKWebView) 上经 JSON 序列化回传为 number[]，
      // 其余平台是 ArrayBuffer。`new Uint8Array` 同时接受两者，一处归一
      // （直接 `new Blob([number[]])` 会把数组强转成 "137,80,…" 字符串，图片就坏了）。
      const bytes = new Uint8Array(raw);
      const r: PreviewResult = { url: URL.createObjectURL(new Blob([bytes], { type: imageMime(name) })) };
      cache.set(id, r);
      return r;
    } catch (e) {
      const msg = String(e);
      console.error(`[favoritePreview] 预览失败 (id=${id}, name=${name}): ${msg}`);
      const r = previewFailureResult(msg);
      // 只缓存确定性失败（副本已不在 / 文件过大）：未知失败缓存了会永久显示失败态。
      if (r.missing || r.note === "文件过大，无法预览") cache.set(id, r);
      return r;
    } finally {
      inflight.delete(id);
    }
  })();

  inflight.set(id, p);
  return p;
}

/**
 * 丢掉某条收藏的预览缓存，并**释放 objectURL**。
 *
 * 删除收藏时必须调用：objectURL 只要不 revoke 就一直占着那份字节的内存，
 * 用户删掉一张 10MB 的收藏图，内存不会自己还回来。
 */
export function dropFavoritePreview(id: string) {
  const hit = cache.get(id);
  if (hit?.url) URL.revokeObjectURL(hit.url);
  cache.delete(id);
  inflight.delete(id);
}
