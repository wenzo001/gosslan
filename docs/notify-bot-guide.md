# 通知机器人使用说明与接入文档

> **这是通知机器人唯一的权威入口。** 部署中转服务、在 Gosslan 里建机器人、
> 让外部系统发通知，三件事都看这一篇。
>
> 服务端源码与上游契约：[wenzo001/gosslan-relay-server](https://github.com/wenzo001/gosslan-relay-server)
> （`README-v7-notify.md` / `notify.mjs` / `server.mjs`）。
> 本文描述的接口、端口与参数均按当前服务端与客户端源码核对；改了服务端配置后，
> 用 §5 的命令复跑自检，不要靠记忆填空。
>
> ⚠️ **旧协议已删除**：`/v1/hooks/<bot_id>/messages` + `Authorization` 头 +
> 独立进程 `webhook.mjs`（59995）+ `WEBHOOK_CLIENT_TOKEN` / `WEBHOOK_PEPPER`
> 那一套全部不再使用。旧机器人无法升级，删掉重建。
> 那一套的源码、接口文档与它自己的两套自测已归档到服务端仓库的 `legacy/`
> （2026-11-18；**不部署、也不算现役证据**），本仓不再指向它的任何路径。
> 设计取舍记录在 `docs/notes/webhook-simple-protocol-v7-2026-11-17.md`；
> 群机器人管理指令见 `docs/notes/bot-group-actions-2026-11-17.md`。

## 0. 先看这张表

| 你是谁 | 直接看 | 你要拿到的东西 |
|---|---|---|
| 部署中转服务器的运维 | §1 | 一个跑起来的 `server.mjs`，59993 + 59994 可达 |
| 在 Gosslan 里收通知的用户 | §2 | 一条 `/publish/<send_token>` 链接 |
| 要发通知的外部系统（CI / 监控 / 工单） | §3 | 上面那条链接，一条 curl |
| 卡住了 | §4 | 按错误信息对号入座 |

一句话链路：

```
外部系统 --HTTP--> server.mjs:59994 /publish/<send_token> --> 落盘队列
                                                              |
                                       Gosslan 客户端每 60 秒 GET /pull/<client_token>
                                                              |
                          个人：进会话（Markdown 渲染） / 群：本机代发成真群消息
                                                              |
                                             客户端 GET /ack/... ⇒ 服务端删除该条
```

## 1. 部署中转服务（服务器上做一次）

### 1.1 端口与进程

| 端口 | 协议 | 用途 |
|---|---|---|
| 59993 | 裸 TCP（GSRL1） | **盲中继**，好友/群通信依赖它，属 Frozen 传输层，一个字不动 |
| 59994 | HTTP | **通知 API + `/healthz`**，复用原来的健康端口，现在对外绑 `0.0.0.0` |

**只有一个进程、一个 PM2 条目**：`server.mjs` 同时开这两个端口，`notify.mjs`
作为模块被它加载。不要另外启动 `webhook.mjs`，也不要给通知服务单开 PM2 条目。

> `ecosystem.config.cjs` 里 `exec_mode: 'fork'` + `instances: 1` 是功能正确性要求：
> 盲中继的「通道哈希 → 等待连接」表在进程内存里，开 cluster 会永远配不上对。

### 1.2 最小部署步骤

环境：Node.js 18+（ESM），程序本身零运行依赖；PM2 只是部署工具。

```bash
git clone https://github.com/wenzo001/gosslan-relay-server.git
cd gosslan-relay-server

# ① 生成盲中继口令（必填，丢了客户端全部连不上）
openssl rand -hex 16

# ② 写环境文件。PM2 / systemd 都读它，权限收紧
sudo tee /etc/gosslan-relay.env >/dev/null <<'EOF'
TOKEN=<上一步生成的 32 位十六进制串>
PORT=59993
HOST=0.0.0.0
HEALTHZ_PORT=59994
HEALTHZ_HOST=0.0.0.0
NOTIFY_TTL_MS=604800000
NOTIFY_MAX_EVENTS=10000
WEBHOOK_DATA_DIR=./webhook-data
EOF
sudo chmod 600 /etc/gosslan-relay.env

# ③ 启动（单进程）
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u <运行用户> --hp /home/<运行用户>   # 按输出提示执行它给的那条命令
pm2 logs gosslan-relay
```

**三个最常见的部署错误**：

1. **没设 `TOKEN` 或口令太短** —— 服务以退出码 2 拒绝启动（避免退化成开放代理）。
   非回环地址下口令短于 16 字符同样拒启。
2. **照抄 `gosslan-relay.env.example` 末尾那一段 `WEBHOOK_*`** —— 那是已删除的
   独立进程配置（`WEBHOOK_PORT=59995` / `WEBHOOK_PEPPER` / `WEBHOOK_CLIENT_TOKEN`）。
   配了它、起了 `webhook.mjs`，59994 上就**没有** `/v1/bots`，客户端创建机器人会拿到 404。
3. **防火墙 / 云安全组没放行** —— 59993 和 59994 都要放。
   `HEALTHZ_HOST` 默认是 `0.0.0.0`；`ecosystem.config.cjs` 里「默认只绑回环」那句注释
   是旧版遗留描述，以 `server.mjs` 的实际默认值为准。

### 1.3 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TOKEN` | **必填** | 盲中继口令；改了所有客户端要重配 |
| `PORT` | `59993` | 盲中继 TCP 端口 |
| `HOST` | `0.0.0.0` | 盲中继绑定地址 |
| `HEALTHZ_PORT` | `59994` | 通知 API + 健康端点；设为 `0` 会**关掉通知服务** |
| `HEALTHZ_HOST` | `0.0.0.0` | 通知 API 绑定地址 |
| `NOTIFY_TTL_MS` | `604800000`（7 天） | 未取走的消息留存期，超期物理删除 |
| `NOTIFY_MAX_EVENTS` | `10000` | 全服队列硬上限，满了返回 503 而不是静默丢 |
| `NOTIFY_PULL_MAX` | `50` | 单次取件最多返回多少条 |
| `WEBHOOK_DATA_DIR` | `./webhook-data` | 落盘目录，内含 `notify-bots.json` 与 `notify-queue.json` |

数据落盘在这两个 JSON 文件里，**重启不丢机器人和未取消息**；备份服务器就备份这个目录。
过期事件每 60 秒清一次，不依赖客户端在线。

### 1.4 部署完先自检（在服务器上跑）

```bash
# ① 服务活着，且能看见通知队列状态
curl -s http://127.0.0.1:59994/healthz
# → {"ok":true,...,"notify":{"bots":0,"queued":0}}

# ② 建一个临时机器人（这一步和客户端「新建机器人」走的是同一个接口）
curl -s -X POST http://127.0.0.1:59994/v1/bots \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke","scope":"personal"}'
# → {"send_token":"…","client_token":"…","publish_url":"/publish/…"}

# ③ 发一条 / 取一条 / 确认 / 撤销
curl -s "http://127.0.0.1:59994/publish/<send_token>?text=hello"
# → {"ok":true,"id":"…"}
curl -s "http://127.0.0.1:59994/pull/<client_token>?limit=20"
curl -s "http://127.0.0.1:59994/ack/<client_token>/<event_id>"
curl -s -X DELETE "http://127.0.0.1:59994/v1/bots/<send_token>"
```

⚠️ 第 ② 步会真的留下一个机器人，第 ③ 步最后的 `DELETE` 一定要跑，否则
`/healthz` 的 `notify.bots` 会一直多一个。客户端创建机器人时也是调用同一个
`POST /v1/bots`，所以**这一步能过，客户端就一定能建**。

### 1.5 公网部署：建议套一层 HTTPS 反代（可选但推荐）

服务本身是明文 HTTP。当前客户端允许 `http://IP:59994` 直连（内网 / 可信网络场景），
但 token 在 URL 路径里、消息正文也是明文，公网裸奔会被访问日志和链路中间设备看到。
有域名和证书时这样收口：

```nginx
server {
    listen 443 ssl http2;
    server_name hooks.example.com;

    ssl_certificate     /etc/ssl/hooks.example.com.crt;
    ssl_certificate_key /etc/ssl/hooks.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:59994;
        proxy_set_header Host $host;
        # token 在 URL 里 ⇒ 反代日志务必脱敏，或干脆关掉 access_log
        access_log off;
    }
}
```

配好后客户端地址填 `https://hooks.example.com`（**不带端口、不带路径**）。
只有公网 IP、没有域名证书时，就用 `http://IP:59994`，但请限制来源 IP、别在正文里放密钥。

## 2. 在 Gosslan 里新建机器人

### 2.1 地址怎么填（最容易失败的一步）

表单只有两项：**机器人名字** 和 **通知服务地址**。地址只接受
`scheme://主机[:端口]` 这一种形状，客户端会拼出后面的 `/publish/...`。

| 填法 | 结果 |
|---|---|
| `http://192.168.1.10:59994` | ✅ 内网按 IP 直连 |
| `http://<公网IP>:59994` | ✅ 可信网络 / 已限制来源 IP |
| `https://hooks.example.com` | ✅ 走了 HTTPS 反代 |
| `http://127.0.0.1:59994` | ✅ 服务端与客户端在同一台机器 |
| `192.168.1.10:59994` | ❌ 缺 `http://` |
| `http://host:59994/publish/xxx` | ❌ 带了路径，endpoint 由客户端拼 |
| `http://host:59994?token=xxx` | ❌ 带参数（密钥会进日志） |
| `http://user:pass@host:59994` | ❌ 带账号密码 |
| `ftp://host:59994` / `https://` | ❌ 协议不支持 / 缺主机 |

**当前客户端同时接受 `http` 和 `https`**（见 `src-tauri/src/commands/bots.rs` 的
`normalize_bot_server`）。如果你手上的版本填 `http://IP:59994` 仍提示
「必须用 HTTPS」，那是旧版客户端，升级到当前版本即可。

### 2.2 入口与权限

| 目标 | 入口 | 谁能建 |
|---|---|---|
| 个人机器人（通知进自己的会话） | 通讯录 →「添加」→ **添加机器人** | 每个用户自己建 |
| 群机器人（通知进某个群） | 群 → 成员 / 管理面板 → **添加机器人** | **仅群主 / 管理员**，后端会再挡一道 |

点创建后，客户端会向服务端 `POST /v1/bots` 注册，服务端生成两把 token。
群机器人必须带上有效的 `groupId`，否则向导不渲染（fail-closed）。

### 2.3 创建成功后立刻复制这三样

界面只展示**一次**，关掉窗口就不再回显：

1. **Endpoint** —— `http://host:59994/publish/<send_token>`，**认证 token 已经在路径里**；
2. **发送密钥** —— 就是上面那个 `send_token`，单独列出方便你核对；
3. **curl 示例** —— `curl "<endpoint>?text=hello&title=CI"`，可直接复制给发送方。

⚠️ 丢了找不回来：删掉机器人重建一个，旧的 hook 立即失效。
另外**创建过程不需要任何令牌**——两把 token 都由服务端生成，界面上不要找
`WEBHOOK_CLIENT_TOKEN` 之类的输入框，那是旧协议的东西。

### 2.4 日常管理

点机器人头像 / 列表项进详情：可开关**免打扰**（只压系统通知和任务栏闪烁，
消息照样进会话并显示未读）、点**立即取件**（跳过 60 秒轮询）、暂停、删除。

删除 = 服务端撤销，未取走的消息一起清掉，hook 立即返回 401，**不可恢复**。

## 3. 外部系统发通知

### 3.1 三种方法完全等价

```bash
# GET：参数放 URL，最短
curl "http://host:59994/publish/<send_token>?text=构建完成&title=CI"

# POST：纯文本 body
curl -X POST "http://host:59994/publish/<send_token>" -d "构建完成"

# PUT：JSON body（要 Markdown 或群管理指令就用这个）
curl -X PUT "http://host:59994/publish/<send_token>" \
  -H 'Content-Type: application/json' \
  -d '{"text":"## 构建完成\n- **main** 全部测试通过","format":"markdown"}'
```

成功一律返回 `200 {"ok":true,"id":"<event_id>"}`。
认证**只看 URL 路径里的 send_token**，不需要 `Authorization` 头、不需要 SDK、
不需要注册外部账号。

### 3.2 参数

| 参数 | 位置 | 说明 |
|---|---|---|
| `text` | query 或 body | **必填**。没有就返回 `400 {"error":"text_required"}` |
| `title` | query 或 JSON body | 可选标题 |
| `format` | query 或 JSON body | 只有值恰好是 `markdown` 才按 Markdown 渲染，其余按纯文本 |
| `action` | **仅 JSON body** | 群机器人管理指令，见 §3.3 |
| `limit` | `GET /pull/...` 的 query | 客户端取件用，发送方用不到 |

- 正文上限 **8192 个字符**（服务端 `text.slice(0, 8192)`），超长截断，不报错、不整条丢弃；
- body 是合法 JSON 且含字符串 `text` 时按 JSON 解析，否则整段当纯文本，`title` / `format`
  仍可从 URL query 取；
- ⚠️ **当前协议没有幂等键**：`Idempotency-Key` 头不生效，重试可能产生两条。
  要自己防重，请在发送侧按事件唯一编号去重；
- ⚠️ **不支持图片**：带 `images` 字段也不会下载或显示，别把关键信息放图片里；
- 不支持 HTML 渲染，外部正文一律按不可信输入消毒。

### 3.3 群机器人的管理指令（可选）

只有**群机器人**、且用 JSON body 时，`action` 才会被透传。客户端白名单**只认
`create_todo`**，其它 `type` 一律当普通通知处理（不执行、不报错），
杜绝借通知触达踢人 / 任免 / 转让等危险路径：

```bash
curl -X PUT "http://host:59994/publish/<send_token>" \
  -H 'Content-Type: application/json' \
  -d '{"text":"日报待办","action":{"type":"create_todo","title":"写周报"}}'
```

`action` 必须是纯 JSON 对象、序列化后不超过 2048 字符。

### 3.4 个人机器人 vs 群机器人

| | 个人机器人 | 群机器人 |
|---|---|---|
| 消息落点 | 本机 `bot:<id>` 会话，像联系人一样 | 由本机代发成**真群消息**，正文带 `【机器人名】` 前缀 |
| Markdown | 渲染（标题 / 列表 / 粗体 / 链接 / 代码块） | **按纯文本显示**，群聊线格式属 Frozen Core |
| 后来者能否看到 | 只在本机 | 能：走既有**群历史同步**，服务端不为每个成员存副本 |
| 创建权限 | 任意用户 | 群主 / 管理员 |

### 3.5 离线与可靠性

- 客户端每 **60 秒**轮询一次 `GET /pull/<client_token>`，成功写入本地收件箱后才
  `GET /ack/<client_token>/<event_id>`，服务端随后删除该条 ⇒ 先落本地再 ACK，不会丢；
- 人离线时消息留在 `notify-queue.json`，默认 **7 天**，上线后自动取到；
- 队列到 `NOTIFY_MAX_EVENTS` 上限时明确返回 **503**，不静默接收后丢弃；
- 取件与 ACK 之间若抖动，同一条可能被重复投递，客户端按 `event_id` 幂等去重。

## 4. 故障排查

### 4.1 新建机器人失败（按错误文案对号入座）

| 你看到的提示 | 真实原因 | 怎么处理 |
|---|---|---|
| 「通知服务地址不是合法 URL」 | 没写 `http://` / `https://`，或 URL 本身非法 | 补上协议，例如 `http://1.2.3.4:59994` |
| 「通知服务地址只能写 scheme://主机[:端口]」 | 带了路径、`?` 参数、`#` 或账号密码 | 只留 `http://主机:59994` |
| 「通知服务必须用 HTTPS」 | **旧版客户端**的校验 | 升级客户端；当前版本已接受 `http://IP:59994` |
| 「连不上通知服务：…」 | 服务没起 / 端口错 / 防火墙没放 / `HEALTHZ_PORT=0` | 从**客户端那台机器**跑 §4.3 的第 ①② 条 |
| 「注册失败（404）」 | 起的是 `webhook.mjs`（59995）或旧版服务端，59994 上没有 `/v1/bots` | 只用 `pm2 start ecosystem.config.cjs`，`pm2 list` 应只有 `gosslan-relay` 一个条目 |
| 「注册失败（500 / 503）」 | 服务端写盘失败 / 队列满 | `pm2 logs gosslan-relay`；检查 `WEBHOOK_DATA_DIR` 可写 |
| 「只有群主或管理员可以在群里添加机器人」 | 权限不足 | 让群主建，或先被设为管理员 |
| 「请选择要投递到的群」 | 群入口没传 `groupId` | 从群成员面板里的「添加机器人」进入，别从通讯录入口进 |

> **本地优先判据**：在服务器上跑 §1.4 的第 ② 条 `POST /v1/bots`。
> 它返回 `201` 和两个 token ⇒ 服务端没问题，故障一定在「客户端地址 / 网络可达 / 客户端版本」；
> 它返回 404 或连不上 ⇒ 故障在服务端部署，跟 Gosslan 客户端无关。
> 这条能把问题一刀切成两半，别一上来就重装客户端。

### 4.2 发通知 / 收通知异常

| 现象 | 原因 / 处理 |
|---|---|
| 发送返回 `401 {"error":"bad_token"}` | token 写错，或机器人已被删除/撤销（重建一个） |
| 发送返回 `400 {"error":"text_required"}` | 没有 `text`；GET 要带 `?text=`，POST 要有 body |
| 发送返回 `503 {"error":"queue_full"}` | 队列到上限，等过期清理或调大 `NOTIFY_MAX_EVENTS` |
| 发送 200 但客户端没显示 | ① 应用没开着；② 还没到 60 秒轮询（可在详情点「立即取件」）；③ 看 `/healthz` 的 `notify.queued` 是否 >0；④ 确认机器人不是 `paused` |
| `/healthz` 里 `queued` 一直不降 | 客户端 `client_token` 对不上（例如服务端 `notify-bots.json` 被清空过）⇒ 删掉机器人重建 |
| 群里只看到纯文本、没有 Markdown | 预期行为，群线格式冻结；要 Markdown 用个人机器人 |
| 重复收到同一条 | 当前协议无幂等键，检查发送侧是否重试了两次 |

### 4.3 诊断命令清单

```bash
# 在【服务器上】
pm2 list                                      # 应只有 gosslan-relay，且 online
pm2 logs gosslan-relay --lines 50
curl -s http://127.0.0.1:59994/healthz        # ok:true + notify:{bots,queued}
curl -s -X POST http://127.0.0.1:59994/v1/bots \
  -H 'Content-Type: application/json' -d '{"name":"smoke","scope":"personal"}'
ls -la webhook-data/                          # notify-bots.json / notify-queue.json

# 在【客户端那台机器】上（把 IP 换成真实地址；这一步最容易被防火墙拦）
curl -v --connect-timeout 5 "http://<服务器IP>:59994/healthz"
# 云服务器还要确认安全组入站放行了 59994/TCP（和 59993/TCP）
```

## 5. 复跑自检

```bash
# 服务端：条数现读脚本末尾「自测通过：N 条」；覆盖三方法 / 离线留存 / ack / TTL / 上限 / 中文 / 长轮询 / limit / 断连 / 撤销唤醒
cd gosslan-relay-server && node notify-selftest.mjs
# 写盘失败回滚另有一个脚本（需独立数据目录，勿与上面混跑）
node notify-persist-selftest.mjs

# 客户端
cd gosslan && npm test
cd src-tauri && cargo test --features bluetooth --lib
```

## 6. 信任边界（务必读完）

- 这是**自托管**服务，运营者能看到消息**明文**并落盘，**不是端到端加密**。
  别用它传密码、密钥、个人隐私。
- `send_token` 在 URL 路径里，会进反代 / 访问日志；`client_token` 明文存在服务端配置里。
- 当前协议**有意去掉**了 Authorization 头、HMAC 摘要、幂等键、租约重投
  （见 `docs/notes/webhook-simple-protocol-v7-2026-11-17.md` 的取舍表）。
  代价是：token 泄露即可冒充发送、网络抖动可能重复或丢一条。
- 机器人是**单向**的：外部只能往里发，读不到对方回复，也读不到聊天记录。
- 一个机器人只服务一个目标（某个人的会话或某个群）；要发到多个目标就建多个机器人。
- 客户端对通知服务地址仍拒绝 userinfo / query / fragment / 带路径 / 非法端口，
  这些边界与地址是否 HTTPS 无关。
