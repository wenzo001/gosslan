/**
 * 从 file / image 消息的**载荷**里解析附件元信息 —— 一份实现，两处共用。
 *
 * 为什么要单独一个模块（AI_RULES §32 单一事实来源）：同一条消息可能在两个位置上被"打开"——
 *   1. 气泡自己（`useMessageFile`）：额外用**传输记录**补齐乐观上屏时还缺的 path/size；
 *   2. **引用块**（`MessageItem.viewQuoted`）：引用的是**另一条**消息，那条的传输记录拿不到，
 *      只能用载荷里已经落下的字段。
 * 两处各写一遍 `JSON.parse` + 字段兜底，就会出现"气泡里能点开、引用里点不动"这类漂移。
 *
 * 返回 `Partial<FileMeta>`：**只给载荷里真的存在且类型正确的字段**，缺省/类型不对一律不填，
 * 让调用方按自己的语境兜底（气泡那侧会用传输记录与 i18n 默认名补，引用那侧没 path 就提示）。
 * 载荷不是对象或不是合法 JSON 时返回 `null`（与 `parseTodo` 等解析器同一种约定）。
 *
 * ⚠️ 本模块必须保持**零 `@/` 依赖**（与 `appActions`/`nameGroup`/`cardText` 同一条规则）：
 * `fileMeta.test.ts` 用 `node --test` 直接 import 它，而 Node 解析不了 Vite 的别名。
 */
import type { FileMeta } from "@/types";

export function parseFileMeta(content: string): Partial<FileMeta> | null {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const out: Partial<FileMeta> = {};
  if (typeof p.name === "string" && p.name) out.name = p.name;
  if (typeof p.path === "string" && p.path) out.path = p.path;
  if (typeof p.size === "number" && Number.isFinite(p.size)) out.size = p.size;
  if (typeof p.subtype === "string" && p.subtype) out.subtype = p.subtype;
  // sha256（= content store 的 cid）只有新格式消息才有
  if (typeof p.sha256 === "string" && p.sha256) out.sha256 = p.sha256;
  // 图片像素尺寸：后端从本机文件头读出；只接受正整数，坏值当没有（回退 288）。
  if (typeof p.w === "number" && Number.isFinite(p.w) && p.w > 0) out.w = Math.round(p.w);
  if (typeof p.h === "number" && Number.isFinite(p.h) && p.h > 0) out.h = Math.round(p.h);
  return out;
}

/**
 * 气泡「展示 / 另存 / 转发」的路径来源 —— **唯一判定**。
 *
 * 台账路径优先：收到的文件真正落盘的位置只在 `file_transfers.path` 里。
 * 台账还没到（乐观上屏 / 群文件首帧）时，**只有本机发出的消息**可以用载荷里的 `path`
 * —— 载荷是**对端**写的，回退它等于让对端指定本机要读/发哪个文件（SEC-01 的同一威胁）。
 * 对端来的消息此时返回空串，调用方按"尚未就绪"处理。
 */
export function displayPathFor(
  transferPath: string | null | undefined,
  payloadPath: string | null | undefined,
  isMine: boolean,
): string {
  if (transferPath) return transferPath;
  return isMine ? (payloadPath ?? "") : "";
}
