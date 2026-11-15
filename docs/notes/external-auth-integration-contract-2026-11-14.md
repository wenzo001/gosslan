# 外部 RP 设备绑定/快捷认证与外链分享集成契约（活契约与就绪度）

> 日期：2026-11-14
> 状态：活契约 + 就绪度清单；随实现演进更新
> 范围：外部 RP 设备绑定/快捷认证、外链窗口、认证/分享深链、网页到聊天的分享

## 1. 文档定位

- 本文是**活契约与就绪度清单**，不是设计草案，也不是验收报告。
- 设计草案 `docs/notes/external-app-device-auth-design-2026-11-13.md` 描述目标形状；同日的外部快捷认证与外链分享就绪度审计（只读源码审阅，会话输入文档，**未纳入版本库**）给出就绪度判断。本文把两者收敛成「对外契约条目 + 逐条当前差距 + 发布准入」，供集成方与后续实现共同对账。
- 结论来源：上述设计草案、该就绪度审计的结论，以及本文各节引用的源码路径。**以当前源码为准**，不引用历史快照里的判断；未入库的外部文档只作背景，不作为可追溯的仓库内依据。
- 本文只登记**外部接入域**的契约与差距：写作时未改动设备认证、深链、外链窗口或分享相关代码，未做安装包与真机验收。同一轮并行的 #34 后台任务改动属另一功能域（更新器与任务中心），不改变本文任何结论。
- 因此本文只登记契约与差距，不写「本轮已修复」「已通过」。凡未拿到运行时或真机证据的，一律标 `NOT RUN` 或「需运行时/真机证据」。
- 为什么分开：设计稿说「应该是什么」，审计说「当时读到什么」，本文说「现在对外承诺什么、还差什么」。三者混写会让集成方把目标态误当成现状。

## 2. 术语与产品边界

- 统一术语：**设备绑定**、**设备快捷认证**、**设备凭证**。一次绑定 = 某个外部 RP 把某个 Gosslan 安装登记为一条可撤销的设备凭证。
- 明令不使用以下表述：用户指纹、永久身份、不可变用户、绑定 Gosslan 用户、同步全局资料。
  - 为什么：这些词暗示一个中心化的自然人身份保证，而产品没有账号、用户资料服务或实名来源。
- 一致的产品描述：**外部 RP 可把某个 Gosslan 安装登记为可撤销的设备凭证；每次登录由用户在 Gosslan 原生界面确认；RP 自己负责账号、会话、资料与撤销。**
- 产品身份边界：当前主身份是本地安装级设备身份与 P2P 好友关系，无中心账号/用户资料服务。依据 `docs/adr/0021-device-id-is-generated-not-derived.md` 与 `docs/protocol-invariants.md`。
  - 为什么：安装可重装、标识可重置，设备凭证只证明「这个安装持有该 RP 专属密钥」，不证明自然人，也不构成跨 RP 的关联标识。
- 登录授权不等于 P2P 好友关系。此流程不得添加好友、接受好友申请、允许网络中继或修改设备身份锚点。

## 3. 状态机定义（目标态与当前差距）

### 3.1 三个层次必须分开

- 客户端内存 pending map：进程内 `Mutex<HashMap>`，复合键定位，容量有上限，过期在读取与新请求时惰性清理；重启即空。它只是「本机待用户确认」的队列。现在另带一个本地 TTL 上限（取 RP `expires_at` 与插入后固定上限的较早者）与跨重试稳定的幂等键。
- 本地 DB 绑定表：`rp_device_bindings` 的表结构在 `src-tauri/src/db.rs`，CRUD 在 `src-tauri/src/db/device_auth.rs`；状态取值现为 `pending_registration | active | revoked | registration_failed`（**列结构未改**）。它记录「本机是否还认可这条凭证」。
- RP 侧事务：RP 服务端的事务状态，记录「这次登录/绑定的最终结局」。
- 为什么分开：三者不共状态、不互相推导。内存清空不等于 RP 撤销，DB `active` 不等于 RP 已登记公钥。审计指出的分叉来源——「首绑在 RP 回写之前就写 `active`」——现已改为回写 2xx 成功后才激活；失败落 `registration_failed` 并保留同一密钥供重试。

### 3.2 目标态

- RP 事务：`created → awaiting_device → approved / denied / expired / cancelled`。
- 本地绑定：`pending_registration → active → revoked`；另有失败终态 `registration_failed`。
- 目标不变式：只有 RP 成功确认回调后，绑定才从 `pending_registration` 进入 `active`；失败、超时、重试都有可见状态与幂等键。

### 3.3 逐条当前差距（本轮代码修复后复核）

- `created` / `awaiting_device` / `cancelled`：客户端只见「拉到的一条待确认请求」，没有这三个 RP 侧状态的本地表示。需 RP 侧实现，`NOT RUN`。
- `approved`：客户端侧分叉已闭合。`src-tauri/src/commands/device_auth.rs` 的批准编排现在是 `prepare_assertion`（首绑落 `pending_registration`）→ `post_decision`（RP 回调）→ `settle_binding_after_post`（2xx 才 `activate_binding`，失败/超时落 `registration_failed`）→ `consume_pending_if`。重试复用同一密钥、不重复 insert。整链路运行时验收仍 `NOT RUN`。
- `denied`：可观察性已闭合。`DeviceAuthOutcome` 新增 `rp_notified`：`false` = 本机已拒绝、RP 未收到（事务保留可重试、留具名 `code=` 日志），`true` = RP 确认收到（此时才消费事务）；`decision` 仍恒为 `denied`，保持兼容语义。
- `expired`：客户端已加本地 TTL 兜底（取 RP `expires_at` 与插入后固定上限的较早者）与读取时的明确过期错误码；仍是惰性清理、无后台定时器、无 RP 侧终态回写。
- `pending_registration` / `registration_failed`：均已落地（见 `src-tauri/src/db/device_auth.rs`）。失败态可重试，`active` 不许被回退。
- `active` / `revoked`：**双边撤销已接**（客户端侧）。`device_auth_revoke` 先本地立即生效，再按 metadata 的 `revocation_endpoint` 尽力回写 RP；回写结果由 `DeviceAuthRevokeOutcome.rp_notified` 单独表达，界面把「本机已撤、对方没收到」分开提示。RP 没提供端点的老 RP 仍只做本地撤销（不是失败）。撤销通知**不回 seed、不回断言**，只回 `client_id` 与 `kid`（见 §4「撤销双边语义」）。
- 队列边界：满载不再静默淘汰最老事务，改为返回明确错误「暂不能处理」并留具名 `code=` 日志；新事务不会顶掉用户正在看的确认页。
- 断言时效：断言有效期常量仍只约束签名本身；事务 TTL 由上面的本地兜底与 RP `expires_at` 共同决定。
- `/share` 深链：解析 + 内联闭环均已落地（面板、会话选择、显式发送、粘贴兜底都已接线，见 §6）。**定向分享已接**（`to` + `to_kind` 预填目标、目标不存在整笔拒、分享回执可选）。仍**没有**：受控 `share_request`（缺 RP 端点）、文件分享，见 §11。
- **数据交付（`sync` 动作）**：已接（客户端侧，2026-11-15 裁决后落地）。scope 只有 `friends.read` 与
  `events.metadata` 两项，**默认全关、由用户在确认页逐项勾选**，且**只对本次事务有效（不落库）**。
  交付数据随决策回写发出，形状见接入指南 §1.10：**消息正文不外送、好友只给 device_id + 昵称、
  用户没勾的 scope 连键都没有**。事件除元信息外还带**通知性两位**（`mentions_me` = @ 了我吗、
  `notifies` = 会弹通知吗）—— 供第三方页面显示「你有一条 @ 你的消息」而不必外送正文。**不做后台推送**（交付只在用户当场批准时发生一次）。

## 4. 协议契约

说明：本节「已具备」只指源码可见的客户端实现存在，不等于已运行时验收；运行时证据状态统一见 §10。

- **RP session/CSRF 绑定**
  - 要求：绑定场景必须 RP 已登录会话且通过 CSRF 检查；登录场景事务必须绑定发起它的浏览器会话，状态轮询仍校验同源 session。
  - 当前状态：需 RP 侧实现。客户端只校验 HTTPS 同源 metadata 与端点，不参与 RP 会话；`scripts/device-auth-rp-mock.mjs` 免 session/CSRF。
- **挑战一次性消费**
  - 要求：challenge、transaction_id、jti 与 RP/action/audience/会话绑定后原子消费；重放旧签名、旧事务一律拒绝且保持终态。
  - 当前状态：已具备（客户端层）。`jti` 与幂等键现在挂在 pending 事务上、跨重试复用，不再每次 `sign_assertion` 重生成；`src-tauri/src/commands/device_auth.rs` 的一次性消费、复合键与代际对账保持。RP 侧原子消费与**持久化**重放库仍需 RP 实现；mock 只提供进程级 `jti` 去重。
- **idempotency key**
  - 要求：decision 回写带 HTTP 层幂等键；网络重试不重复登记公钥、不重复创建绑定、不重复建会话。
  - 当前状态：已具备（客户端回写层）。`PendingDeviceAuth.idempotency_key` 在事务创建时生成，approve / deny 的重试都复用，`post_decision` 带 `Idempotency-Key` 头。跨进程、跨重启的幂等仍依赖 RP 按该键去重，客户端不持久化该键。
- **最大 TTL**
  - 要求：RP 短 TTL + 客户端本地兜底上限 + 过期终态清理；客户端重启后不残留过期事务。
  - 当前状态：部分具备。客户端已加本地上限（取 RP `expires_at` 与插入后固定上限的较早者）与读取时的明确过期错误；仍无后台定时器，pending 重启即空靠内存态而非清理逻辑。RP 侧短 TTL、会话绑定与过期清理由 RP 实现。
- **拒绝可观察状态与重试**
  - 要求：界面区分「本机已拒绝」与「RP 已收到拒绝」；回写失败可重试或给出明确过期时间。
  - 当前状态：已具备（客户端与确认页）。`rp_notified` 区分两态，回写失败保留事务可重试并留具名日志；确认页据该字段给重试入口。运行时整链路验收仍 `NOT RUN`。
- **撤销双边语义**
  - 要求：本地撤销与 RP 侧公钥撤销分别定义；失败可重试，并给出最终一致性状态；撤销后旧 key 立即不能登录。
  - 当前状态：**客户端侧已具备**（2026-11-15 落地），RP 侧仍需生产实现。
    - metadata 增加可选字段 `revocation_endpoint`（**给了就必须 HTTPS 且与 issuer 同源**，跨域或 http 一律拒）。
      空串 = 该 RP 没提供 ⇒ 客户端只做本地撤销，与旧行为一致，**不是失败**。
    - 撤销顺序：**先本地、后通知**。本地撤销立即生效；通知失败只体现为 `rp_notified=false`，
      绝不回滚本地撤销（否则网络不通时会出现「点了撤销却还是已授权」）。
    - 通知请求：`POST {revocation_endpoint}`，头带 `Idempotency-Key`（由 `revoke_idempotency_key`
      **确定性派生**自 `(rp_origin, client_id, kid)`，不落库 ⇒ 跨重试恒定，RP 才能合并）。
      体只有 `{ client_id, kid }` —— **不回 seed、不回断言**（撤销不需要证明「我是私钥持有者」）。
      超时 5 秒（比常规 RP 请求短：用户在界面点「撤销」时等 10 秒不可接受）。
    - **可重试**：`revoke_binding` 只改 `active` 的行，所以「本地早已撤销」时那次 UPDATE 返回 0 行 ——
      但那种情况**照样要发通知**（那正是「第一次通知失败、用户来补发」的场景）。
      撤销态的行因此仍带一个「重发撤销通知」入口，重复发由同一个 `Idempotency-Key` 在 RP 侧合并。
    - 最终一致性状态由界面分四态呈现：已彻底撤销 / 本机已撤但对方没收到（提示去对方账号页再撤，
      并可重发通知）/ 重发通知已送达 / 本机没有这条绑定。
      判据：`src/utils/deviceAuthRevokeWiring.test.ts`（含 Rust↔mock 跨语言契约对账与重试路径）。
  - 仍需 RP 侧实现：按 `kid` 真正作废公钥、拒绝该 key 后续登录、持久化幂等键去重。
    mock 已提供端点作契约演示（且会核对 `client_id`、按 `Idempotency-Key` 合并重放），
    但它是内存态，**不能作为生产接入依据**。

## 5. 密钥保护决策

- 现状（**2026-11-15 已落地 Windows + Android**）：`rp_device_bindings.secret_key` 这一列在
  **有平台密钥库的系统上是信封**（`gsk1.<后端>.<base64url 载荷>`），载荷由
  **Windows 凭据管理器（DPAPI）** 或 **Android Keystore（AES-256-GCM，密钥在 TEE）** 加密；
  读库时解回明文用（解不开 ⇒ 报错，**不回落明文**）。
  实现：`src-tauri/src/rp_key_store.rs`（信封格式与编排）+ `rp_key_store/dpapi.rs` +
  `rp_key_store/keystore_android.rs`（Kotlin 侧 `gen/android/.../KeyVault.kt`）。
  **macOS 暂缓**（未签名构建读 Keychain 会弹授权框 ⇒ 与开机自启/自动重启冲突）：
  那一列仍是 base64 的 Ed25519 32 字节 seed，存本地 SQLite（应用私有目录，目录权限收紧为 0700）。
  `src-tauri/src/crypto.rs` 的 `RpKey` 收口生成、重建、签名与导出；私钥不 derive `Serialize`/`Debug`，
  不进命令返回值或事件载荷；落库导出只发生在 `src-tauri/src/db/device_auth.rs`。
- 明确不是什么：这不是硬件保护密钥，也不是硬件指纹。密钥是软件态 seed，可被读盘、备份、取证或同机高权限进程复制。
  （Android Keystore 的 AES 密钥不可导出，但被保护的那段 seed 本身仍可在本机被取走。）
- 威胁边界：能读应用私有目录或拿到数据库备份的一方，即拿到该 RP 的完整设备凭证，可在有效期内伪造断言；跨 RP 使用不同密钥与 pairwise subject，降低跨站关联，但不改变「本地文件即凭证」这一事实。RP 侧仍须自己防重放、限流、校验公钥绑定。
- 取舍与待决项：
  - 是否上平台密钥库（macOS Keychain、Android Keystore、Windows 凭据/DPAPI 一类）：**2026-11-15 用户裁决「上」**，
    **Windows 与 Android 已落地**（2026-11-15），**macOS 待签名后接**。
    落地时的硬要求（旧 seed 必须**迁移后擦除**、密钥库不可用时**拒绝签名而不是回落明文**、
    迁移失败要可诊断且绑定不丢）逐条兑现方式：
    - **不并存**：私钥只有一处（那一列）。有密钥库的系统上那列写的是信封；
    - **不回落**：信封解不开 ⇒ `get_binding` 直接报错（`ForeignBackend`/`Backend` 族），签名链路拿不到私钥；
    - **迁移顺序**：旧格式（明文）行在**第一次被读到时**升级，顺序是「封 → 开回来逐字比对 → 才写回」，
      中途崩溃 ⇒ 下次启动重试，不会出现两条并存；
    - **导出仍是明文**（导出包自己用用户口令加密）：换机/重装要能迁移，而 DPAPI 绑机器、Keystore 绑设备 ⇒
      把信封搬走等于搬了个解不开的东西（`list_bindings_with_secrets` 专门负责这件事）。
    **成本口径（2026-11-15 复核）**：只有 **macOS** 需要代码签名（否则每次读 Keychain 都弹授权框，
    而本应用有开机自启与更新后自动重启 ⇒ 卡死）；**Windows（DPAPI）与 Android（Keystore）零成本即可做**。
    macOS 的免费解法是 **Apple Development 证书**（免费，Team ID 稳定 ⇒ DR 稳定 ⇒ 不再弹框）；
    **付费的 Apple Developer Program 买的是公证与分发，不是「Keychain 能不能用」**。
    详见 [`platform-keychain-free-path-2026-11-15.md`](platform-keychain-free-path-2026-11-15.md)。
  - 待决：macOS Keychain 接入（等签名）、跨平台密钥迁移与备份恢复、无头/无用户会话环境、密钥轮换与旧绑定重绑、密钥损坏时不得静默用新密钥覆盖、移动端 Tauri 工程与签名配置的可用性。
  - 现状方案（SQLite + 0700 + `RpKey` 收口）与平台密钥库方案需产品与安全评审签字；未定案前不得对外宣称硬件级保护。
- 备份 / 迁移 / 清数据后行为：私钥只在本地 DB（macOS 暂缓期间是明文列；Windows/Android 是本机密钥库信封）。
  **Android 侧还有一条额外边界**：系统清除 Keystore（换机恢复、用户清数据、系统重置）⇒ 那份信封解不开 ⇒
  该绑定必须重新显式绑定（不静默用新密钥覆盖原绑定）。导出包（口令加密、装的是明文）是跨机迁移的正路。
  清数据、重装、换设备、备份迁移不含密钥或密钥损坏时，绑定丢失，必须重新显式绑定；不得自动用新密钥覆盖原绑定；旧公钥由 RP 账号管理页撤销。源码对撤销态/已存在绑定有明确拒绝（`DEVICE_AUTH_BINDING_EXISTS`、`DEVICE_AUTH_BINDING_REVOKED`）。
- 为什么写清：外部登录比本地 P2P 身份多一层「可被外部站点验证」的语义，恢复与撤销路径必须由契约明文承担，不能靠用户自行推断。

## 6. 外链窗口与深链边界

- `link` 窗口隔离：`src-tauri/capabilities/default.json` 的 windows 集合刻意不含 label `link`。远端页面因此拿不到 Tauri command capability。`src-tauri/src/commands/logs.rs` 的 `open_link_window` 先用 `validate_external_url` 校验（只放行 http/https、host 非空），再以 `.on_navigation` 只放行 http/https；不向远端页面注入通用 JS / invoke bridge。
- 为什么：这是本仓唯一一处渲染第三方网页的窗口，任何 capability 或通用桥都会把本机命令面暴露给远端内容。
- 深链现状：`src-tauri/tauri.conf.json` 注册 desktop `gosslan` scheme。`src-tauri/src/device_auth.rs`
  的 `parse_authorize_link` 只认 `/authorize/<ref>` 与 `gosslan://authorize/...?origin=...`；
  分享侧已接线：`src-tauri/src/share.rs::parse_share_intent` 认**内联**（`gosslan://share?url=…`、
  `https://<站点>/share?url=…`）与**受控引用**（`/share/<ref>`，本期只解析不解析内容）两种形态，
  并由 `commands/external_share.rs::route_deep_link` 在**一个地方**把深链分派给分享或授权
  （三处调用点：单实例转发 / `on_open_url` / 冷启动 argv）。HTTPS App Link 的域名关联仍只有
  骨架文件（`docs/link-handoff/`），真机关联 `NOT RUN`。
- 网页分享到聊天：**内联闭环已落地** —— 入口解析 + 限额 + 去重 + 内存排队（cap 8 / TTL 10 分钟）
  + `share-request` / `share-error` 事件 + `share_get_pending` / `share_dismiss` 两条命令；
  前端 `SharePanel.vue` 做「来源线索 + 可编辑正文 + 会话搜索/单选 + 显式发送」，发送复用既有
  `send` 通道。**兜底入口**：设置 → 关于（桌面端其「安全」区）的「分享链接」粘贴框 `share_handle_link`
  走**同一个** `begin_share`（深链未注册时唯一的自测路径，与设备认证的粘贴框对称）。
  **系统分享目标（从别的应用分享到本机）**：**读取端已实现，平台写入端未实现**。
  协议是「写文件 → 主应用读文件」（macOS 的 Share Extension 与 Windows 的 MSIX share target
  都是独立进程，只能写共享容器/目录）：落地区在 `app_local_data_dir()/incoming-shares/`，
  文件名 `incoming-<32 位小写十六进制>.json`，正文见
  [`system-share-target-design-2026-11-15.md`](system-share-target-design-2026-11-15.md) §3。
  读取端把落地区当**不可信输入**（严格文件名、大小、时效，且内容走 `share.rs` 的同一个
  构造入口 ⇒ 深链拦得住的落地区也拦得住），先入队后删文件，与深链**共用**队列与面板。
  触发点是应用启动与窗口重新获得焦点（不给常驻托盘的客户端挂永不停歇的 IPC 轮询）。
  **未做**：macOS Share Extension 与 Windows MSIX share target 两个写入端（都要独立工程与
  签名证书，本仓产不出可安装的包），骨架与配置说明见该设计稿 §6。
  **定向分享（可选）**：深链加 `to`（目标会话 id）与 `to_kind`（`peer` / `group`）⇒ 面板**预勾并高亮**
  该目标，但**用户仍要点「发送」**（RP 不能静默往聊天框塞东西）。目标**必须存在**（好友表 / 群表），
  否则**整笔拒**（`EXTERNAL_SHARE_BAD_TARGET`），**不新建会话、不猜、不广播**；目标好友还没聊过 ⇒
  客户端先建一个空会话（不发消息），否则面板列不出来。回执可选：深链带 `receipt=`（HTTPS + 与 `origin` 同源）
  ⇒ 发送后 `POST {share_id, status, sent, failed}`，**不含会话名与内容**；回执地址由**后端从队列取**，
  前端不能指定。
  **未做**：受控 `share_request`（需 RP 端点）、文件分享、第三方分享 SDK、网页预览。
  注意区分：`src/components/ShareDirectory.vue` 与 `src-tauri/src/commands/share.rs` 是
  **P2P 共享目录**，与这里的「外部分享到会话」是两件事（错误码也分族：`SHARE_DIR_*` vs
  `EXTERNAL_SHARE_*`）。
- 分享的边界（内联形态已开放；下列约束是它的红线，不是「将来再说」）：
  - 只暴露窄操作（例如「创建待审分享请求」），不提供任意 Tauri command bridge。
  - 绑定来源（已验证的 RP HTTPS 同源 issuer）、一次性 nonce、过期时间、用户手势、原生确认页，缺一不可。
  - 分享事务与认证事务用不同 action、不同 endpoint、不同状态记录；分享不能借 `authenticate` 的 challenge，不能隐式批准设备绑定。
  - 分享内容不附带 assertion、Cookie、页面 DOM、本地存储或设备私钥；认证确认页不提供分享入口。
  - 实际发送只在用户选定会话并显式点击后发生；取消不产生消息，失败保留可恢复草稿。
- 认证与分享不得混成网页桥：不为分享开放通用 `invoke`，不为认证复用分享通道，也不把外链窗口当通用 OAuth 登录容器。

## 7. RP mock 的能力与限制声明

`scripts/device-auth-rp-mock.mjs` 是契约形状演示：可驱动客户端走完绑定/登录流程，并给出 JWS EdDSA 验签示例。它不是生产后端、SDK，也不是经过验证的 starter。限制逐条如下。

- 内存 `Map` 存事务、绑定、已消费 `jti` 与创建事务的限流窗口，进程重启即全部丢失。
- 自签 localhost 证书，需手动加入系统/钥匙串信任才能联调；真机信任配置 `NOT RUN`。
- 创建事务免 RP session、免 CSRF 检查。
- 事务状态仍是简化模型：对外 pending / approved / denied / expired，内部另有 `consumed` 终态；仍缺 `created`、`awaiting_device`、`cancelled` 等 RP 侧细分。
- 事务 TTL 写死为短时值（以该脚本内的 TTL 常量现读为准），没有可配置的生产级过期与清理策略。
- 验签已要求 `jti` 存在；决策路径按 `jti` 全局去重，重复断言返回明确的重放冲突。这只是 mock 内的进程级去重，不是生产级持久化重放库。
- 已提供 RP 侧撤销端点（`POST /api/device-auth/revoke`，按 `kid` 或 `subject`；客户端的撤销通知走同一条路径，会带 `client_id` 与 `Idempotency-Key`，mock 会核对 `client_id` 并合并同一幂等键的重放），撤销后 authenticate 拒绝；但绑定仍在内存里，重启即恢复。
- 无分享端点，metadata 不含分享字段；外部分享走的是**内联内容**（不经 RP），因此 mock 不参与分享链路。
- `account_hint` 硬编码为固定掩码串，不来自真实 RP 账号。
- **不能作为生产接入依据。** 生产接入必须以 §9 交付的版本化文档与服务端参考实现为准。

## 8. 字段与错误码表

- 字段 allowlist（定义见 `src-tauri/src/device_auth.rs` 的 claim 常量）：
  - `device_subject`：pairwise 随机安装级 subject，对该 RP 唯一，不是全局设备 ID。
  - `device_public_key`：该 RP 专属 Ed25519 公钥，与 P2P 身份密钥分开。
  - `nickname`（可选）：仅当用户主动允许且 RP 请求时才出现，默认不勾选；它是设备昵称，不是认证过的用户姓名。
- 断言禁止泄露的内容：全局 `device_id`、P2P 身份 Ed25519/X25519 私钥、主机名 / 硬件序列号 / 网卡 MAC、通讯录 / 好友 / 群资料、Cookie、RP 访问 token 与长期凭证、完整邮箱 / 手机号、页面 DOM / 本地存储、签名原文与内部堆栈。断言只含协议约定字段与 header 的 `kid`。
- 错误码家在 `src-tauri/src/error_codes.rs` 的 `DEVICE_AUTH_*` 常量族，并与 `src/utils/errors.ts` 的错误码规则表双向对账（对账测试见 `src/utils/errors.test.ts`）。
- **字段与错误码以源码为准，不在此抄完整清单。**
  - 为什么：常量会随实现增减，抄一份进文档就形成第二份手抄真源，一天就漂。集成方读源码常量与版本化字段表即可。
- 错误响应不回显秘密、完整邮箱、签名原文或内部堆栈；未知 claim / 未知协议版本整笔拒（fail closed）。

## 9. 外部接入文档版本化约定

- 版本化对象是 **RP 集成契约**：metadata 与端点形状、字段 allowlist、断言结构与校验、状态机、错误码语义。不是 P2P wire 协议，也不是客户端发版号。
- 协议版本由 RP metadata / request 的版本字段协商，未知版本 fail closed；具体版本值见 `src-tauri/src/device_auth.rs` 的协议版本常量，不在本文写死。
- 客户端版本同样不在本文写死：需要标注当前构建时用 `npm run version:show` 现读（`scripts/version.mjs` 是单一真源）。
  - 为什么：硬数字会漂，命令现读不会。
- 正式开放「外部直接接入」前必须交付：
  - 版本化 RP 接入文档（带契约版本号与变更记录）。
  - 服务端参考实现（事务存储、登录会话绑定、公钥登记、状态查询、RP 侧撤销、重放与并发防护）。
  - 字段 / 错误码表（与源码常量对账）。
  - 密钥轮换与撤销说明（含双边语义与失败重试）。
  - 桌面与移动端关联配置（协议注册、Android App Links 域名关联文件、iOS Associated Domains 站点关联文件）。
  - 沙盒 / 测试环境（与生产隔离，含可复现的联调数据）。
  - 生产验收清单（对应 §10 的判据）。
  - 兼容策略（版本协商、未知版本 fail closed、契约变更给弃用窗口、旧绑定迁移或明确退役路径）。
- 当前状态：以上均为待交付项，本文不登记任何一项为完成。`scripts/device-auth-rp-mock.mjs` 只覆盖契约形状，不替代其中任何一项。

## 10. 发布准入清单

依据同日就绪度审计的「发布准入判据」一节，改成可勾选清单并标注当前证据状态。判据文字以本文为准，便于在仓库内独立复核。

- [ ] RP 事务从创建、原生确认到 RP 会话完成全链路成功；批准、拒绝、过期、重复和网络失败均有确定结局。 — `NOT RUN`
- [ ] 本地与 RP 的绑定 / 撤销状态无歧义，失败可重试或明确恢复方式。 — `部分：源码可见，未运行时验收`（客户端侧首绑分叉、拒绝可观察、幂等键与本地 TTL 已闭合；撤销仍为单边，运行时结局未验收）
- [ ] 签名断言仅含协议约定字段，不泄露全局设备 ID、P2P 私钥、Cookie 或长期 token。 — `部分：源码可见，未运行时验收`（源码可见 claim allowlist 与只公钥面输出，未跑最小披露验收）
- [ ] 桌面签名安装包真实唤起通过；Android / iOS App Links / Universal Links 分平台通过。 — `NOT RUN`
- [ ] 外链窗口不能调用任意本机命令；所有远端回调严格限制 HTTPS 同源与重定向。 — `部分：源码可见，未运行时验收`（源码可见 `link` 窗口隔离、不跟随重定向、端点同源校验，未跑反例验收）
- [ ] 分享流程经用户选择接收人并显式发送；取消不会发消息，失败保留可恢复草稿。 — `部分：源码可见，未运行时验收`（面板 + **多选逐项勾** + 显式发送 + 部分失败只留失败项可重试 + 失败保留草稿已落地；接线由 `src/utils/shareWiring.test.ts` 七段钉着，含设置页粘贴兜底；真机唤起与真实体验收仍 `NOT RUN`）
- [ ] 外部 RP 文档、示例、错误码和生产注意事项与实际客户端版本一致。 — `部分：文档已交付`（[`external-integration-guide-2026-11-14.md`](external-integration-guide-2026-11-14.md) 覆盖两端点字段表、断言校验步骤、错误码与接入自测清单；「与实际版本一致」仍需真实 RP 联调后复核）

**只有全部有可复现证据，才可把「外部直接接入」标为可用。** 部分项有源码可见的实现，不等于已有准入证据；`NOT RUN` 项不得以「代码路径存在」代替。

## 11. 本轮未验证项 / 不做项

- 真机 App Links / Universal Links：需要 Android 签名包、`assetlinks.json` 域名部署与安装验证；需要 iOS Associated Domains 权限、`apple-app-site-association` 站点文件与真机；需覆盖冷启动、前台唤起、未安装、链接无效、重复点击、返回原页面。当前 manifest / Info.plist / entitlements 均无对应配置。
- 签名桌面安装包唤起：需要 macOS / Windows 签名发行包、系统协议注册与浏览器跳转；需实机验证安装、升级、卸载后的注册语义。
- 真实 RP 后端：需要外部 RP 实现事务存储、登录会话绑定、公钥登记、状态查询、RP 侧撤销、重放与并发防护，并跑契约测试（非法状态转移、重复批准、错账户、重放）。
- 第三方分享 SDK：需要各平台官方 SDK / API、平台资质与审核、包签名配置；不通过猜测私有 URL scheme 直发。
- 系统分享面板：需要各桌面 / 移动系统原生分享目标能向 Gosslan 返回内容，并验证目标缺失、取消、失败时的明确退路。
- 端到端验收矩阵：需要 `docs/notes/external-app-device-auth-design-2026-11-13.md` 的验收矩阵在真实环境跑出可复现结果（正常绑定 / 登录、拒绝与过期、防重放、防账户错绑、防来源欺骗、撤销、密钥变化、平台唤起、最小披露、分享 / 认证隔离）。

本轮已落地（代码层）：设备认证事务与绑定状态机、拒绝可观察状态与重试、队列满载反馈、幂等键与本地 TTL 兜底；`/share` 深链的解析纯函数与反例单测；Android App Links / iOS Universal Links 的配置骨架；RP mock 的重放去重、撤销端点与 `consumed` 终态。逐项验收证据见对应单测与 CHANGELOG；真机与运行时证据仍按 §10 标 `NOT RUN`。

本轮已落地（2026-11-14 第二批，分享闭环）：`gosslan://share?url=…&title=…&text=…` 与
`https://<站点>/share?url=…` 两种**内联**入口（解析、限额、去重、内存排队、`share-request` /
`share-error` 事件、`share_get_pending` / `share_dismiss` 两条命令）；面板做「来源线索 + 可编辑
正文 + 会话搜索/单选 + 显式发送」，发送复用既有 `send`。深链分派收口到 `route_deep_link`
（分享 / 授权靠 host 区分，避免三处各判一次）。

本轮已落地（2026-11-14 第三批，自测兜底）：`share_handle_link` 命令 + 设置 → 关于 → 安全 的
「分享链接」粘贴框。深链靠系统协议注册，开发期构建/未签名包/未注册的 Linux 桌面拿不到注册 ——
没有这条，接入方在本地只能先打签名包才能验证分享，接入指南 §4 的自测清单也就无法执行。
它与深链入口走**同一个** `begin_share`（限额/去重/排队/事件全不变），因此「粘贴能过」等价于
「深链能过」，不构成第二条信任通道。

本轮仍不做（有明确理由，不是遗漏）：
- **受控 share request**（`/share/<不透明引用>`）：需要 RP 侧「用 ref 换内容」的端点，本仓没有；
  链接形状已能解析，命令层明确回 `EXTERNAL_SHARE_REFERENCE_UNSUPPORTED`，不静默失败。
- **文件分享 / 系统分享面板 / 第三方分享 SDK**：需要平台工程改造（Share Extension、ACTION_SEND、
  shell 扩展）或平台资质与审核，且分享目标缺失/取消/失败的产品退路未定。
- **网页预览**：抓取任意 URL 等于把 SSRF / 内网探测 / 跟踪像素引进来，本期只显示调用方自报内容。
- 不新增中心账号或用户资料服务，不把现状包装成硬件保护。

### 11.1 2026-11-15 产品裁决（登记，不是现状）

| 事项 | 裁决 | 当前状态 |
|---|---|---|
| 分享面板单选 / 多选 | **多选**（逐项勾、按钮带目标数、部分失败只留失败项可重试） | **已实现**（`src/components/SharePanel.vue`，判据在 `shareWiring.test.ts`） |
| 系统分享目标（从别的应用分享到本应用） | **要做，先 macOS / Windows** | **读取端已实现，平台写入端未实现**：协议 + 读取端 + 两份骨架已交（`incoming_share.rs` + `commands/external_share.rs` 的扫描 + 设计稿 §6）；macOS 需要 Share Extension（Xcode target，本仓构建不出）、Windows 需要 MSIX share target，两者都要签名打包与真机验证 |
| 双边撤销 | **做，先定契约再实现** | **已实现（客户端侧）**：metadata 加可选 `revocation_endpoint`（HTTPS 同源）、撤销先本地后通知、通知带 `Idempotency-Key`、体只回 `{client_id, kid}`；结果由 `rp_notified` 分四态呈现，通知失败可**重发**。判据 `deviceAuthRevokeWiring.test.ts` + Rust 单测。RP 侧作废与最终一致性仍需生产实现（见 §4） |
| RP 私钥保护 | **上平台密钥库** | 未实现。要求与迁移顺序见 §5；成本口径与免费路径见 [`platform-keychain-free-path-2026-11-15.md`](platform-keychain-free-path-2026-11-15.md)（只有 macOS 需签名，且免费证书即可） |
| 开放接口：好友同步 / 定向分享 / 事件交付 | **要做**（scope 逐项授权，默认全关） | **已实现（客户端侧）**（2026-11-15 裁决后落地，设计稿 [`open-extension-api-design-2026-11-15.md`](open-extension-api-design-2026-11-15.md)）：`sync` 动作 + `friends.read` / `events.metadata` 两个 scope、确认页逐项勾选（默认全关）、决策回写体带可选 `data`（形状：**没有正文、没有公钥、没勾的连键都没有**）、scope 只对本次事务有效（**不落库**）；定向分享（`to` / `to_kind` 预填 + 目标 fail-closed + 可选回执）。**注意**：`friends.read` 只给好友列表 ⇒ RP 拿不到群列表，「一键发到某个群」需要 RP 另行知道 `group:<群 id>` |
| 导出 / 恢复绑定密钥 | **要做**（口令加密单文件；不做云备份、不导出 P2P 密钥） | **已实现（客户端）**：`rp_key_backup.rs` + 三条命令 + 设置页区块；判据 `rpKeyBackupWiring.test.ts` 与 Rust 单测。设计稿：[`rp-key-export-recovery-design-2026-11-15.md`](rp-key-export-recovery-design-2026-11-15.md)。**顺序硬约束**：导出能力必须先于「抹掉 SQLite 明文 seed」可用 |

已实现的那几条（多选、导出/恢复、双边撤销的客户端侧、系统分享目标的**读取端**、**数据交付与定向分享的客户端侧**）
在本轮改代码与文档；**平台分享写入端**与**平台密钥库**仍只有裁决、没有实现，
对外仍按本节上面的「未做」口径回答，不得写成已具备。

## 12. 复跑与维护

可复现的检查命令：

- `npm run version:show` — 现读客户端版本，不在本文写死数字。
- `node scripts/check-doc-citations.mjs` — 校验本文所有裸路径引用指向真实文件（`npm run verify` 也会带它跑）。
- `npm run test` — 前端单测。
- `cd src-tauri && cargo test --features bluetooth` — Rust 全量单测；`--features bluetooth` 不能省，漏了会让整批 BLE 用例连同被测代码一起消失。
- `cd src-tauri && cargo test --features bluetooth device_auth` — 按名过滤，只跑设备认证相关用例。
- `npm run lint:md` — 文档格式检查。

改了实现要同步本文哪一节：

| 改动位置 | 同步本文 |
| --- | --- |
| `src-tauri/src/commands/device_auth.rs`、`src-tauri/src/db/device_auth.rs`（绑定状态、批准/拒绝/撤销顺序） | §3、§4、§10 |
| `src-tauri/src/device_auth.rs`（协议版本、claim allowlist、断言字段、深链解析、TTL 常量） | §3、§4、§8、§9 |
| `src-tauri/src/crypto.rs` 或密钥存储方案（`RpKey`、平台密钥库） | §5 |
| `src-tauri/capabilities/default.json`、`src-tauri/src/commands/logs.rs`、`src-tauri/tauri.conf.json`（窗口隔离、scheme、URL 校验） | §6、§10 |
| `src-tauri/gen/android/app/src/main/AndroidManifest.xml`、`src-tauri/Info.plist`、`src-tauri/entitlements.plist`、域名关联文件 | §6、§9、§11 |
| `scripts/device-auth-rp-mock.mjs` | §7 |
| `src-tauri/src/error_codes.rs`（`DEVICE_AUTH_*`） | §8 |
| `src-tauri/src/share.rs`、`src-tauri/src/commands/external_share.rs`（分享入口、限额、排队、粘贴兜底） | §6、§10、§11 |
| 契约版本或客户端版本（`package.json`、`scripts/version.mjs`） | 用 `npm run version:show` 重读并同步 §9 |
| 跑完真机 / 安装包 / 真实 RP 后端 / 端到端验收 | 更新 §10、§11 的证据状态（`NOT RUN` → 可复现证据） |

维护约定：本文只登记契约与差距，不写「本轮已修复」。实现变化先改源码，再按上表改本文；证据状态只在拿到可复现结果后更新。契约发生不兼容变更时，先在版本化 RP 接入文档起新契约版本并给弃用窗口，再改客户端。
