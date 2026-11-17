# 通知机器人：部署与使用（简明版）

> 面向部署者。目标：**5 分钟跑通**。版本 6.0.0+。
> 完整契约见 `gosslan-relay-server/webhook-api.md`；给发送方的接入说明见
> `docs/notes/webhook-bot-integration-guide-2026-11-16.md`。

## 一句话架构

```
外部系统 --HTTPS POST--> Webhook 服务(webhook.mjs, 独立进程) --> 队列(落盘)
                                                              |
                                              Gosslan 客户端每 60s 来取
                                                              |
                                        个人: 会话里显示 / 群: 本机代发进群
```

**盲中继 `server.mjs` 不用动、不用重启** —— Webhook 是另一个进程、另一个端口。

## 1. 部署 Webhook 服务（服务端，一次）

```bash
cd gosslan-relay-server

# 生成两把密钥（只生成一次，妥善保存）
openssl rand -hex 16   # → WEBHOOK_CLIENT_TOKEN（客户端注册/取件用）
openssl rand -hex 32   # → WEBHOOK_PEPPER（密钥摘要用；换了等于全部机器人作废）

# 启动
WEBHOOK_CLIENT_TOKEN=<上面第1把> \
WEBHOOK_PEPPER=<上面第2把> \
WEBHOOK_PORT=59995 \
WEBHOOK_DATA_DIR=./webhook-data \
node webhook.mjs
```

**可选的内存 / 可达性参数**（有默认值，一般不用改；含义见下表）：

| 参数 | 默认 | 作用 |
|---|---|---|
| `WEBHOOK_QUEUE_TTL_MS` | 7 天 | **未送达**消息最多留多久；用户临时离线，上线后仍可取到，超期才丢弃（最终期限） |
| `WEBHOOK_DONE_RETENTION_MS` | 1 小时 | 已送达/已过期的事件留多久后**物理删除**（连附件一起清）⇒ 内存/磁盘不膨胀 |
| `WEBHOOK_MAX_EVENTS_TOTAL` | 10000 | 全服事件硬上限；到了**明确回 503（背压）**，不静默接收后丢失 |
| `WEBHOOK_INDEX_TTL_MS` | 7 天 | 幂等索引 / 限流桶空闲淘汰，防 Map 无限增长 |
| `WEBHOOK_QUEUE_DEPTH_PER_BOT` | 500 | 单个机器人的队列深度上限 |

服务端每 60 秒自动清理一次（不需要客户端在线）。

验证：`curl http://127.0.0.1:59995/healthz` 返回 `"ok":true`，
且 `"storage_writable":true`。

**生产必须放在 HTTPS 反向代理后面**（服务本身终结不了 TLS，只看得见明文）：

```nginx
location /v1/ {
  proxy_pass http://127.0.0.1:59995;
  proxy_set_header Authorization "";   # 脱敏，别把 token 写进代理日志
  client_max_body_size 24m;
}
```

进程守护照抄同目录的 `ecosystem.config.cjs` / `gosslan-relay.service`，
**新增一条独立进程**，不要和 TCP 中继混在一起。

## 2. 在 Gosslan 里建机器人（客户端，一次）

| 目标 | 入口 | 谁能建 |
|---|---|---|
| 个人机器人（通知进会话） | 通讯录 →「添加」→ **添加机器人** | 每个用户自己建 |
| 群机器人（通知进某个群） | 群 → 成员/管理面板 → **添加机器人** | **仅群主 / 管理员** |

表单只填三样：**名称** / **Webhook 服务地址**（如 `https://hooks.example.com`）
/ **客户端令牌**（上面服务端那把 `WEBHOOK_CLIENT_TOKEN`）。

提交后界面一次性给出：**endpoint + 发送密钥 + curl 示例**。
⚠️ **发送密钥只显示这一次，立刻复制给发送方**（丢了只能删掉机器人重建）。

- 建好的个人机器人会出现在会话列表里（名字带「· 机器人」），点进去看通知；
- 群机器人会出现在群成员面板的「本群机器人」列表里；
- 点机器人头像 / 列表项 → 详情：可开关**免打扰**、**立即取件**、**删除**。
  删除 = 服务端撤销，hook **立即失效**（401），不可恢复。

## 3. 让外部系统发通知

把创建时拿到的 endpoint 和发送密钥给发送方，它只要发一个 HTTP POST：

```bash
curl -X POST 'https://hooks.example.com/v1/hooks/<bot_id>/messages' \
  -H 'Authorization: Bearer <发送密钥>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: build-20261117-001' \
  -d '{"text":"## 构建完成\n- **main** 全部测试通过","format":"markdown"}'
```

- `format`：`text`（默认）或 `markdown`（标题/列表/粗体/链接/代码块）；
- 正文上限 **8192 UTF-8 字节**，超长自动截断；
- 同一个 `Idempotency-Key` 重发**不会**产生两条通知；
- ⚠️ **群机器人只显示纯文本**（群聊协议冻结，带「【机器人名】」前缀）。
  要完整 Markdown 渲染，用个人机器人。

更多（错误码、查状态、检查清单）给发送方看：
`docs/notes/webhook-bot-integration-guide-2026-11-16.md`。

## 4. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 创建机器人报「连不上通知服务」 | 地址写错，或服务没起 / HTTPS 代理没配好。先 `curl .../healthz` |
| 创建报 401 | 客户端令牌填错（要填 `WEBHOOK_CLIENT_TOKEN`，不是发送密钥） |
| 外部发送报 401 | 发送密钥错了，或机器人被删除/撤销（重建一个） |
| 外部发送报 403 | 机器人在详情里被暂停了，恢复即可 |
| 收不到通知 | ① 看 `/healthz` 的 `queued` 是否 >0（是 ⇒ 客户端没在线/没到 60s 轮询）；② 客户端是否开着；③ 详情里点「立即取件」验证链路 |
| 发通知返回 503 `server_queue_full` | 服务端事件达到硬上限（默认 10000），等定期清理或调大 `WEBHOOK_MAX_EVENTS_TOTAL`；**不会静默丢消息** |
| 离线很久后上线，还能收到吗 | 能：未送达消息最多留 7 天（`WEBHOOK_QUEUE_TTL_MS`），租约到期自动重投；超 7 天才丢弃 |
| 想换发送密钥 | 没有单独轮换：删除机器人重建（旧 hook 立即失效） |

## 5. 复跑自检

```bash
# 服务端自测（17 条：scope/幂等/撤销/Markdown 限额等）
cd gosslan-relay-server && node webhook-selftest.mjs

# 客户端判据 + 全量
cd gosslan && npm test
cd src-tauri && cargo test --features bluetooth --lib
```
