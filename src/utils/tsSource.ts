/**
 * 从源码文本里取一个函数的本体 —— **测试专用**（三个守卫需要看"某个函数里到底写了什么"）。
 *
 * 只按花括号配对切，不解析语法：够用即可。为什么不用固定长度的窗口：`slice(at, at + 600)`
 * 这种写法一加注释就把调用点挤出窗口（2026-10-29 审计同批里 `longPress.test.ts` 正是这么
 * 假红过一次），窗口本身会把"内容变长"变成"判据变红"。
 *
 * 放在独立模块而不是各自抄一份：`longPress.test.ts` 与 `messageKinds.test.ts` 都要用它，
 * 抄第二份就是本仓一直在治的那种重复（而且两份的边界处理迟早漂）。
 */
export function tsFnBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) return "";
  // 参数表里的内联类型（`member: { id: string }`）也是花括号：先跨过**参数表**再找函数体，
  // 否则取到的是那段类型本身（2026-11-01 就是这样把 `insertMentionAtEnd` 切成了 `{ id: string; … }`）。
  // 只有在 `{` 之前真的先出现 `(` 时才跨 —— 像 `if !a && !b {` 这种守卫签名保持原行为。
  let from = at;
  const paren = src.indexOf("(", at);
  const firstBrace = src.indexOf("{", at);
  if (paren >= 0 && (firstBrace < 0 || paren < firstBrace)) {
    let parens = 0;
    for (let i = paren; i < src.length; i += 1) {
      if (src[i] === "(") parens += 1;
      else if (src[i] === ")") {
        parens -= 1;
        if (parens === 0) {
          from = i + 1;
          break;
        }
      }
    }
  }
  const open = src.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return src.slice(at);
}
