<script setup lang="ts">
/**
 * 独立「图片预览」窗口的根组件（`preview.html`，桌面端固定 label=`preview`，**全局只有一个**）。
 *
 * 用户 2026-09-24 #40 要的是：看图是一个公共能力 —— 任何界面点图都开这同一个窗口，
 * 从聊天点开的就在聊天那批图里左右循环，从任务/收藏点开的就在那一条的几张图里循环。
 * 所以这里的语义是"**替换内容**而不是再开一扇窗"：主窗口每次调用都会把新的相册写进后端
 * 那份暂存（`AppState::preview_gallery`），窗口要么挂载时取一次（新建），
 * 要么被 `preview-gallery` 事件叫醒后再取一次（已开着）。
 * 2026-11-06 用户再确认："窗实例只有一个。如果已经打开过一个，点了其他图片就替换内容"
 * —— 换图走 `replace`（**立刻清掉旧图**进 loading 占位，不允许旧图闪一下），
 * 窗口的位置/尺寸/层级都不动。
 *
 * 内容靠 IPC 取、不从主窗口传：跨文档传 `blob:` objectURL 一定是破图，
 * 而 `msgId` / `cid` 这种引用在这个文档里能自己把字节取回来（`filePreview` 那套）。
 *
 * 外壳 = `AuxWindowShell`（自绘标题栏），与设置/日志/群任务窗口同一套。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "@/api";
import AuxWindowShell from "@/components/window/AuxWindowShell.vue";
import ImageLightbox from "@/components/message/ImageLightbox.vue";
import StateBlock from "@/components/ui/StateBlock.vue";
import {
  INITIAL_PREVIEW_VIEW,
  PREVIEW_PULL_TIMEOUT_MS,
  reducePreviewGallery,
  withTimeout,
  type PreviewGalleryView,
} from "@/utils/previewGalleryState";
import { t } from "@/i18n";
import { detailText } from "@/composables/useErrorText";
import { createInitScope } from "@/utils/initScope";

const view = ref<PreviewGalleryView>({ ...INITIAL_PREVIEW_VIEW });
const index = computed({
  get: () => view.value.index,
  set: (value: number) => {
    view.value = { ...view.value, index: value };
  },
});
let generation = 0;

const blockedKind = computed<"loading" | "empty" | "error">(() =>
  view.value.status === "ready" ? "loading" : view.value.status,
);
const blockedTitle = computed(() => {
  switch (view.value.status) {
    case "empty":
      return t("preview.empty");
    case "error":
      return t("preview.error");
    default:
      return t("preview.loading");
  }
});
const blockedDetail = computed(() => (view.value.status === "error" ? view.value.error : ""));
const blockedRetry = computed(() => (view.value.status === "error" ? t("preview.retry") : ""));

/**
 * 取当前该看的相册。⚠️ **不清**后端那份暂存 —— 每次投递都会整体覆盖它，
 * 所以留着也不会把"上一次的内容"带给下一次；反过来如果这里清掉，任何比监听
 * 更早到达的一次投递就会被读成空相册。
 */
async function pull(replace = false) {
  const gen = ++generation;
  view.value = reducePreviewGallery(view.value, { kind: replace ? "replace" : "begin" });
  try {
    const gallery = await withTimeout(
      api.getImagePreviewGallery(),
      PREVIEW_PULL_TIMEOUT_MS,
      t("preview.timeout"),
    );
    if (disposed || gen !== generation) return;
    view.value = reducePreviewGallery(view.value, {
      kind: "loaded",
      gallery: gallery ?? { items: [], index: 0 },
    });
  } catch (err) {
    if (disposed || gen !== generation) return;
    view.value = reducePreviewGallery(view.value, {
      kind: "failed",
      message: detailText(err, { log: true }),
    });
  }
}

// `disposed` 仍然管着 `pull()` 的迟到回写；两条订阅的卸载改交给 scope
// （`listen()` 要等一次 IPC 往返，窗口在那之前就被关掉时取消函数会永远没人调用）。
let disposed = false;
const listenerScope = createInitScope();

/**
 * 关闭时把这个文档自己持有的相册放掉。
 *
 * 窗口现在是**关闭即销毁**（`AUX_PREVIEW_RESIDENT = false`，见 Rust 侧说明：用户关掉后
 * 下次点击必须能重新创建，常驻隐藏走不到那条路）。所以这里只做"关之前先把解码位图
 * 放掉"，不再拦 `close-requested` —— 拦下来会让那扇窗关不掉。
 */
function releaseAlbum() {
  generation++;
  view.value = reducePreviewGallery(view.value, { kind: "released" });
}

onMounted(() => {
  // **监听先注册，事件先到也无所谓**：Rust 在"窗口已开着"那条路上是 show + focus
  // 之后才发 `preview-gallery`，先挂监听能把"事件到了但没人接"的窗口期缩小到一次
  // IPC 往返。真先到了也不丢内容 —— 首次 `pull()` 读的是后端那份**当前值**，
  // 而后面那次 `replace` 由 generation 守卫保证胜出（旧图不会残留）。
  api
    .onImagePreviewChanged(() => void pull(true))
    .then((fn) => listenerScope.onDispose(fn))
    .catch(() => {
      /* 订阅失败只影响"窗口已开着时再点图"这一条路（内容会停在上一次） */
    });
  // 首次挂载：保留 `begin` 的语义（新建窗口本来就没有旧内容）。
  void pull();
});
onUnmounted(() => {
  disposed = true;
  listenerScope.dispose();
});

function closeSelf() {
  // 先放资源再关：`close-requested` 的监听也在同一时刻清，这里再清一次是为了
  // 不依赖那条订阅真的注册成功（幂等，成本是两行）。
  releaseAlbum();
  void getCurrentWindow()
    .close()
    .catch(() => {
      /* 关不掉也不能把异常吞进 unhandled rejection */
    });
}
</script>

<template>
  <!-- 标题栏双击 = 最大化/还原（与主窗口同一条路）；图片区域双击仍是全屏，两者不重叠。 -->
  <AuxWindowShell :title="t('preview.title')" dblclick-maximize>
    <!-- `contents` 包装只为给探针留一套稳定读数（`data-preview-status=loading` 时
         窗口里是占位、不是旧图）；`display: contents` 不参与布局，尺寸与层级都不变。 -->
    <div
      class="contents"
      data-preview-status
      :data-status="view.status"
      :data-count="view.images.length"
      :data-index="index"
    >
      <ImageLightbox
        v-if="view.status === 'ready'"
        :images="view.images"
        v-model:index="index"
        :open="true"
        hide-close
        @close="closeSelf()"
      />
      <StateBlock
        v-else
        :kind="blockedKind"
        :title="blockedTitle"
        :detail="blockedDetail"
        :retry-label="blockedRetry"
        @retry="pull()"
      />
    </div>
  </AuxWindowShell>
</template>
