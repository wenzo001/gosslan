/**
 * 错误**分类** —— 保证用户只看到「能读懂 + 可行动」的说明，而不是异常转储。
 *
 * 分工（本批拆干净的正是这一层）：
 *   - 本文件只做分类，**一条文案都不带**（纯函数，能被 `node --test` 直接 import）。
 *   - 文案住在 i18n 词典；拼装住在 `composables/useErrorText.ts`（那边才允许 import `@/i18n`）。
 *   原来这里自带三条中文替换文案和一句「请稍后重试」尾巴 ⇒ 英文界面上端口被占、公钥拿不到
 *   这类提示永远是中文，而它们跟后端一个字的关系都没有，本来就该翻译。
 *
 * 背景（2026-09-10 Apple HIG 审计 P0-6）：调用处曾普遍写 `app.toast(\`发送失败：${e}\`)`，
 * 把 IPC 抛出的错误原样拼进提示。HIG 要求错误讲清「发生了什么」并给出下一步。
 *
 * ⚠️ 实测前提（别想当然）：本项目 Rust 侧**大部分错误本来就是写好的中文说明**
 * （例如「对方不是好友，请先扫描添加好友之后再继续聊天。」）。正确做法不是
 * 「一律替换成通用文案」—— 那会把有用的信息抹掉。策略是：
 *
 *   1) 命中「需要额外解释」的模式 → 给词典键（如公钥缺失时的自动补发说明）；
 *   2) 已经是给人看的中文说明 → 原样保留，不做无用改写；
 *   3) 其余（IO / 库错误的英文串，如 `os error 2`）→ 通用文案，
 *      **原文只进 console**，既不给用户看转储，也不丢排查线索。
 *
 * 第 2 类是**已知的欠账**：要让它也能翻译，前提是后端给结构化错误码（协议面），
 * 已按「暂缓」登记在 `docs/architecture/frontend-inventory.md` §4 队列 2。
 */

/** 需要换成更具体提示的错误特征。命中即给**词典键**，文案由调用侧解析。 */
const RULES: { re: RegExp; key: string }[] = [
  {
    // E2EE 恒开的固有代价：对方从未上线过/处于不同子网时拿不到公钥。
    // 调用处原本会带出 device_id 等细节，这里换成用户能理解、且知道「不用重发」的说法。
    re: /公钥/,
    key: "errors.rule.pubkey",
  },
  {
    re: /address already in use|端口.{0,8}占用/i,
    key: "errors.rule.port",
  },
  {
    // 库/OS 错误签名（英文）——最典型的「用户看不懂」的一类
    re: /os error|No such file|Connection (refused|reset|aborted)|timed? ?out|permission denied|No route to host|network is unreachable|dns error/i,
    key: "errors.rule.system",
  },
];

/** 技术签名：出现这些说明这串不是写给用户看的（Rust panic / 内部实现细节）。 */
const TECHNICAL = /os error|panicked at|RUST_BACKTRACE|thread '[^']*'|unwrap\(\)|src\/[\w./-]+\.rs:\d+/i;

/**
 * 前端自己抛出的、带**词典键**的错误。
 *
 * `message` 就是那个键（`errors.*`），`params` 是插值要用的数据（如 HTTP 状态码）。
 * 形状与 zod 那套一致（见 `utils/validation.ts`）：**判据与键住纯函数侧，文案住词典侧**，
 * 于是英文界面也说得出「头像压缩后仍超过 1MB」，而排查用的数据一个都不丢。
 */
export class MessageKeyError extends Error {
  readonly params?: Record<string, string | number>;

  constructor(key: string, params?: Record<string, string | number>) {
    super(key);
    this.name = "MessageKeyError";
    this.params = params;
  }
}

/** 分类结论：给键（要查词典）、透传（已是人话）、或只给「请稍后重试」。 */
export type ErrorVerdict =
  | { kind: "copy"; key: string; params?: Record<string, string | number> }
  | { kind: "human"; detail: string }
  | { kind: "retry" };

/** 取错误的可读文本（兼容 Error / string / 任意抛出物）。 */
export function rawErrorMessage(e: unknown): string {
  if (e === null || e === undefined) return "";
  if (e instanceof Error) return e.message.trim();
  return String(e).trim();
}

/** 是否「已经是给人读的文案」：含中文且不带技术签名。 */
function looksUserFacing(s: string): boolean {
  return /[\u4e00-\u9fa5]/.test(s) && !TECHNICAL.test(s);
}

/**
 * 把任意抛出物分成三类之一。**不含任何文案**，所以可以脱离浏览器与词典被判定。
 */
export function classifyError(e: unknown): ErrorVerdict {
  if (e instanceof MessageKeyError) return { kind: "copy", key: e.message, params: e.params };
  const raw = rawErrorMessage(e);
  if (!raw) return { kind: "retry" };
  for (const r of RULES) {
    if (r.re.test(raw)) return { kind: "copy", key: r.key };
  }
  if (looksUserFacing(raw)) return { kind: "human", detail: raw };
  return { kind: "retry" };
}

/**
 * 这串错误值不值得进 console：带技术签名的英文串、或干脆是空串之外的原始异常。
 * 已是人话（含中文/自家词典键）的**不该**打噪音 —— 原行为，别顺手放宽。
 */
export function isTechnicalError(e: unknown): boolean {
  if (e instanceof MessageKeyError) return false;
  const raw = rawErrorMessage(e);
  if (!raw) return false;
  return !looksUserFacing(raw);
}
