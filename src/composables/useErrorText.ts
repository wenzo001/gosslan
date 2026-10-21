/**
 * 错误提示的**拼装**（分类在 `utils/errors.ts`，文案在 i18n 词典，这里只把两者接起来）。
 *
 * 为什么必须单独一格：`utils/errors.ts` 要能被 `node --test` 直接 import，
 * 所以它不能 value-import `@/i18n`；而"把键换成当前语言的那句话"又必须有词典。
 * 于是分类是纯函数、文案在词典、拼装在这一格 —— 三件事各一个家，
 * 英文界面才可能说出「端口被占用」这类提示（它们跟后端一个字的耦合都没有）。
 *
 * 文件名按目录习惯叫 `use*`，但它**不是组合式**：没有响应式状态、不碰生命周期。
 */
import { t } from "@/i18n";
import { classifyError, isTechnicalError, rawErrorMessage } from "@/utils/errors";

/**
 * 把任意抛出物转成一句可直接上屏的提示。
 *
 * @param e     捕获到的错误
 * @param prefix 动作前缀（调用方给已翻译的那半句，如 `t("links.loadFail")`）
 * @param opts.log 技术串额外写一份 console（用户不给转储、开发者不丢线索）
 */
export function errorText(e: unknown, prefix: string, opts?: { log?: boolean }): string {
  if (opts?.log && isTechnicalError(e)) {
    console.warn(`[gosslan] ${prefix}: ${rawErrorMessage(e)}`, e);
  }
  const v = classifyError(e);
  if (v.kind === "copy") return t("errors.joined", { prefix, detail: t(v.key, v.params) });
  if (v.kind === "human") return t("errors.joined", { prefix, detail: v.detail });
  return t("errors.retry", { prefix });
}
