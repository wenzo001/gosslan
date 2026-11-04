# 排版/样式核查 — 截图清单（2026-11-04）

本轮只补两处此前未单拍的桌面状态：**群文件成功态**、**独立群管理面板**。截图只加画面，
没有改任何组件、样式或文案（`git diff` 无 `src/` 变更）。

## 环境与口径

- 运行：`npm run tauri dev`，`GOSSLAN_INSTANCE=9`，库 `gosslan-9.db`（`gosslan-3.db` 的副本）
- 版本：工作区 `package.json` = `5.18.0`；窗口 1000×681，Retina 2x，浅色主题
- 抓图：`/usr/sbin/screencapture -x -R235,123,1000,681`（窗口左上角 235,123）
- 截图目录：[docs/assets/layout-check-2026-11-04/](../assets/layout-check-2026-11-04/)
- 每张 PNG 均为 2000×1362（1000×681 @2x）

## 清单

| # | 状态 | 中文 | English | 结论 | 判据 |
|---|---|---|---|---|---|
| 1 | 群文件成功态 | [zh-gfiles-success.png](../assets/layout-check-2026-11-04/zh-gfiles-success.png) | [en-gfiles-success.png](../assets/layout-check-2026-11-04/en-gfiles-success.png) | PASS：文件行落在「群文件（1）」里，无错误条、无重试按钮、无「传输中/失败」标记 | 行来自 `list_group_files`；`file_transfers.path` 指向真实文件且 `std::path::Path::exists` 为真 ⇒ `local_state = local`；`group_file_recipients` 三条 `completed` |
| 2 | 独立群管理面板 | [zh-group-manage.png](../assets/layout-check-2026-11-04/zh-group-manage.png) | [en-group-manage.png](../assets/layout-check-2026-11-04/en-group-manage.png) | PASS：群名/公告、成员列表（含「我」）、任务与退群入口都在，单独成景 | 入口是 `ChatHeader` 的 users 图标（`@open-members`），面板为 `src/components/GroupMemberPanel.vue` |

## 夹具（种子数据）

`gosslan-9.db` 里补上的行（脚本可重放；群密钥 `gk:g-e2e-harness` 与
`scripts/e2e/rounds/gfile.mjs` 用的同一条测试群密钥）：

```sql
-- file_transfers：本地已有整份文件
INSERT OR REPLACE INTO file_transfers
  (id, peer_id, name, size, direction, status, path, progress, cancel_terminal, created_at)
VALUES ('gfile-shot-1','group:g-e2e-harness','验收报告-2026-11-04.pdf',12612,'out','completed',
        '/tmp/gosslan-shot/验收报告-2026-11-04.pdf',1.0,0,1762300000000);

-- group_files：已完成
INSERT OR REPLACE INTO group_files
  (transfer_id, group_id, sender_id, name, size, sha256, status, created_at, scope, todo_id)
VALUES ('gfile-shot-1','g-e2e-harness','gosslan-f363ee96b9e11-i3','验收报告-2026-11-04.pdf',
        12612,'dbf448029f641463a6e4953dce8dfc06e0d5ffdd33a20e87df7fd09e8e21413d',
        'completed',1762300000000,'chat','');

-- 收件人：i1 / i2 / i9（i9 = 本实例运行时 id）全部 completed
INSERT OR REPLACE INTO group_file_recipients
  (transfer_id, recipient_id, status, progress, updated_at)
VALUES ('gfile-shot-1','gosslan-f363ee96b9e11-i1','completed',1.0,1762300000000),
       ('gfile-shot-1','gosslan-f363ee96b9e11-i2','completed',1.0,1762300000000),
       ('gfile-shot-1','gosslan-f363ee96b9e11-i9','completed',1.0,1762300000000);

-- 群成员：把本实例加进群，面板才会出现「我」
INSERT OR IGNORE INTO group_members(group_id, device_id)
VALUES ('g-e2e-harness','gosslan-f363ee96b9e11-i9');
```

真实文件：`/tmp/gosslan-shot/验收报告-2026-11-04.pdf`，12,612 B，
sha256 `dbf448029f641463a6e4953dce8dfc06e0d5ffdd33a20e87df7fd09e8e21413d`（与 `group_files.sha256` 一致）。

## 未覆盖 + 原因

- **群文件「已送达 N/M」在发送者视角下的计数徽标**：本组截图是收件人视角（`sender_id` 是
  `-i3`，`me` 是 `-i9`），而 `GroupFilesPanel` 的 `deliveryText` 只在 `sender_id === myId`
  时渲染 ⇒ 这张图里不会出现该计数（不是缺陷，是面板的显示口径）。要拍它需要把
  发送人换成本实例并同时保留 `-i9` 的收件人行，会得到不真实的「4/4」；本轮不用近似图充数。
- 群文件**失败/重试态**此前已有 `en-gfiles.png`（上一轮会话截图，未入库）；本轮只补成功态。
- 上一轮排版核查的其余截图（单聊、设置、任务、搜索、深色等）以后只存在于上一轮的会话报告里，
  没有进仓库；本轮没有重拍，也没有把它们写进本清单冒充证据。
