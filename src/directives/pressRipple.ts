/**
 * 按压涟漪（AM-09/AM-10）：只挂在**主操作按钮**上，不是全站按钮。
 *
 * 为什么不做全局监听：用户明确要求"只给主按钮与发送键" —— 所有按钮都起涟漪
 * 会变成廉价特效。所以它是一条显式指令 `v-press-ripple`，由组件自己决定要不要。
 *
 * 几何与时长按规格：直径 = max(控件短边, 240px)，560ms，scale .55 → 1.25、opacity .12 → 0。
 * 同时最多 2 个；只动 transform / opacity；涟漪被按钮的 overflow 裁掉。
 */
import type { Directive } from "vue";
import { prefersReducedMotion } from "@/utils/platform";

interface ActiveRipple {
  node: HTMLSpanElement;
  timer: ReturnType<typeof setTimeout>;
}

const active: ActiveRipple[] = [];

function clearRipple(item: ActiveRipple) {
  const i = active.indexOf(item);
  if (i >= 0) active.splice(i, 1);
  clearTimeout(item.timer);
  item.node.remove();
}

const handler = (ev: PointerEvent) => {
  const host = ev.currentTarget as HTMLElement;
  if (document.documentElement.dataset.ambient !== "drift") return;
  if (prefersReducedMotion()) return;
  if (document.hidden) return;

  const rect = host.getBoundingClientRect();
  const diameter = Math.max(Math.min(rect.width, rect.height), 240);
  const node = document.createElement("span");
  node.className = "press-ripple";
  node.style.setProperty("--press-ripple-d", `${diameter}px`);
  node.style.setProperty("--press-ripple-x", `${ev.clientX - rect.left}px`);
  node.style.setProperty("--press-ripple-y", `${ev.clientY - rect.top}px`);
  host.append(node);

  // 同屏最多 2 个：第 3 个到来时先摘掉最老的那个，避免连点堆层。
  if (active.length >= 2) clearRipple(active[0]);
  const item: ActiveRipple = {
    node,
    timer: setTimeout(() => clearRipple(item), 700),
  };
  active.push(item);
};

/**
 * 用法：`<button v-press-ripple>`。指令只补两个类（relative + overflow 裁剪），
 * 不改任何尺寸/间距；组件本身已有圆角，涟漪自然跟着圆角被裁。
 */
export const vPressRipple: Directive<HTMLElement> = {
  mounted(el) {
    el.classList.add("press-ripple-host");
    el.addEventListener("pointerdown", handler);
  },
  unmounted(el) {
    el.removeEventListener("pointerdown", handler);
  },
};
