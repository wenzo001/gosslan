/**
 * chat store 源码判据的**统一读取入口**。
 *
 * 拆分前，几十条静态判据都直接读 `src/stores/useChatStore.ts`（那是当时唯一的实现文件）。
 * 拆分后同一批实现分散在：
 *   - `src/stores/useChatStore.ts` —— 入口：状态声明、`init()`、对外 `return`；
 *   - `src/stores/chat/*.ts`        —— 各职责模块（通知 / 任务中心 / 消息 / 会话 / …）。
 *
 * 判据守的是**行为与接线**，不是"代码必须活在哪个文件"，所以必须覆盖整份实现。这里按
 * 稳定顺序拼接（入口在前，模块按文件名排序），顺序稳定意味着「先 X 后 Y」这类顺序断言
 * 仍然成立（同一段代码仍在同一块文本里）。
 *
 * 反例自证：任一模块被删除/改名，对应断言会因为找不到锚点而失败 —— 不会空转。
 * （`storeContract.test.ts` 里有一条专门的聚合器自证。）
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** 入口文件里"接线"那一段（模块创建 + 动作表注册 + 解构）。 */
const WIRING_MARK = "// ── chat store 拆分接线";

/**
 * 读取 chat store 的完整实现源码。
 *
 * `entryPath` 指向 `.../stores/useChatStore.ts`；同目录下的 `chat/*.ts`
 * （排除 `*.test.ts`）会被一起读进来。
 */
export function readChatStoreSrc(entryPath: string): string {
  const entry = readFileSync(entryPath, "utf8");
  // 接线段会把搬走的动作名再"提"一遍（`const { send, ... } = messaging;`）。那只是别名，
  // 不是实现；留在聚合文本里会让 `indexOf("send")` 这类锚点指到入口的别名行，把判据
  // 断在错误的位置上。所以只从判据视角里剔掉这一段，其余照原文保留。
  const wiringAt = entry.indexOf(WIRING_MARK);
  let entryForJudges = entry;
  if (wiringAt >= 0) {
    const initAt = entry.indexOf("async function init() {", wiringAt);
    if (initAt > wiringAt) entryForJudges = entry.slice(0, wiringAt) + entry.slice(initAt);
  }

  const chatDir = join(dirname(entryPath), "chat");
  let modules: string[] = [];
  try {
    modules = readdirSync(chatDir)
      .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
      .sort();
  } catch {
    modules = [];
  }
  const parts = [entryForJudges];
  for (const name of modules) parts.push(readFileSync(join(chatDir, name), "utf8"));
  return parts.join("\n");
}
