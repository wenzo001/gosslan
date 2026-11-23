# 外部接入指南：设备快捷认证 与 分享到会话（2026-11-14）

> **2026-11-17 更新**：① origin 与元数据端点**同时支持 HTTP 和 HTTPS**
> （含 `http://IP:端口` / `http://localhost:端口`），用于对方接入与自测；
> ② 确认页改为**一键允许**：申请的交付项默认全选，用户点一次「允许」即完成，
> 页面明列将同步什么，仍可逐项取消；③ 同步范围 = 设备凭证（登录）+ 好友/群列表 +
> 分享到会话，**不含机器人密钥**。
>
> ⚠️ **HTTP 的安全取舍（请务必读）**：HTTP 是明文，同一局域网/链路上的人可能看到
> 设备凭证与好友/群列表。这是用户明确要求的接入便利取舍 —— **生产环境请务必用 HTTPS**；
> HTTP 只建议用于本机/内网开发联调。客户端会强制「端点与 issuer 同协议同源」，
> 不接受 https→http 降级或跨域。
>
> **2026-11-19 更新（先登录后绑定 / 解绑 / 内网部署 / 重复唤起）**：
> - **先登录后绑定 + 无账号快速注册**：从没绑过你应用的设备现在可直接发 `action=authenticate`
>   （或 `sync`），批准时自动完成首绑、签发稳定 pairwise `device_subject`，不要求预先 `link`。
>   你的服务端**必须**以这个 subject 作为账号主键：有账号就登录，没有就用它（+ 用户批准的
>   昵称）快速注册。**绝不能用昵称匹配已有账号**（改名即可冒充他人）。详见 §六.4 与 §1.10。
> - **解绑与解绑后可再绑**："撤销"让本机授权立即失效并尽力通知你的 `revocation_endpoint`；
>   设置页另有"移除"（二次确认），可清掉中间态 / 撤销态 / 异常残留的本地记录。移除后该应用
>   可重新走完整绑定流程。注意：**撤销/移除只改变本机状态**，你的服务端仍须在自己的账号页
>   按 `kid` 作废这把公钥，否则旧凭证在你那边依旧有效。
> - **公司内网自签证书**：客户端除公共 CA 外还信任**操作系统/钥匙串的受信任根证书**。
>   请让你的 IT 把签发 RP 证书的企业 CA 装入客户端机器的系统信任库（Windows 证书管理器 /
>   macOS 钥匙串），并确保证书 **SAN 覆盖实际访问的域名**（证书签给 `localhost`、却用
>   `rp.corp.example` 访问会失败）。客户端仍逐笔校验证书链，不接受"跳过校验"。若报证书错，
>   错误文案会直接提示这一项。
> - **域名深链唤起（App Link）是可配置的部署项**：Android 清单里的 host 目前是保留占位
>   `link.example.invalid`，需接入方替换为真实域名并发布 `https://<域名>/.well-known/assetlinks.json`
>   （iOS 需配 Associated Domains + `apple-app-site-association`）。**未配置前**，请让用户在
>   Gosslan 设置 → 第三方接入页用"粘贴授权链接"完成绑定 —— 这是内网部署最可靠的通道，
>   不依赖系统 App Link 关联。

> 读者：**外部应用的开发者**（RP = relying party，要接入登录的那一方），不是本仓的维护者。
> 维护者视角的取舍、现状与准入判据在
> [`external-auth-integration-contract-2026-11-14.md`](external-auth-integration-contract-2026-11-14.md)。
>
> 本文件只写**已经实现的**协议面。凡是还没跑过真机/真实 RP 的项，一律在文末「验收状态」里
> 标 `NOT RUN`，不在这里承诺。

## 0. 先看清产品边界（决定了你能拿它做什么）

- Gosslan **不是账号提供方**。它没有全局账号、邮箱、头像或「用户指纹」服务。
- 它做的事只有一件：把**某个 Gosslan 安装**登记成你那边一条**可撤销的设备凭证**，并在
  每次登录时让用户在 Gosslan 原生界面**确认一次**。
- 账号、会话、资料、权限、撤销后的处置，全部由**你的服务端**负责。
- 没有任何「网页直接调用本机能力」的桥。外链窗口里的第三方页面拿不到 IPC，
  这一点是刻意的（见维护者契约 §6）。所以接入方式是**深链 + 你的服务端**，不是 JS SDK。

术语：**设备绑定**（link，或首次 authenticate 时自动建立）、**设备快捷认证**（authenticate）、**设备凭证**。
不要用「用户指纹」「永久身份」「同步账号资料」这类词 —— 实现里没有这些语义。
「先登录后绑定」指从没绑过的设备可直接发 authenticate，批准时自动完成首绑，无需预先 link；
账号关联一律以断言里的 pairwise `device_subject` 为准，昵称只是可选展示字段。

### 0.2 接入分类速查（我要哪几类，自己组合）

三类能力**互相独立**：可以只接一类，也可以全接。**分开接不需要多写任何一行代码** ——
它们是三条不同的入口，不是一个「权限包」。

| 我要什么 | 接入方要做的事 | 用户会看到几步 | 本文对应章节 |
|---|---|---|---|
| **只要登录** | 三个端点（metadata / request / decision）+ 校验断言 | **1 步**（点「批准」） | §1.1~§1.9 |
| **还要数据**（好友列表 / 消息通知 / 群列表） | 在 `requested_scopes` 里声明要哪几项，其余不变 | **1 步**（2026-11-17 起全部默认勾选，点一次「允许」；仍可逐项取消） | §1.10 |
| **还要分享**（把内容发到会话） | 实现分享深链 `gosslan://share`，可选回执 | **2~3 步**（选会话 → 发送） | §2、§2.7 |
| **全都要** | 上面几样都做 | 各步相加 | 全文 |

**数据交付只要一步**：2026-11-17 起，你申请的交付项在确认页**默认全勾**，
用户点一次「允许」就完成（页面明列将同步什么，仍可逐项取消）。
授权只对本次事务有效，不落库、不跨应用继承。

**为什么分享不在 scope 体系里**：分享是**一次用户动作**（选谁、说什么、点发送），
不是一项长期授权。把它做成 scope 等于「点一次同意、以后所有分享自动放行」——
那是把动作当权限，本实现不做。

### 0.1 没有签名包怎么自测（两条兜底入口）

深链（`gosslan://…` / App Links）靠**系统协议注册**才通。开发期构建、未签名包、以及没做协议
注册的 Linux 桌面拿不到注册 —— 那时点链接会「什么都没发生」。为了不让你必须先把安装包签名
才能验证协议，客户端在**设置 → 第三方接入**（2026-11-17 起独立成 tab，此前在「关于」）留了两个粘贴入口：

| 入口 | 粘什么 | 走的后端路径 |
|---|---|---|
| 「授权链接」 | `gosslan://authorize/<ref>?origin=…` 或 https 形态 | 与深链**同一个** `handle_device_auth_link` |
| 「分享链接」 | `gosslan://share?url=…` 或 https 形态 | 与深链**同一个** `begin_share` |

两条都**不是**额外的信任通道：解析、限额、去重、排队、确认页/分享面板全都不变，所以
「粘贴能过」等价于「深链能过」。

唯一的差别在**失败的可见性**：粘贴是同步调用，失败会当场弹一条可读提示；深链那条路，
分享失败也会提示（`share-error`），但**授权失败只写客户端日志**——因为对授权来说「确认页没
出现」与「用户关掉了确认页」本来就是一个结局（= 没批准），客户端不区分这两者。联调时如果
你只看到「没反应」，先用粘贴入口复现，能拿到具体原因。

真机唤起（系统把链接交给应用）仍属 `NOT RUN`，见 §5 —— 粘贴入口不能替代它。

## 1. 设备快捷认证（登录）

### 1.1 端到端时序

```text
浏览器/你的应用                      Gosslan                     你的服务端(RP)
      │                                │                             │
  1   │ 用户点「用 Gosslan 登录」        │                             │
      │─────────────────────────────────────────────────────────────▶│ 创建事务(未确认)
      │◀─────────────────────────────────────────────────────────────│ request_id
  2   │ 打开深链 gosslan://authorize/<request_id>?origin=<你的 origin> │
      │───────────────────────────────▶│                             │
  3   │                                │ GET /.well-known/gosslan-device-auth
      │                                │────────────────────────────▶│
      │                                │ GET <request_endpoint>      │
      │                                │────────────────────────────▶│
  4   │                                │ 原生确认页（用户批准/拒绝）    │
  5   │                                │ POST <decision_endpoint>    │
      │                                │  Idempotency-Key: <jti>     │
      │                                │────────────────────────────▶│ 校验断言、建会话
  6   │ 浏览器轮询自己的后端拿登录结果    │                             │
      │─────────────────────────────────────────────────────────────▶│
```

要点：

- **第 2 步之后客户端只信任「与深链同协议同源」的元数据**（HTTP 或 HTTPS，取决于
  issuer），不跟随任何重定向；不接受 https→http 降级。
- **第 5 步是唯一一次回写**。你在收到 2xx 之前不要建会话。
- 客户端**不轮询**你的服务；登录结果由你的页面自己轮询（`poll_endpoint` 字段客户端只保留不使用）。

### 1.2 深链格式

两种形态，二选一（origin 支持 **http / https**，可带端口；不带 userinfo / query / fragment）：

```text
gosslan://authorize/<request_id>?origin=http%3A%2F%2F127.0.0.1%3A59995
http://127.0.0.1:59995/authorize/<request_id>
https://your-app.example.com/authorize/<request_id>
```

- HTTP 形态用于自测/内网接入；第二种 HTTPS 要生效，需要把 `https://your-app.example.com`
  与 App 做域名关联
  （Android App Links / iOS Universal Links）。关联文件的模板见 `docs/link-handoff/`。
- `request_id` 是**不透明**的：客户端不解析，只原样带去 `request_endpoint`。
- 系统没注册协议时（开发期构建、未签名包），把整条链接粘到设置页的「授权链接」里，见 §0.1。

### 1.3 元数据端点（`GET /.well-known/gosslan-device-auth`）

必须与深链 origin **同协议同源**（issuer 是 http ⇒ 端点也是同主机同端口的 http；
issuer 是 https ⇒ 端点必须 https）。字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol_version` | string | 是 | 当前 `"1"`；不认识就整笔拒 |
| `client_id` | string | 是 | 你的应用标识（稳定不变） |
| `display_name` | string | 是 | 确认页上展示的应用名 |
| `issuer` | string | 是 | 必须等于深链 origin（跨域即拒） |
| `request_endpoint` | string | 是 | 取事务的 URL，同源，可带 `{request_id}` 占位 |
| `decision_endpoint` | string | 是 | 收决策的 URL，同源，可带 `{request_id}` 占位 |
| `poll_endpoint` | string | 否 | 浏览器轮询端点，客户端不使用（保留给契约完整） |
| `supported_actions` | string[] | 是 | 至少含 `link` 与 `authenticate`；要申请数据交付再加 `sync`（见 §1.10） |
| `supported_claims` | string[] | 是 | 只能是 `device_subject` / `device_public_key` / `nickname` |
| `share_receipt_endpoint` | string | 否 | 分享回执端点（定向分享发完后回传结果，见 §2.7）。**与 `issuer` 同协议同源**；不给 = 分享后不回执（与旧行为一致，不是失败） |

### 1.4 事务端点（`GET <request_endpoint>`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `protocol_version` | string | 同元数据 |
| `request_id` | string | 必须与深链里的引用一致（不一致即拒） |
| `client_id` | string | 与元数据一致 |
| `issuer` | string | 与元数据一致 |
| `display_name` | string | 账号提示以外的展示名 |
| `action` | string | `link`（首绑）、`authenticate`（登录）、`sync`（登录+数据交付）。后两者在本机没绑过时会自动首绑，不要求预先 `link` |
| `account_hint` | string | 可选，账号提示（确认页展示，用于防错绑） |
| `requested_claims` | string[] | allowlist 之内；未知 claim **整笔拒** |
| `challenge` | string | 你的随机挑战（要求足够熵） |
| `expires_at` | string | ISO-8601 过期时刻 |
| `requested_scopes` | string[] | 否 | 本次要交付什么（见 §1.10）。**只有 `action=sync` 能带**；其它动作带它、或带未知值 ⇒ 整笔拒 |

### 1.5 决策回写（`POST <decision_endpoint>`）

请求头 `Idempotency-Key: <jti>`（与下面断言里的 `jti` **同一个值**）。两次回写只有 body 不同：

批准：

```json
{
  "decision": "approve",
  "key_id": "<kid>",
  "public_key": "<base64url 32B Ed25519 公钥>",
  "device_subject": "<pairwise subject>",
  "claims": { "device_subject": "…", "device_public_key": "…", "nickname": "…" },
  "assertion": "<JWS>",
  "data": { "subject": "…", "friends": [ … ], "events": [ … ] }
}
```

`data` 是**可选**的：只有 `action=sync` 且用户批准了对应的交付范围时才有这个键，
**没有就是没交付**（不是空对象）。形状见 §1.10。

拒绝：

```json
{ "decision": "deny" }
```

你回 **2xx** 才算这一笔结束。非 2xx / 超时：客户端保留事务可重试，并把
`rp_notified=false` 上报给用户（用户看到「本机已拒绝，但对方未收到通知，请重试」）。

### 1.6 断言（JWS）与校验步骤

- 算法 `EdDSA`（Ed25519），`typ` 为客户端固定的常量，`kid` = `base64url(sha256(公钥 32B))`。
- 载荷：`iss`(=device_subject)、`aud`(= `"<issuer>/api/device-auth"`)、`client_id`、
  `transaction_id`、`challenge`、`action`、`iat`、`exp`(=`iat+60s`)、`jti`。
- 你必须校验：签名（用 `public_key`）→ `aud` 等于自己的 `issuer + "/api/device-auth"` →
  `client_id` / `transaction_id` / `challenge` 与本事务一致 → `iat/exp` 在窗口内 →
  `jti` 未被用过（防重放）。

`device_subject` 是**按 RP 隔离**的 pairwise 标识：同一个设备在你的应用里与在别人应用里
得到的值不同，不要跨站关联。它证明「某个 Gosslan 安装持有你登记的密钥」，
**不证明自然人身份**。

### 1.7 幂等与重试

- 同一笔事务的网络重试会复用**同一个** `Idempotency-Key`（= 断言 `jti`）⇒ 你的服务端应把
  重复回写合并成一次（否则会重复登记公钥 / 重复建会话）。
- 批准失败后用户可原地重试，**复用同一把 RP 专用密钥**，不会给你造出第二条绑定。
- 同一应用连点多次：客户端对同一应用串行处理，不同应用之间并行。

### 1.8 撤销

- 用户在 Gosslan 设置页撤销后，本地立即失效。
- 用户可以在设置里把已授权应用**导出成一个口令加密的文件**、换机后恢复（与深链无关，纯本地文件）。
  恢复不改变公钥 ⇒ 你的登记仍然有效，撤销逻辑也不用变；但**你看不出**这台机器是不是原来那台
  （导出文件可复制）。
- **双边撤销（可选启用）**：如果你的 metadata 里带 `revocation_endpoint`，客户端撤销时会**尽力**
  `POST` 一次到这个地址（头带 `Idempotency-Key`，体是 `{ client_id, kid }`），让你那边也能作废这把公钥。
  - 端点必须 **与 `issuer` 同协议同源**，否则客户端直接拒（不会把撤销请求发去别处）。
  - 客户端**先本地撤销、再通知**：通知失败不会让本地撤销回滚，但你的服务端会**仍然认这把公钥**，
    所以你的校验流程里必须保留「撤销即拒」的开关，而不是只认签名。
  - 通知**不带私钥、不带断言** —— 你收到的是「客户端说这把 kid 该撤了」，不是「客户端证明它持有私钥」。
  - 通知失败时，客户端在列表里给那条已撤销的应用留一个「重发撤销通知」的入口 ——
    你那边按同一个 `Idempotency-Key` 合并重复通知即可（**你的撤销动作本身要幂等**）。
  - 没有 `revocation_endpoint`（或该 RP 还没升级）时，客户端只做本地撤销，与旧行为一致。
- **RP 侧公钥始终可以自己在账号页撤销**（账号页那条路不受上面这个可选端点影响）。
  因此你的校验流程里必须保留「撤销即拒」的开关，而不是只认签名。

### 1.9 最小服务端示例（Node/Express，仅示意字段关系）

```js
app.get("/.well-known/gosslan-device-auth", (req, res) => {
  res.json({
    protocol_version: "1",
    client_id: "acme",
    display_name: "Acme 控制台",
    issuer: "https://acme.example.com",
    request_endpoint: "https://acme.example.com/device-auth/requests/{request_id}",
    decision_endpoint: "https://acme.example.com/device-auth/decisions/{request_id}",
    // 可选：给了客户端就会在撤销时通知你（必须与 issuer 同协议同源）。
    // 不给 = 客户端只做本地撤销，你这边照旧在账号页手动撤销。
    revocation_endpoint: "https://acme.example.com/device-auth/revoke",
    supported_actions: ["link", "authenticate"],
    supported_claims: ["device_subject", "device_public_key", "nickname"],
  });
});

// 撤销通知（可选）：客户端撤销时 POST 一次到这里。
// 体是 { client_id, kid }，头带 Idempotency-Key —— 同一把钥匙的重复通知要合并成一次。
app.post("/device-auth/revoke", express.json(), (req, res) => {
  const idem = req.get("Idempotency-Key") ?? "";
  if (seenRevocations.has(idem)) return res.status(200).json({ ok: true });
  seenRevocations.add(idem);
  revokePublicKey(req.body.kid); // 之后这把 key 的断言一律拒
  res.status(200).json({ ok: true });
});

app.post("/device-auth/decisions/:id", express.json(), (req, res) => {
  const idem = req.get("Idempotency-Key") ?? "";
  if (seenDecisions.has(idem)) return res.status(200).json({ ok: true }); // 重复回写合并
  if (req.body.decision === "deny") {
    seenDecisions.add(idem);
    return res.status(200).json({ ok: true });
  }
  const ok = verifyAssertion(req.body.assertion, req.body.public_key, txnOf(req.params.id));
  if (!ok) return res.status(400).json({ error: "bad_assertion" });
  seenDecisions.add(idem);
  res.status(200).json({ ok: true });
});
```

## 1.10 数据交付（`sync`）：把好友列表与消息通知给你的页面

除了登录，你还可以让用户**在你自己的页面上**看到他的好友列表与最近收到的消息通知。
这一节是可选能力，**不实现也不影响 §1 的登录**。

### 什么时候用

典型场景：你的页面里有个「同步好友」按钮，用户点了之后，页面上就列出他的好友，
并让他挑一个直接分享到你应用里的某个会话。

### 流程

1. 你建一个事务：`action=sync`、`requested_scopes` 写你要的东西。
2. 深链唤起 Gosslan（同 §1.2 的形状），**用户会看到一个确认页**：
   应用名、来源域，以及「这个应用还想要」的几项（**默认全勾，可逐项取消**；
   点一次「允许」即完成）。
3. 用户批准 ⇒ 客户端把数据**随决策回写一起**送到你的 `decision_endpoint`（§1.5）。
4. 你按 `data` 的形状取用。

### `requested_scopes` 只有三个值

| scope | 交付什么 |
|---|---|
| `friends.read` | `friends`：好友的 `device_id` 与 `nickname`（**没有公钥、没有在线态**） |
| `events.metadata` | `events`：最近收到的消息的 `conv_id` / `sender_id` / `kind` / `ts` / `seq` + 通知性两位 `mentions_me`（这条 @ 了本机用户吗）/ `notifies`（这条会弹通知吗）（**没有正文**） |
| `groups.read` | `groups`：群的 `group_id` / `name` / `member_count`（**没有成员明细、没有群密钥、没有正文**） |

写了别的值 ⇒ **整笔拒**（`DEVICE_AUTH_UNKNOWN_SCOPE`），不是静默忽略。
没写任何值、却用 `action=sync` ⇒ 也拒（那是个空申请）。

### `data` 的形状

```json
"data": {
  "subject": "<pairwise subject>",
  "friends": [ { "device_id": "…", "nickname": "…" } ],
  "groups": [ { "group_id": "…", "name": "…", "member_count": 3 } ],
  "events": [ {
    "conv_id": "…", "sender_id": "…", "kind": "text",
    "ts": 1731600000000, "seq": 42,
    "mentions_me": true,     // 这条 @ 了本机用户
    "notifies": true         // 这条会触发通知（表情回应、撤回、置顶这类静默事件不算）
  } ]
}
```

**键按你请求的 scope 出现**：没请求 `friends.read` 就**没有 `friends` 这个键**
（不是空数组）。用户也可以在确认页里**只勾一部分** —— 那就只交付勾了的那部分。

### 六条硬限制（请照着设计你的页面）

1. **没有后台推送**。交付只在用户当场点、当场批准时发生一次。
   应用闲置时不会向你发任何东西。
2. **每次都要用户确认**。你的页面不能静默拿到数据。
3. **scope 只对本次事务有效**，不落库。下次要数据就再走一遍流程。
4. **先登录后绑定（2026-11-19 起）**：`authenticate` / `sync` 在该设备从没绑过你的应用时，
   会自动生成一份 RP 专属密钥与稳定 `pairwise_subject`（与 `link` 首绑同一形状），批准即建立
   本机身份，不要求预先 `link`。**你的服务端必须用断言里的 `pairwise_subject` 作为账号主键**：
   已有该 subject 就登录对应账号，没有就用它（+ 用户批准的昵称）快速注册新账号。
   ⚠️ 绝不能用昵称/设备名去匹配已有账号 —— 那会让任何人改用同名就能冒充他人登录。
   仅当绑定处于「首绑后等你回调确认」的中间态（pending_registration）时再次登录会被拒
   （`DEVICE_AUTH_NO_BINDING`）；正常流程里你的服务端收到断言后回写 2xx 即激活。
5. **消息正文永远不外送**。`events` 里没有 `content`。
   如果你的产品需要正文，那是另一个决定，不在这份契约里。
   `groups` 同理：只有 id / 名称 / 人数，**没有成员明细**（成员明细基本就是好友集合，
   已由 `friends.read` 单独授权 ⇒ 再给一遍就是「一个 scope 偷渡另一个 scope 的内容」）。
6. **不承诺隐藏**：`device_id` 是设备标识，跨应用可关联（这是 P2P 的既有暴露面，
   本契约不扩大它，也不承诺隐藏）。

## 2. 分享到会话

### 2.1 入口

任何网页、任何应用都能拉起（**不需要**域名关联，因为它是自定义 scheme）：

```text
gosslan://share?url=<urlencoded>&title=<urlencoded>&text=<urlencoded>&origin=<urlencoded>
```

已经做了域名关联的站点也可以用 HTTPS 形态（来源自动取链接主机）：

```text
https://your-app.example.com/share?url=…&title=…&text=…
```

系统没注册协议时（开发期构建、未签名包），把整条链接粘到设置页的「分享链接」里，效果与深链
相同（同一段后端逻辑），见 §0.1。

### 2.2 参数

| 参数 | 必填 | 上限 | 说明 |
|---|---|---|---|
| `url` | 否* | 2048 码点 | 被分享的链接。**只接受 `http` / `https`**；`javascript:` / `data:` / `file:` 一律整笔拒 |
| `title` | 否* | 300 码点 | 标题 |
| `text` | 否* | 2000 码点 | 原文 / 选中文字 |
| `origin` | 否 | — | 你**自称**的来源，必须是 http/https origin（2026-11-17 起允许 http 内网 IP:端口 / localhost）。仅用于在面板上给用户一个线索，**不参与任何信任判断**；但带 `receipt` 时必填，用于校验回执同源（2026-11-20 起无 `origin` 的 `receipt` 整笔拒，防 SSRF） |

\* 三者至少给一个，否则整笔被拒（不会弹一个空面板）。

未知参数会被忽略（方便你以后加字段）；已知参数非法则**整笔拒**，不会静默丢弃 ——
丢掉 `url` 只留标题会让用户以为分享的就是那段文字。

### 2.3 用户看到什么

1. 一个面板：来源主机名、链接（只读）、一段**可编辑**的正文（默认按 `text` → `title` → `url` 拼接并去重）。
2. 会话列表 + 搜索。**不预选任何会话**，可以勾多个（逐项勾选，不是"发给最近的人"）。
3. 用户必须勾好目标并点「发送」（多选时按钮显示目标数）。每个目标都走与手动发消息**完全相同**的
   通道（乐观上屏、台账、失败态）。
4. 部分失败：已成功的**不会重发**，面板保留、只把失败的那几个留作勾选，草稿不动，可直接再点一次。
5. 关闭面板 = **什么都不发**。不存在「自动发到最近会话」。

### 2.4 你能拿到什么反馈

没有回调、没有 JS 事件。分享是**单向**的：内容递进应用，之后由用户决定。

- 内容不合法 / 队列满（同时最多 8 条待处理，10 分钟内有效）时，用户会看到一条可读提示，
  你不会收到通知。所以**别把分享当成必须成功的步骤**（例如别把它当成支付回调）。
- 同一份内容重复触发只会出现一个面板（按内容去重）。

### 2.5 示例

网页按钮：

```html
<a href="gosslan://share?url=https%3A%2F%2Fexample.com%2Fpost%2F1&title=标题&text=摘要&origin=https%3A%2F%2Fexample.com">
  分享到 Gosslan
</a>
```

JS 构造（注意 `encodeURIComponent`）：

```js
const link = "gosslan://share?" + new URLSearchParams({
  url: location.href,
  title: document.title,
  text: (window.getSelection()?.toString() ?? "").slice(0, 2000),
  origin: location.origin,
}).toString();
location.href = link;
```

### 2.6 目前**不**支持

| 期望 | 现状 |
|---|---|
| 文件（图片/文档）分享 | 不支持。只能分享链接与文字；传文件请用应用内的发送入口 |
| 系统分享面板（macOS Share Extension / Windows 分享目标 / Android ACTION_SEND） | **读取端已实现，平台写入端未实现**：应用会捡起平台扩展写进「落地区」的文件，与深链走同一个面板、同一套限额（协议见 [`system-share-target-design-2026-11-15.md`](system-share-target-design-2026-11-15.md)）；但 macOS/Windows 的扩展本体需要独立工程与签名证书，**用户现在装不上** |
| 受控分享 `gosslan://share/<ref>` 或 `https://<host>/share/<ref>` | 链接形状已能解析，但需要 RP 侧提供一个「用 ref 换内容」的端点；**本期明确回「暂不支持」** |
| 网页预览 / 抓取 OG 标签 | 不做。抓取等于把任意 URL 交给本机去请求（SSRF / 内网探测 / 跟踪像素） |
| 分享结果的回执 | **可做（可选）**：带 `receipt=<http(s) 同源地址>` 且同时带 `origin` 才有，见 §2.7；回执只含状态与条数 |
| 定向分享（预填目标） | **可做（可选）**：带 `to` + `to_kind` 才有，见 §2.7。**只是预填，用户仍要点发送**；目标不存在则整笔拒 |
| 群密钥、群成员明细 | 不做。§1.10 的 `groups.read` 只给群 id / 名称 / 人数 |

## 2.7 定向分享（可选）：让用户一键发到指定的人

分享默认是「内容递进来，用户自己在面板里挑会话」。如果你还希望**预填**一个目标
（比如「发给这个好友」），可以带上两个参数。

### 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `to` | 与 `to_kind` 同时 | 目标会话 id：单聊 = 对方设备 id（你从 §1.10 的 `friends` 里拿到的 `device_id` 就是它），群 = `group:<群 id>` |
| `to_kind` | 与 `to` 同时 | `peer`（单聊）或 `group`（群） |

```text
gosslan://share?url=…&to=gosslan-<设备 id>&to_kind=peer&origin=https://your-app.example.com
```

### 五条规则

1. **只是预填，不是代发**。面板照常出现、目标被**勾上并高亮**，但用户**必须点「发送」**。
   静默代发等于任何网页都能往用户聊天框塞东西。
2. **目标必须存在**，否则**整笔拒**（`EXTERNAL_SHARE_BAD_TARGET`）：不在好友列表 ⇒ 拒；
   群不在群列表 ⇒ 拒。**不会**替你新建会话、不会猜、不会广播。
3. **没聊过的朋友也会出现在面板里**：客户端会先为这个好友建一个空会话（不发任何消息），
   否则面板列不出来，就没法「一键发给他」。
4. **群 id 从 §1.10 的 `groups.read` 拿**（`groups[].group_id`，拼成 `group:<群 id>`）；
   没申请这个 scope 时就拿不到 ⇒ 让用户自己在面板里选。
   （2026-11-20 更正：括号内旧句"群列表不在本次授权范围内"已过时——`groups.read` 已于
   2026-11-15 开放，交付群 id / 群名 / 人数，不含群成员明细。所以申请了该 scope 就能拿到群列表。）
5. **回执是可选的**：加 `receipt=<地址>`（必须与 `origin` 同协议同源），
   用户点完发送后客户端会 `POST` 一次 `{ share_id, status, sent, failed }`。
   回执**不含会话名、不含分享内容**。不写 `receipt` ⇒ 不回执（不是错误）。
   - `status` 有三种：`sent`（全部成功）/ `partial`（部分成功）/ `cancelled`
     （**用户取消**，2026-11-23 起：`sent=0 failed=0`——你方页面不要在用户取消后干等）。
   - `Idempotency-Key` 就是 `share_id`：同一笔分享的多条回执（如先 `partial` 后 `cancelled`）
     你方按此键合并成一条。
   - **你方必须自带超时**：客户端对回执请求本身有超时、待处理条目 10 分钟后过期；
     超时内没等到回执就视为用户放弃，不要无限等待（用户 2026-11-23）。

## 3. 版本化与兼容

- 元数据与事务都带 `protocol_version`，当前 `"1"`。加字段不算破坏；**改语义或删字段才升版本**。
- 客户端对未知字段宽容（忽略），对未知 `claim`、未知 `action`、未知协议版本**整笔拒**。
- 分享入口的未知 query 参数被忽略，所以给分享加参数是向后兼容的。

## 4. 接入自测清单

自测入口：有签名包就用真机点链接；没有就用 §0.1 的两个粘贴入口（两者走同一段后端逻辑）。

登录：

- [ ] 元数据端点与深链 origin 同源，HTTPS 200，字段齐全。
- [ ] 深链打开后确认页显示的应用名与 `account_hint` 正确，来源域可见。
- [ ] 批准后 `decision_endpoint` 收到 `approve`，`Idempotency-Key` 与断言 `jti` 相同。
- [ ] 断网重试：同一次批准重试两次，`Idempotency-Key` **不变**，你的服务端只建一个会话。
- [ ] 拒绝：收到 `deny`；若你回非 2xx，用户界面出现「重试拒绝」入口。
- [ ] 换一台设备再绑：`device_subject` 不同（pairwise 隔离）。
- [ ] 撤销后旧断言被你的服务端拒绝。

数据交付（可选，见 §1.10）：

- [ ] 用 `action=sync` 建事务：从没绑过的设备批准时自动首绑（无需先 `link`），
      已绑过的设备复用同一密钥；两者都能拿到交付数据。
- [ ] 确认页列出「这个应用还想要」的两项，且**默认都没勾**。
- [ ] 全勾后批准：回写 body 里**有** `data`，且 `data.friends` 有好友、`data.events` 有事件。
- [ ] 只勾一项：回写里**只有**那一个键（另一个键不存在，不是空数组）。
- [ ] 一个都不勾：回写里**没有** `friends` 与 `events`。
- [ ] `data.events` 的每一条都**没有** `content` 字段。
- [ ] `data.events` 的每一条都有 `mentions_me` 与 `notifies` 两个布尔；
      一条 @ 了本机的消息 `mentions_me=true`，一条表情回应 `notifies=false`。
- [ ] `data.friends` 的每一条都**没有**公钥字段。
- [ ] 用没 `link` 过的应用申请 `authenticate` / `sync`：批准即成功（自动首绑），
      断言含稳定 `pairwise_subject`，你的服务端据此登录或快速注册。
- [ ] 首绑后、你的服务端还没回写确认（pending_registration）时再次登录：被拒
      （`DEVICE_AUTH_NO_BINDING`），提示对方稍后重试。
- [ ] `requested_scopes` 里写 `groups.read`：整笔拒（`DEVICE_AUTH_UNKNOWN_SCOPE`）。
- [ ] 同一个 `Idempotency-Key` 重放：你的服务端合并成一次。

分享：

- [ ] `gosslan://share?url=…` 能拉起面板并显示来源主机名。
- [ ] 面板里改正文后发送，收到的消息就是改过的内容。
- [ ] 关闭面板后没有任何消息发出。
- [ ] `url=javascript:alert(1)` 被拒（用户看到「分享内容为空，或链接不是 http/https」）。
- [ ] 超长正文（>2000 字）被拒，提示可读。
- [ ] 带 `to` + `to_kind=peer`（好友的设备 id）：面板出现且**那个目标被勾上并高亮**；
      **不点「发送」则一条都不发**。
- [ ] 带 `to` 指向一个不在好友列表里的设备 id：整笔拒（`EXTERNAL_SHARE_BAD_TARGET`），
      **面板不出现**，且**没有新建会话**。
- [ ] 带 `to=group:<群 id>`（已知群）：面板出现、那个群被勾上。
- [ ] 带 `receipt=`（http 或 https，**与 `origin` 同协议同源**，且必须同时带 `origin`）：
      发送后你收到一次 `POST`，体是 `{ share_id, status, sent, failed }`，**没有会话名与内容**。
- [ ] 带 `receipt=` 但**不带 `origin`**：整笔拒（2026-11-20 SSRF 加固，无来源无从校验回执归属）。
- [ ] 打开面板后点**取消**：`receipt` 端点收到 `status=cancelled`（`sent=0 failed=0`，
      2026-11-23 起）；不点取消就 TTL 过期 ⇒ 无回执（你方按超时兜底）。
- [ ] 带 `receipt=`（跨协议 / 跨源 / 非 http(s) scheme，如 `file:`）：整笔拒。

## 5. 验收状态（诚实边界）

| 项 | 状态 |
|---|---|
| 协议解析 / 限额 / 排队的自动化用例 | 已通过（Rust 单测 + 前端单测） |
| 桌面系统协议注册与真实点击唤起 | `NOT RUN`（需签名安装包 + 真机） |
| Android App Links / iOS Universal Links | `NOT RUN`（配置骨架已就位，需域名关联文件与真机） |
| 真实 RP 后端联调 | `NOT RUN`（本仓只有内存 mock：`scripts/device-auth-rp-mock.mjs`） |
| 系统分享面板 / 文件分享 / 受控 share request | 未实现（见 §2.6） |
| 设置页两个粘贴兜底入口（登录 / 分享） | 已实现，链路有单测钉着（`src/utils/shareWiring.test.ts` 等）；真机深链仍 `NOT RUN` |

## 6. 附录：错误码与你会看到什么

客户端**不把这些码发给你**（回写只有 §1.5 的决策与断言）。它们出现在用户的提示与客户端日志里
—— 联调时你听到「用户说弹了个框」，可以对照这张表定位是谁的问题。

| 错误码 | 触发条件 | 用户看到 | 你该做什么 |
|---|---|---|---|
| `DEVICE_AUTH_INVALID_LINK` | 深链形状不对（scheme / 路径不认识，或缺 `<ref>`） | 授权链接不正确 | 检查深链拼装与 URL 编码 |
| `DEVICE_AUTH_INVALID_ORIGIN` | `origin` 不是合法 http/https origin（带 userinfo / query / fragment） | 应用来源不是有效的 http(s) 地址 | 传干净的 `https://host[:port]` 或 `http://host[:port]` |
| `DEVICE_AUTH_CROSS_ORIGIN` | 元数据 `issuer` 与深链 origin 不同源 | 应用来源与端点不一致，已拒绝 | 两者必须是同一个 origin |
| `DEVICE_AUTH_BAD_METADATA` | 元数据缺字段、端点非 HTTPS、端点是跨源 | 应用认证信息不完整 | 按 §1.3 补齐；端点必须同源 HTTPS |
| `DEVICE_AUTH_UNSUPPORTED` | `protocol_version` 不认识，或不支持该 `action` | 不支持的认证协议或动作 | 用 `"1"`，并在 `supported_actions` 里声明要用的动作 |
| `DEVICE_AUTH_UNKNOWN_CLAIM` | `requested_claims` 超出 allowlist 或不在你的 `supported_claims` 里 | 请求了不支持的信息字段 | 只用三个允许的 claim |
| `DEVICE_AUTH_UNKNOWN_SCOPE` | `requested_scopes` 里有 allowlist 之外的值；或 `action=sync` 却没写 scope；或非 `sync` 动作却带了 scope | 请求了不支持的共享范围 | 只用 `friends.read` / `events.metadata` / `groups.read`，且只放在 `action=sync` 的事务里（§1.10） |
| `DEVICE_AUTH_BAD_REQUEST` | 事务字段不合法（`request_id` 不一致、`expires_at` 过期等） | 认证请求不正确 | 事务与深链引用必须同一条 |
| `DEVICE_AUTH_EXPIRED` | 确认页停留超过有效期（本地上限 5 分钟，取你的 `expires_at` 与它的较小值） | 授权已过期，请重新发起 | 重新建事务；别复用旧 `request_id` |
| `DEVICE_AUTH_NETWORK` | 拉元数据/事务超时或非 2xx | 与应用通信失败，请稍后再试 | 检查端点可达性、TLS 与状态码 |
| `DEVICE_AUTH_REPLAYED` | 同一事务被再次批准（已消费），或事务代际已变更 | 该授权已处理过 | 一次事务只该有一次决策；你仍要做幂等（§1.7） |
| `DEVICE_AUTH_NOT_FOUND` | 待确认事务已被清除/从未存在 | 授权请求不存在或已清除 | 重新发起 |
| `DEVICE_AUTH_BINDING_REVOKED` | 本机对该应用是撤销态，又收到 `authenticate` | 绑定已撤销，请先在本机移除后重新绑定 | 引导用户在 Gosslan 设置页点「移除」清掉撤销态绑定，再走 `link`；你服务端那把公钥仍须按账号页流程作废 |
| `DEVICE_AUTH_BINDING_EXISTS` | 已有撤销态绑定，又收到 `link` | 已有撤销态绑定，请先在本机移除后再绑定 | 引导用户在 Gosslan 设置页点「移除」清掉撤销态绑定后重新 `link`（移除后可绑出一把新密钥）；你账号页的授权仍需自行作废 |
| `DEVICE_AUTH_NO_BINDING` | 首绑后还处于 pending_registration（你的服务端尚未回写确认）时又来 `authenticate`/`sync`；或绑定是待登记/登记失败态 | 正在等待该应用完成登记，请稍后重试或重新发起 | 你的服务端收到断言后要按 §决策回写及时回 2xx 激活绑定；之后同一设备再登录即走 active 路径。**从没绑过**的设备现在不会报这个码——会自动首绑（先登录后绑定）。绑定键是 `(规范化 origin, client_id)`，域名/端口/IP 或 client_id 变化算另一个应用：内网自签 + hosts 部署要确保 origin 稳定，否则会被当成新设备重新注册 |
| `DEVICE_AUTH_BUSY` | 待确认队列已满（上限 4） | 待确认的授权太多，先处理手上这几条 | 别把多条授权并发塞给用户 |
| `DEVICE_AUTH_DENY_NOTIFY_FAILED` | 本机已拒绝，回写你失败 | 本机已拒绝，但对方没收到通知，请重试 | 你的 `decision_endpoint` 要能接受重复的 `deny` |
| `EXTERNAL_SHARE_INVALID_LINK` | 分享链接形状不对（不是 share 入口） | 这个分享链接不正确 | 检查 scheme 与路径 |
| `EXTERNAL_SHARE_BAD_CONTENT` | 三个内容参数全空；`url` 不是 http(s)；`origin` 给了但不是合法 http(s) origin；或 `receipt` 无 `origin` / 跨源 / 非 http(s) | 分享内容为空或链接非法（共用这一条提示） | 至少给一个内容；`url` 只放 http(s)；`receipt` 必须配同源 `origin` |
| `EXTERNAL_SHARE_TOO_LARGE` | 超出 §2.2 的码点上限 | 分享内容太长了 | 见 §2.2 三个上限 |
| `EXTERNAL_SHARE_BUSY` | 待处理分享已达 8 条 | 还有几条分享没处理，先处理完再分享 | 不要循环触发；等用户处理 |
| `EXTERNAL_SHARE_REFERENCE_UNSUPPORTED` | 用了受控形态 `/share/<ref>` | 这个分享需要应用侧配合，暂不支持 | 改用内联参数（§2.1） |
| `EXTERNAL_SHARE_BAD_TARGET` | 定向目标形状不合法（种类不匹配 / 字符集 / 长度），或**目标不存在**（不在好友列表 / 不在群列表） | 要分享给的那个人或群不在你的好友列表里 | 目标 id 取自 §1.10 的 `friends[].device_id`（单聊）或 `group:<群 id>`（群）；拿不到就让用户自己在面板里选 |
| `EXTERNAL_SHARE_INCOMING_INVALID` | 落地区里有一份文件不合规（文件名 / 版本 / 正文 / 大小） | **不显示**（只进日志，用户没做任何事） | 检查平台扩展写出的文件是否合协议 |
| `EXTERNAL_SHARE_INCOMING_UNREADABLE` | 落地区里有一份文件读不了（权限、占用） | **不显示**（只进日志） | 检查落地区目录的读写权限 |

维护提示：这张表的两侧都在仓库里 —— 码在 `src-tauri/src/error_codes.rs`，用户文案在
`src/i18n/locales/*.ts`，两张表的双向对账由 `src/utils/errors.test.ts` 钉着。加码必须同时补两边，
否则那条判据当场红。
