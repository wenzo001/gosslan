<script setup lang="ts">
import { Lock } from "lucide-vue-next";
</script>

<template>
  <section>
    <h3 class="mb-3 text-[13px] font-semibold text-[var(--gosslan-text)]">安全</h3>
    <div class="flex items-center gap-2">
      <Lock class="h-4 w-4 text-emerald-600" />
      <span class="text-sm">端到端加密（E2EE）</span>
      <span class="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600">已启用</span>
    </div>
    <div class="mt-1.5 text-[11px] leading-relaxed text-[var(--gosslan-text-2)]">
      所有单聊与群聊消息在发送前经 X25519 密钥交换 + ChaCha20-Poly1305 加密，
      中继节点只透传密文、无法查看内容；聊天窗口顶部的锁形标识实时显示该状态。
      发送前需获取对方公钥（对方上线后自动同步），因此向从未上线的好友发送会提示稍后重试。
    </div>
  </section>
</template>
