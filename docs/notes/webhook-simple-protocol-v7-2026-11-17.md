# Webhook 通知服务简化（v7，2026-11-17）

> **状态：已实施**。服务端 `notify.mjs` + `server.mjs` HTTP 端点（59994）、
> PM2 单进程、客户端 v7 协议适配均已完成；自测条数现读服务端 `notify-selftest.mjs` 末尾输出，端到端实测全过。

> 用户诉求（2026-11-17）：**中转服务器只有一个进程、一个 PM2 条目、复用现有端口**；
> 接口协议参考 ntfy / Bark —— **尽量简单通用**；**认证信息放 URL**，不要请求头；
> **GET / POST / PUT 都兼容**；机器人设计简单，不用太考虑安全；
> **重点是通知稳定可达**：个人离线时服务端保存一定时间；群机器人有人在线收到后，
> 后续其他人可通过群消息同步拿到。

## 1. 部署形态（已确认）

- **一个进程、一个 PM2 条目**：`ecosystem.config.cjs` 只启动 `server.mjs`。
- `server.mjs` 内部开两个监听：
  - TCP `59993`（盲中继，裸协议，**不变**，客户端好友/群通信依赖它）；
  - HTTP `59994`（原来只绑回环的 healthz 端口）⇒ 现在绑 `0.0.0.0`，**同一端口**提供
    `/healthz` + 新通知 API。
- `webhook.mjs` / 第二个 PM2 条目**不再需要**（源码保留作历史，但不再部署）。

## 2. 协议（像 ntfy 一样一条 curl）

**认证与路由全在 URL 路径**，不看 Authorization 头：

```text
GET  http://<host>:59994/publish/<bot_token>?text=构建完成&title=CI
POST http://<host>:59994/publish/<bot_token>        body: 纯文本 或 JSON {"text":"…"}
PUT  http://<host>:59994/publish/<bot_token>        body: 同上
```

- `<bot_token>` = 创建机器人时生成的随机串（同时作为 bot id 与认证）。
- 三种方法语义相同：都只是「往这个机器人投一条通知」。
- `text` 缺省从 query / body 取；`format=markdown`（可选）；`title` 可选。
- **成功返回 200 `{"ok":true,"id":"<event_id>"}`**。

**客户端取件**（保持简单，同样在 URL 带 token）：

```text
GET  http://<host>:59994/pull/<client_token>?limit=20
→ {"events":[{"id":…,"text":…,"format":…,"title":…,"ts":…}]}
GET  http://<host>:59994/ack/<client_token>/<event_id>   # 确认后服务端删除该条
```

## 3. 有意去掉的机制（按用户「不用太考虑安全 / 尽量简单」）

| 去掉 | 理由 |
|---|---|
| Authorization 头 | 认证在 URL 路径里，一条 curl 搞定 |
| HMAC 摘要存储 | token 明文存配置文件（改了要重启），不再算摘要 |
| `Idempotency-Key` / 租约 / ACK 重投 | 简单队列：收到即入队、取走即删；**代价**：极端网络抖动可能丢一条 |
| 多端点 metadata / 深链注册 | 机器人创建改为服务端生成 token、客户端把 token 存 settings |

## 4. **保留**的可靠性（用户的重点，不因简化而丢）

- **离线留存**：事件落盘在 `webhook-data/notify-queue.json`，默认保留 **7 天**
  （`NOTIFY_TTL_MS`），个人不在线时消息一直在，上线后取到即删。
- **总量上限**：队列硬上限（默认 10000）⇒ 满了明确 503（背压），不静默丢。
  到期事件定期物理删除 ⇒ 不内存膨胀。
- **群消息同步**：群机器人有人在线收到 ⇒ 由**既有群消息链路**发给在线成员；
  后续其他成员上线时，走**既有群历史同步**拿到那条消息（不依赖 Webhook 服务）⇒
  「后来者也能看到」由 Gosslan 自己的群消息机制保证，服务端不用为每个成员存副本。
  ⚠️ 这要求群机器人消息作为**真群消息**发进群（当前实现已是：本机代发 + `【机器人名】` 前缀），
  所以后来者从群历史里拿得到 —— **正好符合用户要的形状**。

## 5. 客户端改动

- `normalize_bot_server` 的地址改为「通知服务基址」：`http://host:59994`；
- `bot_create` 不再做 metadata / 多端点注册：POST `/v1/bots` 让服务端生成 token
  （或保持现有 client-token 引导，简化为只存 token）；
- endpoint 展示改为 `/publish/<send_token>` 一条链接；
- 拉取改为 `GET /pull/<client_token>`、确认改为 `GET /ack/<client_token>/<id>`。

## 6. 判据与验证

- 服务端自测：`GET/POST/PUT` 三方法都能发、离线留存后取到、ack 后删除、
  超 TTL 清理、队列上限 503；
- 客户端：`GET/POST/PUT` 兼容形状、URL token 认证、不依赖 header；
- 端到端：一条 curl 发通知 → 客户端轮询取到 → 会话显示 → ack → 服务端不再返回。

## 7. 明确边界

- **TCP 盲中继（59993）一个字不动** —— 它是 Frozen 传输层，好友/群通信依赖它。
- 简化后**安全性下降**（token 在 URL 会进访问日志、无幂等、无租约重投）——
  这是用户明确的产品取舍；部署文档要写清楚「只适合可信网络/内网，公网请放反代并脱敏日志」。
