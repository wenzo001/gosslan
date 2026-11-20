import { ref, type Ref } from "vue";
import { INPUT_DEFER_MS } from "@/utils/defer";
import { refDebounced } from "@vueuse/core";

/**
 * 搜索框的**纯输入状态**：`keyword` 绑输入框，`query` 是它的延迟镜像。
 *
 * ## 为什么不在这里搜（用户 2026-09-12 明确要求）
 * 「现在已经有聊天的列表，已经有搜索记录了。在上面输入，列表就不要有变化了。
 *   回车弹窗之后，在弹窗里面搜就行了。」
 * ⇒ 会话列表上的输入框**只当入口**：打字不改列表、不查消息；回车才打开
 * 「搜索聊天记录」弹窗，真正的搜索（跨会话 + 发送人/日期筛选 + loading）都在弹窗里做。
 * 联系人页仍用 `query` 做**姓名过滤**（那里就是要实时筛人）。
 *
 * ## 为什么保留延迟镜像
 * 姓名过滤会让整张联系人列表重渲染；按住 Ctrl+V 连发粘贴时关键词每秒变十几次，
 * 用原值会把主线程占满、输入框自己的 caret 掉帧（见 `utils/defer.ts` 说明）。
 *
 * ## 为什么状态在**模块级**（2026-11-20 用户需求：闭环）
 * 「点某个搜索结果跳进对应的聊天框，搜索界面关掉之后，
 *   **聊天界面搜索框里的搜索词应该清掉**。」
 * ⇒ 搜索词必须能被**搜索弹窗之外**的地方清掉（清的人不在这个组件里）。
 * 局部 ref 做不到：弹窗在路由层（`/search`），输入框在左栏（`/chats/:id`），
 * 两处从不相遇，但用户看到的是**同一个词**。
 * ⇒ 提升为模块级单例，并导出 `clearSearchKeyword()` 作为**唯一**清空出口。
 * ⚠️ 全仓只有 `ConversationList` 一个消费者（搜索框只有那一处），
 *   所以单例不会造成"两个实例抢同一个词"。
 */
const keyword = ref("");
const query = refDebounced(keyword, INPUT_DEFER_MS);

export function useSearchKeyword(): {
  keyword: Ref<string>;
  query: Readonly<Ref<string>>;
} {
  return { keyword, query };
}

/**
 * 清空搜索词（**唯一的清空出口**）。
 *
 * 调用点：搜索结果页把用户送进某个会话之后（用户 2026-11-20：「搜索界面关掉之后，
 * 聊天界面搜索框里的搜索词应该是清掉的」—— 否则左栏还留着旧词，
 * 看上去像"还在搜这个"，而实际已经在别的会话里了）。
 */
export function clearSearchKeyword(): void {
  keyword.value = "";
}
