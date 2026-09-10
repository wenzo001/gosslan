/**
 * 轻量 i18n 机制：字典 + 响应式 locale + t()。
 *
 * 为什么自写而非引入 vue-i18n：本项目文案量有限、无复数/日期等复杂需求，
 * 自写一个「字典 + 插值 t()」足够，避免新增依赖与 bundle 体积。
 *
 * 响应式：`t()` 内部读取 `dict`（computed，依赖 locale ref）。组件在模板里调用
 * `t()` 会建立依赖，切换 locale 时自动重渲染；事件处理器里的 toast 等一次性文案
 * 取「当前时刻」的 locale，无需响应式。
 */
import { computed, ref } from "vue";
import { zhCN, enUS, type MessageDict } from "./locales.ts";

export type Locale = "zh-CN" | "en-US";

/** 可选语言（value 即后端持久化值；label 用各自语言显示，切换入口不翻译自身）。 */
export const LOCALES: { value: Locale; label: string }[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en-US", label: "English" },
];

const MESSAGES: Record<Locale, MessageDict> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

const STORAGE_KEY = "gosslan.locale";

/** 从 localStorage 读上次语言（启动首帧快路径；真值在后端 settings.language）。 */
function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "zh-CN" || raw === "en-US") return raw;
  } catch {
    /* localStorage 不可用 → 默认中文 */
  }
  return "zh-CN";
}

const locale = ref<Locale>(readStoredLocale());
const dict = computed(() => MESSAGES[locale.value]);

/** 翻译：t('key') 或 t('key', { name: '张三' }) → 替换 {name} 占位。 */
export function t(key: string, params?: Record<string, string | number>): string {
  const template = dict.value[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    return v == null ? `{${k}}` : String(v);
  });
}

/** 切换语言并落地（localStorage 快路径 + document.lang）。后端持久化由 store 负责。 */
export function applyLocale(l: Locale) {
  locale.value = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* 忽略 */
  }
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

/** 判断一个值是否为合法语言（后端/旧数据脏值校验用）。 */
export function isLocale(v: unknown): v is Locale {
  return v === "zh-CN" || v === "en-US";
}

export function currentLocale(): Locale {
  return locale.value;
}
