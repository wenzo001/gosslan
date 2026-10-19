/**
 * 高频语义图标的唯一入口。
 *
 * Lucide 仍是全应用唯一的图标来源；这里把公共状态块与最高频的语义收成稳定入口，
 * 让"换图标库 / 统一 stroke-width / 统一 aria-hidden"将来只有一处要改。
 *
 * ⚠️ 必须保持**静态具名再导出**：不要改成 `Record<string, Component>` 之类的运行时
 * 映射表 —— 那会把整套图标打进包，直接毁掉 tree-shaking（vite 的 icons chunk
 * 就是靠静态 import 才能只装用到的那些）。
 *
 * 迁移纪律：本文件导出的这些名字只许从本模块 import；其余图标继续直接从
 * `lucide-vue-next` 引。判据在 `src/utils/designGuards.test.ts`（㊵），
 * 它**从下面这行 export 现解析分母** —— 加名字不用再改判据。
 */
export { AlertCircle, Check, ImageOff, Loader2, RotateCcw, Trash2, X } from "lucide-vue-next";
