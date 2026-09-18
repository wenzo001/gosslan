// 合并转发（微信式「聊天记录」卡片）的**纯函数部分**：载荷构建、解析、摘要、标题。
//
// 为什么单独成文件：这些判据（能解析吗、几条、标题怎么拼、每行摘要写什么）要在
// 「发送时」「渲染卡片时」「卡片详情」「会话预览」四处用；散着写就会出现
// "列表里写 3 条、卡片里写 2 条"这类不一致，而且它们全是纯逻辑，能直接单测。
//
// 与 Rust 侧 `protocol::parse_merge_payload` / `merge_summary` 同构：跨语言契约由
// 两侧各自的测试钉住（Rust 那边校验并拒绝畸形/超限，这边负责渲染与构建）。

import type { MessageRecord, MsgKind } from "@/types";

/** 卡片里的一条（快照，不是 msg_id 引用 —— 原消息删了卡片也要能展开）。 */
export interface MergedItem {
  /** 发送者显示名（发送侧拼好，接收方未必解析得出对方的昵称）。 */
  sender: string;
  kind: MsgKind;
  content: string;
  ts: number;
}

export interface MergePayload {
  title: string;
  items: MergedItem[];
}

/** 与 Rust `protocol::MAX_MERGE_ITEMS` 一致（微信同款 100 条）。 */
export const MAX_MERGE_ITEMS = 100;

/**
 * 解析卡片载荷。**失败返回 null**（而不是抛错）：渲染路径上遇到一条畸形载荷，
 * 应该退化成一句「[聊天记录]」占位，而不是让整个消息列表崩掉。
 */
export function parseMergePayload(content: string): MergePayload | null {
  try {
    const v = JSON.parse(content) as Partial<MergePayload>;
    if (!v || !Array.isArray(v.items) || v.items.length === 0) return null;
    const items: MergedItem[] = [];
    for (const raw of v.items) {
      const it = raw as Partial<MergedItem>;
      if (typeof it?.content !== "string") return null;
      items.push({
        sender: typeof it.sender === "string" ? it.sender : "",
        kind: (it.kind ?? "text") as MsgKind,
        content: it.content,
        ts: typeof it.ts === "number" ? it.ts : 0,
      });
    }
    return { title: typeof v.title === "string" ? v.title : "", items };
  } catch {
    return null;
  }
}

/**
 * 会话预览/卡片副标题：`[聊天记录] N 条`（解析失败也要给人话）。
 *
 * ⚠️ 这里刻意**不**走 `t()`：它属于"会话列表摘要"那一类占位文案，本仓库既有约定就是
 * 中文常量（`previewText` 的 `[文件]`/`[图片]`/`[代码]`、Rust 侧 `preview_text` 同理）。
 * 卡片**界面**上的标题才走 i18n（见 `merge.title*` 与 ChatWindow 里的拼装）。
 */
export function mergeSummary(content: string): string {
  const p = parseMergePayload(content);
  return p ? `[聊天记录] ${p.items.length} 条` : "[聊天记录]";
}

/**
 * 媒体行的文件名：`[图片] 照片.png`。
 *
 * 卡片不携带媒体本体，**文件名就是这条记录在"看不到图"时唯一有信息量的东西** ——
 * 微信的聊天记录卡片同样把名字带出来。载荷里的媒体 content 是 `{name,size,subtype}`
 * （发送方打包时已剥掉本机路径，见 `mediaSafeContent`），所以这里读名字是安全的；
 * 解析不出名字（畸形载荷 / 老版本载荷 / 旧格式 dataURL）就退回纯类型。
 */
function mediaLine(prefix: string, content: string): string {
  try {
    const name = (JSON.parse(content) as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return `${prefix} ${name.trim()}`;
  } catch {
    /* 解析不出就只给类型 */
  }
  return prefix;
}

/** 卡片里单行的摘要文本（与消息气泡同一套口径：图片/文件写类型 + 文件名，文本原样截断）。 */
export function mergeItemLine(item: MergedItem): string {
  switch (item.kind) {
    case "image":
      return mediaLine("[图片]", item.content);
    case "file":
      return mediaLine("[文件]", item.content);
    case "code":
      return "[代码]";
    case "merge":
      return "[聊天记录]";
    default: {
      const one = item.content.replace(/\s+/g, " ").trim();
      return one.length > 40 ? `${one.slice(0, 40)}…` : one;
    }
  }
}

/**
 * 卡片里的媒体条目只保留**不含本机路径**的元信息。
 *
 * 图片/文件的 `content` 是 `{name,size,subtype,path,sha256}`，其中 `path` 是**发送方本机**的
 * 落盘路径。卡片本身不渲染媒体路径，把 path 带过去只是把发送方的目录结构泄露给对端；
 * 而旧格式图片的 `content` 干脆是一整段 dataURL —— 原样打包会把上兆的 base64 塞进
 * 一条合并转发消息里（帧大小直接爆掉）。
 * `sha256`（= cid，内容寻址指纹）**必须保留**：这是接收方按需拉取图片的唯一钥匙
 * （ADR-0019 Phase 3）。去掉这两样不影响其它渲染路径：`mergeItemLine` 对媒体只输出
 * `[图片] 名字`。
 */
function mediaSafeContent(m: MessageRecord): string {
  if (m.kind !== "image" && m.kind !== "file") return m.content;
  try {
    const meta = JSON.parse(m.content) as { name?: string; size?: number; subtype?: string; sha256?: string };
    return JSON.stringify({ name: meta.name, size: meta.size, subtype: meta.subtype, sha256: meta.sha256 });
  } catch {
    // 旧格式（content 直接是 dataURL）等一切解析不出的形态：什么都不带。
    return "{}";
  }
}

/** 媒体条目的文件名（卡片详情用它给出可读行；拉取时也要带给对端）。 */
export function mediaName(item: MergedItem): string {
  try {
    const name = (JSON.parse(item.content) as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

/** 媒体条目的内容指纹（= cid）。读侧按它取本机字节 / 向卡片发送者发起拉取；旧载荷没有则返回空。 */
export function mediaCid(item: MergedItem): string {
  try {
    const v = JSON.parse(item.content) as { sha256?: unknown };
    return typeof v.sha256 === "string" ? v.sha256 : "";
  } catch {
    return "";
  }
}

/**
 * 把选中的消息打包成一张卡片载荷。
 *
 * `senderOf` 由调用方注入（ChatWindow 知道每条消息该显示谁的名字：自己用本机昵称，
 * 别人用好友/群成员昵称）—— 纯函数不该反过来依赖 store。
 */
export function buildMergePayload(
  items: MessageRecord[],
  title: string,
  senderOf: (rec: MessageRecord) => string,
): string {
  const payload: MergePayload = {
    title,
    items: items.map((m) => ({
      sender: senderOf(m),
      kind: m.kind,
      content: mediaSafeContent(m),
      ts: m.ts,
    })),
  };
  return JSON.stringify(payload);
}
