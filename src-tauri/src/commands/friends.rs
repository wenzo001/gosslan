// 职责边界：
// - 好友列表查询、安全号
// - 删除好友、pending request 登记
// - 建链补发路径（send_friend_request_via_link）
// ---------------- 好友 ----------------

/// 好友「在线」判据：**最近 [`FRIEND_ONLINE_GRACE_MS`] 内见过**（announce / Presence /
/// 握手都算 `last_seen`）**或**手里有活链路。
///
/// 为什么不沿用「在不在 `peers` 表里」：`mark_peer_offline` 现在**故意保留**刚掉线的
/// 节点条目（BLE 上"连上→被对端退让→断开"是常态；删掉的话 Mac 的「添加好友」列表里
/// 安卓只闪一下、用户根本点不到），所以"在表里"不再等价于"在线"，必须看
/// `last_seen` 的新鲜度 —— 否则就是 2026-09-12 复核抓到的那个 High 缺陷
/// （一次「连过又掉线」的节点永久显示在线）。
///
/// 15s ≈ 3 个 announce 周期（5s 基础 + 0~3s 抖动）：够容忍局域网丢一两轮广播，
/// 又不会把早已离开的节点长时间标成在线。
fn friend_is_online(last_seen: i64, now: i64, has_active_link: bool) -> bool {
    has_active_link || last_seen >= now - FRIEND_ONLINE_GRACE_MS
}

const FRIEND_ONLINE_GRACE_MS: i64 = 15_000;

/// 安全码：本机与指定对端之间那串**双方一致**的核对码（见 `crypto::safety_number`）。
///
/// 返回 `None` 表示**还算不出来** —— 缺对方的公钥（尚未通过 Hello/announce 学到）。
/// 这时**必须如实返回 None 而不是拿 device_id 凑一个**：凑出来的码在真正的中间人
/// 攻击下与真实对端的码不同，用户核对后会以为"对得上"，比没有更糟。
///
/// 对端公钥取 peers 优先、friends 回落（与 `resolve_member_x25519` 同一口径）。
#[tauri::command(async)]
pub async fn get_safety_number(
    state: State<'_, Arc<AppState>>,
    peer_id: String,
) -> Result<Option<String>, String> {
    let s = state.inner().clone();
    // 两次锁快照 + 两次点查 + 一次安全码推导（哈希/编码）：设置页与对方资料卡都会打这条。
    tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let (their_x, their_e) = {
            let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
            let p = peers.get(&peer_id);
            (
                p.and_then(|p| p.x25519_pubkey.clone()),
                p.and_then(|p| p.ed25519_pubkey.clone()),
            )
        };
        let (their_x, their_e) = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            (
                their_x.or_else(|| db::get_friend_x25519(&dbc, &peer_id)),
                their_e.or_else(|| db::get_friend_ed25519(&dbc, &peer_id)),
            )
        };
        // 拿不到任一份公钥 = "还没核实过对方身份"，界面显示空而不是报错（语义与改造前一致：
        // 原来这条命令返回 Option，`?` 是在 Option 上；搬进返回 Result 的闭包后必须显式退 None）。
        let (Some(their_x), Some(their_e)) = (their_x, their_e) else {
            return Ok(None);
        };
        Ok(Some(crypto::safety_number(
            &crypto::SafetyParty {
                device_id: &s.device_id,
                x25519_pubkey: &s.identity.x25519_public_b64(),
                ed25519_pubkey: &s.identity.ed25519_public_b64(),
            },
            &crypto::SafetyParty {
                device_id: &peer_id,
                x25519_pubkey: &their_x,
                ed25519_pubkey: &their_e,
            },
        )))
    })
    .await
    .map_err(|e| format!("安全码计算被线程池中断: {e}"))?
}

#[tauri::command(async)]
pub async fn get_friends(state: State<'_, Arc<AppState>>) -> Result<Vec<Friend>, String> {
    let s = state.inner().clone();
    // 整段进阻塞池：里面是 links/peers/peer_versions 三份快照 + 一次 `list_friends` 全表读 + 逐行富化，
    // 全是同步动作（`links` 用的是 `try_lock`，在不认 async 的阻塞线程里同样合法）。
    tokio::task::spawn_blocking(move || -> Result<Vec<Friend>, String> {
        // 同时检查活跃 TCP 链接：链路存活但 peer 已被 discovery sweep 清掉时，
        // 仍应显示在线，避免「实际可通信但 UI 显示离线」。
        // ⚠️ 只算**非空** Vec（与 `sweep_peers` / `has_link` 同一口径）：
        // 残留的空 key 会让好友**永久显示在线**。根因已在 reader_loop 修掉，这里是防线。
        let active_links: std::collections::HashSet<String> = s
            .links
            .try_lock()
            .map(|l| {
                l.iter()
                    .filter(|(_, v)| !v.is_empty())
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default();
        let now = crate::db::now_ms();
        // peers 的在线判定快照：**先取完并放锁**，下面才取 db。
        // 持 peers 求 db 会与 Hello 路径的 db→peers 构成 ABBA（这条 IPC 恰恰是前端常调的）。
        let peer_snapshot: std::collections::HashMap<String, (i64, String)> = {
            let peers = s.peers.lock().unwrap_or_else(|e| e.into_inner());
            peers
                .iter()
                .map(|(id, p)| (id.clone(), (p.last_seen, p.device_type.clone())))
                .collect()
        };
        // 对端版本快照：与 device_type 同一个"读时富化"套路（`peer_versions` 只在验签后的
        // Hello 里写入）。先取快照再拿 db 锁 —— 不为省事在持 db 锁期间再去锁别的表。
        let versions: std::collections::HashMap<String, crate::state::PeerVersion> = s
            .peer_versions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut friends = db::list_friends(&dbc).unwrap_or_default();
        for f in friends.iter_mut() {
            let (last_seen, device_type) = peer_snapshot
                .get(&f.device_id)
                .cloned()
                .unwrap_or((0, String::new()));
            f.online = friend_is_online(last_seen, now, active_links.contains(&f.device_id));
            // 设备类型从 peers 表现场读取（Hello/UserInfo/Presence 都会更新它）。
            f.device_type = device_type;
            // 版本：判定放在唯一的 `peer_protocol_is_newer` 里，前端只消费结论。
            let declared = versions.get(&f.device_id);
            f.peer_app_version = declared.and_then(|v| v.app_version.clone());
            f.peer_version_newer =
                crate::protocol::peer_protocol_is_newer(declared.and_then(|v| v.protocol_version));
        }
        Ok(friends)
    })
    .await
    .map_err(|e| format!("好友列表读取被线程池中断: {e}"))?
}

/// 删除好友（保留聊天记录；对方仍会出现在扫描列表，可重新添加）。
#[tauri::command(async)]
pub async fn remove_friend(state: State<'_, Arc<AppState>>, peer_id: String) -> Result<(), String> {
    let s = state.inner();
    // 删好友前先取消在途发送；否则 outbox 删了、发送任务却可能把 transfer 写回 active。
    crate::commands::cancel_send_transfers_for_peer(s, &peer_id);
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::remove_friend(&dbc, &peer_id).map_err(|e| e.to_string())?;
        db::delete_file_outbox_for_peer(&dbc, &peer_id).ok();
    }
    // ⚠️ **同时解除内存里的身份绑定**（用户 2026-09-13 真机：不这么做就"必须重启"）。
    // `friends` 表那一行删掉只解除了一条腿；`verify_hello` 还会回落到内存 `peers` 表里
    // 广播学来的旧公钥 ⇒ 对方重装换过公钥时，删了好友重新加也照样被硬拒。
    crate::network::transport::forget_peer_identity(s, &peer_id);
    // 密钥轮换候选一起清：关系都没了，横幅与待确认状态没有意义。
    s.pending_key_rotations
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&peer_id);
    // 通知对方解除好友关系（对方收到后也会删除本机好友行）
    let msg = Message::FriendRemove {
        from: s.device_id.clone(),
        to: peer_id.clone(),
    };
    let _ = try_send(s, &peer_id, &msg).await;
    let _ = s.app.emit("friend-removed", &peer_id);
    Ok(())
}

/// 一条待确认的好友密钥轮换（发给前端展示用；只含好友，非好友不登记）。
#[derive(serde::Serialize)]
pub struct FriendKeyRotation {
    pub device_id: String,
    pub nickname: String,
    pub x25519_pubkey: String,
    pub ed25519_pubkey: String,
    /// 首次观察到的时刻（ms），前端可按时间排序/显示"刚刚"。
    pub ts: i64,
}

/// 列出当前所有「好友身份密钥已更换、等待用户确认」的候选。
///
/// 候选只在内存里（见 `AppState::pending_key_rotations`），且只返回**仍是好友**的条目；
/// 已经删除的好友自然消失。聊天界面据此显示「同步新密钥」横幅。
#[tauri::command(async)]
pub async fn get_friend_key_rotations(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<FriendKeyRotation>, String> {
    let s = state.inner().clone();
    // 一次内存快照 + 每个候选一次好友点查（持 db 锁）⇒ 进阻塞池（审计 R-18）。
    tokio::task::spawn_blocking(move || -> Result<Vec<FriendKeyRotation>, String> {
        let pending = s
            .pending_key_rotations
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();
        for (device_id, c) in pending {
            // 只保留仍是好友的：删除好友后横幅必须立刻消失。
            if let Some((nickname, _)) = db::get_friend(&dbc, &device_id) {
                out.push(FriendKeyRotation {
                    device_id,
                    nickname,
                    x25519_pubkey: c.x25519_pubkey,
                    ed25519_pubkey: c.ed25519_pubkey,
                    ts: c.ts,
                });
            }
        }
        // 新观察到的候选排最前（Reverse ⇒ 按 ts 降序；clippy 要求 sort_by_key）。
        out.sort_by_key(|r| std::cmp::Reverse(r.ts));
        Ok(out)
    })
    .await
    .map_err(|e| format!("密钥轮换候选读取被线程池中断: {e}"))?
}

/// 用户确认「对方换密钥是本人操作（如重装应用）」后，把好友的身份密钥同步成新值。
///
/// 为什么必须显式命令而不是自动覆盖：自报公钥来自网络，自动覆盖等于任何同 ID 的
/// 广播都能冒充好友（E2EE 被击穿）。候选已通过**新私钥的 Hello 自验签**（证明持有新私钥），
/// 再加用户本人确认，才允许覆盖 friends 表。同步后：内存 peers 的旧绑定一起忘掉
/// （`forget_peer_identity`），下次 Hello 以新密钥验签通过，消息/文件收发恢复。
#[tauri::command(async)]
pub async fn sync_friend_keys(
    state: State<'_, Arc<AppState>>,
    peer_id: String,
) -> Result<(), String> {
    let s = state.inner();
    let candidate = {
        let map = s
            .pending_key_rotations
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.get(&peer_id).cloned()
    }
    .ok_or_else(|| "没有观察到这位好友的新密钥；请确认对方在线并重试过".to_string())?;
    let name = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let (name, _) = db::get_friend(&dbc, &peer_id)
            .ok_or_else(|| "对方已经不是好友了".to_string())?;
        db::replace_friend_pubkeys(
            &dbc,
            &peer_id,
            &candidate.x25519_pubkey,
            &candidate.ed25519_pubkey,
        )
        .map_err(|e| e.to_string())?;
        name
    };
    {
        let mut map = s
            .pending_key_rotations
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.remove(&peer_id);
    }
    // 忘掉内存 peers 里的旧公钥与冲突告警标记：否则新 Hello 仍按旧绑定被硬拒。
    crate::network::transport::forget_peer_identity(s, &peer_id);
    s.logger.info(
        "identity",
        format!("用户确认后同步好友新身份密钥 peer={peer_id}（对方重装等合法换钥）"),
    );
    insert_system_message(
        s,
        &peer_id,
        &format!("已按你的确认同步「{name}」的新身份密钥，消息与文件收发已恢复。"),
    );
    let _ = s.app.emit("friend-keys-synced", &peer_id);
    Ok(())
}

// 待处理的好友申请。
//
// **规则（用户 2026-09-12 真机实测要求）**：已经在好友列表里的人，其申请不该再出现
// ——「如果该好友已在好友列表的话，列表里的那个好友申请就应该自动清除掉」。
// 主修在各条"同意"路径上清 `pending_requests`（见 `transport::forget_pending_request`），
// 这里按 friends 表再过滤一遍并**顺手把内存态收敛掉**：万一哪条路径漏了（或对方是走
// 别的消息把我加上的），「新朋友」里也不会留着一条永远处理不掉的过期申请。
