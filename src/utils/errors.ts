/**
 * 错误文案收敛 —— 保证用户只会看到「能读懂 + 可行动」的说明，而不是异常转储。
 *
 * 背景（2026-09-10 Apple HIG 审计 P0-6）：
 * 调用处普遍写成 ``app.toast(`发送失败：${e}`, "error")``，把 IPC 抛出的错误原样拼进
 * 提示。HIG 要求错误讲清「发生了什么」并给出下一步，而不是把原始异常串出来。
 *
 * ⚠️ 实测前提（别想当然）：本项目 Rust 侧**大部分错误本来就是写好的中文说明**
 * （例如「对方不是好友，请先扫描添加好友之后再继续聊天。」）。所以正确做法不是
 * 「一律替换成通用文案」——那会把有用的信息抹掉。本模块的策略是：
 *
 *   1) 命中「需要额外解释」的模式 → 换成更有帮助的说明（如公钥缺失时的自动补发）；
 *   2) 看**起来已经是给人读的**（含中文、无技术签名）→ 原样保留，不做无用改写；
 *   3) 其余（IO / 库错误的英文串，如 `os error 2`）→ 换成通用文案，
 *      **原文只进 console**，既不给用户看转储，也不丢排查线索。
 *
 * 纯函数、无副作用，便于单测（见 errors.test.ts）。
 */

/** 需要换成更具体提示的错误特征。命中即用 text 替换原始串。 */
const RULES: { re: RegExp; text: string }[] = [
  {
    // E2EE 恒开的固有代价：对方从未上线过/处于不同子网时拿不到公钥。
    // 调用处原本会带出 device_id 等细节，这里换成用户能理解、且知道「不用重发」的说法。
    re: /公钥/,
    text: "对方尚未上线，暂时无法加密发送。消息已保留，对方上线后会自动补发",
  },
  {
    re: /address already in use|端口.{0,8}占用/i,
    text: "端口被占用，可能已有一个 Gosslan 实例在运行",
  },
  {
    // 库/OS 错误签名（英文）——最典型的「用户看不懂」的一类
    re: /os error|No such file|Connection (refused|reset|aborted)|timed? ?out|permission denied|No route to host|network is unreachable|dns error/i,
    text: "系统或网络暂时不可用，请稍后重试",
  },
];

/** 技术签名：出现这些说明这串不是写给用户看的（Rust panic / 内部实现细节）。 */
const TECHNICAL = /os error|panicked at|RUST_BACKTRACE|thread '[^']*'|unwrap\(\)|src\/[\w./-]+\.rs:\d+/i;

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
 * 把任意抛出物转成提示文案。
 *
 * @param e        捕获到的错误
 * @param prefix   动作前缀，如「发送失败」「删除失败」。结果形如 `发送失败：<说明>`
 * @returns        可直接放进 toast 的一句话
 */
export function friendlyError(e: unknown, prefix: string): string {
  const raw = rawErrorMessage(e);
  if (!raw) return `${prefix}，请稍后重试`;
  for (const r of RULES) {
    if (r.re.test(raw)) return `${prefix}：${r.text}`;
  }
  if (looksUserFacing(raw)) return `${prefix}：${raw}`;
  return `${prefix}，请稍后重试`;
}

/**
 * 同 friendlyError，但额外把原始错误写进 console —— 用户看不到转储，
 * 开发者仍拿得到排查线索（HIG 原则「不说转储」与工程原则「不丢信息」的折中）。
 */
export function reportError(e: unknown, prefix: string): string {
  const raw = rawErrorMessage(e);
  if (raw && !looksUserFacing(raw)) {
    console.warn(`[gosslan] ${prefix}：${raw}`, e);
  }
  return friendlyError(e, prefix);
}
