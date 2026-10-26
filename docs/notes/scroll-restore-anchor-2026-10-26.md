# 聊天阅读位置恢复：从像素到消息锚点（2026-10-26）

## 0. 结论

用户报「离开再回来不是当时那一屏」。本轮用**真 ChatWindow + 真 store + 混合高度消息**复现：
旧实现（只存 `scrollTop`）在 50 条混合消息里，离开时上沿是 `m-scroll-5 @ -21.5px`，
回来落在 `m-scroll-9 @ -40.5px`（scrollTop 601 → 827）——**跨了 4 条消息**。
现在改为「消息 key + 行内偏移」锚点恢复，并在真实 DOM 上做落定校正：

- 卸载/重挂载（资料页、切 tab）：同一条消息、偏移差 ≤2px
- A→B→A 切会话：同一条消息、偏移差 ≤2px
- 探针 `--only=scrollrestore`：**8/8**

## 1. 复现与根因（已证）

量具：`scripts/check-ui-runtime.mjs --only=scrollrestore`。50 条消息里每 5 条一条
`file` + `subtype=image`（无 `w/h`、无后端时渲染文件卡 ≈90px，而估算按图片上限 288px），
这是"老消息/预览未就绪"的真实形状，也是估算误差最大的一类。

| 位置 | 旧实现 | 期望 |
|---|---|---|
| 离开时上沿 | `m-scroll-5 @ -21.5px` | 同一条 |
| 回来上沿 | `m-scroll-9 @ -40.5px` | `m-scroll-5 @ -21.5px` |
| scrollTop | 601 → 827 | 由锚点决定，不要求像素相同 |

四个叠加原因：

1. **纯像素恢复本身不成立**：切换/重挂载后列表按 `estimateSize` 布局，行未实测；
   `scrollToOffset(top)` 把同一个像素映射到另一条消息。旧探针只判 `scrollTop` 差 ≤8px，
   在 30 条同构文本上能过，遇到混合高度就暴露——**判据量错了维度**。
2. **锚点行自己被"上方行补偿"推走 29px**：TanStack 首次测量的默认补偿条件是
   `item.start < scrollOffset`；锚点行跨过视口上沿，顶部没变，补偿它的高度差只会把锚点
   往下推。改为「只有**整行完全在视口上方**才补」（首测与重测同一口径）。
3. **重挂载首帧 `listRef` 还没就绪时，恢复请求被清空**：旧实现 `listRef.value?.scrollToOffset()`
   空跑后就把 `restoreScrollTop` 置 null，之后再也没人恢复。现在没有 listRef 时保留请求，
   由 `onMounted` 再补一次。
4. **库的滚动命令与行内偏移校正互相覆盖**：`virtualizer.scrollToIndex` 会在后续帧继续把
   目标对齐到 8px，而锚点需要的是保存的 -21.5px；`pendingJump` 试满 10 次后停在错的位置。
   锚点恢复不再用库的滚动命令：按 `getOffsetForIndex(i,"start") - anchorOffset` 粗定位，
   再由 `pendingJump` 的 100ms 轮询按真实 DOM 校正。

## 2. 落地形状

- `src/utils/scrollRestore.ts`：`SavedScroll` 增加可选 `anchorKey`/`anchorOffset`；
  `top` 降级为**只在锚点不在已加载范围时的兜底**。TTL 3 分钟 / 未读优先 / 离开在底部
  三条口径不变（`shouldRestoreScroll` 未改）。
- `src/components/VirtualList.vue`：
  - `getAnchor()`：视口上沿第一条（可跨上沿，偏移可为负）的 key + offset。
  - `scrollToAnchor(key, offset, fallbackTop)`：按 key 找下标 → 估算起点粗定位 →
    `pendingJump`（复用未读/引用定位的 DOM 轮询）校到行内偏移；找不到则像素兜底。
  - `shouldAdjustScrollPositionOnItemSizeChange`：只在**整行完全在视口上方**时补偿。
- `src/components/ChatWindow.vue`：保存锚点；恢复时若锚点不在已加载范围，先逐页
  `loadMoreMessages`（≤5 页）补齐再落位；`onMounted` 兜一次；恢复完成后才清请求。
- 探针：`scrollrestore` 从"只读 scrollTop"升级为"上沿消息 key + 偏移"；混合高度、
  file-image、卸载重挂与 A→B→A 两条路径都在判据里。

## 3. 最佳实践 / 开源对照

动态高度聊天列表的恢复，主流做法都是**锚点消息 + 偏移**，不是像素：

- Element / Matrix：记录 read marker / event id，`scrollToEvent` 按事件定位（不是 scrollTop）。
- Signal Desktop：`scrollToMessage` 按消息 id 定位，再处理同帧内的高度变化。
- React Virtuoso：`initialTopMostItemIndex` 以 item index + align 初始化；内部用 size tree
  在测量后维持锚点。
- TanStack Virtual：`scrollToIndex`/`getOffsetForIndex` 在未测量时用估算，靠
  `measureElement` 收敛；所以必须**配合真实 DOM 校正**（本仓复用 `pendingJump` 轮询），
  不能只调一次 `scrollToOffset`。
- 另一条可选路线是**持久化每会话的测量缓存**（`itemSizeCache`）让估算=实测；但它会随
  宽度/字号/主题失效、内存也有上界问题。锚点+校正对这类变化天然稳，先用它；测量缓存
  可作后续优化。

> Context7 本轮配额已用尽（`Monthly quota exceeded`），所以依赖断言来自仓库锁定的
> `@tanstack/virtual-core@3.19.6` 源码（`scrollToIndex`/`getOffsetForIndex`/`resizeItem`/
> `shouldAdjustScrollPositionOnItemSizeChange`），不是外部 README。

## 4. 验证

```bash
GOSSLAN_PROBE_PORT=5299 GOSSLAN_PROBE_CDP=9445 \
  node scripts/check-ui-runtime.mjs --only=scrollrestore
```

- 修复前：`m-scroll-5 @ -21.5` → `m-scroll-9 @ -40.5`（2 条锚点判据红，scrollTop 判据仍绿）
- 修复后：卸载/重挂 + A→B→A 共 **8/8**
- 全量门禁：`npm test` 1416/1416、`verify:local` **24/24**（含 build / clippy / Rust 单测 / Android 编译）

## 5. 已知边界

- 锚点消息被删除/不在已加载历史（补 5 页仍找不到）⇒ 退回像素 `top`。
- 多窗口/重启不持久化（位置表是模块级内存，与消息缓存同生命周期），这是既有产品口径。
- 真机滚动惯性/系统覆盖层仍属人工验收；本轮证明的是组件生命周期 + 锚点链。
