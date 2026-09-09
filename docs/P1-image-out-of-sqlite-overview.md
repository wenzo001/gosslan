# P1 修复交付概览：图片不再以 base64 内联 SQLite

> 提交：`46188c0`（rebased 至 origin/main e27cf53 之上；含夜间模式 PR #5 合并，独立 commit）
> 分支：main。协议版本 / schema / DB 迁移 **零改动**。

## 背景问题（P1）

粘贴/拖拽发送的图片消息曾以 **完整 base64 data URL** 写进 SQLite `messages`/`outbox`，
单图动辄数 MB，队列与库体积无谓膨胀，且内容经多次 base64/E2EE 封框放大。

## 修复方案

图片 data URL 只作为前端临时输入 → Rust 解码落盘为本地文件 → 复用既有 1:1
`FileOffer/FileChunk/FileDone` 与群 `GroupFileOffer/GroupFileChunk/GroupFileDone`
传输链路 → SQLite 只存 JSON 元数据 `{name, path, size, subtype:"image"}` →
UI 用既有 `read_file_preview` + Blob/objectURL 展示。

**关键约束全部守住**：`kind` 保持 `"image"`（不降级为 `"file"`）；协议零变更、
不新增 Message variant、不 bump 版本、不做 DB 迁移/新表/新字段；不动 text/code/file
行为；离线重发语义不变（outbox 走磁盘路径重读，Ack 到达才删行）。

## 改动文件（12 个）

| 文件 | 改动 |
|---|---|
| `src-tauri/src/commands.rs` | 移除 `send_message`/`send_group_message` 的 `"image"` 分支；新增 `save_outgoing_image`（校验 image/* MIME + 按解码后字节 ≤8MiB + UUID 文件名落 `downloads_dir`）与 `delete_file`；`send_file`/`send_group_file` 按 `classify_file_subtype` 把 png/jpeg/gif/webp 标 `kind="image"`；新增 9 个图片 decode 单测 |
| `src-tauri/src/lib.rs` | invoke_handler 注册 `delete_file`、`save_outgoing_image` |
| `src-tauri/src/network/transport.rs` | 1:1 `FileDone`、群 `GroupFileOffer`/`GroupFileDone` 接收端按 subtype 生成 `kind="image"`，content 带 `subtype`；预览摘要 `[图片]` |
| `src/api/index.ts` | `saveOutgoingImage` / `deleteFile` IPC 封装 |
| `src/stores/useChatStore.ts` | 新增 `sendImage`：save→sendFileAuto/sendGroupFile，失败 deleteFile 清孤儿 |
| `src/components/ChatWindow.vue` | `onSendImage` 接 `@send-image` |
| `src/components/chat/MessageComposer.vue` | 粘贴图片 emit `send-image`（不再 `send("image", dataUrl)`） |
| `src/components/MessageItem.vue` | 图片走 objectURL（attachmentUrl）；`saveImage` 改 fetch→btoa |
| `src/composables/useMessageFile.ts` | `kind="image"` 也走 fileMeta / 预览 |
| `src/types.ts` | 删未用 `ImagePayload` |
| `src/utils/messages.test.ts` | `previewText` 图片新格式 JSON 仍显示 `[图片]` |
| `src-tauri/examples/e2e_peer.rs` | 1:1 / 群图片改真实文件传输，落库断言 kind=image + JSON 元数据 |

## 测试结果（全绿）

| 套件 | 结果 |
|---|---|
| `cargo test --lib` | **196 passed, 0 failed** |
| `cargo check` / `cargo build` | clean（无 warning） |
| `npm test` | **79 passed, 0 failed**（含夜间模式 PR 新增用例） |
| `npm run build` | 成功 |
| `bash scripts/e2e-dev.sh` | **30 项：29 PASS / 0 FAIL / 1 SKIP**（SKIP=人工 UI 好友同意，预期） |

E2E 中图片相关项全部 PASS：1:1 图片 FileOffer→FileChunk→FileCompleteAck、群图片
GroupFileCompleteAck、图片/群图片消息落库均为 `kind=image` + `subtype=image` 的 JSON 元数据。

## 排查中解决的两个技术问题

1. **E2E UDP 发现（who_has）超时根因**：实例 Auto 模式 UDP 绑真实 LAN IP（v1.0.1 行为）。
   macOS 上「绑具体单播 IP 的 socket」收不到同机发往子网广播/有限广播的包（python 实测验证）。
   修复：`e2e_peer` 改向各候选 LAN IP **直接单播** who_has + 广播兜底。
2. **E2E 若干失败为测试基建缺陷**（非产品 bug）：下载方向分片需先解封 file_key 再逐片
   `open_symmetric` 解密（此前拿到 49B AEAD 密文）；乱序落库断言改查发送方 `seq`
   （产品按 seq 排序，ts 为本地接收时间）；移除无法端到端触发 Ack→删除的 outbox 注入测试
   （该可靠性由 transport.rs 单测覆盖）。

## 备注

- 开发期间在真实 `downloads_dir` 残留了少量 `e2e-image*.png` 测试文件（属无害测试产物，
  不在本 commit 内）。
- 库内真实用户会话消息未做任何删除。
