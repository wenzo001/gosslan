/**
 * 共享的"现在"：一个 30 s 一跳的定时器，按引用计数启停（没有订阅者就停）。
 *
 * 为什么需要：`sending → 等待对方上线` 是**时间**驱动的（见 `utils/sendWaiting`），
 * 而消息在没人操作时会一直不动 —— 不推一个时钟，它就会永远停在"转圈"那一格，
 * 直到用户碰一下界面。每行自己起 `setInterval` 会在长列表里起几百个定时器，
 * 所以这里只留一个、大家共用。
 */
import { onMounted, onUnmounted, readonly, ref, type Ref } from "vue";

const TICK_MS = 30_000;
const nowMs = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
let subscribers = 0;

export function useNowMs(): Readonly<Ref<number>> {
  onMounted(() => {
    subscribers += 1;
    if (!timer) {
      nowMs.value = Date.now();
      timer = setInterval(() => {
        nowMs.value = Date.now();
      }, TICK_MS);
    }
  });
  onUnmounted(() => {
    subscribers -= 1;
    if (subscribers <= 0) {
      subscribers = 0;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    }
  });
  return readonly(nowMs);
}
