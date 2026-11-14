# 外部接入指南：设备快捷认证 与 分享到会话（2026-11-14）

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

术语：**设备绑定**（link）、**设备快捷认证**（authenticate）、**设备凭证**。
不要用「用户指纹」「永久身份」「同步账号资料」这类词 —— 实现里没有这些语义。

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

- **第 2 步之后客户端只信任 HTTPS 同源元数据**，不跟随任何重定向。
- **第 5 步是唯一一次回写**。你在收到 2xx 之前不要建会话。
- 客户端**不轮询**你的服务；登录结果由你的页面自己轮询（`poll_endpoint` 字段客户端只保留不使用）。

### 1.2 深链格式

两种形态，二选一（都要求 HTTPS origin 合法：不带 userinfo / query / fragment / 端口除外）：

```text
gosslan://authorize/<request_id>?origin=https%3A%2F%2Fyour-app.example.com
https://your-app.example.com/authorize/<request_id>
```

- 第二种要生效，需要把 `https://your-app.example.com` 与 App 做域名关联
  （Android App Links / iOS Universal Links）。关联文件的模板见 `docs/link-handoff/`。
- `request_id` 是**不透明**的：客户端不解析，只原样带去 `request_endpoint`。

### 1.3 元数据端点（`GET /.well-known/gosslan-device-auth`）

必须与深链 origin **同源**，且必须是 HTTPS。字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol_version` | string | 是 | 当前 `"1"`；不认识就整笔拒 |
| `client_id` | string | 是 | 你的应用标识（稳定不变） |
| `display_name` | string | 是 | 确认页上展示的应用名 |
| `issuer` | string | 是 | 必须等于深链 origin（跨域即拒） |
| `request_endpoint` | string | 是 | 取事务的 URL，同源，可带 `{request_id}` 占位 |
| `decision_endpoint` | string | 是 | 收决策的 URL，同源，可带 `{request_id}` 占位 |
| `poll_endpoint` | string | 否 | 浏览器轮询端点，客户端不使用（保留给契约完整） |
| `supported_actions` | string[] | 是 | 至少含 `link` 与 `authenticate` |
| `supported_claims` | string[] | 是 | 只能是 `device_subject` / `device_public_key` / `nickname` |

### 1.4 事务端点（`GET <request_endpoint>`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `protocol_version` | string | 同元数据 |
| `request_id` | string | 必须与深链里的引用一致（不一致即拒） |
| `client_id` | string | 与元数据一致 |
| `issuer` | string | 与元数据一致 |
| `display_name` | string | 账号提示以外的展示名 |
| `action` | string | `link`（首绑）或 `authenticate`（登录） |
| `account_hint` | string | 可选，账号提示（确认页展示，用于防错绑） |
| `requested_claims` | string[] | allowlist 之内；未知 claim **整笔拒** |
| `challenge` | string | 你的随机挑战（要求足够熵） |
| `expires_at` | string | ISO-8601 过期时刻 |

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
  "assertion": "<JWS>"
}
```

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
- **RP 侧公钥需要你自己在账号页撤销**（客户端目前是单边撤销，没有通知你的服务端）。
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
    supported_actions: ["link", "authenticate"],
    supported_claims: ["device_subject", "device_public_key", "nickname"],
  });
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

### 2.2 参数

| 参数 | 必填 | 上限 | 说明 |
|---|---|---|---|
| `url` | 否* | 2048 码点 | 被分享的链接。**只接受 `http` / `https`**；`javascript:` / `data:` / `file:` 一律整笔拒 |
| `title` | 否* | 300 码点 | 标题 |
| `text` | 否* | 2000 码点 | 原文 / 选中文字 |
| `origin` | 否 | — | 你**自称**的来源，必须是 HTTPS origin。仅用于在面板上给用户一个线索，**不参与任何信任判断** |

\* 三者至少给一个，否则整笔被拒（不会弹一个空面板）。

未知参数会被忽略（方便你以后加字段）；已知参数非法则**整笔拒**，不会静默丢弃 ——
丢掉 `url` 只留标题会让用户以为分享的就是那段文字。

### 2.3 用户看到什么

1. 一个面板：来源主机名、链接（只读）、一段**可编辑**的正文（默认按 `text` → `title` → `url` 拼接并去重）。
2. 会话列表 + 搜索。**不预选任何会话**。
3. 用户必须选一个会话并点「发送」。发送走的是与手动发消息**完全相同**的通道（乐观上屏、台账、失败态）。
4. 关闭面板 = **什么都不发**。不存在「自动发到最近会话」。

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
| 系统分享面板（macOS Share Extension / Windows 分享目标 / Android ACTION_SEND） | 未实现。需要平台工程改造与签名审核，本期只做深链 |
| 受控分享 `gosslan://share/<ref>` 或 `https://<host>/share/<ref>` | 链接形状已能解析，但需要 RP 侧提供一个「用 ref 换内容」的端点；**本期明确回「暂不支持」** |
| 网页预览 / 抓取 OG 标签 | 不做。抓取等于把任意 URL 交给本机去请求（SSRF / 内网探测 / 跟踪像素） |
| 分享结果的回执 | 不做。见 §2.4 |

## 3. 版本化与兼容

- 元数据与事务都带 `protocol_version`，当前 `"1"`。加字段不算破坏；**改语义或删字段才升版本**。
- 客户端对未知字段宽容（忽略），对未知 `claim`、未知 `action`、未知协议版本**整笔拒**。
- 分享入口的未知 query 参数被忽略，所以给分享加参数是向后兼容的。

## 4. 接入自测清单

登录：

- [ ] 元数据端点与深链 origin 同源，HTTPS 200，字段齐全。
- [ ] 深链打开后确认页显示的应用名与 `account_hint` 正确，来源域可见。
- [ ] 批准后 `decision_endpoint` 收到 `approve`，`Idempotency-Key` 与断言 `jti` 相同。
- [ ] 断网重试：同一次批准重试两次，`Idempotency-Key` **不变**，你的服务端只建一个会话。
- [ ] 拒绝：收到 `deny`；若你回非 2xx，用户界面出现「重试拒绝」入口。
- [ ] 换一台设备再绑：`device_subject` 不同（pairwise 隔离）。
- [ ] 撤销后旧断言被你的服务端拒绝。

分享：

- [ ] `gosslan://share?url=…` 能拉起面板并显示来源主机名。
- [ ] 面板里改正文后发送，收到的消息就是改过的内容。
- [ ] 关闭面板后没有任何消息发出。
- [ ] `url=javascript:alert(1)` 被拒（用户看到「分享内容为空，或链接不是 http/https」）。
- [ ] 超长正文（>2000 字）被拒，提示可读。

## 5. 验收状态（诚实边界）

| 项 | 状态 |
|---|---|
| 协议解析 / 限额 / 排队的自动化用例 | 已通过（Rust 单测 + 前端单测） |
| 桌面系统协议注册与真实点击唤起 | `NOT RUN`（需签名安装包 + 真机） |
| Android App Links / iOS Universal Links | `NOT RUN`（配置骨架已就位，需域名关联文件与真机） |
| 真实 RP 后端联调 | `NOT RUN`（本仓只有内存 mock：`scripts/device-auth-rp-mock.mjs`） |
| 系统分享面板 / 文件分享 / 受控 share request | 未实现（见 §2.6） |
