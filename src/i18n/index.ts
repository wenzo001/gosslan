/**
 * 轻量 i18n 机制：字典 + 响应式 locale + t()。
 *
 * 为什么自写而非引入 vue-i18n：本项目文案量有限、无复数/日期等复杂需求，
 * 自写一个「字典 + 插值 t()」足够，避免新增依赖与 bundle 体积。
 *
 * 语言偏好三态（LanguagePreference）：
 *   - "system"：跟随系统语言（默认）。系统 zh* → 中文，其余（含 en* 与非中英）→ 英文。
 *   - "zh-CN" / "en-US"：显式指定，覆盖系统语言。
 *
 * 响应式：`t()` 内部读取 `dict`（computed，依赖 preference / systemLocale 两个 ref）。
 * 组件在模板里调用 `t()` 会建立依赖，切换语言时自动重渲染；事件处理器里的 toast 等
 * 一次性文案取「当前时刻」的语言，无需响应式。
 */
import { computed, ref } from "vue";
import { zhCN, enUS, type MessageDict } from "./locales.ts";

export type Locale = "zh-CN" | "en-US";
/** 语言偏好：跟随系统 / 显式中文 / 显式英文。 */
export type LanguagePreference = "system" | Locale;

const MESSAGES: Record<Locale, MessageDict> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

const STORAGE_KEY = "gosslan.locale";

/** 从 localStorage 读上次偏好（启动首帧快路径；真值在后端 settings.language）。 */
function readStoredPreference(): LanguagePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "system" || raw === "zh-CN" || raw === "en-US") return raw;
  } catch {
    /* localStorage 不可用 → 跟随系统 */
  }
  return "system";
}

/**
 * 从系统语言推导 locale：`zh*` → 中文，其余（含 `en*` 与非中英系统）→ 英文。
 * 非中英系统回落英文，与 macOS 的 CFBundleDevelopmentRegion（English）语义一致。
 *
 * @param langs 可选的语言列表（测试注入用）；缺省读 `navigator.languages`。
 */
export function detectSystemLocale(langs?: readonly (string | null | undefined)[]): Locale {
  let list = langs;
  if (!list) {
    try {
      list = typeof navigator !== "undefined" ? navigator.languages : undefined;
    } catch {
      list = undefined;
    }
  }
  if (list && list.length) {
    for (const l of list) {
      const tag = (l || "").toLowerCase();
      if (tag.startsWith("zh")) return "zh-CN";
      if (tag.startsWith("en")) return "en-US";
    }
  }
  // 兜底：再试一次 navigator.language（有些 WebView 只暴露 language 不含 languages）
  try {
    const tag = (navigator?.language || "").toLowerCase();
    if (tag.startsWith("zh")) return "zh-CN";
  } catch {
    /* ignore */
  }
  return "en-US";
}

const preference = ref<LanguagePreference>(readStoredPreference());
const systemLocale = ref<Locale>(detectSystemLocale());

/** 解析后的实际语言：跟随系统时取系统语言，否则取显式偏好。 */
const locale = computed<Locale>(() =>
  preference.value === "system" ? systemLocale.value : preference.value,
);
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

function syncDocumentLang() {
  if (typeof document !== "undefined") document.documentElement.lang = locale.value;
}

/**
 * 应用语言偏好并落地（localStorage 快路径 + document.lang）。
 * 后端持久化（settings.language）由 store 负责。
 */
export function applyPreference(p: LanguagePreference) {
  preference.value = p;
  try {
    localStorage.setItem(STORAGE_KEY, p);
  } catch {
    /* 忽略 */
  }
  syncDocumentLang();
}

/** 重新检测系统语言（languagechange 监听与测试共用）。 */
export function refreshSystemLocale() {
  systemLocale.value = detectSystemLocale();
  syncDocumentLang();
}

// 系统语言变化（桌面 WebView 支持度有限，但零成本监听）：跟随系统模式下即时重解析。
if (typeof window !== "undefined" && "onlanguagechange" in window) {
  window.addEventListener("languagechange", refreshSystemLocale);
}

// 模块加载即同步一次 document.lang：覆盖 index.html 的静态 `lang="zh-CN"`，
// 让首帧（store init 读后端之前的这段时间）的无障碍/字体/拼写语言就是正确的。
syncDocumentLang();

/** 判断一个值是否为合法 locale（后端脏值校验用）。 */
export function isLocale(v: unknown): v is Locale {
  return v === "zh-CN" || v === "en-US";
}

/** 判断一个值是否为合法语言偏好。 */
export function isLanguagePreference(v: unknown): v is LanguagePreference {
  return v === "system" || isLocale(v);
}

export function currentLocale(): Locale {
  return locale.value;
}

export function currentPreference(): LanguagePreference {
  return preference.value;
}
