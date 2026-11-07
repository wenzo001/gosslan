# UI Pulse 审查后续可执行计划（2026-11-07）

配套报告：`docs/notes/ui-pulse-review-2026-11-07/report.md`
基线：`353a634d`，审查 worktree `/Users/wendongfu/Documents/code/gosslan-ui-review-353a634d`

前置约定
- 每步一个 issue、一个 commit；提交标题带 Change Budget 标记（`[plan]` / `[impact]`），绝不 `--no-verify`。
- 涉及界面文案时中英同步（本计划的改动均不新增文案键）。
- 每步完成后跑该步的"验证"命令；验收方式写进 commit 正文，写不出就写"已改，未验证"。

---

## 一、必修（按顺序，B → M1 → M2 → M3 → M6）

### 1. B-1 列宽把聊天区压成 0（最小窗口 360px）

影响文件
- `src/layouts/ResponsiveLayout.vue`（`RAIL_W`/`LIST_W_MIN`/`LIST_W_DEFAULT` 附近的宽度计算、`onResizeMove` 的夹取）
- `src-tauri/tauri.conf.json`（仅在选方案 B 时）
- `src/utils/designGuards.test.ts`（新增结构常量守卫）

做法（二选一）
- A：`effListW = clamp(listW, LIST_W_MIN, innerWidth - RAIL_W - CHAT_MIN)`，窗口变窄时列表自动收；`CHAT_MIN` 取 360，并在 `resize` 时重算。
- B：`minWidth = RAIL_W + LIST_W_MIN + 360 = 704`，默认宽度同步上调到 1000 以上（保持现状 1000 也可）。

验证
- `npm run dev`（或 `npm run tauri:dev`）→ 把窗口拖到最小宽 → DevTools 读 `document.querySelector('aside').getBoundingClientRect().width` 与 `main` 的宽度，断言 main ≥ 360（方案 A）或窗口拖不到 360（方案 B）。
- 新增守卫断言：`tauri.conf.json minWidth` 与 `ResponsiveLayout` 的 `RAIL_W + LIST_W_MIN + CHAT_MIN` 一致；故意把 `LIST_W_DEFAULT` 改成 420 时应红。

### 2. M-1 首屏骨架三处漂移

影响文件
- `src/boot/skeleton.css`（`.boot-cap` 82-88 / 受 136-139 / `html.is-mac` 165-168 / `.boot-list` 109 起的结构）
- `index.html`（骨架 DOM：`.boot-list` 前加 50px 标题行占位；`index.html:16` 注释 38→40）
- `src/utils/designGuards.test.ts` 或 `src/utils/windowEntries.test.ts`（新增骨架↔真实尺寸守卫）

做法
1. `.boot-cap { height: 40px }`，移动端 `calc(40px + env(safe-area-inset-top))`；
2. 删 `html.is-mac .boot-cap { height: 28px }` 与其过期注释（`style.css` 已无 `.platform-mac` 覆盖）；
3. `.boot-list` 增加与 `ConversationList.vue:515` 同几何的 50px 标题行（标题占位 + 右上角 32px 方块占位）；
4. 注释里的 "caption 38" 改 40。

验证
- `node scripts/check-ui-runtime.mjs --only=...`（若已有启动首帧探针，用它抓骨架→真实的 y 坐标差；没有则用 `tauri:dev` + 录屏首帧，比对列表首行 y）；
- 新增守卫：从 `style.css` 解析 `--gosslan-title-h`、`--gosslan-header-h`、列表标题行高，与 `skeleton.css` 的 `.boot-cap`/`.boot-head` 值和 `index.html` 的列表标题行高逐项比对，任一项不等即红；反例自证：把 `.boot-cap` 改 41px 必须红。

### 3. M-2 ㊶ 对任意值/单轴内边距空转

影响文件
- `src/utils/designGuards.ts`（`RAW_CARD_PADDING_TOKEN_RE` 及其函数）
- `src/utils/designGuards.test.ts`（新增三条反例夹具）

做法
- 正则扩成：可选 `!` 前缀 + `(p|px|py|pt|pr|pb|pl|ps|pe)-` + (`3|4|5|6` 之外的数值 **或** `[...]` 任意值) 视为散值；`px-(4|5|6)` 视作已知档时同样要防 `px-[16px]`。
- 夹具：`<div class="p-[16px]">`、`<div class="pt-4 pb-4">`、`<div class="!p-4">` 必须各产出一条 issue。

验证
- `node --test --experimental-strip-types src/utils/designGuards.test.ts` → 322+ pass，新夹具全绿；
- 突变自证：在 `src/components/settings/AboutSection.vue` 注入 `class="p-[16px]"` → 必红；复原后必绿。

### 4. M-3 设置外壳漏在扫描域外

影响文件
- `src/components/SettingsPanel.vue`（217 行 `p-4`、234 行 `px-4 py-3`）
- `src/utils/designGuards.test.ts`（7334 扫描目录、7341 分母断言）

做法
- 两处换成 `settings-group` / 三档共用类；
- 扫描域改为"`src/components/settings/**` + 文件名以 `Settings` 开头的组件"，分母断言从 `>= 17` 改为现算（不写死条数，避免存量迁移导致恒红）；
- 保留反例自证：在扫描域内写 `p-4` 必须红。

验证
- `node --test ... designGuards.test.ts` 全绿；
- `git diff` 确认 `SettingsPanel.vue` 内不再有 `p-4`/`px-4 py-3`（`grep -n 'class="p-4"'` 无命中）。

### 5. M-6 浮层限高收敛

影响文件
- `src/components/**` 的 13 处 `collision-padding="8"`
- `src/components/chat/MessageComposer.vue:1170`（@成员下拉）
- `src/style.css:2172-2173`（`100vh`→`100dvh`）
- `src/utils/popoverBounds.ts`（删 `POPOVER_EDGE_TOKEN`）

做法
1. 先确认（本步的前置检查）：`node_modules` 安装后 `grep -r "--reka-popper-available-height" node_modules/reka-ui` 是否有写入；**没有就改用"打开时读一次 `availableHeight` 写内联 max-height"**，否则限高在小窗里等于没做；
2. 13 处改常量引用；mention 下拉挂 `.gosslan-pop-clamp` 并保留 `max-h` 作为下限；
3. 兜底换 `100dvh`；删死导出。

验证
- 设置窗口（780×600）打开任意 select 与 mention 下拉：下拉底边距窗口底 ≥ 8px，且不超出；
- `grep -rn 'collision-padding="8"' src --include=*.vue` = 0；
- `node --test ... designGuards.test.ts`（PC-01）全绿。

---

## 二、建议修（不阻塞发布，按收益排序）

### 6. M-4 图标统一到单一出口

影响文件：`src/components/ui/icons.ts`（删除）、`src/components/ui/iconRegistry.ts`（补 `check`）、34 个 `ui/icons` import 点、`src/components/message/MessageItem.vue:57-58`
验证：`npx vue-tsc --noEmit` 通过；`grep -rl "ui/icons" src | wc -l` = 0；视觉抽查 `MessageReceipt`/`SettingsSelect`/`ChatWindow` 三处图标不变。

### 7. M-5 `Icon.vue` 尺寸双轨

影响文件：`src/components/ui/Icon.vue`、`src/style.css`（新增 `.icon-16 { stroke-width: 1.8 }` 或在 registry 内按尺寸出 class）
验证：`grep '<Icon.*size='` 仍为 0 时删掉 prop；抽 3 个 16px 图标（`MessageReceipt`、`ChatHeader` 设备图标、`ToastList`）截图对比描边粗细。

### 8. M-7 内容区玻璃与降级开关

影响文件：`src/style.css`（`html[data-frost="off"]` 规则、`.frost` 组）、`src/components/ToastList.vue:39`、`BaseModal.vue` 内菜单、`ImageLightbox.vue:655`、`GroupTasksBoard.vue`/`MessageComposer.vue` 的 `.frost` 浮件
验证：真机 `Performance` 面板看合成层数量；`grep -ro frost src/components | wc -l` 应从 20 降到标题栏/底栏那几处；`data-frost` 要么有真实写入点（设置项/低帧率检测），要么连守卫一起删。

### 9. m-1 日志工具条三套高度统一

影响文件：`src/components/LogViewer.vue:307-311`、`src/boot/skeleton.css:420-421`
验证：打开日志窗口，工具条高度与骨架首帧一致（录屏比对），`grep -n "46px"` 无命中。

### 10. m-3 / m-2 / m-7 死代码与过期对照清理

影响文件：`src/style.css`（`.glass-2` 1646-1657 与 `.frost` 1674-1685、`--gosslan-header-h` 101/276）、`src/boot/skeleton.css:323,330`
验证：`grep -c "--gosslan-header-h" src/style.css` = 1；`grep 'class="[^"]*glass-2' src` = 0；样式构建后无视觉差异（对比 `npm run build` 前后截图）。

### 11. m-8 / m-9 对比度契约补两行

影响文件：`src/utils/tokenContrast.ts`（暗色 `--gosslan-placeholder` 行）、`src/style.css`（`.dark` 的 `--gosslan-field-border` 改别名）
验证：`node --test ... tokenContrast.test.ts` 全绿；反例自证：把暗色 placeholder 改成 `#5f6b7a` 必须红。

---

## 三、记账（只记录，不改代码，或并入上面的小步）

| 项 | 内容 | 处理 |
|---|---|---|
| 记账-1 | m-10 文件名 `line-clamp-2 break-all` vs `edge-cases.md` 单行省略 | 与设计负责人确认是"实现错"还是"文档过期"；确认实现错才改 `MessageFileBubble.vue:130` |
| 记账-2 | m-11 `StateBlock` 说明无行数上限、图标 32/标题 14 与决策 7 的 40/17 不符 | 视觉已验收 ⇒ 倾向改文档；行数上限建议真加 `line-clamp-3`（长 IPC 错误会顶出按钮） |
| 记账-3 | m-12 Toast 512px/无两行、m-13 搜索摘要与任务路径单行 | 归入 `designs/gosslan-redesign/docs/` 的下一轮文档校准 |
| 记账-4 | 设计文档内部矛盾：HANDOFF 图标 23/21 + 描边 2 vs decisions 决策 1/8 的 22/21 + 1.75；HANDOFF 行高 48 vs 实现 52 | 文档单点校准，无功能后果 |
| 记账-5 | m-5 `rounded-full` 111 处绕过 ㊴、m-6 `NavIcon :size=24` 与尺寸表互斥 | 并入"建议修 6/7"，在图标收敛时一起做 |
| 记账-6 | B-1 的根因是"结构常量散落在 TS 与 tauri 配置两处" | 必修 1 里的守卫即为根治手段；不额外做抽象层 |

---

## 验收口径（整批推完前自查）

1. `npm run verify` 与 `npm run verify:full`（含中英双 locale 复跑）全绿；
2. `node --test --experimental-strip-types src/utils/designGuards.test.ts` ≥ 322 pass 且新增反例全部"故意违反会红"；
3. 首帧：`tauri:dev` 冷启动录屏，骨架→真实的列表首行 y 差应 < 2px，macOS 标题栏高应为 40px；
4. 最小窗口（360×640）下 main 宽度 ≥ 360（方案 A）或窗口无法到达该宽度（方案 B）；
5. 每步 commit 正文附：命令 + 关键输出行 + 截图路径（无则写"已改，未验证"）。
