// Hello 认证与好友接受：判据、密钥绑定、有界补发、签名 Hello 构造
// 从 transport.rs 搬出：`include!` 回同一模块 ⇒ 模块路径、可见性、测试全名一字不变。
// 大文件拆分第四批；守卫视图与领域图的分册清单一同登记。

/// Hello 认证的**纯判定**：给定「已绑定公钥」（`None` = 首次接触 TOFU），
/// 判断本次 Hello 是否可信。抽出来是为了可单测（不依赖 AppState）。
fn hello_auth_decision(
    bound: Option<&str>,
    device_id: &str,
    tcp_port: u16,
    nonce: &str,
    x25519_pubkey: &str,
    ed25519_pubkey: &str,
    sig_b64: &str,
) -> Result<(), String> {
    if nonce.is_empty() || sig_b64.is_empty() {
        return Err(format!("Hello 缺少 nonce/sig（device_id={device_id}）"));
    }
    let data = hello_signing_bytes(device_id, tcp_port, nonce, x25519_pubkey, ed25519_pubkey);
    match bound {
        // 已知身份：自报公钥必须与绑定公钥一致，且签名必须由该公钥验证通过。
        // 攻击者即便拿到真实公钥也签不出来；用自己公钥签名则与绑定值不符。
        Some(expected) => {
            if expected != ed25519_pubkey {
                return Err(format!(
                    "Hello 公钥与已绑定身份不符（device_id={device_id}）：对方可能重装了应用。\
                     若确认是本人重装，删掉该好友后重新添加即可（聊天记录保留、无需重启）"
                ));
            }
            if !crypto::verify_signature(expected, &data, sig_b64) {
                return Err(format!("Hello 签名校验失败（device_id={device_id}）"));
            }
            Ok(())
        }
        // 首次接触（TOFU）：仅要求自洽签名；密钥绑定在后续 announce/upsert 中固化。
        // 注意：TOFU 分支无法冒充「已建立信任的身份」——那是上面 Some 分支的事。
        None => {
            if !crypto::verify_signature(ed25519_pubkey, &data, sig_b64) {
                return Err(format!("Hello 自签名校验失败（device_id={device_id}）"));
            }
            Ok(())
        }
    }
}

/// 校验 Hello 握手，确认 TCP 对端确实持有 `device_id` 绑定的 Ed25519 私钥。
///
/// 信任根：`friends`（持久、权威）→ `peers`（运行时）中该 device_id 已绑定的
/// Ed25519 公钥。两者都没有时才走 TOFU（首次接触），用 Hello 自带的公钥验签。
///
/// 这封堵的是：任意局域网节点在 Hello 里自报好友/群主的 device_id 即可建立链路，
/// 随后利用 `from == peer_id` 的绑定关系伪造 GroupMemberRemoved / GroupRename 等
/// 明文控制消息（把群从受害者本地删掉、改名）。已建立信任的身份必须签名匹配。
///
/// 返回 `Err(原因)` 表示必须拒绝该连接。
pub(crate) fn verify_hello(
    state: &AppState,
    device_id: &str,
    tcp_port: u16,
    nonce: &str,
    x25519_pubkey: &str,
    ed25519_pubkey: &str,
    sig_b64: &str,
) -> Result<(), String> {
    if nonce.is_empty() || sig_b64.is_empty() {
        return Err(format!("Hello 缺少 nonce/sig（device_id={device_id}）"));
    }
    // 已绑定身份：**好友表（持久，权威）优先**；在线节点表只作回落，
    // 且**回落项必须是已验签的**（`keys_verified`）。
    //
    // ⚠️ 为什么回落必须过滤：`peers` 里的公钥可能来自**未签名**的 UDP announce。
    // 若把广播来的公钥当成绑定，攻击者只要抢先广播（真实节点 5s 才播一次，他 100ms 一次，
    // 必赢这个竞态）就能让真实好友的 Hello 被判「公钥与已绑定身份不符」而永远连不上，
    // 同时攻击者自己的 Hello（用他自报的那把公钥验签）却能顺利通过 —— 完成身份冒充。
    let bound = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_friend_ed25519(&dbc, device_id)
    }
    .or_else(|| {
        let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
        bound_ed25519_from_peer(peers.get(device_id))
    });
    // 绑定值与自报值不一致（对方重装应用换了身份）时：先按**新私钥自验签**，
    // 通过则给聊天界面留一个"用户确认后同步新密钥"的候选（仍拒绝本次连接）。
    // 未通过自验签 = 连"持新私钥者本人"都证明不了，或纯伪造，不登记。
    if let Some(expected) = bound.as_deref() {
        if expected != ed25519_pubkey
            && crypto::verify_signature(
                ed25519_pubkey,
                &hello_signing_bytes(device_id, tcp_port, nonce, x25519_pubkey, ed25519_pubkey),
                sig_b64,
            )
        {
            record_key_rotation_candidate(state, device_id, x25519_pubkey, ed25519_pubkey);
        }
    }
    hello_auth_decision(
        bound.as_deref(),
        device_id,
        tcp_port,
        nonce,
        x25519_pubkey,
        ed25519_pubkey,
        sig_b64,
    )?;
    // ⚠️ nonce 的消费必须放在**验签通过之后**。
    //
    // 它是一条有界 FIFO（512 条）：先消费等于给任何**未通过验签**的连接发了一张
    // 污染缓存的入场券 —— 洪泛者可以持续占用/挤出槽位，把合法对端的 nonce 顶掉，
    // 或在窗口内让合法 Hello 被误判成「重放」而拒掉（表现为"好友时连时断"）。
    // 顺序调换不改变任何安全性质：重放的 Hello 签名本来就有效，
    // 依旧会被下面这一判拦下 —— 只是它不再有机会占用槽位。
    if !state.accept_hello_nonce(nonce) {
        return Err(format!("Hello nonce 重放（device_id={device_id}）"));
    }
    Ok(())
}

/// 在线节点表里的公钥**能否作为 Hello 的身份绑定** —— 唯一判定点。
///
/// 只有 `keys_verified`（Hello 验签通过后由 `mark_peer_keys_verified` 置位）的条目才算数。
/// 未验签的条目只可能来自**未签名**的 UDP announce：任何人拿到 device_id（announce 里
/// 明文广播）就能以它广播自己的公钥。若这种公钥被当成绑定，攻击者只需抢先广播
/// （真实节点 5s 播一次、他 100ms 一次，必赢竞态），就能：
///   ① 让真实好友的 Hello 被判「公钥与已绑定身份不符」而永远连不上；
///   ② 用自己的私钥签 Hello 冒充该好友 —— 绑定值就是他自己的公钥，验签必然通过。
/// 抽成独立函数是为了让这条规则有名字、有单测，而不是散在 `or_else` 闭包里。
fn bound_ed25519_from_peer(peer: Option<&Peer>) -> Option<String> {
    peer.filter(|p| p.keys_verified)
        .and_then(|p| p.ed25519_pubkey.clone())
}

/// Gossip 锚点：与 [`bound_ed25519_from_peer`] **同一把尺子** —— 只认验签过的条目。
///
/// 为什么必须有它（2026-10-29 全仓审计 SEC-03）：同一条身份（某 `device_id` 的公钥）有两条
/// 取用路径，Hello 那条过滤 `keys_verified`、Gossip 锚点那条**不过滤** ⇒ 未签名 UDP announce
/// 灌进来的公钥能当锚点用。攻击者只要用某个**好友**的 `device_id` 广播自己的公钥（announce
/// 是明文、`device_id` 谁都能看到），随后用自己私钥签一条 `sender_id = 该好友` 的信封，
/// 锚点比对就通过 ⇒ 聊天库里出现一条"好友发的"伪造消息；更糟的是真实好友的 Hello 之后会
/// 判「公钥与已绑定身份不符」⇒ 与那位好友的跨跳聊天静默中断。
///
/// 返回 `None` 的语义是**"不认识"**（不是"认识但没公钥"）：调用方会回落到 `friends` 表那份
/// 持久化锚点（`gossip.rs` 的 `None` 分支），所以只靠中继、从未直连的好友照旧能收消息。
fn verified_peer_anchor(peer: Option<&Peer>) -> Option<(Option<String>, Option<String>)> {
    peer.filter(|p| p.keys_verified)
        .map(|p| (p.ed25519_pubkey.clone(), p.x25519_pubkey.clone()))
}

/// 成为好友那一刻要绑的公钥快照（两把钥匙 + `peers` 里“是否验签过”的读数）。
///
/// 只有验签通过的 Hello 能打上 `keys_verified`（见 `mark_peer_keys_verified`），
/// 未签名的 UDP announce 带来的不算。
///
/// `verified` 是"能不能拿它当身份锚点"的**唯一**判据。此前只有 `upsert_peer` 问它，而三条
/// 成为好友的路径（直连 FriendAccept / 跨跳 Gossip FriendAccept / 本机点同意）读的是
/// **同一张 `peers` 表**却不过这道闸 —— 同一个概念两处规矩，就是本仓库反复付钱的那类缺陷。
/// 收紧的理由：`friends.ed25519_pubkey` 此后既是 Hello 的验签锚点（INV-P21），又是
/// **公网中继电路的准入判据**（`db/friends.rs` 的 `list_bound_friend_identities` 只看它
/// 非空），一次伪造广播把它抢先填上，后果从"消息被加密给攻击者"扩到"我们主动跨公网
/// 给攻击者建电路、并把协商验签锚在它的钥匙上"（ADR-0020 自己称那把钥匙为"整个设计的支点"）。
///
/// 留 NULL 不是死路：验签通过的 Hello 会经 `handle_message` 的 Hello 分支打上
/// `keys_verified`（见 `mark_peer_keys_verified` 那条 ⚠️），下一条 announce 就补得进来 ——
/// 而 `update_friend_pubkeys` 只填空、不覆盖，所以"晚一点绑"安全，"绑错"永久。
///
/// **必须在取 `state.db` 锁之前**用 [`FriendKeySnapshot::capture`] 取好，再把快照传下来：
/// `peers` 与 `db` 是两把独立的 `std::sync::Mutex`，而 gossip 接收热路径是
/// `peers → db`。若本函数在 db 锁内再去求 peers，两条热路径就构成 ABBA
///（重启后 `peers` 为空时 gossip 必走 None 分支，最容易撞上）。
pub(crate) struct FriendKeySnapshot {
    x25519: Option<String>,
    ed25519: Option<String>,
    verified: bool,
}

impl FriendKeySnapshot {
    /// 一次取锁读齐“两把钥匙 + 是否验签过”。条目不存在 ⇒ 全空、未验证。
    pub(crate) fn capture(state: &AppState, device_id: &str) -> Self {
        let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
        match peers.get(device_id) {
            Some(p) => Self {
                x25519: p.x25519_pubkey.clone(),
                ed25519: p.ed25519_pubkey.clone(),
                verified: p.keys_verified,
            },
            None => Self {
                x25519: None,
                ed25519: None,
                verified: false,
            },
        }
    }

    /// **Case A 的证明快照**：来自一封「验签通过的 Gossip FriendAccept」，
    /// 且它的 `request_id` 与本机 `pending_out_requests` 里那条申请对得上。
    ///
    /// 为什么它和 `capture` 不是一回事：`capture` 读的是 `peers` 表（可能被未签名
    /// announce 写过，所以 `verified` 决定 ed25519 能不能绑）；而这里的两个值是
    /// **信封自报值**，它们的可信度来自两件事，缺一不可：
    /// 1. Ed25519 签名验证通过（`handle_gossip` 第 1 步已经做过，调用方复用那次结果）；
    /// 2. `request_id` 回显 —— 那个 id 躺在申请信封的**加密载荷**里，只有被申请的
    ///    那台机器解得开 ⇒ 回显它证明「收到并解密了我那条申请」。
    ///
    /// ⚠️ 安全边界（必须写进提交说明）：验签只证明「持有这把 ed25519 私钥」，
    /// 不证明「这就是 sender_id 那个人」。所以 Case A 的绑定点是**本机发起申请这条
    /// 本地记录**（id 对得上），不是信封自报本身 —— 少了第 2 条就退回 Case B。
    pub(crate) fn proven_by_matched_request(ed25519: String, x25519: String) -> Self {
        Self {
            x25519: Some(x25519),
            ed25519: Some(ed25519),
            verified: true,
        }
    }
}

/// 这一刻允许绑哪些钥匙（纯函数 —— 把"两列两套规矩"这条判据单独钉住，不必造 AppState）。
///
/// `verified` 来自 [`FriendKeySnapshot`]：**加密钥匙照绑，身份锚点只认被证明过的来源**。
/// 未 verified 时把 `ed25519` 收成 `None` 不是"漏了一步"，而是刻意留 NULL 等一次验签通过的
/// Hello 来补（`upsert_peer` 那条路本来就做这件事）—— 因为 `update_friend_pubkeys` 只填空、
/// 首写者永久胜出，"晚一点绑"安全，"绑错"永久。
fn acceptable_friend_keys(
    verified: bool,
    x25519: Option<String>,
    ed25519: Option<String>,
) -> (Option<String>, Option<String>) {
    (x25519, if verified { ed25519 } else { None })
}

/// 成为好友那一刻把公钥补进 `friends`：**加密钥匙照旧早绑，身份锚点只认被证明过的来源**。
///
/// 为什么两列区别对待（这是 #32 这一片的全部要点）：
///   · `x25519` 是功能性钥匙 —— 不绑就是"首次加密发送失败"（三条调用点原本各写一遍的注释
///     说的都是这件事），而 Gossip 那条补齐路径以"这一封能解密"作持有证明，收紧它只会把
///     可靠性修回去；
///   · `ed25519` 是**身份锚点** —— Hello 验签（INV-P21）、安全码、以及公网中继的准入判据
///     （`list_bound_friend_identities` 只看它非空）全都读它，而 `update_friend_pubkeys`
///     只填空、首写者永久胜出 ⇒ 一次伪造广播就能把它永久钉死。
///
/// 未 verified 时留 NULL 不是死路：任何一次验签通过的 Hello 都会经 `upsert_peer` 补上。
/// 调用方必须**已经持有** `state.db` 的锁。本函数**只碰 `conn` 与快照**，不再取任何锁 ——
/// 同锁重入会当场死锁，而反过来在 db 锁内存取 `peers` 会与 gossip 热路径构成 ABBA。
pub(crate) fn bind_friend_keys_on_accept(
    conn: &rusqlite::Connection,
    friend_id: &str,
    keys: FriendKeySnapshot,
    logger: &crate::logging::Logger,
) {
    let (x, e) = acceptable_friend_keys(keys.verified, keys.x25519, keys.ed25519);
    if x.is_some() || e.is_some() {
        if let Err(e) = db::update_friend_pubkeys(conn, friend_id, x.as_deref(), e.as_deref()) {
            crate::logging::log_write_failure(logger, "update_friend_pubkeys", e);
        }
    }
}

/// 把某节点的公钥标记为**已验证**（Hello 验签通过后调用）。
///
/// 为什么必须有这个显式升级点：`peers` 表由两条信任级别完全不同的路径共同维护 ——
/// 未签名的 UDP announce（可伪造）与验签通过的 Hello（可信）。只靠「表里有值」无法区分
/// 二者，于是未验证的公钥会被当成身份绑定用（详见 `verify_hello` 与 `upsert_peer` 的注释）。
/// 这里用一对公钥的**实际值**再核对一次：只有与 Hello 自报值一致时才升级，
/// 避免在验签与本次写入之间被另一条 announce 插空改动。
///
/// ⚠️ **条目不存在时它是空操作**（下面的 `let Some(p) = ... else { return }`），所以"在握手
/// 验签通过后立刻调一次"**不够**：出站拨号与 BLE 那两条路径的 `peers` 条目是稍后才由
/// `handle_message` 的 Hello 分支经 `upsert_peer` 建的（`upsert_peer` 新建时恒标
/// `keys_verified: false`）。只在握手处调，则"第一次连接的对方"整个会话都是未验证 ⇒
/// `friends.ed25519` 补不上 ⇒ 安全码算不出、公网中继永不准入。所以 Hello 分支在
/// `upsert_peer` **之后**再调一次（那里条目必然已带着这对刚验过的钥匙）。
fn mark_peer_keys_verified(state: &AppState, device_id: &str, x25519: &str, ed25519: &str) {
    let mut peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
    // ⚠️ **只给已存在的记录打标，绝不凭空造记录**。
    //
    // 曾经的写法是「Hello 早于 announce ⇒ 先插一条占位记录」，那是错的：
    // `peers` 的条目还要承载 **ip / tcp_port / nickname**（「添加好友」列表直接读它、
    // 拨号也用它），凭空造出来的条目这些字段全是空的 —— 表现为「搜得到这个节点、
    // 但加不上好友」，而且会被当成"在线"参与 UI 判定。
    //
    // 对端若还没 announce，这里就什么都不做：`bound` 回落为空 ⇒ 走 TOFU 分支
    // （与本次改动之前的行为完全一致），下一条 announce 会把它正常登记进来。
    let Some(p) = peers.get_mut(device_id) else {
        return;
    };
    if p.x25519_pubkey.as_deref() != Some(x25519) || p.ed25519_pubkey.as_deref() != Some(ed25519) {
        return; // 与自报值不一致：不动（交由既有 key_conflict 路径处理）
    }
    p.keys_verified = true;
}

/// 同意好友之后**忘掉这条申请**（内存态 `pending_requests` 里的那一行）。
///
/// 真实缺陷（用户 2026-09-12 真机实测）：双方互发过申请时，A 点了同意，B 的「新朋友」里
/// 那条申请**还在** —— 因为直连路径（`Message::FriendAccept`）只加了好友、没有清 pending，
/// 而跨跳路径（`GossipKind::FriendAccept`）清了。同一件事两条路径行为不一致，
/// 于是"有时候会清、有时候不清"。现在两条路径 + `respond_friend_request` 都走这一个助手，
/// 前端再用 `pendingRequests`（按好友列表过滤）兜一层，不会再出现"已经是好友还挂在申请里"。
/// 收到好友申请时的统一前置判断：**对方已经是我的好友就直接同意**。
///
/// 返回 `true` 表示"已经自动处理掉了，不要再往 pending 里插"。
///
/// ## 为什么必须有（用户 2026-09-12 真机实测的 bug）
/// B 的好友列表里已经有 A，而 A 是**重置过的账号**、列表里没有 B：
///   · A 发申请 → 旧实现只在 B 侧插一条 pending；
///   · 而 `get_pending_requests` 又会把"申请人是已是好友"的条目**过滤掉**
///     （那是为了修"已经是好友了、申请还挂着"）；
///   ⇒ 两边都看不到、谁也加不上。用户只能先**删掉** B 里的 A、再加回来。
///
/// 正确语义（用户给的规则）：**"他已经是我的好友"就等于我已经同意了这件事** ——
/// 收到这种申请时直接走完整的"同意"路径（落库 + 回执 + 清 pending + 通知 UI），
/// 双方关系立刻收敛，不需要任何人工动作。
///
/// 为什么放在两条 FriendRequest 路径**都**调：直连（`Message::FriendRequest`）与跨跳
/// （`GossipKind::FriendRequest`）是两套独立的入口，只在一条上修就会"同一件事两种行为"。
async fn auto_accept_if_already_friend(state: &Arc<AppState>, peer_id: &str) -> bool {
    let already_friend = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_friend(&dbc, peer_id).is_some()
    };
    if !already_friend {
        return false;
    }
    state.logger.info(
        "friend",
        format!("收到已是好友的申请：自动同意 peer={peer_id}（双方关系收敛）"),
    );
    if let Err(e) = crate::commands::accept_friend_request(state, peer_id).await {
        state
            .logger
            .warn(
                "friend",
                format!("code=FRIEND_AUTO_ACCEPT_FAILED peer={peer_id}：自动同意（收到已是好友的申请）失败：{e}"),
            );
    }
    true
}

/// 收到「好友申请已通过」后的**全部**本地动作 —— 直连与跨跳共用这一个家。
///
/// ## 为什么要收成一家（2026-09-28 架构复审抓到）
/// "重复投递不许刷屏"这条判据原先**只写在跨跳那一份里**（`gossip.rs`，注释里还记着
/// 真机日志同一秒三次那个症状），直连这一份没有 ⇒ 同一条链路上同一个缺陷照旧存在。
/// "同一句话在两处各写一遍、其中一处缺条件"就是这类缺陷的形状，所以连留痕文字
/// 都收进来（只有 `trace` 按来源不同）。
///
/// ## 幂等判据
/// `FriendAccept` 没有 ACK 机制，发送方会持续补发（见 `flush_pending_friend_accept`）⇒
/// 只按"这一次是否真的从不是好友变成好友"决定要不要通知；`add_friend` 本身是幂等的。
/// 「这条好友同意该不该落库」的**唯一**判据（纯函数，可单测）。
///
/// 为什么需要它（2026-10-29 全仓审计 SEC-01）：网络路径收到 `FriendAccept` 时只校验了
/// 「帧里的 from 是链路对端」「to 是本机」两件事，**完全不校验我方是否真的发过申请** ⇒
/// 任何能连上来的对端发一条 `{type:friend_accept, from, to}` 就能把自己写进 `friends` 表
/// （`to` 的值在 Hello 里就会回给它），等价于"对端自助获得本机信任"——而 `friends` 表是
/// 文件接收、共享目录、内容寻址、中继电路的共同输入。
///
/// 两个放行条件：
/// - `was_friend`：重复投递 / 幂等重放（`FriendAccept` 没有 ACK，对方会补发）；
/// - `has_pending_out`：**我方**发过申请、正等回执（`pending_out_requests`）。
///
/// ⚠️ 注意方向：`pending_requests` 是**入站**（别人求我）那张表，拿它判这条会把合法同意
/// 全拒掉 —— 两张表在 `forget_pending_request` 里一起清，但语义相反。
pub(crate) fn friend_accept_is_expected(was_friend: bool, has_pending_out: bool) -> bool {
    was_friend || has_pending_out
}

pub(crate) fn apply_friend_accept(
    state: &Arc<AppState>,
    from: &str,
    trace: &str,
    // Block 1 / Case A：一封「验签通过 + request_id 与本机申请对得上」的跨跳同意
    // 带来的证明快照。直连路径传 `None`（那边由 Hello 的 `keys_verified` 负责）。
    proof: Option<FriendKeySnapshot>,
) {
    let name = resolve_nickname(state, from);
    // 公钥快照在 db 锁**之外**取好：db 锁内再求 peers 会与 gossip 的 peers→db 构成 ABBA。
    let key_snapshot = proof.unwrap_or_else(|| FriendKeySnapshot::capture(state, from));
    // ① 先判「这是不是我们要的那条同意」——必须在任何写库之前（判据是纯函数，见上）。
    let was_friend = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_friend(&dbc, from).is_some()
    };
    // 撤回中的申请仍然算"我方发出过、还没被处理"：对端若先把好友关系落库，
    // 这条同意是**仲裁的明确结果**（同意赢），必须接受并盖掉"已撤回"。
    let has_pending_out = state
        .pending_out_requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains_key(from)
        || state
            .pending_out_withdrawals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(from);
    if !friend_accept_is_expected(was_friend, has_pending_out) {
        // 不写库、不 emit、不通知：只留一行便于排查的痕迹（这条本身就是"有人在硬塞"）。
        state.logger.warn(
            "friend",
            format!("code=FRIEND_ACCEPT_UNSOLICITED peer={from}（我方没有发出中的申请，已忽略）"),
        );
        return;
    }
    let was_friend = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let seen = was_friend;
        if let Err(e) = db::add_friend(&dbc, from, &name, None) {
            crate::logging::log_write_failure(&state.logger, "add_friend", e);
        }
        // 同步公钥：x25519 照旧早绑，ed25519 只认 verified 来源
        // （跨跳到达的那一份尤其要紧 —— 它允许 TOFU，`peers` 里那对钥匙
        //  可能来自未签名广播，判据在 `bind_friend_keys_on_accept` 里）。
        bind_friend_keys_on_accept(&dbc, from, key_snapshot, &state.logger);
        // ★ 发起方也建会话（审计 A10）：同意方那条在自己的 `accept_friend_request` 里建，
        // 而发起方此前只有**真的发出一条消息**才会冒出会话 ⇒ 双方点开后一头有会话、
        // 另一头要等对方先说话，同一件事两条路径行为不一致。
        // `ensure_conversation` 是 `INSERT OR IGNORE` ⇒ 重复回执/重复投递都只有一行，
        // 既不碰已有会话的摘要与未读，也不动历史消息。
        if let Err(e) = db::ensure_conversation(&dbc, from, "single", &name, None) {
            crate::logging::log_write_failure(&state.logger, "ensure_conversation", e);
        }
        seen
    };
    // 已经是好友了 ⇒ 这条申请必须消失（否则「新朋友」里会留着一条永远处理不掉的申请）。
    forget_pending_request(state, from);
    // emit 每次都发：前端 store 只是据此重拉好友列表（幂等），
    // 而漏发会让「首次那个 emit 恰好没被界面收到」时界面永远不刷新。
    let _ = state.app.emit("friend-accepted", from);
    if was_friend {
        // 重复投递：只留一行便于排查的痕迹，**不通知**。
        state
            .logger
            .info("friend", format!("重复的好友同意（已忽略）peer={from}"));
    } else {
        state.logger.info("friend", format!("{trace} peer={from}"));
        // 好友申请/通过是**不经前端**的通知 ⇒ 后端自己判开关与权限；丢弃的只是返回值，
        // 跳过/失败都在 notifications 里带码落日志（code=NOTIFY_*），这里只发起。
        let _ = crate::notifications::show_if_enabled(
            state,
            "好友申请已通过",
            &format!("{name} 已成为你的好友"),
        );
    }
}

/// 「这条到达的好友申请该不该弹系统通知」的判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FriendRequestArrival {
    /// 本机第一次握着这条申请 ⇒ 留痕 + 弹系统通知。
    Notify,
    /// 同一条申请再次到达 ⇒ 事件照发（前端幂等刷新列表），**不弹通知**。
    SilentRefresh,
}

/// 幂等判据的**纯函数内核**：`first_sighting` = 登记前内存里没有这个人
/// （= `pending_requests.insert(..)` 返回 `None`）。
///
/// 为什么要钉死这一格（用户 2026-10-14 真机：「群内加好友会弹出很多个，连续多条的弹窗也有问题」）：
/// 好友申请**没有回执**，发送方在每次建链补全和每次心跳都会补发一次
/// （`flush_pending_friend_request`，心跳 5s 一轮），而每份补发都是**新 `message_id`** 的信封
/// ⇒ 接收方两层去重（mesh `on_receive` + `GossipEngine::is_new`）结构上看不见"重复"。
/// 所以幂等只能判在"本机是否已经握着这条申请"上，判在帧 id 上是判不住的。
pub fn friend_request_arrival_decision(first_sighting: bool) -> FriendRequestArrival {
    if first_sighting {
        FriendRequestArrival::Notify
    } else {
        FriendRequestArrival::SilentRefresh
    }
}

/// 收到「好友申请」后的**全部**本地动作 —— 直连与跨跳共用这一个家。
///
/// ## 为什么要收成一家
/// 与 `apply_friend_accept` 同一条理由（2026-09-28 复审抓到的形状）：判据原先在两处各写一遍，
/// 而**两处都把 `insert(..)` 的返回值丢掉** ⇒ 每一份补发都当成新申请，各 emit 一次事件、
/// 各弹一条系统通知。"同一句话两处各写一遍、且两处都缺同一个条件"就是这类缺陷的形状，
/// 所以连通知文案与点击路由都收进来。
///
/// ## 幂等判据
/// 事件每次都发（前端 store 据此重拉「新的朋友」，幂等；漏发会让首次那一份恰好没被界面收到时
/// 列表永远不刷新），但**通知只在第一次**。已经是好友的情形由
/// `auto_accept_if_already_friend` 先行收敛（那条路径自己会走完整的同意流程）。
/// 待处理好友申请表（`AppState::pending_requests`）的**条数上限**（STB-02）。
///
/// 这张表的键（`from`）与载荷（昵称/头像）都由**不可信对端**控制，而它原本既无上限、
/// 无 TTL，也不在任何清扫名单里 ⇒ 谁都能让这张常驻内存表一直长。正常场景里同时待处理的
/// 申请是个位数，64 是"远大于真实用量、又足够挡住刷表"的一档。
const MAX_PENDING_FRIEND_REQUESTS: usize = 64;
/// 入站头像的上限：预设头像是 ~0.5KB 的 data URL，正常用户头像也远小于 256KB。
/// 超过就**丢掉头像**（而不是整条申请），否则一张 64MiB 上限的帧能带着它进内存常驻。
const MAX_PENDING_AVATAR_BYTES: usize = 256 * 1024;
/// 昵称上限（按字符）：与前端输入上限同档，超出截断（它会进通知标题与列表）。
const MAX_PENDING_NICKNAME_CHARS: usize = 64;

/// 这条申请能不能进表（纯函数）：已在表里的**同一个人**永远可以（幂等重发要能更新载荷），
/// 新条目在满员时拒掉。
pub(crate) fn pending_friend_request_admitted(
    already_pending: bool,
    current_len: usize,
) -> bool {
    already_pending || current_len < MAX_PENDING_FRIEND_REQUESTS
}

/// 把入站的「昵称 + 头像」夹到有界范围内（纯函数）。返回 (昵称, 头像, 是否丢了头像)。
///
/// 一份判据同时服务**两条**入站路径：好友申请（`apply_friend_request`）与资料同步
/// （`Message::UserInfo`）—— 两者的载荷都由不可信对端控制，且都会落进
/// `friends` / `conversations` 并被反复推给前端（2026-10-29 审计 SEC-06）。
pub(crate) fn bounded_profile(
    mut nickname: String,
    avatar: Option<String>,
) -> (String, Option<String>, bool) {
    if nickname.chars().count() > MAX_PENDING_NICKNAME_CHARS {
        nickname = nickname.chars().take(MAX_PENDING_NICKNAME_CHARS).collect();
    }
    let dropped_avatar = avatar
        .as_ref()
        .is_some_and(|a| a.len() > MAX_PENDING_AVATAR_BYTES);
    // 丢掉头像而不是整条载荷：昵称/关系本身是有用的，头像只是装饰。
    (nickname, if dropped_avatar { None } else { avatar }, dropped_avatar)
}

/// 把申请载荷夹到有界范围内（纯函数）。返回 (夹好的申请, 是否丢了头像)。
pub(crate) fn bounded_pending_request(mut req: PendingRequest) -> (PendingRequest, bool) {
    let (nickname, avatar, dropped) = bounded_profile(req.from_nickname, req.from_avatar);
    req.from_nickname = nickname;
    req.from_avatar = avatar;
    (req, dropped)
}

pub(crate) async fn apply_friend_request(state: &Arc<AppState>, req: PendingRequest, trace: &str) {
    // **撤回之后才迟到的重复申请**：撤回时留了墓碑，同一条 `request_id` 不许再弹出来。
    // 不同 `request_id` = 对方重新发起了新申请，清墓碑照常处理。
    let tombstone = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_withdrawn_request_tombstone(&dbc, &req.from).ok().flatten()
    };
    if let Some(withdrawn_id) = tombstone {
        if req.request_id != 0 && req.request_id == withdrawn_id {
            state.logger.info(
                "friend",
                format!(
                    "code=FRIEND_REQUEST_ALREADY_WITHDRAWN peer={} request_id={} 迟到重复申请已丢弃",
                    req.from, req.request_id
                ),
            );
            return;
        }
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = db::forget_withdrawn_request_tombstone(&dbc, &req.from) {
            crate::logging::log_write_failure(&state.logger, "forget_withdrawn_request_tombstone", e);
        }
    }
    // 他已经是我的好友 ⇒ 直接同意（别插 pending，见 auto_accept_if_already_friend）
    if auto_accept_if_already_friend(state, &req.from).await {
        return;
    }
    // 载荷先夹到有界（昵称截断、超大头像丢弃），再判要不要进表。
    let (req, avatar_dropped) = bounded_pending_request(req);
    if avatar_dropped {
        state.logger.warn(
            "friend",
            format!("code=FRIEND_REQUEST_AVATAR_DROPPED peer={}（超过上限，已丢弃头像）", req.from),
        );
    }
    let prior = {
        let mut pending = state
            .pending_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !pending_friend_request_admitted(pending.contains_key(&req.from), pending.len()) {
            drop(pending);
            state.logger.warn(
                "friend",
                format!(
                    "code=PENDING_REQUESTS_FULL peer={}（待处理申请已达上限 {MAX_PENDING_FRIEND_REQUESTS}，本条丢弃）",
                    req.from
                ),
            );
            return;
        }
        pending.insert(req.from.clone(), req.clone())
    };
    // ★ 同一趟也落库（审计 A4）：内存那一格只活在本次进程里，重启就没了 —— 申请人那边
    // 每 30s 才补发一次、还要链路在，所以"重启后申请还在"只能靠库里那一行。
    // 写失败只留痕、不撤回已经发出去的事件：本机这一趟仍然看得见，比"整条申请当场消失"
    // 更接近用户期待（而下一次启动读不回来时会在 restore 那一条日志里留码）。
    // ⚠️ 必须在上面那个块**外面**取 db 锁：`pending` 的守卫还活着时再拿 db 就是 J2 那一族
    // （持库守卫又调自锁 helper / 反过来持别的守卫又拿库锁 ⇒ 同线程二次取锁永久 park）。
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = db::put_friend_request(&dbc, &req) {
            crate::logging::log_write_failure(&state.logger, "put_friend_request", e);
        }
    }
    // 每次都发：前端只是据此重拉列表，重复无害（见上面的「幂等判据」）。
    let _ = state.app.emit("friend-request", &req);
    let was_pending =
        friend_request_arrival_decision(prior.is_none()) == FriendRequestArrival::Notify;
    if was_pending {
        state.logger.info(
            "friend",
            format!("{trace} peer={} nickname={}", req.from, req.from_nickname),
        );
        let mut extra = std::collections::HashMap::new();
        extra.insert("type".to_string(), "friend_request".to_string());
        // macOS 点击捕获必须带 action 按钮（见 crate::notifications）。
        extra.insert("action_label".to_string(), "查看".to_string());
        // 好友申请是**不经前端**的通知：必须走后端开关 + 权限 + 错误可见的统一入口。
        // 点击唤起窗口并跳到「新的朋友」；移动端点击由插件送回前端。
        // 丢弃的只是返回值：跳过/失败都在 notifications 里带码落日志（code=NOTIFY_*）。
        let click_app = state.app.clone();
        let _ = crate::notifications::show_click_if_enabled(
            state,
            "好友申请",
            &format!("{} 请求添加你为好友", req.from_nickname),
            extra,
            false,
            move || {
                crate::notifications::on_notification_clicked(&click_app, "friend_request", None, None)
            },
        );
    } else {
        // 重复投递（同一申请被补发）：只留一行便于排查的痕迹，**不通知**。
        state
            .logger
            .info("friend", format!("重复的好友申请（已忽略通知）peer={}", req.from));
    }
}

pub fn forget_pending_request(state: &AppState, peer_id: &str) {
    state
        .pending_requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(peer_id);
    // 库里那一行跟着删（审计 A4）：只删内存的话，下一次启动 `restore_pending_requests`
    // 会把这条已经处理掉的申请原样端回来 —— 而这个人多半已经是好友了，
    // 表现就是"同意后重启，新朋友里又冒出一条永远处理不掉的申请"。
    // 三个调用点（直连同意 / 直连拒绝 / 命令侧同意）都在 db 守卫**已经放开**之后才调这里。
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = db::forget_friend_request(&dbc, peer_id) {
            crate::logging::log_write_failure(&state.logger, "forget_friend_request", e);
        }
    }
    // 同一条路径也清掉"我方已发出、等对方确认"的登记：对方既然回执了（同意/拒绝），
    // 就不该再补发（`flush_pending_friend_request` 只对仍未处理的申请生效）。
    state
        .pending_out_requests
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(peer_id);
    // 撤回队列同样收口：对方已经回执了（无论同意还是拒绝），撤回就没有继续补发的意义。
    state
        .pending_out_withdrawals
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(peer_id);
    // 出站登记也落库，别让下一次启动把它端回来。
    let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
    if let Err(e) = db::forget_outgoing_friend_request(&dbc, peer_id) {
        crate::logging::log_write_failure(&state.logger, "forget_outgoing_friend_request", e);
    }
}

/// 启动时把库里还没处理的入站申请填回内存（审计 A4）。返回填回去的条数。
///
/// 这一条路径刻意**只填表**：既不 `emit` 也不弹系统通知 —— 用户拍板的是"重启恢复时不重复
/// 弹出好友申请通知或弹窗"。界面那一侧不需要这里推：它启动时自己会拉一次
/// `get_pending_requests`（`useChatStore` 的首屏 `refreshPending`），徽标就是那一份列表的长度。
///
/// 填回内存还有第二个作用，而且是**唯一**能挡住重复弹窗的那一格：申请人没有回执、
/// 每 30s 补发一份新 `message_id` 的信封，接收侧两层帧去重结构上看不见"重复"，
/// 只能靠"本机是否已经握着这条申请"判（见 `friend_request_arrival_decision`）。
/// 内存不预填 ⇒ 每次重启后的第一份补发都会被当成首次见到 ⇒ 又弹一次。
///
/// 读失败只留码、不阻断启动：列表暂时是空的，等对端下一次补发就回来了。
pub(crate) fn restore_pending_requests(state: &AppState) -> usize {
    let rows = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::list_friend_requests(&dbc)
    };
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => {
            state.logger.warn(
                "friend",
                format!("code=FRIEND_REQUEST_RESTORE_FAILED 待处理申请读不回内存：{e}"),
            );
            return 0;
        }
    };
    let mut pending = state
        .pending_requests
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut restored = 0usize;
    for req in rows {
        if !pending_friend_request_admitted(pending.contains_key(&req.from), pending.len()) {
            // 满员时剩下的就不硬塞（这张表的载荷由不可信对端控制，上限是 STB-02 定的）。
            state.logger.warn(
                "friend",
                format!(
                    "code=PENDING_REQUESTS_FULL 恢复时达到上限 {MAX_PENDING_FRIEND_REQUESTS}，其余跳过"
                ),
            );
            break;
        }
        pending.insert(req.from.clone(), req);
        restored += 1;
    }
    if restored > 0 {
        state.logger.info(
            "friend",
            format!("重启恢复 {restored} 条待处理好友申请（只填表，不重复通知）"),
        );
    }
    restored
}

/// 处理收到的撤回帧（`FriendRequestWithdraw`）。
///
/// 返回 `true` = 对端**已经是我的好友**（同意先落库，撤回输），应回执
/// `already_friends` 让撤回方收敛到"已同意"；`false` = 申请已被删除（撤回赢），
/// 回执 `withdrawn`。
///
/// 仲裁点与同意命令共用同一把 DB 锁：先提交者赢，后到者拿到明确结果。
pub(crate) async fn apply_friend_request_withdraw(
    state: &Arc<AppState>,
    from: &str,
    request_id: i64,
) -> bool {
    let (already_friend, removed) = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        // 与同意命令共用同一个事务状判定：先提交者赢（见 `db::withdraw_pending_friend_request`）。
        match db::withdraw_pending_friend_request(&dbc, from, request_id) {
            Ok(db::WithdrawOutcome::AlreadyFriend) => (true, false),
            Ok(db::WithdrawOutcome::Withdrawn) => (false, true),
            Ok(db::WithdrawOutcome::NoMatch) => (false, false),
            Err(e) => {
                crate::logging::log_write_failure(&state.logger, "withdraw_pending_friend_request", e);
                (false, false)
            }
        }
    };
    if removed {
        state
            .pending_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(from);
        let _ = state.app.emit(
            "friend-request-withdrawn",
            serde_json::json!({ "peer_id": from, "direction": "inbound" }),
        );
        state.logger.info(
            "friend",
            format!("对方撤回了好友申请 peer={from} request_id={request_id}"),
        );
    } else if !already_friend {
        state.logger.info(
            "friend",
            format!(
                "code=FRIEND_WITHDRAW_NO_MATCH peer={from} request_id={request_id}（没有命中的待处理申请，可能已被处理）"
            ),
        );
    }
    already_friend
}

/// 处理撤回回执（`FriendRequestWithdrawAck`）：撤回方在这里拿到**明确结果**。
///
/// - `already_friends` ⇒ 对端先落库了好友关系（同意赢）⇒ 走同意那条路径，界面翻成「已同意」；
/// - `withdrawn` ⇒ 申请已在对端删除（撤回赢）⇒ 界面终态「已撤回」。
pub(crate) fn apply_friend_request_withdraw_ack(
    state: &Arc<AppState>,
    from: &str,
    request_id: i64,
    already_friends: bool,
) {
    let (memo_id, row) = {
        let memo_id = state
            .pending_out_withdrawals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(from)
            .map(|e| e.0);
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let row = db::get_outgoing_friend_request(&dbc, from).ok().flatten();
        (memo_id, row)
    };
    let current_id = memo_id.or(row.as_ref().map(|r| r.first_at));
    if current_id != Some(request_id) {
        state.logger.warn(
            "friend",
            format!(
                "code=FRIEND_WITHDRAW_ACK_STALE peer={from} ack_request_id={request_id} current={current_id:?}（不是当前这条申请的回执，已忽略）"
            ),
        );
        return;
    }
    if already_friends {
        // 同意赢：这条申请本来就是"我方发出、等对方处理"，`apply_friend_accept` 接受它；
        // 它会一并清掉撤回队列与出站行。
        apply_friend_accept(state, from, "收到撤回回执：对端已是好友（同意赢）", None);
        return;
    }
    state
        .pending_out_withdrawals
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(from);
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut row) = row {
            row.status = "withdrawn".to_string();
            row.withdraw_confirmed = true;
            row.withdraw_last_at = crate::db::now_ms();
            if let Err(e) = db::put_outgoing_friend_request(&dbc, &row) {
                crate::logging::log_write_failure(&state.logger, "put_outgoing_friend_request", e);
            }
        }
    }
    let _ = state.app.emit(
        "friend-request-withdrawn",
        serde_json::json!({ "peer_id": from, "direction": "outbound" }),
    );
    state.logger.info(
        "friend",
        format!("撤回已确认 peer={from} request_id={request_id}（撤回赢）"),
    );
}

/// 启动时恢复**出站**状态：等待补发的申请、待补发的同意回执、未确认的撤回。
///
/// 与入站恢复同一纪律：只填表、不 `emit`、不弹通知；界面启动后自己拉
/// `get_outgoing_friend_requests`。读失败只留码，不阻断启动。
pub(crate) fn restore_pending_outbound(state: &AppState) -> (usize, usize, usize) {
    let (outgoing, accepts) = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        (db::list_outgoing_friend_requests(&dbc), db::list_pending_out_accepts(&dbc))
    };
    let (outgoing, accepts) = match (outgoing, accepts) {
        (Ok(o), Ok(a)) => (o, a),
        (Err(e), _) | (_, Err(e)) => {
            state.logger.warn(
                "friend",
                format!("code=FRIEND_OUTBOUND_RESTORE_FAILED 出站申请读不回内存：{e}"),
            );
            return (0, 0, 0);
        }
    };
    let now = crate::db::now_ms();
    let mut restored_requests = 0usize;
    let mut restored_accepts = 0usize;
    let mut restored_withdrawals = 0usize;
    let mut remove_rows: Vec<String> = Vec::new();
    let mut waiting_rows: Vec<(String, i64, i64)> = Vec::new();
    let mut withdrawal_rows: Vec<(String, i64, u32, i64)> = Vec::new();
    for row in outgoing {
        // DB 查询放在取内存表锁之前，保持锁序一致（DB → 内存表）。
        let already_friend = {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            db::get_friend(&dbc, &row.peer).is_some()
        };
        if already_friend {
            remove_rows.push(row.peer);
            continue;
        }
        match row.status.as_str() {
            "withdrawn" if !row.withdraw_confirmed => {
                match friend_accept_flush_decision(
                    Some((row.first_at, row.withdraw_attempts, row.withdraw_last_at)),
                    now,
                    WITHDRAW_MAX_ATTEMPTS,
                    WITHDRAW_MIN_INTERVAL_MS,
                    WITHDRAW_WINDOW_MS,
                ) {
                    FriendAcceptFlush::GiveUp => remove_rows.push(row.peer),
                    _ => withdrawal_rows.push((
                        row.peer,
                        row.first_at,
                        row.withdraw_attempts,
                        row.withdraw_last_at,
                    )),
                }
            }
            "waiting" => waiting_rows.push((row.peer, row.first_at, row.last_sent_at)),
            _ => {}
        }
    }
    {
        let mut waiting = state
            .pending_out_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (peer, first_at, last_sent) in waiting_rows {
            waiting.insert(peer, (first_at, last_sent));
            restored_requests += 1;
        }
    }
    {
        let mut withdrawals = state
            .pending_out_withdrawals
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (peer, first_at, attempts, last_at) in withdrawal_rows {
            withdrawals.insert(peer, (first_at, attempts, last_at));
            restored_withdrawals += 1;
        }
    }
    for peer in remove_rows {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = db::forget_outgoing_friend_request(&dbc, &peer);
    }
    {
        let mut accept_rows: Vec<(String, i64, u32, i64)> = Vec::new();
        let mut expired: Vec<String> = Vec::new();
        for entry in accepts {
            match friend_accept_flush_decision(
                Some((entry.issued_at, entry.attempts, entry.last_at)),
                now,
                ACCEPT_MAX_ATTEMPTS,
                ACCEPT_MIN_INTERVAL_MS,
                ACCEPT_WINDOW_MS,
            ) {
                FriendAcceptFlush::GiveUp => expired.push(entry.peer),
                _ => accept_rows.push((entry.peer, entry.issued_at, entry.attempts, entry.last_at)),
            }
        }
        for peer in expired {
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            let _ = db::forget_pending_out_accept(&dbc, &peer);
        }
        let mut accepts_map = state
            .pending_out_accepts
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (peer, issued_at, attempts, last_at) in accept_rows {
            accepts_map.insert(peer, (issued_at, attempts, last_at));
            restored_accepts += 1;
        }
    }
    if restored_requests + restored_accepts + restored_withdrawals > 0 {
        state.logger.info(
            "friend",
            format!(
                "重启恢复出站状态：待补发申请 {restored_requests} 条、待补发同意 {restored_accepts} 条、未确认撤回 {restored_withdrawals} 条"
            ),
        );
    }
    (restored_requests, restored_accepts, restored_withdrawals)
}

/// 好友同意回执的补发参数（与 `flush_pending_friend_accept` 同口径，恢复时复用）。
const ACCEPT_MAX_ATTEMPTS: u32 = 3;
const ACCEPT_MIN_INTERVAL_MS: i64 = 5_000;
const ACCEPT_WINDOW_MS: i64 = 120_000;

/// 撤回帧的补发参数：撤回是持久状态，窗口必须跨重启、跨"对方离线"，
/// 但每次只在有链路时按 30s 间隔试；对端明确不支持时立即停（不等窗口）。
const WITHDRAW_MAX_ATTEMPTS: u32 = 30;
const WITHDRAW_MIN_INTERVAL_MS: i64 = 30_000;
const WITHDRAW_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// 待发好友申请的补发判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FriendRequestFlush {
    /// 该补发一次。
    Flush,
    /// 根本没有登记，或距上次补发不足最小间隔 ⇒ 什么都不做。
    Nothing,
}

/// 补发策略的**纯函数内核**：`entry = (首次登记时刻, 上次补发时刻)`，`None` = 没有登记。
///
/// 与 `friend_accept_flush_decision` 的两点差别（**别把它们合并**）：
/// · **不设次数上限、不设放弃窗口** —— 申请等的是"对方做人"，对方可能几天后才看到，
///   加上限等于偷偷废掉「对方离线时暂存、上线后自动补发」那条承诺（INV-P04）；
///   回执那条要数次数是因为它"我这边的动作已经做完"，这条不是。
/// · 因此这里只有一个约束量：最小间隔。
///
/// 为什么必须有间隔（用户 2026-10-14 真机：「群内加好友会弹出很多个，连续多条的弹窗也有问题」）：
/// 调用点挂在建链**和每轮心跳**上（`dial.rs` 的 `HEARTBEAT_INTERVAL_SECS = 5`），而每份补发
/// 都必须是**新 `message_id`** 的信封（复用旧 id 会被对端两层去重直接丢弃，那正是
/// "丢了没人知道"的前提）⇒ 不限频就是一条没人应答的申请每 5 秒向整个网洪泛一份。
/// 频率这一半归发送侧，通知那一半归接收侧的 `friend_request_arrival_decision` —— 两半都要，
/// 只做接收侧仍会在 BLE 上把链路刷满。
pub fn friend_request_flush_decision(
    entry: Option<(i64, i64)>,
    now: i64,
    min_interval_ms: i64,
) -> FriendRequestFlush {
    let Some((_issued, last)) = entry else {
        return FriendRequestFlush::Nothing;
    };
    // `last == 0` = 登记后一次都没补发过 ⇒ 这是第一个补发机会，立刻发（保住"秒到"）
    if last != 0 && now - last < min_interval_ms {
        return FriendRequestFlush::Nothing;
    }
    FriendRequestFlush::Flush
}

/// **补发"我方已发出、还未被处理"的好友申请**（建链 / Hello 补全与心跳时调用）。
///
/// 为什么需要（用户 2026-09-12 真机）：「好友已发送，等待对方确认」，但对方**什么都没收到**
/// —— 好友申请是**没有回执**的定向帧，链路正好在那一刻抖动（BLE 镜像互拨打断链路）时
/// 它就静默丢了，而发送方界面依然显示"已发送"。现在发出即登记，这里补发；
/// 收到同意/拒绝（走 `forget_pending_request`）后清除。
///
/// ⚠️ 补发的**频率**由 `friend_request_flush_decision` 管（见上面的理由）：这里只负责
/// "锁内取判定 → 锁外发送 → 成功后记下本次时刻"，判定绝不在持锁时 await。
pub async fn flush_pending_friend_request(state: &Arc<AppState>, peer_id: &str) {
    const MIN_INTERVAL_MS: i64 = 30_000;
    let now = crate::db::now_ms();
    // 锁内只做判定（**绝不跨 await 持锁**）
    let (decision, entry) = {
        let entry = state
            .pending_out_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_id)
            .copied();
        (friend_request_flush_decision(entry, now, MIN_INTERVAL_MS), entry)
    };
    if decision == FriendRequestFlush::Nothing {
        return;
    }
    let Some((request_id, _)) = entry else { return; };
    // ⚠️ **已经是好友就不再补发**。
    //
    // 这条登记原本只由 `forget_pending_request` 在「收到对方的同意/拒绝」时清除。
    // 但同意回执本身是**没有 ACK 的定向帧**，可能一直送不到（真机日志：
    // Mac 侧持续 `补发好友申请` 而全程没有 `收到跨跳好友同意`）——
    // 于是登记永不解除，链路每建立一次就重发一次，**无限循环**。
    //
    // 判据用「本地好友表里有没有他」而不是「有没有收到那个回执」：
    // 无论友谊是通过哪条路径建立的（对方同意、我方同意、自动同意），
    // 只要已经是好友，这条待发申请就失去了意义。
    let already_friend = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        crate::db::get_friend(&dbc, peer_id).is_some()
    };
    if already_friend {
        state
            .pending_out_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_id);
        state
            .logger
            .info("friend", format!("已是好友，停止补发申请 peer={peer_id}"));
        return;
    }
    // 复用同一条发送路径（含目标定向 + 重签），失败也不清登记 —— 下次机会再试
    if crate::commands::send_friend_request_via_link(state, peer_id, request_id)
        .await
        .is_ok()
    {
        state
            .pending_out_requests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(peer_id.to_string())
            .and_modify(|e| e.1 = now);
        // 落库：重启后恢复的补发节奏与进程内一致。
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(Some(mut row)) = db::get_outgoing_friend_request(&dbc, peer_id) {
            row.last_sent_at = now;
            if let Err(e) = db::put_outgoing_friend_request(&dbc, &row) {
                crate::logging::log_write_failure(&state.logger, "put_outgoing_friend_request", e);
            }
        }
        state.logger.info(
            "friend",
            format!("补发好友申请 peer={peer_id}（此前链路抖动丢过）"),
        );
    }
}

/// 好友同意回执「补发一次 / 收尾 / 什么都不做」的判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FriendAcceptFlush {
    /// 补发，且这是第几次（1-based）。
    Flush(u32),
    /// 窗口或次数用尽 ⇒ 清掉登记并留一条 warn。
    GiveUp,
    /// 还没到间隔，或根本没有登记。
    Nothing,
}

/// 好友同意回执补发策略的**纯函数内核**：
/// `entry` = `(issed_at, attempts, last_at)`，`None` = 没有待补发登记。
///
/// 策略：`window_ms` 窗口内最多 `max_attempts` 次、两次之间至少隔 `min_interval_ms`。
/// 为什么是"有界补发"而不是无限重试：对方收到重复的 `FriendAccept` 是幂等的（多一次
/// `add_friend` + 一个 UI 事件），但没必要一直打扰；3 次足以覆盖"一次建链 + 两次心跳"。
pub fn friend_accept_flush_decision(
    entry: Option<(i64, u32, i64)>,
    now: i64,
    max_attempts: u32,
    min_interval_ms: i64,
    window_ms: i64,
) -> FriendAcceptFlush {
    let Some((issued, attempts, last)) = entry else {
        return FriendAcceptFlush::Nothing;
    };
    if now - issued > window_ms || attempts >= max_attempts {
        return FriendAcceptFlush::GiveUp;
    }
    if now - last < min_interval_ms {
        return FriendAcceptFlush::Nothing;
    }
    FriendAcceptFlush::Flush(attempts + 1)
}

/// **补发好友同意回执**（`FriendAccept`）。
///
/// 与 `flush_pending_friend_request` 的关键差别：申请是"等对方动作"（收到同意/拒绝才清），
/// 而同意回执**没有回执** —— 发送方无从得知对方是否收到。所以这里用**有界补发**：
/// 2 分钟窗口内最多 3 次、两次之间至少隔 5s（心跳周期），窗口/次数用尽就打一条 warn 收尾。
///
/// 为什么必须做（用户 2026-09-13 真机）：Android 点「接受」后 Android 侧好友列表已经有对方，
/// 但 **Mac 端状态一直没同步** —— 那一帧在 BLE 链路抖动/尚未建好时静默丢了，且永不重发。
pub async fn flush_pending_friend_accept(state: &Arc<AppState>, peer_id: &str) {
    let now = crate::db::now_ms();

    // 锁内只做判定（**绝不跨 await 持锁**）；判定本身是纯函数
    // （`friend_accept_flush_decision`）—— "窗口 + 次数 + 间隔"这类策略最容易写反，
    // 写在 async + 锁里就没法单测。
    let decision = {
        let entry = state
            .pending_out_accepts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_id)
            .copied();
        friend_accept_flush_decision(
            entry,
            now,
            ACCEPT_MAX_ATTEMPTS,
            ACCEPT_MIN_INTERVAL_MS,
            ACCEPT_WINDOW_MS,
        )
    };
    let attempt = match decision {
        FriendAcceptFlush::Nothing => return,
        FriendAcceptFlush::GiveUp => {
            let removed = state
                .pending_out_accepts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(peer_id);
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            let _ = db::forget_pending_out_accept(&dbc, peer_id);
            state.logger.warn(
                "friend",
                format!(
                    "code=FRIEND_ACCEPT_RETRY_EXHAUSTED peer={peer_id} 好友同意回执补发结束（窗口/次数用尽：now={now} 登记={removed:?}）—— 对方那条 pending 申请可能仍挂着（F-FRN-003）"
                ),
            );
            return;
        }
        FriendAcceptFlush::Flush(attempt) => attempt,
    };
    // 判定是纯的 ⇒ 次数/时刻的写入在执行侧完成
    {
        let mut map = state
            .pending_out_accepts
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(peer_id) {
            entry.1 = attempt;
            entry.2 = now;
        }
    }
    // 回显的申请 id（Block 1 / Case A）：补发的那一帧必须和第一帧**同口径**，
    // 否则首帧能绑身份、补发却被判"无法关联"，两边结论不一致。id 只落在这里一行，
    // 丢了（DB 写失败）就是 0 ⇒ 接收侧退回 Case B，不会因此放行身份绑定。
    let request_id = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        match db::list_pending_out_accepts(&dbc)
            .map(|rows| rows.into_iter().find(|r| r.peer == peer_id))
        {
            Ok(Some(mut row)) => {
                row.attempts = attempt;
                row.last_at = now;
                let rid = row.request_id;
                if let Err(e) = db::put_pending_out_accept(&dbc, &row) {
                    crate::logging::log_write_failure(&state.logger, "put_pending_out_accept", e);
                }
                rid
            }
            _ => 0,
        }
    };
    match crate::commands::send_friend_accept_via_link(state, peer_id, request_id).await {
        Ok(()) => state.logger.info(
            "friend",
            format!("[FRIEND] 补发好友同意回执 peer={peer_id}（第 {attempt} 次）"),
        ),
        Err(e) => state.logger.warn(
            "friend",
            format!("code=FRIEND_ACCEPT_RETRY_FAILED peer={peer_id} [FRIEND] 补发好友同意回执失败（第 {attempt} 次）：{e}"),
        ),
    }
}

/// **补发撤回帧**（`FriendRequestWithdraw`）。
///
/// 三件事决定了它的形状：
/// 1. **只在有链路 / 有补发机会时发**（调用点与申请补发相同），不做"没链路还每秒吼"。
/// 2. **对端明确没声明能力位就立刻停**：老端收到只会把整帧当 `Message::Unknown` 丢掉，
///    反复发既不会让对方停止弹申请，也白白占用 BLE（INV-P24 第 4 条）。
/// 3. **窗口跨重启**：撤回是用户已经做出的决定，不能因为进程重启就当作没发生。
pub async fn flush_pending_friend_withdraw(state: &Arc<AppState>, peer_id: &str) {
    let now = crate::db::now_ms();
    let decision = {
        let entry = state
            .pending_out_withdrawals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_id)
            .copied();
        friend_accept_flush_decision(
            entry,
            now,
            WITHDRAW_MAX_ATTEMPTS,
            WITHDRAW_MIN_INTERVAL_MS,
            WITHDRAW_WINDOW_MS,
        )
    };
    let attempt = match decision {
        FriendAcceptFlush::Nothing => return,
        FriendAcceptFlush::GiveUp => {
            state
                .pending_out_withdrawals
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(peer_id);
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            if let Ok(Some(mut row)) = db::get_outgoing_friend_request(&dbc, peer_id) {
                row.withdraw_last_at = now;
                let _ = db::put_outgoing_friend_request(&dbc, &row);
            }
            state.logger.warn(
                "friend",
                format!("code=FRIEND_WITHDRAW_RETRY_EXHAUSTED peer={peer_id} 撤回帧补发窗口/次数用尽"),
            );
            return;
        }
        FriendAcceptFlush::Flush(attempt) => attempt,
    };
    // 已经是好友 ⇒ 同意赢了。撤回不再继续，界面以"已同意"为准。
    let already_friend = {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_friend(&dbc, peer_id).is_some()
    };
    if already_friend {
        state
            .pending_out_withdrawals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_id);
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        let _ = db::forget_outgoing_friend_request(&dbc, peer_id);
        let _ = state.app.emit(
            "friend-request-withdrawn",
            serde_json::json!({ "peer_id": peer_id, "direction": "outbound" }),
        );
        state.logger.info(
            "friend",
            format!("撤回让位于已落库的好友关系 peer={peer_id}（同意赢）"),
        );
        return;
    }
    match crate::commands::peer_friend_withdraw_support(state, peer_id) {
        Some(false) => {
            state
                .pending_out_withdrawals
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(peer_id);
            let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
            if let Ok(Some(mut row)) = db::get_outgoing_friend_request(&dbc, peer_id) {
                row.withdraw_attempts = 0;
                row.withdraw_last_at = now;
                row.withdraw_confirmed = false;
                let _ = db::put_outgoing_friend_request(&dbc, &row);
            }
            state.logger.warn(
                "friend",
                format!("code=FRIEND_WITHDRAW_UNSUPPORTED peer={peer_id} 对端未声明撤回能力，停止补发"),
            );
            return;
        }
        None => return,
        Some(true) => {}
    }
    {
        let mut map = state
            .pending_out_withdrawals
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = map.get_mut(peer_id) {
            entry.1 = attempt;
            entry.2 = now;
        }
    }
    {
        let dbc = state.db.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(Some(mut row)) = db::get_outgoing_friend_request(&dbc, peer_id) {
            row.withdraw_attempts = attempt;
            row.withdraw_last_at = now;
            if let Err(e) = db::put_outgoing_friend_request(&dbc, &row) {
                crate::logging::log_write_failure(&state.logger, "put_outgoing_friend_request", e);
            }
        }
    }
    let Some(request_id) = state
        .pending_out_withdrawals
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(peer_id)
        .map(|e| e.0)
    else {
        return;
    };
    match crate::commands::send_friend_withdraw_via_link(state, peer_id, request_id).await {
        Ok(()) => state.logger.info(
            "friend",
            format!("补发撤回好友申请 peer={peer_id}（第 {attempt} 次）"),
        ),
        Err(e) => state.logger.warn(
            "friend",
            format!("code=FRIEND_WITHDRAW_RETRY_FAILED peer={peer_id} 补发撤回失败（第 {attempt} 次）：{e}"),
        ),
    }
}

/// 构造带签名的 Hello（nonce 每次新生成，签名覆盖连接身份的全部字段）。
/// Hello 里能带的头像上限（字节）。
///
/// ## 为什么必须限制（真机 2026-09-14 三端日志，本批最严重的一条）
///
/// `Hello` 是**握手帧**：链路刚建好就要发出去，对端等它的时间就是 `HANDSHAKE_TIMEOUT`（10s）。
/// 而旧实现把 `state.avatar` **原样**塞进 Hello —— 用户设的是一张 base64 图片时，
/// 这个帧可以到 **几百 KB**。BLE 上后果是双重的：
///   · central 侧：424303 字节 ÷ 514 字节/片 ≈ **826 片 × 12ms ≈ 10s** ⇒ 正好撞上握手超时，
///     对端日志是「握手超时：对端未回 Hello」；
///   · 外设侧：CoreBluetooth/Android 在某些时序下报的 `maximumUpdateValueLength` 还是默认值
///     （MTU 23 ⇒ 每片 20 字节）⇒ 需要 **3 万多片** > `MAX_BLE_CHUNKS_PER_MESSAGE`(8192)
///     ⇒ `fragment()` 直接返回 `None`，日志是「回 Hello 失败：帧无法分片（过大或 MTU 非法：
///     len=424303 mtu=20）」—— 真机上就是"搜得到、连得上、永远握手不成、发不出消息"。
///
/// 头像属于**展示信息**，晚一点、走别的路径同步都可以；握手帧必须小到能秒过。
/// 取 2 KiB：正常的小图标/首字母头像远小于它，而任何"图片级"头像都会被挡在握手之外。
pub const HELLO_AVATAR_MAX_BYTES: usize = 2048;

/// 交给 Hello 携带的头像：**过大就返回 `None`**（并且只留一次 warn 让真机可查）。
///
/// 纯函数：`Option<&str>` 便于单测。
pub fn hello_avatar_for_wire(avatar: Option<&str>) -> Option<&str> {
    match avatar {
        Some(a) if !a.is_empty() && a.len() <= HELLO_AVATAR_MAX_BYTES => Some(a),
        _ => None,
    }
}

pub fn build_signed_hello(state: &AppState, conv_clock: i64) -> Message {
    let device_id = state.device_id.clone();
    let tcp_port = state.tcp_port;
    let x25519_pubkey = state.identity.x25519_public_b64();
    let ed25519_pubkey = state.identity.ed25519_public_b64();
    // ⚠️ 头像**必须先过尺寸闸门**再进握手帧（见 `HELLO_AVATAR_MAX_BYTES` 的说明）：
    // 一张 base64 头像能把 Hello 撑到几百 KB，BLE 上直接导致握手超时或"帧无法分片"。
    let raw_avatar = state
        .avatar
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let avatar = hello_avatar_for_wire(raw_avatar.as_deref()).map(str::to_string);
    if avatar.is_none() && raw_avatar.as_deref().is_some_and(|a| !a.is_empty()) {
        state.logger.warn(
            "transport",
            format!(
                "Hello 不携带头像：本机头像 {} 字节 > 上限 {} 字节（握手帧必须小；头像由 UserInfo 同步）",
                raw_avatar.as_deref().map(str::len).unwrap_or(0),
                HELLO_AVATAR_MAX_BYTES
            ),
        );
    }
    let nonce = STANDARD.encode(crypto::random_key());
    let sig = state.identity.sign_b64(&hello_signing_bytes(
        &device_id,
        tcp_port,
        &nonce,
        &x25519_pubkey,
        &ed25519_pubkey,
    ));
    Message::Hello {
        device_id,
        nickname: state
            .nickname
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        avatar,
        device_type: crate::protocol::current_device_type().to_string(),
        content_features: crate::protocol::content_features(),
        protocol_version: Some(crate::protocol::PROTOCOL_VERSION),
        app_version: Some(crate::protocol::current_app_version().to_string()),
        tcp_port,
        x25519_pubkey,
        ed25519_pubkey,
        conv_clock,
        nonce,
        sig,
    }
}

/// 把本机完整资料（昵称/头像/设备类型）**定向**同步给一个对端。
///
/// 为什么需要它：Hello 只带不超过 2KiB 的头像、Presence 已不再内联大头像，所以
/// 「大头像」只剩这一条正式路径 —— 链路建好后同步**一次**。超过
/// CONTROL_AVATAR_MAX_BYTES 的帧会被通道分类降到 Low 队列，
/// 不再和聊天/好友请求抢优先道。
pub async fn send_user_info_to(state: &Arc<AppState>, peer_id: &str) {
    let msg = Message::UserInfo {
        device_id: state.device_id.clone(),
        nickname: state
            .nickname
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        avatar: state
            .avatar
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        device_type: crate::protocol::current_device_type().to_string(),
    };
    let _ = try_send(state, peer_id, &msg).await;
}
