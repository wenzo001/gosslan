# 外部应用绑定与 Gosslan 设备快捷认证设计

> 日期：2026-11-13  
> 状态：方案草案，供产品/架构评审；未修改业务代码  
> 目标：允许 Web 应用及其他应用把当前 Gosslan 安装绑定为一个可信设备，并在后续登录时请求用户在 Gosslan 中确认。  
> 关键边界：Gosslan 当前没有用户账号、中心身份服务或云端用户资料。本方案的首期是“外部应用账号 ↔ Gosslan 安装”的信任绑定与设备持有证明，不把 Gosslan 改造成全局账号提供方。

## 1. 需求理解与审批建议

用户在外部应用中选择“绑定 Gosslan / 使用 Gosslan 快捷登录”后，系统唤起本机 Gosslan。Gosslan 展示发起方、登录/绑定动作及拟共享信息；用户明确批准后，Gosslan 证明自己持有对应设备密钥。外部应用后端验证结果并完成账号绑定或登录，浏览器继续在原站点建立会话。

**建议批准首期方向：外部应用自有账号系统 + Gosslan 作为本地设备确认器/登录凭证。** 外部应用必须有自己的 HTTPS 后端，负责用户账号、事务、设备公钥、撤销和会话。Gosslan 不替外部应用认证邮箱/手机号，也不声称知道用户的真实姓名。

如果需求实际是“一个 Gosslan 账号在任意网站登录，并由 Gosslan 下发用户资料”，那属于新的中心化身份产品：必须增加 Gosslan 账号注册、恢复、授权服务器、服务运行与隐私政策，和现有“无账号、无中心服务”的产品目标冲突。该目标需要单独做产品决策，不应混进本期实现。

## 2. 现状与身份语义

仓库现有身份能力的依据：

- [ADR-0021](../adr/0021-device-id-is-generated-not-derived.md)：`device_id` 首次安装时生成并持久化，重启不变；它标识一次安装，不保证标识一个自然人或一台不可变物理设备。
- [crypto.rs](../../src-tauri/src/crypto.rs)：已有 Ed25519 签名密钥和 X25519 加密密钥；安全码以设备 ID 和双方公钥计算，供带外核对。
- [protocol-invariants.md](../protocol-invariants.md)：设备身份、公钥绑定、好友信任和换钥都属于安全敏感边界；未验证的 announce 不能建立信任，好友密钥替换需要明确确认。
- [capabilities/default.json](../../src-tauri/capabilities/default.json)：应用窗口与外链窗口分离，外部网页不应获得 Tauri 命令能力。
- [external_links.rs](../../src-tauri/src/commands/external_links.rs)：外部 URL 被加载前有 HTTPS/HTTP scheme 校验；新认证流程需要比普通外链更严格，不能接受任意 callback URL。

### 2.1 可共享与不可共享的信息

| 字段 | 含义 | 建议 |
| --- | --- | --- |
| `device_id` | 当前 Gosslan 安装标识 | 默认不对所有 RP 暴露；仅在用户明确同意且有业务必要时共享。跨 RP 重用会形成关联标识 |
| Ed25519 公钥 | 当前设备身份签名公钥 | 可用于已绑定 RP 验证设备持有证明；建议首期为每个 RP 创建独立认证密钥，避免把 P2P 身份密钥扩展到无关网站 |
| X25519 公钥 | P2P 加密用途 | 快捷登录通常不需要；不共享 |
| 昵称 | 本机可编辑展示名 | 可选、明确授权；这是设备昵称，不是认证过的用户姓名 |
| 头像 | 本地资料 | 默认不共享；若产品需要，单独 scope 与用户确认 |
| OS/应用版本 | 诊断/兼容信息 | 只有明确用途才共享，且不作为身份因子 |
| 主机名、硬件序列号、网卡/MAC、原始机器属性 | 高关联性设备数据 | 不提供、不上传、不用于外部用户画像 |
| 外部站点的真实用户资料 | RP 账号资料 | 由 RP 自己的账号系统管理；Gosslan 无权也没有事实来源代为声明 |

“不可变信息”在本协议里应改称**稳定凭证材料**。公钥只在对应私钥未轮换时稳定；安装重置/重装可能产生新身份；昵称、系统版本、平台、头像都可变化。任何字段都不应被描述为永久硬件指纹。

## 3. 架构与数据流

```text
浏览器 / 外部 App             RP 后端                 Gosslan 桌面/移动端
       |                         |                             |
  用户已登录或开始登录 -------->|                             |
       |  创建一次性事务        |                             |
       |<-- transaction + link --|                             |
       |---- 打开 App Link ----------------------------------->|
       |                         |<--- 拉取事务请求 ------------|
       |                         |--- RP/动作/scopes/challenge ->|
       |                         |                             | 展示确认页
       |                         |<--- 用户批准 + 签名证明 ------|
       |<---- 浏览器轮询状态 ----|                             |
       |<---- 同站点完成登录 ----|                             |
```

1. RP 页面通过已登录的 RP 后端创建一笔短时事务；登录场景的请求必须绑定发起该事务的浏览器会话。绑定场景必须要求用户已登录 RP 账号并通过 CSRF 检查。
2. RP 页面以已验证的 HTTPS App Link/Universal Link 唤起 Gosslan。链接只携带随机、不透明、短时的一次性事务 ID，不含用户资料、密钥、长期 token 或签名材料。
3. Gosslan 使用固定 HTTPS 来源或经用户确认的 RP HTTPS 来源获取事务详情。页面呈现真实来源域、应用名、操作（绑定/登录）、目标 RP 账号提示、请求字段和有效期。
4. 用户批准后，Gosslan 使用该 RP 专属设备密钥对事务挑战签名，并把签名证明发给 RP 后端。拒绝或超时也明确回写事务状态。
5. RP 后端验证 challenge、签名、公钥绑定、nonce、有效期、一次性状态和浏览器会话绑定。登录成功后，浏览器只在原 RP 域内完成会话，不把 access token 交给 Gosslan。
6. 浏览器通过同站点 session/status API 得到完成状态，或 RP 完成自己的标准 OAuth/OIDC 回跳。不得把长期凭证放入系统深链参数。

### 3.2 外链窗口、分享链接与聊天入口

当前桌面端已有一个固定、复用的外链 WebView 窗口：它加载远端 HTTP(S) 页面、没有 Tauri capability，导航也只允许 HTTP(S)。认证/分享设计应继续依赖这个隔离边界，不给网页注入可调用任意本机命令的 JS bridge。

**参与集成的 RP 页面分享链接：**

1. 用户在 RP 页面点击“分享到 Gosslan”。RP 网页在自己的后端创建一次性 `share_request`，返回短时 `share_request_id` 和已验证的 Gosslan App Link。App Link 只含不透明 ID 与 RP issuer 标识，不直接携带原始目标 URL、用户资料或授权 token。
2. 操作系统把已验证的 Universal/App Link 交给 Gosslan。Gosslan 向同源 RP 后端读取待分享内容，确认 RP 域名、链接标题、目标 URL 和过期时间。
3. Gosslan 显示原始站点、目标链接和统一分享面板。用户可在面板里搜索/选择会话并编辑内容；点“发送到〈会话名〉”后才投递。若用户先选择“在聊天中继续”，则切到对应会话并把内容放入未发送草稿，仍需在聊天输入框明确发送。
4. 发送出去的是普通聊天文本中的 HTTP(S) 链接（可附一行标题），不包含外部认证 cookie、页面 DOM、本地存储或任何 Gosslan 账号密钥。收件人点击该链接时走现有外链窗口。

RP 分享 API 草案：

- `POST /api/gosslan/share-requests`：浏览器同源、带 RP session 与 CSRF 检查；请求当前页面规范 URL 和用户选择的分享文本；响应 `{share_request_id, app_link, expires_at}`。
- `GET /api/gosslan/share-requests/{share_request_id}`：Gosslan 从 HTTPS、同源 endpoint 读取 `{issuer, title, url, text, expires_at}`。请求 ID 至少 256-bit 随机、一次性、建议 2 分钟过期；不可通过它读取 RP 用户资料或会话 cookie。
- 读取后可标记 consumed；重复读取只能返回同一份有限内容，不能重复触发发送。

**普通网站分享：**

- 没有 RP 集成的网页优先使用系统 Web Share/平台分享入口；Gosslan 可作为操作系统原生分享目标的候选实现，按各平台机制逐一评估。
- 平台不支持或未安装 Gosslan 分享目标时，退回复制链接，再由用户在 Gosslan 中粘贴到会话。首期不承诺任意网页都能用定制按钮直接调用 Gosslan。
- 不建议把完整目标 URL 塞进 query 参数型自定义 scheme：URL 可能带搜索词、一次性参数或个人资料，也会进入浏览器历史、诊断日志和系统事件记录。若必须提供通用 deep link，应由用户显式触发、长度有限、只接收 HTTP(S)，并先展示待分享链接和会话选择；绝不能自动发送。

**认证与内置浏览器衔接：**

- 用户从外链窗口中的 RP 页面发起“用 Gosslan 确认/绑定”时，网页只向 RP 后端创建事务，再通过已验证 App Link 唤起 Gosslan；它不能直接调用 `invoke` 或读取 Gosslan 本地身份。
- Gosslan 原生确认完成后，RP 后端把事务状态置为终态。原外链窗口只通过 RP 同源 status endpoint 轮询并显示成功/取消，再继续该 RP 自己的站内流程。RP 页面不获得 Gosslan session token。
- 外链窗口仍可用于普通站点内容与该 RP 自己的已登录页面。若站点需要第三方 OAuth/OIDC 登录、密码管理器或跨站 SSO，跳到系统浏览器完成身份提供方流程，再按 RP 自己支持的安全回跳返回；不把 Gosslan 外链 WebView 当成通用 OAuth 登录容器。
- 用户也可以在 Gosslan 内先点开 RP，再由页面发起设备绑定；绑定、设备签名和账号会话仍按 §3 原生确认流处理。外链窗口的 cookie/session 与系统浏览器不假设共享。

**聊天内打开链接：**

- 聊天气泡继续把 URL 当普通 HTTP(S) 超链接；桌面端由现有外链窗口单例加载，移动端使用当前平台已有的外部/内置页面策略，另行验收。
- 若链接属于已接入 RP，RP 页面可显示“用已绑定 Gosslan 设备确认登录”。网页创建认证事务并唤起 Gosslan；确认后页面轮询该 RP 事务，登录 session 由 RP 自己建立。
- 打开链接和认证授权是两个不同动作。打开网页本身不自动发起认证；RP 页面不能以导航、弹窗或脚本绕过 Gosslan 的原生确认；用户离开聊天或关闭链接窗不代表拒绝已发出的认证事务，事务需单独显示并可取消/过期。

### 3.3 分享面板与快捷发送

分享要有明确、可见的 Gosslan 原生面板，不能把“分享”藏在复制链接或系统菜单里。面板分为“发到 Gosslan”和“分享给其他应用”两组，避免把聊天投递和外部应用分享混成一种授权：

```text
分享面板
┌──────────────────────────────────────┐
│ 分享网页                               │
│ 标题 / 预览域名 / 可编辑分享语          │
│                                      │
│ 发到 Gosslan                          │
│ [最近会话] [搜索联系人或群]             │
│                                      │
│ 分享给其他应用                         │
│ [系统分享…] [微信*] [QQ*] [飞书*] [复制链接] │
│                                      │
│                         [发送]         │
└──────────────────────────────────────┘
```

`*` 表示系统分享面板在当前设备实际提供该目标时才出现；上图用于说明可见的快捷入口，不代表 Gosslan 内置了各应用账号或私有 SDK。

- 分享面板统一接收 `title`、`text`、`url` 和来源；外部网页内容只由操作系统分享输入或 RP 的一次性 `share_request` 提供。用户可编辑分享语、移除标题或链接，发送前看到最终文本和目标。
- “发到 Gosslan”支持搜索会话、最近会话、多选接收对象。选定对象后进入发送确认态，显示会话名称、头像、链接预览和最终消息；用户点击“发送”才实际投递。不能仅选中会话就自动发送。批量发送逐个展示目标，避免误发到群。
- “分享给其他应用”优先调用各平台的原生系统分享面板，由系统展示当前可用的微信、QQ、飞书等分享目标；Gosslan不仿造或嵌入这些应用的联系人列表，也不读取其账号、好友或登录状态。若某个平台要求品牌化的一键入口，再单独集成其官方 SDK/分享 API、完成平台审核和包签名配置；不通过猜测私有 URL scheme 来直发。
- 快捷入口按操作系统能力和设备上实际可用的目标动态展示。桌面端可展示“系统分享… / 复制链接 / 发到 Gosslan”；若系统分享无法提供应用目标，明确提示用户改用系统菜单或复制。移动端由原生分享 sheet 提供已安装目标。未安装、不可用或调用失败的目标隐藏或显示不可用状态，不能伪装成已发送。
- “发送”按钮必须标明目标：内部目标显示“发送到〈会话名〉”；外部分享选择器启动后由目标应用完成最终发送，Gosslan只报告“已打开分享面板”，不把目标应用选择等同于发送成功。分享取消返回 Gosslan，不生成聊天消息。
- 普通网页的系统分享按钮由页面/系统触发；若接收目标包含 Gosslan，进入同一分享面板并完成会话选择与手动发送。RP 集成页的“分享到 Gosslan”也进入同一面板，校验 `share_request` 后才展示内容。认证确认页不提供分享快捷操作，防止把账号提示、认证参数或敏感 URL 混入消息。
- 链接预览只展示可验证的 URL 主机名和用户提供标题。首期不自动抓取网页生成预览，避免 SSRF、跟踪请求和泄露用户网络地址；未来如做预览服务，须另设安全代理、缓存策略与用户可关闭开关。

**首期建议：** 完成 Gosslan 会话选择/搜索、多选确认、草稿编辑和显式发送；外部应用走操作系统分享 sheet 与复制链接。微信、QQ、飞书等专属快捷按钮只有在官方 SDK/API、平台资质及各系统维护成本确认后纳入后续阶段。这样 UI 可以统一呈现快捷目标，同时不会承诺未经验证的跨应用直发能力。

### 3.1 密钥建议

- 首次绑定时生成**RP 专属 Ed25519 登录密钥对**，与现有 P2P 身份私钥分开。数据库保存密钥引用和 RP 绑定状态；私钥保护策略需单独评估。当前项目把身份密钥保存在本地 SQLite 并收紧 Unix 文件权限，但并没有统一的系统 Keychain/Android Keystore 封装。
- RP 仅保存该 RP 公钥、设备标签、授权 scopes、创建/最近使用时间和撤销状态。不同 RP 的公钥与 subject 不同，降低跨站关联。
- 对一个已绑定 RP 的登录，断言包含 RP 专属 `sub`（随机安装级 subject）及 `kid`，不必发送全局 `device_id`。
- 私钥丢失/应用数据被清除后，需要重新绑定。不得自动用新密钥覆盖原绑定；旧公钥须由 RP 账号管理页面撤销。
- 如果评审决定复用现有设备 Ed25519 密钥，必须先接受跨站关联风险，并明确哪些 key rotation 会导致所有 RP 重新绑定。**不建议此方案作为默认值。**

## 4. 接口契约（v1 草案）

本接口由 RP 实现，Gosslan 是客户端。每个 RP 通过 HTTPS 提供自己的设备认证接口元数据。接口不要求 Gosslan 运营中心服务器，但意味着每个集成方都需管理事务端点和已绑定设备公钥。

### 4.1 RP 元数据

`GET https://<rp-origin>/.well-known/gosslan-device-auth`

```json
{
  "protocol_version": "1",
  "client_id": "com.example.product",
  "display_name": "示例工作台",
  "issuer": "https://app.example.com",
  "request_endpoint": "https://app.example.com/api/device-auth/requests/{request_id}",
  "decision_endpoint": "https://app.example.com/api/device-auth/requests/{request_id}/decision",
  "poll_endpoint": "https://app.example.com/api/device-auth/requests/{request_id}/status",
  "supported_actions": ["link", "authenticate"],
  "supported_claims": ["device_subject", "device_public_key", "nickname"],
  "share_request_endpoint": "https://app.example.com/api/gosslan/share-requests",
  "share_content_endpoint": "https://app.example.com/api/gosslan/share-requests/{request_id}"
}
```

分享字段为可选项。要求：所有端点必须 HTTPS，且与 `issuer` 同源；禁止重定向到其他 origin；客户端名不能只信任网页传入的字符串，确认页同时显示规范化域名。元数据的 client ID 必须与 origin 绑定，不能由链接参数覆盖。

### 4.2 创建事务（RP 浏览器 → RP 后端）

`POST /api/device-auth/requests`（同源、需 RP session、CSRF token）

```json
{
  "action": "link",
  "requested_claims": ["device_subject", "device_public_key"],
  "state": "browser-csrf-correlator"
}
```

响应 `201 Created`：

```json
{
  "request_id": "256-bit-random-opaque-value",
  "app_link": "https://<verified-app-link-host>/authorize/<opaque-reference>",
  "expires_at": "2026-11-13T08:15:00Z",
  "poll_after_ms": 1500
}
```

RP 后端须把 `request_id`、当前 RP 用户、登录 session 或待绑定账号、state、nonce、请求字段和 expires_at 存为服务端事务；浏览器不决定最终的用户 ID。事务默认 2 分钟有效、仅可处理一次；限流和过期清理由 RP 实现。

### 4.3 获取待确认请求（Gosslan → RP 后端）

`GET /api/device-auth/requests/{request_id}`

响应 `200 OK`：

```json
{
  "protocol_version": "1",
  "request_id": "…",
  "client_id": "com.example.product",
  "issuer": "https://app.example.com",
  "display_name": "示例工作台",
  "action": "link",
  "account_hint": "li***@example.com",
  "requested_claims": ["device_subject", "device_public_key"],
  "challenge": "256-bit-random-base64url",
  "expires_at": "2026-11-13T08:15:00Z"
}
```

此响应不得包含访问令牌、RP 用户密码、未授权的完整邮箱/手机号或可复用的长期凭证。Gosslan 必须拒绝未知 protocol version、过期事务、不支持的 action/claim、跨域 endpoint 和畸形响应。

### 4.4 用户批准/拒绝（Gosslan → RP 后端）

`POST /api/device-auth/requests/{request_id}/decision`

批准示例：

```json
{
  "decision": "approve",
  "key_id": "rp-key-thumbprint",
  "public_key": "base64url-ed25519-public-key",
  "device_subject": "pairwise-random-subject",
  "claims": {
    "nickname": "用户主动允许时才出现"
  },
  "assertion": "base64url-encoded-JWS-EdDSA"
}
```

断言建议采用 JWS EdDSA，固定 `typ=gosslan-device-auth+jwt`，并严格校验：

```json
{
  "iss": "pairwise-random-subject",
  "aud": "https://app.example.com/api/device-auth",
  "client_id": "com.example.product",
  "transaction_id": "…",
  "challenge": "…",
  "action": "link",
  "iat": 1794557520,
  "exp": 1794557580,
  "jti": "single-use-random-id"
}
```

签名主体、header `kid`、audience、client_id、request_id、challenge、action 必须互相一致。签名有效期建议不超过 60 秒，`jti` 与事务均只能消费一次。初次 `link` 时，RP 在已有登录 session 和用户明确操作的前提下注册公钥；后续 `authenticate` 必须用已登记公钥验证，不能在登录流程里临时接受新公钥。拒绝示例为 `{"decision":"deny"}`，不带 assertion。

响应：`202 Accepted`，表示已登记待完成状态；重复提交同一事务返回幂等结果，不重复创建绑定。RP 事务状态变为 `approved` / `denied` / `expired` / `consumed`。

### 4.5 浏览器轮询和完成

`GET /api/device-auth/requests/{request_id}/status`（同源、仍需原 RP session）

```json
{"status":"pending|approved|denied|expired|consumed"}
```

- `approved` 只说明设备证明通过；RP 后端再按 action 创建站点自己的登录 session 或绑定记录。
- 浏览器不从 Gosslan 深链接收 bearer token。站点用原 session cookie 或该站点已登记的标准 OAuth/OIDC redirect 完成登录。
- 如需第三方 OAuth/OIDC 接入，RP 仍是 OAuth client，使用 Authorization Code + PKCE；Gosslan 不是该 OAuth 授权服务器。

### 4.6 错误码建议

| HTTP | `code` | 语义 |
| --- | --- | --- |
| 400 | `DEVICE_AUTH_INVALID_REQUEST` | 参数、版本或 claim 不合法 |
| 401 | `DEVICE_AUTH_UNAUTHORIZED` | 事务不存在、session 不匹配或未经授权 |
| 403 | `DEVICE_AUTH_USER_DENIED` | 用户在 Gosslan 明确拒绝 |
| 404 | `DEVICE_AUTH_REQUEST_NOT_FOUND` | request ID 不存在或已清除 |
| 409 | `DEVICE_AUTH_ALREADY_CONSUMED` | nonce/事务/jti 已使用 |
| 410 | `DEVICE_AUTH_EXPIRED` | 事务或 challenge 过期 |
| 429 | `DEVICE_AUTH_RATE_LIMITED` | 请求/轮询过频 |
| 5xx | `DEVICE_AUTH_TEMPORARY_FAILURE` | RP 暂时不可用；客户端可显示重试，不重放已消费签名 |

错误响应不回显秘密、完整邮箱、签名原文或内部堆栈。

### 4.7 RP 分享链接契约（可选扩展）

分享事务和登录事务使用不同 action、不同状态记录和不同 endpoint；分享请求不能借用 `authenticate` 的 challenge，也不能隐式批准设备绑定。

创建分享请求：`POST /api/gosslan/share-requests`（RP 页面同源、需用户操作、带 CSRF token）

```json
{
  "url": "https://app.example.com/articles/123",
  "title": "用户当前查看的文章",
  "text": "可选的用户自定义分享语"
}
```

响应：

```json
{
  "share_request_id": "256-bit-random-opaque-value",
  "app_link": "https://<verified-app-link-host>/share/<issuer-ref>/<opaque-reference>",
  "expires_at": "2026-11-13T08:15:00Z"
}
```

Gosslan 以元数据中同源的 `share_content_endpoint` 读取：

```json
{
  "protocol_version": "1",
  "share_request_id": "…",
  "issuer": "https://app.example.com",
  "title": "用户当前查看的文章",
  "url": "https://app.example.com/articles/123",
  "text": "可选的用户自定义分享语",
  "expires_at": "2026-11-13T08:15:00Z"
}
```

客户端校验 issuer 与已加载元数据一致、事务未过期、URL 长度受限且协议为 HTTP(S)；拒绝 `javascript:`、`data:`、`file:`、Tauri scheme、带用户名/密码的 URL 和跨域重定向。Gosslan 不在后台抓取目标页面，不执行目标脚本，也不读取页面 DOM。页面/URL 中若存在疑似登录 token 或敏感 query，确认页应显示完整域名并提示用户核对，不能悄悄改写后发送。实际发送仍由用户在选定会话的输入框明确确认。

## 5. 交互与状态机

RP 事务：

```text
created → opened → pending_user_decision → approved → consumed
                                  ├──────→ denied
                                  └──────→ expired
```

Gosslan UI 的确认页至少显示：

1. RP 的规范域名和应用名（域名作为主要防钓鱼线索）。
2. “绑定此设备”或“登录到此站点”的明确动作。
3. RP 账户提示（掩码化），避免用户把设备绑定到错误账号。
4. 本次拟共享的精确字段；昵称/头像/全局设备 ID 等非必要信息默认不选。
5. 过期时间、批准和拒绝两条清晰操作；批准后显示成功/失败结果。

分享确认页则显示原始 RP 域名、目标 URL 的 host/path、标题/分享语以及将要发送到的会话；进入会话后只预填草稿。分享成功不等于认证成功，认证成功也不应替用户自动分享页面。

后台只保留有限个待处理事务，退出/拒绝/过期清除敏感内存状态。登录中的陌生 RP 不应静默弹窗或自动批准；多个并行请求要分别呈现来源并让用户能辨别。

## 6. 安全、隐私与滥用边界

- **深链不是授权凭证。** Universal/App Link 优先；自定义 scheme 只作为兼容回退。URI 不承载 token、完整资料、私钥、可重放 assertion。深链被劫持最多能触发待确认 UI，不能静默完成登录。
- **分享链接和登录事务分离。** 分享只把用户明确选中的页面 URL 放入聊天草稿；不附带 cookie、访问 token、页面 DOM 或聊天记录。认证 assertion 不进入分享文本，分享请求不能切换为登录授权。
- **反钓鱼与确认。** 展示从 HTTPS 元数据取得的 origin；不信任 deep link 中的 `display_name`、callback 或 claim。用户确认必须发生在受信任的 Gosslan 原生界面。
- **callback 限制。** 回调/状态接口只来自 HTTPS 同源 metadata，不接受用户输入 URL、任意 redirect 或 HTTP URL。阻止 open redirect、SSRF、DNS rebinding 和跨域凭据转发；不跟随跨 origin 重定向。
- **短时、一次性与防重放。** 随机 nonce、transaction ID、challenge、jti 绑定 RP、action、audience 和浏览器会话；后端原子消费事务。拒绝 PKCE 降级（如 RP 同时采用 OAuth code flow）。
- **账号绑定先验。** 首次绑定必须由 RP 已登录会话发起，执行 CSRF 检查并显示目标账户；不能仅凭 Gosslan 自报昵称/设备 ID 找到并登录某个用户。
- **最小资料。** RP 只拿到用户批准的 allowlisted claims。每个 RP 使用不同 subject/key；默认不传 `device_id`、X25519 key、硬件信息、通讯录、好友/群信息。
- **密钥储存与撤销。** RP 绑定密钥可单独撤销/轮换；用户从 Gosslan 可查看已授权应用并撤销本地授权，但服务端仍须提供设备解绑入口。需要设计 OS Keychain/Keystore 能力或清楚标注本机数据库保护限制。
- **登录授权不等于 P2P 好友关系。** 此流程不得添加好友、接受好友申请、允许网络中继或修改现有设备身份锚点。
- **无服务端边界。** Gosslan 不托管 account linking registry，也不能向 RP 证明这个设备对应哪个自然人。RP 服务故障时登录不可用；本地 P2P 通讯不应因此受影响。
- **审计数据最小化。** RP 可记录事务 ID、client ID、结果、key thumbprint 和时间；避免记完整昵称、完整邮箱、签名断言、设备全局 ID 和 challenge。

## 7. 对现有仓库的预期影响面（未来实现时）

这里只列设计影响，不代表已修改文件：

- Tauri 窗口/外部 URL 唤起：deep-link 或系统 URL 事件接入，以及协议校验、队列和前台窗口提示；需评估当前 Tauri 插件/平台能力，不假设已安装 deep-link 插件。
- 外部网页到本机的分享入口：verified App Link/Universal Link、可选 Share Target、一次性 share request、前台聊天选择和草稿预填；不开放外链窗口的 Tauri capability/通用 JS bridge。
- Rust 命令层与状态：创建/列出/撤销 RP 专属授权、解析待处理事务、签名确认、取消和状态读取；网络请求与签名不得阻塞 UI/异步 runtime。
- SQLite：授权客户端/公钥、pairwise subject、scope、状态、撤销时间和迁移；不得写入访问 token 或冗余个人资料。
- 前端 Vue/Pinia：授权确认/拒绝、应用来源、请求字段、活动授权清单和撤销 UI；中英文文案同步，使用 `t()`。
- Windows/macOS/Android 原生配置：Universal/App Link 关联、URI scheme 回退、Android intent filters、macOS URL types、Windows 协议注册/安装器行为；升级卸载后的注册语义需实机确认。
- 验证：协议状态机和签名单测、RP 合约测试、链接劫持/过期/重放/拒绝/撤销 E2E、三平台真机唤起和冷启动测试。

## 8. 分阶段实施计划

### 阶段 0：产品决策与安全边界（先决）

1. 确认是“RP 账号绑定本机 Gosslan 设备”还是“Gosslan 中心账号单点登录”。本方案仅覆盖前者。
2. 确认 RP 后端承担事务、用户账号、公钥存储、登录 session 和撤销；列首批集成应用及受信 origin。
3. 定义资料字段 allowlist、每字段必要性、默认关闭项、保留期限和删除/撤销语义。
4. 确认 RP 专属 Ed25519 key 的存储方案、备份/重装后重新绑定行为和跨平台最低支持版本。
5. 确认分享入口首期范围：推荐先支持“合作 RP 的不透明一次性 share request + 原生分享面板 + Gosslan 会话选择/手动发送 + 普通网页复制粘贴兜底”；微信、QQ、飞书专属按钮需逐一确认官方集成条件后再排期。

**验收门槛：** 数据流图、威胁模型、字段表、密钥恢复/撤销决策经产品和安全评审签字。

### 阶段 1：RP 服务端原型与接口冻结

1. 实现 metadata、事务创建/读取/批准/拒绝/状态端点和状态机。
2. 加入 origin/client ID 绑定、短过期、一次消费、CSRF、rate limit、日志脱敏和账号 session 绑定。
3. 发布独立的 RP 集成接口文档/SDK 示例；不先发布 Gosslan 深链实现，以免两边契约漂移。
4. 建立 RP contract tests，覆盖非法状态转移、重复批准、错账户和重放。

**验收门槛：** 服务端自动测试通过；安全评审确认未知 key 不能完成既有账户登录。

### 阶段 2：Gosslan 最小设备绑定

1. 实现受信 HTTPS app link 接收、request 获取与强制确认 UI。
2. 用户批准时生成/使用 RP 专属 key，完成首次绑定；拒绝、取消、过期、重复唤起和网络错误均有清晰状态。
3. 增加已授权应用清单与逐项撤销；严格限制 claim 和请求并发。
4. 先支持桌面单平台内测，验证冷启动/已运行窗口的链接路由和系统协议注册。
5. 同期可实现分享链路最小闭环：系统分享入口或可信 App Link → 读取/校验分享内容 → 原生分享面板 → 会话搜索与选择 → 最终消息预览 → 用户手动发送；外部应用目标由系统分享 sheet 承载，聊天里的链接复用现有 HTTP(S) 外链窗口。

**验收门槛：** 不能静默批准；未经用户授权不返回昵称/公钥；重放/恶意 callback/外域 endpoint 被拒。

### 阶段 3：Web 快捷登录、跨平台与发布

1. RP 完成设备绑定后增加 `authenticate` challenge；在用户当前浏览器 session 中验证事务并创建该 RP session。
2. 接入 Windows、macOS、Android app links/deep links 和单实例前台传递；逐平台验证浏览器、安装器、冷启动与已有实例。
3. 测设备丢失、卸载重装、key rotation、RP 解绑、网络中断和服务故障恢复。
4. 仅在真机矩阵与隐私说明完成后逐步开放；先 allowlist 邀请制，再扩大集成方。

**验收门槛：** 三平台关键流程实机 PASS；安全反例自证通过；撤销后旧 key 立即不能登录；公开文档不把设备证明称为实名认证。

## 9. 验收矩阵

| 类别 | 必测案例 | 预期 |
| --- | --- | --- |
| 正常绑定 | 已登录 RP 用户创建事务、Gosslan 同意 | RP 仅登记当前 RP key 和已批准字段 |
| 正常快捷登录 | 已绑定 key 对有效 nonce 签名 | 原浏览器/RP session 登录成功，不向深链发 token |
| 拒绝与过期 | 用户拒绝、2 分钟超时、后台网络断开 | 不创建绑定/会话；页面可解释并重新开始 |
| 防重放 | 重用 request、challenge、jti 或旧签名 | 服务端拒绝，事务保持终态 |
| 防账户错绑 | 浏览器切换 RP 账号、state/session 不匹配 | 不将设备绑定到新账户 |
| 防来源欺骗 | 修改 deep link 显示名、外域 metadata、跨域跳转 | 显示真实 origin 或 fail closed；不会发给攻击方 endpoint |
| RP 分享入口 | 外部链接窗口页面点击分享到 Gosslan | App Link 只带不透明票据；Gosslan 展示真实 RP 域和目标链接，统一面板选择会话并手动发送；可转入会话草稿但不自动发送 |
| 普通网页分享 | 浏览器系统分享、Gosslan 目标不可用、复制粘贴和取消分享 | 可用系统显示 Gosslan 目标并打开分享面板；不可用时提示复制/粘贴；取消不产生消息 |
| Gosslan 分享面板 | 搜索会话、多选、编辑分享语、确认发送 | 发送前展示全部目标和最终消息；只有点击发送才投递；多目标逐项可辨认 |
| 外部应用快捷分享 | 系统分享 sheet 展示微信、QQ、飞书等已安装目标；目标缺失/失败/取消 | 动态显示系统可用目标；目标应用负责最终发送，取消不报告成功；未完成官方集成的平台不显示伪快捷按钮 |
| 分享/认证隔离 | 分享票据尝试调用登录授权，认证回调混入分享文本 | action 与服务器事务分开；分享不建登录 session，认证不发聊天消息 |
| 内置浏览器边界 | RP 页面尝试调 Tauri 命令、跳 tauri/file scheme、启动第三方 OAuth | 无命令 capability；危险 scheme 拒绝；第三方 OAuth 转系统浏览器并回到 RP 自己的会话 |
| 最小披露 | 不请求昵称/头像/全局 ID；请求未授权 claim | 响应不包含这些字段，未知 claim 整笔拒绝 |
| 撤销 | 用户在 RP 或 Gosslan 撤销设备 | 旧 key 立即被服务端拒绝；本地不再显示有效授权 |
| 密钥变化 | 清数据、重装、密钥丢失或轮换 | 要重新显式绑定；不能悄悄覆盖旧公钥 |
| 平台唤起 | App 未运行/已运行、冷启动、多个请求、旧版本系统 | 请求正确路由到 Gosslan；只出现一次可辨认的确认页 |

## 10. 未决产品选择

1. 是否首期只做“已登录账号绑定设备”，把真正的无密码快捷登录放到第二期？推荐先绑定、再登录。
2. 首期采用 RP 专属设备密钥，还是接受复用 Gosslan P2P 身份密钥的跨站关联？推荐 RP 专属密钥。
3. 是否允许个人开发者/内网应用自助集成，还是只允许经过审核的 RP origin？安全性和开放性需要明确取舍。
4. 用户资料到底要共享哪些字段？推荐首期只提供 pairwise `device_subject` 与设备公钥；昵称仅作为设备标签选项，不提供自然人资料。
5. 是否接受这项能力依赖外部 RP 后端在线？若要求无服务器、离线跨应用登录，当前产品架构不具备可信的全局账号/撤销机制。

## 11. 参考标准

- [RFC 8252 — OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252)：原生应用应使用外部用户代理；公共客户端使用 Authorization Code + PKCE；桌面可采用 loopback redirect。此方案让 Web 会话留在浏览器，不嵌入远程登录页。
- [RFC 7636 — PKCE](https://www.rfc-editor.org/rfc/rfc7636)：保护授权码被截获后的兑换过程。
- [RFC 9700 — OAuth 2.0 Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html)：要求严格执行 PKCE，建议使用 `S256`，避免 implicit/token-in-redirect 和 PKCE downgrade。
- [RFC 10017 — OAuth 2.0 for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc10017.html)：浏览器客户端建议 Authorization Code + PKCE；带后端时应由后端持有机密凭证并保护会话。
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)：若未来决定运营 Gosslan 中心身份服务，应按 OIDC 的 issuer/audience/nonce/subject 等语义实现，而不是自定义“用户信息回调”冒充身份令牌。
- [Web Share API](https://www.w3.org/TR/web-share/)：普通网页在用户操作下调用系统分享界面的标准入口；各平台可用性不同，不能假设所有嵌入式 WebView 都提供此 API。
- Web Share API 描述网页如何请求系统分享面板；它不规定微信、QQ、飞书等应用内的私有分享接口，也不保证各系统的目标列表一致。Gosslan 接收外部分享时应按各操作系统的原生分享目标机制分别实现与验证，不把平台专属 API 误称为 W3C 标准。

这些标准定义 OAuth/OIDC 授权的安全模式，并不直接标准化本文件提出的 Gosslan 设备批准 API；RP 请求、设备签名断言和 pairwise subject 仍需版本化为 Gosslan 集成协议并进行独立安全审查。
