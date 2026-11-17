# 通知机器人 v6 审计整改记录（2026-11-17）

> 对照 `docs/notes/bot-v6-code-audit-2026-11-17.md` 的逐条发现，交代**怎么修的 /
> 验了什么 / 哪些仍是有意保留的边界**。用户要求：最佳实践、考虑各种情况、
> 不内存泄漏、不膨胀、性能好、消息可达、堆积有最终期限。

## P1（已修）

| 审计发现 | 修法 | 判据 |
|---|---|---|
| 个人消息去重与消息落库非原子，重投吞消息 | `append_inbox` + `insert_message` + `touch_conversation` 放进**同一 SQLite 事务**；任一步失败整体回滚，重投能走完整路径 | Rust `personal_bots_never_enter_the_network_outbox` + 端到端 |
| 群消息无 event_id 幂等，ACK 丢失重复发 | 新增 `bot_delivered:<id>`（固定 200 条窗口）**独立于可裁剪 inbox**；只在真发出去后记；记录失败写 error 日志（风险可观测，不假装 exactly-once） | Rust 新判据 + 自测 |
| 图片契约承诺但客户端没实现 | **不假装支持**：含图片事件在正文后附「当前版本不支持图片通知」并照常 ACK（不 NACK 免无限重投）；接入文档改为如实说明 | 文档 + 源码形状 |
| `GroupMemberPanel` watcher 早于 `defineProps`（TDZ，群面板打不开） | `defineProps` 移到所有读 props 的逻辑之前 | vue-tsc + 全量测试 |
| 长消息截 240 字且无全文入口 | 消息体**存全文**（服务端已限 8192 字节）；预览交给 UI 的 line-clamp | 判据禁止落库截断 |
| Inbox 超 200 条裁掉新事件 | 新事件插到**头部**（列表新在前），truncate 尾部最旧；新增 2 条 Rust 单测（保留最新 / 重投幂等） | `bot_inbox_order_tests` |

## P1 附带修的（6.0.1 已发）

- 机器人消息落库后 emit `message-received`（否则已打开的窗口不显示新气泡）；
- 中文正文按字节截断 panic（改存全文后彻底消除）；
- `format=text` 不再被误当 Markdown（msg_id 前缀 `botmsg-md-` 分路）；
- 机器人消息不走普通消息通知（避免正文泄漏 + 双通知 + 白发给假设备发回执）。

## P2（已修）

| 审计发现 | 修法 |
|---|---|
| 删除/撤销语义不一致 | 统一：撤销 = 服务端 revoke + 个人会话删除；删除同口径；确认文案写明 hook 立即失效且不可逆 |
| 整条 BotRecord 读改写并发覆盖 | 新增字段级原子更新：`update_bot_poll_stats` / `set_bot_dnd`，**同一把锁内读-改-写**；轮询统计不再覆盖用户刚改的 DND/状态；没事件不推进 `last_event_at` |
| URL 解析用字符串 split | 改用标准 `url::Url::parse`，拒绝 userinfo / query / fragment / 路径 / 非法端口 / 非 HTTPS（回环 http 例外）；新增 7 个反例测试 |
| scope 未知值默认个人 | 只认 `personal` / `group` / 旧 `inbox`，其它**明确拒绝** |

**有意保留的边界**（不强求本轮做完，避免仓促引入新缺陷）：
- pending / lastError 的可视化时间线、逐事件重试按钮：当前详情里已有「立即取件」与失败计数，
  更细的状态机 UI 留待下一轮；
- 群机器人 Markdown 仍按纯文本呈现（群线格式属 Frozen Core，首版不改）。

## 服务端（gosslan-relay-server）内存 / 队列 / 可达性加固

按用户要求逐条落地（详见该仓 `webhook-api.md` §7 与 `gosslan-relay.env.example`）：

1. **不内存泄漏 / 不膨胀**
   - `buckets`（限流桶）与 `idemIndex`（幂等索引）加 **7 天空闲淘汰**（`sweepIndexes`）；
   - 终态事件（已送达 / 已过期 / 失败）超过 `WEBHOOK_DONE_RETENTION_MS`（默认 1h）
     **物理删除**：`events.delete` + 附件文件 `unlink` + 幂等索引清理；
   - 全服事件硬上限 `WEBHOOK_MAX_EVENTS_TOTAL`（默认 10000），到了**明确回 503（背压）**，
     不静默接收后丢失；
2. **定期回收**：每 60 秒定时 sweep（`unref()` 不吊住进程）；不只靠客户端 pull 触发 ——
   没有客户端上线时也能回收；
3. **消息可达性（用户临时离线）**：未送达事件在队列里最多留 `WEBHOOK_QUEUE_TTL_MS`
   （默认 7 天），租约 60s 到期自动重投；用户上线取件即可收到 ——
   这就是「上线后再推」；**超过 7 天 TTL 才丢弃**（用户要求的「最终期限」）；
4. **性能**：队列深度按 bot 500、批量取 20、幂等 HMAC 摘要、附件按内容哈希去重；
   清理是 O(n) 扫描 + 定时，不阻塞请求主路。

**服务端自测**：原 17 条全过 + 新增 `webhook-memory-selftest.mjs` 2 条
（终态物理删除、达上限 503）。端到端实测：创建 → 发送 → 幂等 → 取件（format 保留）
→ 撤销后 401 全过。

## 复跑

```bash
# 客户端
cd gosslan && npm test
cd src-tauri && cargo test --features bluetooth --lib

# 服务端
cd gosslan-relay-server
node webhook-selftest.mjs
node webhook-memory-selftest.mjs
```
