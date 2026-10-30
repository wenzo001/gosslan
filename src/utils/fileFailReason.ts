/**
 * 文件失败的**可行动文案**映射：后端给的稳定失败码 → 界面文案。
 *
 * ## 为什么需要这一层
 *
 * 后端 `file-failed` 事件的 `reason` 字段此前是自由文本：盘满时是一句英文
 * "No space left on device (os error 28)"，用户看到它**不知道该做什么**。
 * 而"磁盘满了"其实是**可行动**的失败（清出空间后重试即可），与"目录没有权限"
 * 完全不同 —— 但两者在后端曾经长得一模一样。
 *
 * 后端现在给这一类失败一个**稳定码**（`DISK_FULL`），码是契约、措辞是实现：
 * 契约改动只动这一张表，实现改动只动后端那一处。
 *
 * ## 契约边界（两侧必须同口径）
 *
 * · 后端码定义在 `src-tauri/src/logging.rs`（`FAIL_CODE_DISK_FULL`）。
 * · 本表的键必须与后端的码**逐字相同**；不一致 ⇒ 前端回落到原始 reason
 *   （那条回落是刻意的：宁可显示后端原文，也不要显示空白或 undefined）。
 * · **加新码必须同时改两侧**：后端加码 + 本表加一行 + 中英词典各加一条文案。
 *   本仓的 `fileFailReasonCodesMatchBackend` 用例把这条钉住（两侧现读、逐条对账）。
 *
 * ## 为什么表在 `src/utils` 而不在组件里
 *
 * 它被两处消费（聊天气泡的失败提示、任务中心的失败条目），而组件之间互相 import
 * 会造环（`check-import-cycles` 守着 0 个环）。`src/utils` 是本仓既有的
 * "跨组件共享的纯逻辑"落点（见 `src/utils/memberName.ts` 那族）。
 */

/** 后端稳定失败码 → 中英词典的 key。键名与后端码**逐字相同**。 */
const FILE_FAIL_REASON_KEYS: Record<string, string> = {
  DISK_FULL: "file.diskFull",
  // 1:1 文件在 outbox 里过期。后端这一族以前直接发中文串 ⇒ 英文界面看到硬编码中文；
  // 现在发码，措辞归词典。这两条从 5.15.31 起**也落库**（`messages.fail_code`），所以家搬到了
  // `error_codes.rs`（`FILE_SEND_EXPIRED` / `FILE_SEND_GIVEUP`，在 `MESSAGE_FAIL_CODES` 里对账）；
  // 事件载荷与库里那一列引用的是**同一个常量**，不会出现"当场说 A、重启后说 B"。
  FILE_SEND_EXPIRED: "file.sendExpired",
  FILE_SEND_GIVEUP: "file.sendGiveUp",
  FILE_RELAY_STATE_EXPIRED: "file.relayStateExpired",
  FILE_RELAY_SIZE_MISMATCH: "file.relaySizeMismatch",
  FILE_INTEGRITY_FAILED: "file.integrityFailed",
  FILE_RELAY_STALLED: "file.relayStalled",
  // ── 1:1 **接收侧**那七格（5.15.36）──────────────────────────────────────
  // 这一族的码只走 `file-failed` 事件（家在同文件的 `logging.rs::FAIL_CODE_*`），**不落库**：
  // 收件方那条 `file-` 气泡行是文件落盘成功之后才插的，收失败的单没有行可写 ⇒
  // 当场说得出就是它唯一的一次机会。群侧同一件事有 `GROUP_FILE_*` 那六格（能落进气泡行），
  // 两族各一份不是重复：生命周期不同（当场消失 vs 留在行上）。
  // ⚠️ 别顺手把"未知传输 / 来源不匹配"也配成码 —— 那两条走 `fail_receive` 的 `return false`
  //   分支，根本不 emit，是内部控制的返回值，不是给用户读的话。
  FILE_RECEIVE_STALLED: "file.receiveStalled",
  FILE_PEER_UNLINKED: "file.peerUnlinked",
  FILE_CHUNK_GAP: "file.chunkGap",
  FILE_CHUNK_DECRYPT_FAILED: "file.chunkDecryptFailed",
  FILE_CHUNK_OVERSIZE: "file.chunkOversize",
  FILE_CHUNK_POOL_ABORT: "file.chunkPoolAbort",
  FILE_CHUNK_SEQ_OVERFLOW: "file.chunkSeqOverflow",
  // ── 中继**接收侧**（5.15.37）────────────────────────────────────────────
  // 同样是事件载荷族（接收失败没有消息行可写）。这四格的共同来源：以前发的是**动态文本** ——
  // 枚举的 Debug（`format!("{breach:?}")`）、内部串（`… 被线程池中断: {e}`）、`io::Error` 原文。
  RECV_QUOTA_EXCEEDED: "file.quotaExceeded",
  FILE_RELAY_BAD_CHUNK: "file.relayBadChunk",
  FILE_RELAY_TASK_ABORTED: "file.relayTaskAborted",
  FILE_RELAY_HASH_FAILED: "file.relayHashFailed",
  // ── 中继**发送侧**（5.15.38）────────────────────────────────────────────
  // `handle_share.rs` 把返回值原样当失败原因 emit。`FILE_SEND_CANCELLED` 与其余十条**不是一类**：
  // 取消是用户动作，那边见到它就不发失败帧了（取消自己有终态）——它在这里有文案只为
  // 文档完整（万一将来别处把取消也走这一帧，界面至少说得对）。
  FILE_SEND_CANCELLED: "file.sendCancelled",
  FILE_SEND_UNREADABLE: "file.sendUnreadable",
  FILE_SEND_NOT_REGULAR: "file.sendNotRegular",
  FILE_SEND_TOO_LARGE: "file.sendTooLargeRelay",
  FILE_SEND_HASH_TASK_ABORTED: "file.sendHashAborted",
  FILE_SEND_NO_PUBKEY: "file.sendNoPubkey",
  FILE_SEND_KEY_EXCHANGE_FAILED: "file.sendKeyExchangeFailed",
  FILE_SEND_SEAL_FAILED: "file.sendSealFailed",
  FILE_SEND_NO_RELAY_NEIGHBOR: "file.sendNoRelayNeighbor",
  FILE_SEND_RELAY_LINK_BROKEN: "file.sendRelayLinkBroken",
  FILE_SEND_RELAY_TIMEOUT: "file.sendRelayTimeout",
  // ── 消息气泡的失败原因（`messages.fail_code`，DB v14→v15）───────────────────
  // 词表另一侧：`src-tauri/src/error_codes.rs::MESSAGE_FAIL_CODES`（双向对账见
  // `fileFailReason.test.ts`，两条一起钉）。这一族自 5.15.31 / 5.15.32 起**含文件气泡**：
  // 1:1 的超时/放弃与群文件的六种原因都会写进那一列。
  // **在册之外**的失败（如线程池中断那种内部串）读回来是 NULL ⇒ 界面走通用文案；
  // 那是"这一格没记原因"，不是"没有原因"（INV-P16 ③）。
  SEND_RETRY_EXPIRED: "msg.fail.retryExpired",
  SEND_ORPHAN_AT_START: "msg.fail.orphanAtStart",
  SEND_PEER_DELETED: "msg.fail.peerDeleted",
  SEND_GROUP_MEMBER_GONE: "msg.fail.groupMemberGone",
  GROUP_FILE_STALLED: "msg.fail.groupFileStalled",
  GROUP_FILE_NO_CHUNK: "msg.fail.groupFileNoChunk",
  GROUP_FILE_DECRYPT_FAILED: "msg.fail.groupFileDecryptFailed",
  GROUP_FILE_CHUNK_GAP: "msg.fail.groupFileChunkGap",
  GROUP_FILE_CHUNK_EXCEEDS_SIZE: "msg.fail.groupFileChunkOversize",
  GROUP_FILE_PEER_UNLINKED: "msg.fail.groupFilePeerUnlinked",
  // ── 文件**接收收尾**那一族（5.15.35）──────────────────────────────────────
  // 这四格说的是"这一份内容收成了没有"，1:1 与群共用同一份判据（`file/receive.rs` 与
  // `file/group_receive.rs` 各写一遍同一个决定），所以名字不带 `GROUP_` 前缀。
  // `FILE_INTEGRITY_FAILED` 早就在这张表里（中继那一格在用），本批只是把它从"只进事件"
  // 变成"也落库"—— 同一格气泡重启之后仍然说得出"内容与本机不匹配"。
  // 以前这四格给的是中文散文，其中写盘/占名两格干脆把 `io::Error` 原文当载荷
  // （"No space left on device (os error 28)"）：前端对未知 reason 是**原样上屏**，
  // 于是这一格既没法翻译也没法当成动作。盘满仍单独走上面的 `DISK_FULL`（那条才有动作）。
  FILE_RECEIVE_INCOMPLETE: "file.receiveIncomplete",
  FILE_RECEIVE_WRITE_FAILED: "file.receiveWriteFailed",
  FILE_RECEIVE_PLACE_FAILED: "file.receivePlaceFailed",
};

/**
 * 把后端给的 `reason` 翻译成给用户看的一句话。
 *
 * @param reason 后端 `file-failed` 的 `reason`（可能是稳定码，也可能是自由文本）
 * @param t 词典取值函数（注入而非直接 import ⇒ 本模块不依赖 i18n，不造环）
 * @returns 已知码 → 本地化文案；未知 reason → **原样返回**（绝不返回空串/undefined）
 */
export function fileFailReasonText(reason: string, t: (key: string) => string): string {
  const key = FILE_FAIL_REASON_KEYS[reason];
  if (!key) return reason;
  const text = t(key);
  // 词典缺这条（后端加了码但前端忘了加文案）⇒ 回落成原始 reason，
  // 而不是把 key 本身印到界面上。
  return text && text !== key ? text : reason;
}

/** 本表认的全部码（供对账用例现读）。 */
export function fileFailReasonCodes(): string[] {
  return Object.keys(FILE_FAIL_REASON_KEYS);
}
