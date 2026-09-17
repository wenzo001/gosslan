<script setup lang="ts">
import { t } from "@/i18n";
import { Pin, PinOff, Undo2 } from "lucide-vue-next";
import { Copy, CornerUpLeft, Save, Share2, Star } from "lucide-vue-next";
import type { MsgKind } from "@/types";
import ContextMenu from "@/components/ContextMenu.vue";

defineProps<{
  /** 仅自己的消息才显示撤回（其他人的消息后端也不接受） */
  canRecall?: boolean;
  /** 群聊才可置顶 */
  canPin?: boolean;
  /** 当前是否已置顶（决定文案） */
  pinned?: boolean;
  x: number;
  y: number;
  kind: MsgKind;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "copy-text"): void;
  (e: "copy-image"): void;
  (e: "save-image"): void;
  (e: "save-file"): void;
  (e: "copy-file"): void;
  (e: "quote"): void;
  (e: "recall"): void;
  (e: "pin"): void;
  (e: "forward"): void;
  (e: "favorite"): void;
}>();

/** 转发支持：文本 / 代码 / 图片 / 文件（文件按本地路径重走传输链路；系统消息不提供）。 */
const forwardable = (k: MsgKind) => k === "text" || k === "code" || k === "image" || k === "file";

/** 收藏支持的类型与转发一致：这四类都是"有内容可留存"的消息（见 utils/messages）。 */
const favoritable = forwardable;

// 定位 / 点外部关闭 / Esc 全部交给统一外壳 `ContextMenu`（#4 全局统一样式）。
</script>

<template>
  <!-- 聊天气泡右键菜单（用户 2026-09-12 晚 #11：「聊天气泡的右键菜单也参考微信样式」）。
       外观与分组统一走 `.gosslan-menu*`：先「内容操作」（复制 / 保存），
       再分隔线，后「转发 / 引用 / 收藏」—— 与微信把"内容操作"和"消息流转"分组的习惯一致。
       本应用没有 翻译 / 搜一搜 / 多选 / 提醒 这些能力，就不放空条目。 -->
  <ContextMenu :x="x" :y="y" :estimated-height="292" @close="emit('close')">
    <template v-if="kind === 'text' || kind === 'code'">
      <button role="menuitem" class="gosslan-menu-item" @click="emit('copy-text')">
        <Copy />
        {{ t("common.copy") }}
      </button>
    </template>
    <template v-if="kind === 'image'">
      <button role="menuitem" class="gosslan-menu-item" @click="emit('copy-image')">
        <Copy />
        {{ t("common.copyImage") }}
      </button>
      <button role="menuitem" class="gosslan-menu-item" @click="emit('save-image')">
        <Save />
        {{ t("common.saveImage") }}
      </button>
    </template>
    <!-- 文件：保存（另存为）+ 复制（文件本体写 CF_HDROP，可在资源管理器/聊天框直接粘贴） -->
    <template v-if="kind === 'file'">
      <button role="menuitem" class="gosslan-menu-item" @click="emit('save-file')">
        <Save />
        {{ t("common.save") }}
      </button>
      <button role="menuitem" class="gosslan-menu-item" @click="emit('copy-file')">
        <Copy />
        {{ t("common.copyFile") }}
      </button>
    </template>

    <div class="gosslan-menu-sep" role="separator"></div>

    <button v-if="canPin" role="menuitem" class="gosslan-menu-item" @click="emit('pin')">
      <component :is="pinned ? PinOff : Pin" />
      {{ pinned ? t("msg.unpin") : t("msg.pin") }}
    </button>
    <button
      v-if="canRecall"
      role="menuitem"
      class="gosslan-menu-item gosslan-menu-item--danger"
      @click="emit('recall')"
    >
      <Undo2 />
      {{ t("msg.recall") }}
    </button>
    <button role="menuitem" class="gosslan-menu-item" @click="emit('quote')">
      <CornerUpLeft />
      {{ t("common.quote") }}
    </button>
    <button v-if="forwardable(kind)" class="gosslan-menu-item" @click="emit('forward')">
      <Share2 />
      {{ t("common.forward") }}
    </button>
    <!-- 收藏：微信的收藏是"内容留存"，放在消息流转（转发）之后，不与复制/保存混在一起 -->
    <button v-if="favoritable(kind)" class="gosslan-menu-item" @click="emit('favorite')">
      <Star />
      {{ t("favorite.add") }}
    </button>
  </ContextMenu>
</template>
