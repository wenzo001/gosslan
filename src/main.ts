import { createApp } from "vue";
import { createPinia } from "pinia";
import "./style.css";
import App from "./App.vue";

const app = createApp(App);
app.use(createPinia());
app.mount("#app");

// ---------------- 首屏骨架（见 index.html） ----------------
// 骨架写在 index.html 里内联，先于样式/脚本给出"正在启动"的画面，消除启动白屏。
// 真实数据就绪后由 App.vue 派发 `gosslan:app-ready` → 这里淡出并移除。
// 兜底定时器：初始化异常/卡住时也必须移除，绝不能把骨架永久挡在界面上。
const boot = document.getElementById("boot");
let bootDismissed = false;

function dismissBoot() {
  if (bootDismissed || !boot) return;
  bootDismissed = true;
  boot.classList.add("boot-hide");
  window.setTimeout(() => boot.remove(), 220);
}

window.addEventListener("gosslan:app-ready", dismissBoot);
window.setTimeout(dismissBoot, 5000);
