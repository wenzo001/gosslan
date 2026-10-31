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

window.onerror = (message) => {
  setStatus(`这个窗口自己出错了：${String(message)}`, "error");
  // 返回 false：仍让原始错误进控制台，方便接 devtools 时看得更全。
  return false;
};

async function loadInfo(): Promise<void> {
  try {
    const info = await api.startupErrorInfo();
    if (detailEl) detailEl.textContent = info.message;
    if (descEl) descEl.textContent = "下面是这一次启动失败的原因与它给出的错误码。";
    if (dataDirEl) dataDirEl.textContent = info.dataDir;
    if (logDirEl) logDirEl.textContent = info.logDir;
    if (dirsEl) dirsEl.hidden = false;
  } catch (e) {
    // 连文案都取不到时**不许留白**：至少让用户知道发生了什么、能按哪个键走。
    if (descEl) descEl.textContent = "失败原因读不出来（后端没有应答）。";
    setStatus(`读取失败原因时出错：${String(e)}`, "error");
  }
}

async function onRetry(): Promise<void> {
  setBusy(true);
  setStatus("正在重试…");
  try {
    await api.startupErrorRetry();
    // 成功时 Rust 侧会关掉这扇窗并让主窗口按正常启动的路子重新走一遍；
    // 这句只是在那之前给一眼反馈（窗口可能已经先消失了，属正常）。
    setStatus("已恢复，正在进入应用…");
  } catch (e) {
    setStatus("仍然打不开。可以修好之后（挂载回来 / 释放占用 / 改对权限）再点一次重试。", "error");
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
    setStatus(`已打开数据目录：${opened}`);
  } catch (e) {
    setStatus(`打开数据目录失败：${String(e)}`, "error");
  }
}

async function onQuit(): Promise<void> {
  setBusy(true);
  setStatus("正在退出…");
  try {
    await api.startupErrorQuit();
  } catch (e) {
    setStatus(`退出请求失败：${String(e)}。可以手动结束这个进程。`, "error");
    setBusy(false);
  }
}

retryBtn?.addEventListener("click", () => void onRetry());
openBtn?.addEventListener("click", () => void onOpenDir());
quitBtn?.addEventListener("click", () => void onQuit());

// 骨架必须由本入口撤掉：这扇窗不跑 Vue 挂载，`gosslan:app-ready` 永远不会派发，
// 而骨架是一块 `position:fixed; inset:0` 的遮罩 —— 不撤就是"错误窗口里一片空白"。
void loadInfo().finally(() => dismissBoot());
