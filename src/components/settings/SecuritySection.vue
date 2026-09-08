<script setup lang="ts">
import { ref } from "vue";
import { Lock, Trash2 } from "lucide-vue-next";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";

const app = useAppStore();
const chat = useChatStore();
const confirming = ref(false);

async function doClear() {
  if (confirming.value) {
    confirming.value = false;
    try {
      await chat.clearAllData();
      app.toast("聊天数据已清除", "success");
    } catch (e) {
      app.toast(`清除失败：${e}`, "error");
    }
  } else {
    confirming.value = true;
    // 5 秒内未二次确认则自动退出确认态
    window.setTimeout(() => (confirming.value = false), 5000);
  }
}
</script>

<template>
  <section>
    <h3 class="mb-3 text-[13px] font-semibold text-[var(--gosslan-text)]">安全</h3>
    <div class="flex items-center gap-2">
      <Lock class="h-4 w-4 text-primary" />
      <span class="text-sm">端到端加密（E2EE）</span>
      <span class="rounded-full bg-primary-light px-2 py-0.5 text-[10px] text-primary">已启用</span>
    </div>
    <div class="mt-1.5 text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
      所有单聊与群聊消息在发送前经 X25519 密钥交换 + ChaCha20-Poly1305 加密，
      中继节点只透传密文、无法查看内容；聊天窗口顶部的锁形标识实时显示该状态。
      发送前需获取对方公钥（对方上线后自动同步），因此向从未上线的好友发送会提示稍后重试。
    </div>

    <div class="mt-4 border-t border-[var(--gosslan-border)] pt-3">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <Trash2 class="h-4 w-4 text-red-500" />
            <span class="text-sm">清除聊天数据</span>
          </div>
          <div class="mt-1 text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
            删除本机全部消息与会话（含群聊），不影响其他成员。
            已清除的群旧历史不会再被同步回本机；清除后的新消息正常接收。
          </div>
        </div>
        <button
          class="h-8 shrink-0 rounded-lg border text-xs transition"
          :class="
            confirming
              ? 'border-red-500 bg-red-500 text-white hover:bg-red-600'
              : 'border-red-500/40 px-3 text-red-500 hover:bg-red-500/10'
          "
          @click="doClear"
        >
          {{ confirming ? "再次点击确认清除" : "清除" }}
        </button>
      </div>
    </div>
  </section>
</template>
