import type { PreviewGallery, PreviewImage } from "@/types";

/**
 * 独立预览窗口的相册加载状态。**为什么是纯 reducer**：
 * 这个窗口只有 IPC 一条数据源，失败/空相册/超时都曾静默留一个空白窗（2026-10-18 盘点），
 * 状态迁移写成纯函数才能在没有 DOM 地基的仓里被 node --test 直接钉住。
 */
export type PreviewGalleryStatus = "loading" | "ready" | "empty" | "error";

export interface PreviewGalleryView {
  status: PreviewGalleryStatus;
  images: PreviewImage[];
  index: number;
  error: string;
}

export type PreviewGalleryEvent =
  | { kind: "begin" }
  | { kind: "loaded"; gallery: PreviewGallery }
  | { kind: "failed"; message: string }
  | { kind: "released" };

export const INITIAL_PREVIEW_VIEW: PreviewGalleryView = {
  status: "loading",
  images: [],
  index: 0,
  error: "",
};

export function reducePreviewGallery(
  state: PreviewGalleryView,
  event: PreviewGalleryEvent,
): PreviewGalleryView {
  switch (event.kind) {
    case "begin":
      // 已有内容时不清空：重开窗口先看上一条，等新相册到了再替换。
      return state.images.length > 0
        ? { ...state, status: "ready", error: "" }
        : { ...state, status: "loading", error: "" };
    case "loaded": {
      const items = event.gallery.items;
      if (items.length === 0) {
        return { status: "empty", images: [], index: 0, error: "" };
      }
      return {
        status: "ready",
        images: items.slice(),
        index: Math.min(Math.max(event.gallery.index ?? 0, 0), items.length - 1),
        error: "",
      };
    }
    case "failed":
      // 有旧内容就保留，失败只作为附带信息；没有内容才进入错误态。
      return state.images.length > 0
        ? { ...state, status: "ready", error: event.message }
        : { status: "error", images: [], index: 0, error: event.message };
    case "released":
      return { ...INITIAL_PREVIEW_VIEW };
  }
}

export const PREVIEW_PULL_TIMEOUT_MS = 8000;

/** 给一次 IPC 取数加超时；超时后迟到的结果由调用方的代次号丢弃。 */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
