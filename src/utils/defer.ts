/**
 * 「输入框优先」这一族剩下的两件事：延迟窗口常量 + 节流判据。
 *
 * ## 为什么需要（真实缺陷）
 * 项目里的输入框大多和"重"的派生计算挤在同一个组件里：搜索框的每个字符都会重算过滤
 * 结果并重渲染整个列表（日志窗口一次要重建上千行 `v-html`）、拖颜色选择器时每个
 * `input` 事件都要落一次库。平时打字感觉不出来，**但按住 Ctrl+V 连发粘贴时**
 * （系统按键重复，每秒十几到几十次）每次都触发一遍，就会"一顿一顿"：输入框本身的字符
 * 是 DOM 原生行为（不受 Vue 影响），卡的是那些派生渲染 —— 它们把主线程占满，
 * 输入框的 caret/上屏就被挤掉了。
 *
 * ## 做法：输入值"两档"
 * 输入框 `v-model` 绑**原值**（DOM 立即更新，零响应式成本）；过滤/高亮/后端查询读
 * `refDebounced` 得到的**延迟镜像**。于是连发期间：原值每次都变，派生渲染每
 * `INPUT_DEFER_MS` 毫秒最多一次，输入框始终跟手。
 *
 * ## 为什么不用 `requestAnimationFrame` 合并
 * rAF 只保证"每帧一次"，但一次派生渲染（例如重建上千行日志）本身就超过一帧的预算，
 * 60fps 合并仍然会把帧吃满；对这类输入要用**时间窗**（trailing debounce）来限流，
 * 并且窗口结束（用户停手）时必定补一次，不会丢最终状态。
 *
 * ## 这一格里已经没有自研去抖器
 * `debounce` 与 `useDeferredRef` 都被删了：换的是已装的 `@vueuse/core` 14.4.0
 * （`useDebounceFn` / `refDebounced`）。换之前在库里跑过真值表 —— 尾沿、取最后一次
 * 参数、`cancel` 丢弃、`flush` 立即执行且之后不重复、无待执行时 `flush` 空操作、
 * 窗口结束后镜像落到新值、作用域关闭后不再回写，七条与自研版逐条一致
 * （同一套假定时器下复跑，见 `defer.test.ts` 前半）。留下的这一格是**纯函数判据**，
 * 库给不了（它要的是"用调用方给的两个时间戳算该不该跑"，不是绑作用域的节流器）。
 */

/** 输入框 → 派生渲染的延迟窗口：本地过滤实测 120ms 既吞不掉正常打字、也感觉不到延迟。 */
export const INPUT_DEFER_MS = 120;

/**
 * 节流判据（纯函数，便于单测）：距上次执行不足 `minIntervalMs` 就不必再执行。
 *
 * 这一族**只有一个家**：`peers-updated` 拓扑刷新、`windowLaunch` 连点、强提醒抖动额度
 * （CSS 抖与桌面搬 OS 窗口共用同一份预算）、群历史分页进度重查、草稿已满提示。
 * 「手写 `now - last < N` 当闸门」这种写法由 `defer.test.ts` 现扫拦；白名单里那几处都是
 * **别的语义**（窗口内检测、TTL 清扫、年龄归档、按钮置灰），分界理由写在各处注释里。
 *
 * 原始用途：`peers-updated` 这类事件最多 3/s，而由它触发的拓扑刷新（一次 IPC 往返）变化很慢，
 * 每次都发就是白白的 IPC 风暴 —— 每次 IPC 都要跨进程、进主线程消息循环，攒起来就是"顿"。
 * `last === 0`（从未执行过）一律放行。
 */
export function shouldRunThrottled(now: number, last: number, minIntervalMs: number): boolean {
  if (last <= 0) return true;
  return now - last >= minIntervalMs;
}

/**
 * ⚠️ 这里**删掉**了 `shouldResyncFromBackend`（"收到设置事件要不要重拉"的守卫）。
 *
 * 它存在的唯一理由是：`settings-changed` 以前无载荷、且会**回发给发起窗口**，
 * 于是本窗口刚写进去的值会被自己事件触发的重拉用**旧快照**盖掉（症状："点了主题又跳回去"）。
 * 现在后端 `emit_filter` 按窗口标签过滤、不把事件回发给发起窗口，
 * 加上事件本身带了"变了哪些键 + 那些键的新值"，这个守卫连同它的状态（`settingsDirty`）
 * 一起没有了存在意义 —— 少一套需要长期维护的状态机。
 */

/**
 * 等一段时间（Promise 版 `setTimeout`）—— **这一族只有一个家**。
 *
 * 已装的 `@vueuse/core` 14.4.0 没有对应出口（`@vueuse/core` 与 `@vueuse/shared`
 * 两份 `index.d.ts` 里 grep `sleep` 都是 0 命中），所以这一行留在这里，
 * 而不是让每个调用点各抄一遍 `new Promise((r) => setTimeout(r, ms))`。
 * 它和上面的 `shouldRunThrottled` 是两件事：那条判"该不该跑"，这条只是"稍后再跑"。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
