// 附件预览加载：把已完成的 image/code 文件读成前端可渲染形态。
//
// 图片走原始字节 → Blob → objectURL（绝不把 Base64 字符串塞进 Vue）；
// 代码走原始字节 → TextDecoder → 字符串交给 CodeBlock。
// 按 msg_id 缓存并做 in-flight 去重，避免 VirtualList 滚动反复读同一文件。

import { api } from "@/api";
import { previewFailureResult, type PreviewResult } from "@/utils/mediaAvailability";

export type { PreviewResult };

/** 代码预览上限：超过则回退文件卡片并提示，避免把巨大文件读进前端。 */
const CODE_MAX_BYTES = 512 * 1024;
/** 图片预览上限：远大于常见截图/照片，仍远低于协议 MAX_FRAME。 */
const IMAGE_MAX_BYTES = 15 * 1024 * 1024;

const cache = new Map<string, PreviewResult>();
const inflight = new Map<string, Promise<PreviewResult>>();

function imageMime(name: string): string {
  const ext = (name.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** 加载指定 file 消息的预览；失败/超限返回 `{}` 或 `{note}`，调用方据此回退文件卡片。 */
export function loadFilePreview(
  msgId: string,
  subtype: "image" | "code",
  name: string,
): Promise<PreviewResult> {
  const hit = cache.get(msgId);
  if (hit) return Promise.resolve(hit);
  const fly = inflight.get(msgId);
  if (fly) return fly;

  const max = subtype === "code" ? CODE_MAX_BYTES : IMAGE_MAX_BYTES;
  const p = (async (): Promise<PreviewResult> => {
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
        const r: PreviewResult = { url };
        cache.set(msgId, r);
        return r;
      }
      const r: PreviewResult = { text: new TextDecoder().decode(bytes) };
      cache.set(msgId, r);
      return r;
    } catch (e) {
      const msg = String(e);
      console.error(`[filePreview] ${subtype} preview failed (msgId=${msgId}, name=${name}): ${msg}`);
      const r: PreviewResult = previewFailureResult(msg);
      cache.set(msgId, r);
      return r;
    } finally {
      inflight.delete(msgId);
    }
  })();

  inflight.set(msgId, p);
  return p;
}
