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

/** 卡片里单行的摘要文本（与消息气泡同一套口径：图片/文件只写类型，文本原样截断）。 */
export function mergeItemLine(item: MergedItem): string {
  switch (item.kind) {
    case "image":
      return "[图片]";
    case "file":
      return "[文件]";
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
      content: m.content,
      ts: m.ts,
    })),
  };
  return JSON.stringify(payload);
}
