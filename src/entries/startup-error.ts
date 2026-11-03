/**
 * 启动失败那扇独立窗口的入口（`startup-error.html`，桌面端 label="startup-error"，审计 A2）。
 *
 * 这里**不**初始化任何 store、不订阅事件、不引主界面那套代码：能出现这扇窗的时刻，
 * 数据库根本没开，任何依赖 `AppState` 的调用都只会再失败一次。整个页面只做四件事，
 * 每件都对应 Rust 侧一个命令，且**全部走 `src/api` 门面**（契约面只能有一个家）：
 * 读文案 / 重试 / 打开数据目录 / 退出。
 *
 * ⚠️ 错误可见性：这扇窗自己就是"报错"的地方，所以它坏的时候不能再依赖后端上报 ——
 * `window.onerror` 直接把异常写进状态行，否则就变成"错误窗口里一片安静"。
 */
import { api } from "@/api";
import { dismissBoot } from "@/boot/boot";
// 语言偏好由 i18n 模块在加载时从 localStorage 读（`gosslan.locale`），跟随系统时按系统语言解析；
// 这扇窗不跑 Vue 挂载，但 `t()` 是一次性取「当前时刻」的文案，不依赖响应式。
import { t } from "@/i18n";
import "./startup-error.css";

function text(id: string): HTMLElement | null {
  return document.getElementById(id);
}

const detailEl = text("se-detail");
const descEl = text("se-desc");
const dirsEl = text("se-dirs");
const dataDirEl = text("se-data-dir");
const logDirEl = text("se-log-dir");
const statusEl = text("se-status");
const retryBtn = document.getElementById("se-retry") as HTMLButtonElement | null;
const openBtn = document.getElementById("se-open-dir") as HTMLButtonElement | null;
const quitBtn = document.getElementById("se-quit") as HTMLButtonElement | null;

function setStatus(message: string, kind: "info" | "error" = "info"): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", kind === "error");
}

/** 三个按钮一起禁用：重试在跑的时候不许再点退出（那会留下"进程已经没了而 init 还在跑"的半截）。 */
function setBusy(busy: boolean): void {
  for (const btn of [retryBtn, openBtn, quitBtn]) {
    if (btn) btn.disabled = busy;
  }
}

/**
 * 静态外壳：把 HTML 里带 `data-i18n` 的节点填成当前语言的文案。
 *
 * 为什么不在 HTML 里写死中英两份再按 class 藏一份：那样两门语言会各自漂，且没法用
 * 「词典里有没有这条」来判红。`document.title` 与 `<html lang>` **不归这里管** ——
 * `theme-boot.js` 已按 `data-title-zh` / `data-title-en` 设过，i18n 模块加载时也同步了 lang，
 * 这里再写一次只会把「小院儿 · 启动失败」覆成正文标题。
 *
 * 语言在模块加载时已解析完毕；这扇窗活着的时候语言不会变，所以填一次就够。
 */
function fillStaticText(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  }
}

fillStaticText();

window.onerror = (message) => {
  setStatus(t("startupError.windowError", { error: String(message) }), "error");
  // 返回 false：仍让原始错误进控制台，方便接 devtools 时看得更全。
  return false;
};

async function loadInfo(): Promise<void> {
  try {
    const info = await api.startupErrorInfo();
    if (detailEl) detailEl.textContent = info.message;
    if (descEl) descEl.textContent = t("startupError.desc");
    if (dataDirEl) dataDirEl.textContent = info.dataDir;
    if (logDirEl) logDirEl.textContent = info.logDir;
    if (dirsEl) dirsEl.hidden = false;
  } catch (e) {
    // 连文案都取不到时**不许留白**：至少让用户知道发生了什么、能按哪个键走。
    if (descEl) descEl.textContent = t("startupError.descUnavailable");
    setStatus(t("startupError.readFailed", { error: String(e) }), "error");
  }
}

async function onRetry(): Promise<void> {
  setBusy(true);
  setStatus(t("startupError.retrying"));
  try {
    await api.startupErrorRetry();
    // 成功时 Rust 侧会关掉这扇窗并让主窗口按正常启动的路子重新走一遍；
    // 这句只是在那之前给一眼反馈（窗口可能已经先消失了，属正常）。
    setStatus(t("startupError.recovered"));
  } catch (e) {
    setStatus(t("startupError.retryFailed"), "error");
    // 文案要换成**这一轮**的原因：Rust 侧已经把 message 更新，这里重新取一次，
    // 否则用户看到的还是首启那条，会误判成"重试根本没跑"。
    await loadInfo();
  } finally {
    setBusy(false);
  }
}

async function onOpenDir(): Promise<void> {
  try {
    const opened = await api.startupErrorOpenDataDir();
    setStatus(t("startupError.openedDataDir", { path: opened }));
  } catch (e) {
    setStatus(t("startupError.openDirFailed", { error: String(e) }), "error");
  }
}

async function onQuit(): Promise<void> {
  setBusy(true);
  setStatus(t("startupError.quitting"));
  try {
    await api.startupErrorQuit();
  } catch (e) {
    setStatus(t("startupError.quitFailed", { error: String(e) }), "error");
    setBusy(false);
  }
}

retryBtn?.addEventListener("click", () => void onRetry());
openBtn?.addEventListener("click", () => void onOpenDir());
quitBtn?.addEventListener("click", () => void onQuit());

// 骨架必须由本入口撤掉：这扇窗不跑 Vue 挂载，`gosslan:app-ready` 永远不会派发，
// 而骨架是一块 `position:fixed; inset:0` 的遮罩 —— 不撤就是"错误窗口里一片空白"。
void loadInfo().finally(() => dismissBoot());
