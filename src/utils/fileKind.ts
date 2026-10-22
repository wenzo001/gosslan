/**
 * 文件类型识别与配色 —— 文件气泡（MessageFileBubble）与群文件面板（GroupFilesPanel）
 * 共用的**唯一**判定点。
 *
 * 为什么不各自写一份 switch：同一次「这是个 PDF」的判断如果散在两处，
 * 面板把 pdf 显示成红色文档图标、气泡显示成别的，用户会以为是两种文件；
 * 加一个扩展名时也只改一处、不会漏改另一处（§32 一条清晰路径）。
 */
import type { Component } from "vue";
import { rgba } from "./color.ts";
import {
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from "lucide-vue-next";

export type FileKind =
  | "sheet"
  | "image"
  | "archive"
  | "video"
  | "audio"
  | "code"
  | "pdf"
  | "doc";

/** 文件类型配色：亮色取压得住白卡片的深调，暗色取能在深色卡片上跳出来的亮调。
 *  图标属图形而非文字，与卡片底色对比 ≥ 3 即达标（实测 3.9~5.2）。 */
export const FILE_KIND_COLORS: Record<FileKind, { light: string; dark: string }> = {
  sheet: { light: "#16a34a", dark: "#4ade80" },
  image: { light: "#a855f7", dark: "#c084fc" },
  archive: { light: "#d97706", dark: "#fbbf24" },
  video: { light: "#db2777", dark: "#f472b6" },
  audio: { light: "#0891b2", dark: "#22d3ee" },
  code: { light: "#2563eb", dark: "#60a5fa" },
  pdf: { light: "#dc2626", dark: "#f87171" },
  doc: { light: "#475569", dark: "#94a3b8" },
};

export const FILE_KIND_ICONS: Record<FileKind, Component> = {
  sheet: FileSpreadsheet,
  image: FileImage,
  archive: FileArchive,
  video: FileVideo,
  audio: FileAudio,
  code: FileCode,
  pdf: FileText,
  doc: FileText,
};

/** 文件扩展名（小写，无扩展名时为空串）。 */
export function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

/**
 * 安卓安装包：只有真正的 `.apk` 才交给系统安装器。
 *
 * 不要用 `includes("apk")` 之类的宽松判断：`a.apk.zip` 是压缩包，不是安装包。
 */
export function isApkName(name: string): boolean {
  return fileExt(name.trim()) === "apk";
}

/**
 * 文件角标文案：扩展名大写、**最多 4 个字符**，无扩展名回落到调用方给的那句「文件」。
 *
 * 三处角标（群文件面板 / 消息文件气泡 / 收藏详情）以前各写一遍这三行，漂移是真的：
 * 收藏那一处既不截断也不兜底 —— 一个没有扩展名的文件在那儿渲染成空串，
 * 后面跟着一个孤零零的「 · 大小」。收口到这里，`fallback` 由调用方传（本文件不碰 i18n）。
 */
export function extBadgeLabel(name: string, fallback: string): string {
  const e = fileExt(name);
  return e ? e.toUpperCase().slice(0, 4) : fallback;
}

/** 文件名 → 文件类型。未知扩展名归 `doc`（通用文档图标）。 */
/**
 * 文件类型徽标的强调色（图标色 + 12% 混底）。
 *
 * 为什么放在这个文件：群文件面板与收藏页各写过一份**逐字相同**的算法（取 light/dark 再混 12%），
 * 连 `0.12` 都是手抄的 —— 改一处另一处就漂，而漂了不报错，只是"同一类文件在两个页面颜色不同"。
 *
 * @param dark 当前主题（暗色取 `FILE_KIND_COLORS[kind].dark`）。
 */
export function fileKindStyle(
  name: string,
  dark: boolean,
): { backgroundColor: string; color: string } {
  const c = FILE_KIND_COLORS[fileKindOf(name)];
  const accent = dark ? c.dark : c.light;
  return { backgroundColor: rgba(accent, 0.12), color: accent };
}

export function fileKindOf(name: string): FileKind {
  switch (fileExt(name)) {
    case "xls":
    case "xlsx":
    case "csv":
    case "numbers":
      return "sheet";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
    case "svg":
    case "avif":
    case "heic":
      return "image";
    case "zip":
    case "rar":
    case "7z":
    case "tar":
    case "gz":
    case "bz2":
    case "xz":
    case "dmg":
    case "iso":
      return "archive";
    case "mp4":
    case "mov":
    case "avi":
    case "mkv":
    case "webm":
    case "flv":
    case "wmv":
      return "video";
    case "mp3":
    case "wav":
    case "flac":
    case "m4a":
    case "ogg":
    case "aac":
      return "audio";
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "rs":
    case "py":
    case "go":
    case "java":
    case "c":
    case "h":
    case "cpp":
    case "json":
    case "html":
    case "css":
    case "scss":
    case "vue":
    case "sh":
    case "bash":
    case "toml":
    case "yml":
    case "yaml":
    case "xml":
      return "code";
    case "pdf":
      return "pdf";
    default:
      return "doc";
  }
}
