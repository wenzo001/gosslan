/**
 * 独立「群任务」窗口入口（`todos.html`，桌面端 label=`todo-<groupId>`，每群一个）。
 *
 * 与主窗口的差别（其余主题/骨架/错误上报/标题全在 `src/boot/boot.ts` 共用）：
 *   1. 根组件是 `GroupTodosWindow`（不挂载聊天布局）；
 *   2. 群 ID 从**窗口自己的 label** 解析（label 是身份/参数，不是"按 label 分支渲染"）；
 *   3. 挂载前跑 `app.init()`（只读：主题/语言/设备）**与** `chat.loadGroupTodos(groupId)`
 *      —— 只加载这一个群的读路径。
 *
 * ⚠️ **绝不**调用聊天 store 的初始化入口（`init`）：它会注册第二套后端事件监听
 * （重复通知 / 未读 / 群已读回执），见主窗口根组件顶部的说明。本窗口只订阅
 * **本会话**的 `message-received` 做实时刷新（`watchGroupTodos`）。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import GroupTodosWindow from "@/components/GroupTodosWindow.vue";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import {
  createWindowApp,
  installFrontendErrorReporting,
  mountAuxWindow,
} from "@/boot/boot";
import { groupTodosGroupId } from "@/utils/auxWindowLabels";

installFrontendErrorReporting();

const groupId = groupTodosGroupId(getCurrentWindow().label);

void mountAuxWindow(createWindowApp(GroupTodosWindow), async () => {
  // `init()` 只做只读拉取（外观/语言/设备），不启动网络、不注册聊天事件 —— 与设置窗口同口径。
  await useAppStore().init();
  if (!groupId) return; // 根组件会渲染明确的错误态
  const chat = useChatStore();
  await chat.loadGroupTodos(groupId);
  await chat.watchGroupTodos(groupId);
});
