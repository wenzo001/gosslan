/**
 * 文件类型识别与配色 —— 文件气泡（MessageFileBubble）与群文件面板（GroupFilesPanel）
 * 共用的**唯一**判定点。
 *
 * 为什么不各自写一份 switch：同一次「这是个 PDF」的判断如果散在两处，
 * 面板把 pdf 显示成红色文档图标、气泡显示成别的，用户会以为是两种文件；
 * 加一个扩展名时也只改一处、不会漏改另一处（§32 一条清晰路径）。
 */
import type { Component } from "vue";
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

/** 文件名 → 文件类型。未知扩展名归 `doc`（通用文档图标）。 */
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

/** 当前主题下的强调色（失败态由调用方自行改走红档）。 */
export function fileKindColor(name: string, dark: boolean): string {
  const c = FILE_KIND_COLORS[fileKindOf(name)];
  return dark ? c.dark : c.light;
}
