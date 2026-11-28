# ADR-0024：自定义表情消息与表情库

- Status: Accepted
- Date: 2026-11-28

## Context

Gosslan 需要在聊天中发送 PNG / GIF / WebP 自定义表情。表情必须支持点击直发、按最新加入排序、右键移到最前与删除、引用、普通 emoji 回应、收藏和转发，同时保持旧版本互通与现有文件传输可靠性。

## Decision

1. 产品层将自定义表情视为独立消息类型；wire 层继续使用 `kind="image"`，在 content 中增加 `sticker: true`，不新增 `MsgKind`。
2. `FileOffer`、`RelayFileOffer`、`GroupFileOffer` 增加可选 `sticker: bool`，缺省 `false`；标记持久化到 `file_transfers`、`file_outbox`、`group_files`。
3. 本机表情库使用 `custom_stickers` 表与 `app_data/stickers/` 独立目录，不进缓存清理范围；发送时复制到 `sent`，删除库条目不破坏历史消息。
4. 导入使用 Rust `image` crate（仅 PNG / GIF / WebP）做格式、尺寸、像素与 GIF 帧数校验，并生成首帧缩略图；不使用 JS 解码器。单张上限 8 MiB、边长 32–4096px、宽高比不超过 6:1、静态不超过 16 MP，GIF 不超过 120 帧且累计不超过 64 MP。
5. 全量备份升级为 v2 tar 容器：数据库沿用现有加密快照，表情原件与缩略图逐文件使用同一 Argon2id 派生 key 加密；`tar` 声明为直接依赖。v1 备份继续可读。
6. 自定义表情回应仍只支持现有 emoji token；自定义图片作为 reaction 图标不在本期范围。

## Consequences

- 旧客户端把自定义表情当普通图片显示，不会断链或丢失消息。
- 复用现有文件分片、ACK、离线补发、群聊扇出、E2EE 与内容拉取，不产生第二套传输状态机。
- 新增 `image` 与 `tar` 直接依赖，需要纳入许可证与供应链审计；二者均只用于导入校验和备份容器。
- 表情库不跨设备自动同步；全量备份提供显式迁移能力。

## Compatibility

- 数据库版本 v17 → v18，仅新增列与表，不回填历史消息。
- 新协议字段均可缺省；旧版本忽略未知字段。
- Backup v2 拒绝旧版本恢复，新版本继续支持 v1。

## Revisit Conditions

- 若未来要求自定义 GIF 作为 reaction 图标，再扩展 `ReactionPayload` 与能力位。
- 若表情库需要跨设备自动同步，应另立 ADR，不复用单条消息传输隐式同步目录。
