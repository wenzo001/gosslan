/**
 * 多语言：**vue-i18n（composition 模式）**负责消息编译、命名插值、缺失回退与响应式 locale；
 * 本模块只保留产品级策略：语言偏好三态、系统语言检测、localStorage 快路径、document.lang。
 *
 * 为什么换掉自研引擎（2026-10-19 全仓指令）：旧实现是 150 行手写「字典 + `{name}` 替换」，
 * 属于通用基础设施；消息编译/回退/响应式本来就应该由成熟库承担。迁移前用 1003×2 条消息
 * 做了逐字对账：998 条完全一致，5 条字面 `@` 触发 vue-i18n 的链接语法，已在词典里写成
 * `{'@'}`；其余差异只有「缺参时占位符是否保留」（见下方 `t` 的 Proxy）。
 *
 * 语言偏好三态（LanguagePreference）：
 *   - "system"：跟随系统语言（默认）。系统 zh* → 中文，其余（含 en* 与非中英）→ 英文。
 *   - "zh-CN" / "en-US"：显式指定，覆盖系统语言。
 *
 * 响应式：`t()` 读 vue-i18n 的 locale ref，组件在模板里调用会随切换重渲染；
 * 事件处理器里的 toast 等一次性文案取「当前时刻」的语言，无需响应式。
 */
import { computed, ref } from "vue";
import { createI18n } from "vue-i18n";
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
  // 调用方是否**显式注入**了列表（测试注入 / 明确指定）。
  const injected = langs !== undefined;
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
  // 兜底：再试一次 navigator.language（有些 WebView 只暴露 language 不含 languages）。
  //
  // ⚠️ **只在调用方没注入列表时**才用它。注入列表的契约是"就按这个列表判定"，
  // 再回看 navigator 会让结果取决于跑测试的机器：Node ≥21 自带全局 `navigator`
  // （中文机器上 language === "zh-CN"），于是 `detectSystemLocale(["ja-JP"])` 会返回
  // zh-CN 而不是契约要求的 en-US（2026-09-17 修；这也让 `npm test` 在中文机器上必红，
  // 而 en-US 的 CI runner 是绿的 —— 假绿把这个契约缺陷藏了很久）。
  if (!injected) {
    try {
      const tag = (navigator?.language || "").toLowerCase();
      if (tag.startsWith("zh")) return "zh-CN";
    } catch {
      /* ignore */
    }
  }
  return "en-US";
}

const preference = ref<LanguagePreference>(readStoredPreference());
const systemLocale = ref<Locale>(detectSystemLocale());

/** 解析后的实际语言：跟随系统时取系统语言，否则取显式偏好。 */
const locale = computed<Locale>(() =>
  preference.value === "system" ? systemLocale.value : preference.value,
);

const i18n = createI18n({
  legacy: false,
  locale: locale.value,
  fallbackLocale: "en-US",
  messages: MESSAGES,
  missingWarn: false,
  fallbackWarn: false,
  warnHtmlMessage: false,
});

/**
 * 翻译：`t('key')` 或 `t('key', { name: '张三' })`。
 *
 * vue-i18n 默认把**缺失的命名值**替换成空串（"聊天， 条未读"），会把调用点漏参的 bug
 * 藏起来；旧实现与 `i18n/index.test.ts` 的契约是**保留 `{name}`**。这里先从当前语言的
 * 消息里取出占位符名，缺的补成 `{name}` 再交给 vue-i18n 编译/插值 —— 消息语法与回退仍归库。
 * （只读 Proxy 不行：vue-i18n 会先归一化 values，`get` 陷阱拦不住它的存在性判断。）
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const template = MESSAGES[locale.value][key] ?? MESSAGES["en-US"][key];
  if (!template) return key;
  const values: Record<string, string | number> = {};
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    const name = m[1];
    values[name] = params?.[name] ?? `{${name}}`;
  }
  return i18n.global.t(key, values);
}

function syncDocumentLang() {
  if (typeof document !== "undefined") document.documentElement.lang = locale.value;
}

/** 把解析后的 locale 同步给 vue-i18n；必须**同步**调用（事件处理器里的 t() 不等人）。 */
function syncI18nLocale() {
  i18n.global.locale.value = locale.value;
}

/**
 * 应用语言偏好并落地（localStorage 快路径 + vue-i18n + document.lang）。
 * 后端持久化（settings.language）由 store 负责。
 */
export function applyPreference(p: LanguagePreference) {
  preference.value = p;
  syncI18nLocale();
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
  syncI18nLocale();
  syncDocumentLang();
}

// 系统语言变化（桌面 WebView 支持度有限，但零成本监听）：跟随系统模式下即时重解析。
if (typeof window !== "undefined" && "onlanguagechange" in window) {
  window.addEventListener("languagechange", refreshSystemLocale);
}

// 模块加载即同步一次：vue-i18n 的 locale 与 document.lang 都跟上首帧，
// 覆盖 index.html 的静态 `lang="zh-CN"`，让 store init 之前的时间窗口也正确。
syncI18nLocale();
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
