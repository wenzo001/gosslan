// 职责边界：
// - 自绘标题栏窗口控制（最小化/最大化/全屏/关闭）
// - window_close 里主窗口隐藏 vs 辅助窗口销毁的语义
// ---------------- 自绘标题栏：窗口控制 ----------------
// ⚠️ 这些命令作用于**调用它们的那个窗口**（Tauri 把发起 IPC 的窗口注入 `WebviewWindow` 参数）。
// 主窗口与各辅助窗口共用同一份自绘标题栏（`src/components/TitleBar.vue`），所以**不能写死 "main"**
// —— 否则辅助窗口的最小化/关闭会作用到主窗口上（用户 2026-09-17：辅助窗口要脱离系统标题栏）。

/// 最小化**当前窗口**。
#[cfg(desktop)]
#[tauri::command]
pub fn window_minimize(window: tauri::WebviewWindow) {
    let _ = window.minimize();
}

/// 移动端没有独立窗口概念，最小化由系统接管。
#[cfg(mobile)]
#[tauri::command]
pub fn window_minimize(_app: tauri::AppHandle) {}

/// 切换**当前窗口**最大化，返回切换后的状态。
///
/// ## ⚠️ 为什么不能信 `is_maximizable()`
///
/// 它看着正是"这个窗口能不能最大化"的标准 API，实则**在 macOS 上永远返回 false**，
/// 于是主窗口的绿灯单击 / 标题栏双击点了完全没反应（用户 2026-10-12 实测）。
///
/// 完整根因链（tao 0.35.3 源码 + 真机探针实测，见 git 历史里的独立探针工程）：
/// 1. `tao/platform_impl/macos/window.rs:216-222`：`decorations(false)`（我们所有窗口都是）
///    创建出的 styleMask = `Borderless | Resizable | Miniaturizable`，**没有 `Titled` 位**。
/// 2. `window.rs:300-305`：`!attrs.maximizable` 时去 `standardWindowButton(ZoomButton)
///    .setEnabled(false)`；`L1105-1115` `is_maximizable()` 反过来读同一个 button 的
///    `isEnabled()`，`window.button(ZoomButton)` 取不到就 `return false`。
///    ⇒ **Borderless 窗没有 zoom button ⇒ `is_maximizable()` 恒 false**，
///    `set_maximizable(true)`（L826-834）也就成了静默 no-op。
/// 3. 实测（tao 0.35.3 探针，2000×1360 窗口）：`is_maximizable()`=**false**；
///    但只要绕过这道判断直接 `set_maximized(true)`，窗口照样变到 2940×1718（可见区），
///    `set_maximized(false)` 也照样还原到 1000×680 的逻辑尺寸 —— **能力其实一直在**。
///
/// 更反直觉的一点：`set_fullscreen` 反而**不受影响**（`macos/util/async.rs:113-142`
/// 会在缺 `Titled|Resizable` 位时临时补位并存 `saved_style`）。所以同一扇窗表现为
/// "全屏能用、最大化点不动"，很像是权限被拒，实则只是这一道判据失真。
///
/// 顺带排除一条误判：Tauri 的 ACL 闸门（`tauri/webview/mod.rs:1823`）是
/// `(plugin_command.is_some() || has_app_acl_manifest || !is_local) && ...`，而本项目
/// `gen/schemas/acl-manifests.json` 里没有 `__app-acl__` ⇒ 本地来源的**自定义命令
/// 不走 ACL**。日志里那条 `window.destroy not allowed ... allow-destroy` 是 core 的
/// `plugin:window|destroy` 钥匙，与这里的 `window_toggle_maximize` 无关。
///
/// ## 现在的判据
///
/// 改成读**我们自己写进 builder 的显式配置**：`logs.rs` 里四扇辅助窗都写了
/// `.maximizable(false)`（小窗口不给放大），那才是"这个窗不能最大化"的唯一可信来源。
/// 但 builder 上的配置运行时读不回来 ⇒ 由 [`crate::MAXIMIZABLE_WINDOWS`] 维护一份白名单
/// （与 `logs.rs` 的 builder 由 `window_maximizable_matches_builder` 测试交叉核对）。
#[cfg(desktop)]
#[tauri::command]
pub fn window_toggle_maximize(window: tauri::WebviewWindow) -> bool {
    if !window_can_maximize(&window) {
        return false;
    }
    match window.is_maximized() {
        Ok(true) => {
            let _ = window.unmaximize();
            false
        }
        _ => {
            let _ = window.maximize();
            true
        }
    }
}

/// 「这个窗口允许被最大化吗」的**唯一**可信判据（桌面）。
///
/// 见 [`window_toggle_maximize`] 的注释：`is_maximizable()` 在 macOS Borderless 窗上恒假，
/// 必须换成显式白名单。白名单的含义是"我们**打算**让它可最大化"，与平台实际能力分开 ——
/// 平台能力由 `logs.rs` 的 builder 与 `set_maximizable` 表达。
#[cfg(desktop)]
pub(crate) fn window_can_maximize(window: &tauri::WebviewWindow) -> bool {
    crate::MAXIMIZABLE_WINDOWS.contains(&window.label())
}

/// 移动端窗口始终铺满屏幕，等价于「不可再最大化」。
#[cfg(mobile)]
#[tauri::command]
pub fn window_toggle_maximize(_app: tauri::AppHandle) -> bool {
    false
}

/// 返回**当前窗口**是否最大化。
///
/// 真值直接来自 tao：macOS Borderless 窗上 `set_maximized` 走 `setFrame(visibleFrame)`
/// 分支（`macos/util/async.rs:155-199`），`is_zoomed()` 在缺 `Titled` 位时退回"比对 frame
/// 与 visibleFrame"的比较，所以还原之后这个值会变回 false —— 与我们的 UI 需要一致。
#[cfg(desktop)]
#[tauri::command]
pub fn window_is_maximized(window: tauri::WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

/// 移动端没有"最大化"概念。
#[cfg(mobile)]
#[tauri::command]
pub fn window_is_maximized(_app: tauri::AppHandle) -> bool {
    false
}

/// 关闭**当前窗口**。
///
/// **主窗口 = 隐藏**（托盘语义：关掉窗口 ≠ 退出应用，与 `tray.rs` 的 CloseRequested 一致）；
/// **辅助窗口 = `close()`**，但"关了就藏"这件事由各自的 `AUX_*_RESIDENT` 决定 ——
/// 凡是常驻那几扇（现读 `commands/logs.rs` 里那几个常量），`install_hide_on_close` 已把
/// `close()` 变成"prevent + hide"，所以这里对它们调 `close()` 实际是藏起来。
/// ⚠️ 这里**刻意不再点名哪些窗口常驻**：`commands/logs.rs` 自己的注释写着
/// 「每扇的取舍理由写在各自的 `AUX_*_RESIDENT` 常量上，别在这里再数一遍（数一遍就会过时）」——
/// 而这一句此前正是这么过时的：它写着"群任务不常驻"，实物却是 `AUX_TASKS_RESIDENT = true`。
/// 写死 "main" 会让辅助窗口的关闭键把**主窗口**藏起来。
#[cfg(desktop)]
#[tauri::command]
pub fn window_close(window: tauri::WebviewWindow) {
    if window.label() == crate::WINDOW_MAIN {
        let _ = window.hide();
    } else {
        let _ = window.close();
    }
}

/// 移动端：保持既有行为（隐藏主窗口）。
#[cfg(mobile)]
#[tauri::command]
pub fn window_close(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(crate::WINDOW_MAIN) {
        let _ = w.hide();
    }
}

/// macOS：按前端布局档显示 / 隐藏系统红绿灯（窄窗口 = 移动布局时隐藏）。
///
/// 判据与阈值只在 `TitleBar.vue`（`isMobile` ← `platform.ts::resolveMobileLayout`）那一份，
/// 这里只做"把 AppKit 画的三颗键收起来"这一件事；非 macOS 是空操作。
#[cfg(desktop)]
#[tauri::command]
pub fn set_native_titlebar_buttons_hidden(window: tauri::WebviewWindow, hidden: bool) {
    #[cfg(target_os = "macos")]
    crate::macos_window::set_traffic_lights_hidden(&window, hidden);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, hidden);
    }
}

/// 移动端没有系统标题栏按钮：保持命令存在（前端同一份代码不改）。
#[cfg(mobile)]
#[tauri::command]
pub fn set_native_titlebar_buttons_hidden(_hidden: bool) {}

#[tauri::command(async)]
/// 群消息发送的**唯一内核**：群密钥加密 → Gossip 信封 → 落库（消息 + 每个成员的 outbox）
/// → 广播。文本、代码、表情回应等全部走这一条路。
///
/// `mentions`（这条文本 @ 了谁）只在明文里多带一个键，**不落库**：
/// 「有人@我」是摄入那一刻的一次性判定（重启即清空，见 useChatStore 的 mentionedConvs），
/// 为它动迁移链换来的可观察行为是零，风险却是本仓最高的一类。
/// ⚠️ 同一句话**不再适用于 `mention_targets`**（#122 第二段，迁移 v10→v11）：
/// 落点是"正文里哪一段算谁"，属于那句话的历史事实 —— 不落库的代价是"重启后同一句话换了意思"，
/// 那是**有**可观察行为的一类，所以它进库了。两者的分界写在类型上（见 `state::MessageRecord`）。
///
/// 为什么必须只有一条：它们都要 E2EE、都要 outbox 兜底、都要 GroupAck、都要被四层幂等
/// 去重覆盖。若各写一份，任何一处修 bug（历史上最典型的是「填完 group_creator/members
/// 后忘了重算重签 → 群消息被静默丢弃」）都只会修到其中一条路径。
/// 群消息发送内核；`local_id` 是前端乐观气泡的**持久本地 id**
/// （服务端 `msg_id` 到达后列表 key 不换，见 DB v13→v14）。
/// 非乐观路径（系统消息 / 任务 / 公告 / 回执…）传 `None`，由插入 SQL 回填 `msg_id`。
pub(crate) async fn send_group_payload(
    s: &Arc<AppState>,
    group_id: &str,
    kind: &str,
    content: String,
    mentions: Option<&[String]>,
    local_id: Option<&str>,
) -> Result<MessageRecord, String> {
    // 窗口抖动只支持单聊：群侧没有"独立抖动"的产品语义，且旧成员会收到空 target 的
    // 普通强提醒。放在群发送内核最前面，所有入口一次挡住。
    if kind == "remind" {
        if let Ok(p) = crate::protocol::parse_remind_payload(&content) {
            if p.nudge {
                return Err("窗口抖动只支持单聊".to_string());
            }
        }
    }
    let ts = db::now_ms();
    let conv_id = format!("group:{group_id}");
    let seq = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::next_clock(&dbc, &conv_id).map_err(|e| format!("逻辑时钟推进失败：{e}"))?
    };
    // 把群名 + 创建者 + 当前成员一并带上：跨端成员即便从未收到 GroupKey、
    // 只凭这条群消息也能在本地正确建群（含成员表），成员面板因此不为空。
    let group_meta = {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_group(&dbc, group_id).map(|g| (g.name, g.creator, g.members))
    };
    let (group_name, group_creator, group_members) = match group_meta {
        Some((n, c, m)) => (n, Some(c), m),
        None => return Err("群不存在".to_string()),
    };
    if !group_members.contains(&s.device_id) {
        return Err("你已不在该群中".to_string());
    }
    // 渲染切换只投给声明了 RENDER 的成员：旧端/离线端保持原渲染，不产生“不支持的消息”占位。
    // 其它 kind 仍按全成员投递（不改既有语义）。
    let outbox_members: Vec<String> = if kind == crate::protocol::KIND_RENDER {
        let features = s
            .peer_content_features
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        group_members
            .iter()
            .filter(|m| {
                m.as_str() == s.device_id
                    || (features.get(m.as_str()).copied().unwrap_or(0)
                        & crate::protocol::CONTENT_FEATURE_RENDER)
                        != 0
            })
            .cloned()
            .collect()
    } else {
        group_members.clone()
    };
    let key = get_group_key(s, group_id).await.ok_or("群密钥缺失")?;
    let preview = crate::protocol::preview_text(kind, &content);

    // 群密钥加密 + Gossip 信封（E2EE 恒开：载荷用群密钥 ChaCha20-Poly1305 加密）
    // `mentions` 只在文本消息上有值，且**三态有意义**（None=不发这个键=旧语义），
    // 所以这里不能写成 `mentions.unwrap_or_default()`。形状与理由见 protocol 层。
    // #122：新对端除了名单还要落点（哪一段文字算谁）。名字取**发送当时**通讯录里的那份昵称；
    // 查不到昵称的 id 不分配落点（蒙一个位置比留空更容易让对端把"@第二个人"对到第一次出现上）。
    let targets: Option<Vec<crate::protocol::MentionTarget>> = mentions.map(|ids| {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        // 昵称取通讯录里那份（`get_friend` 返 `(nickname, avatar)`）。
        // ⚠️ 刻意**不为自己的 id 造落点**：自己 @ 自己这条在本仓没有入口，
        // 而为它去猜"本机昵称存在哪"会多引一份状态源 —— 查不到昵称就是没有落点，
        // 那种情况下呈现层退回按昵称判（与老对端同一兜底路径），不是蒙一个位置。
        crate::protocol::build_mention_targets(&content, ids, |id| {
            db::get_friend(&dbc, id).map(|f| f.0)
        })
    });
    let plaintext = crate::protocol::gossip_plaintext_with_targets(
        kind,
        &content,
        mentions,
        targets.as_deref(),
    );
    let sealed = crypto::seal_symmetric(&key, plaintext.as_bytes()).ok_or("加密失败")?;
    let payload_b64 = STANDARD.encode(&sealed);
    let env = {
        let gossip = s.gossip.lock().unwrap_or_else(|e| e.into_inner());
        let mut env = gossip.build_envelope(
            &s.identity,
            &s.device_id,
            GossipKind::Group,
            Some(group_id.to_string()),
            Some(group_name.clone()),
            &payload_b64,
            ts,
            seq,
        );
        env.group_creator = group_creator;
        env.group_members = group_members.clone();
        // group_creator / group_members 属于签名材料（GossipEnvelope::signing_bytes），
        // 而 build_envelope 内部已按「尚未填值」的状态算过 message_id 与 sender_sig。
        // 若此处不重算重签，接收端 verify_envelope 会用最终字段重新计算签名材料，
        // 与旧签名不一致 → 验签失败 → handle_gossip 静默丢弃群消息（群聊收不到的根因）。
        // compute_message_id 只依赖 sender_id + ts + payload，重算后 message_id 不变，
        // 与既有协议语义保持一致。
        env.compute_message_id();
        env.sender_sig = s.identity.sign_b64(&env.signing_bytes());
        env
    };
    // 信封 encrypted 默认 true（build_envelope 内置），无需改写

    // 本地落库：msg_id 统一用 envelope.message_id（与单聊发送路径一致），
    // 保证同一条群消息在本地记录 / Gossip 投递 / 接收端落库三处身份一致。
    let rec = MessageRecord {
        id: 0,
        msg_id: env.message_id.clone(),
        conv_id: conv_id.clone(),
        sender_id: s.device_id.clone(),
        receiver_id: group_id.to_string(),
        kind: kind.to_string(),
        content: content.clone(),
        ts,
        seq,
        status: "sent".to_string(),
        // 自己这一行也带上落点：与刚发出去的那一份**是同一个事实**，不带就等于
        // 让库里那一行比线上少一截（同一件事出现两个真源，正是本仓反复付学费的形状）。
        mention_targets: targets.clone(),
        local_id: local_id.map(|v| v.to_string()),
    };
    // 群消息与单聊一样需要可靠投递：本地落库 + 每个成员的 outbox 在同一事务里完成，
    // 再由建链 / Hello / 心跳触发 flush_group_outbox 补发，收到 GroupAck 才删行。
    let gossip_msg = Message::Gossip {
        envelope: env.clone(),
    };
    let payload = serde_json::to_string(&gossip_msg).map_err(|e| e.to_string())?;
    {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let tx = dbc.unchecked_transaction().map_err(|e| e.to_string())?;
        db::insert_message(&tx, &rec).map_err(|e| format!("消息写入失败：{e}"))?;
        if crate::protocol::is_non_notifying_kind(kind) {
            // 静默事件与系统提示不改会话预览 —— 否则「自己回了个表情」会把会话列表摘要
            // 变成一段 JSON。会话行仍要确保存在。
            db::ensure_conversation(&tx, &conv_id, "group", &group_name, None)
                .map_err(|e| format!("会话写入失败：{e}"))?;
        } else {
            db::touch_conversation(&tx, &conv_id, "group", &group_name, None, &preview, 0)
                .map_err(|e| format!("会话写入失败：{e}"))?;
        }
        for member in &outbox_members {
            if member == &s.device_id {
                continue;
            }
            db::insert_group_outbox(&tx, &rec.msg_id, group_id, member, &payload)
                .map_err(|e| format!("群消息入队失败：{e}"))?;
        }
        tx.commit().map_err(|e| format!("群消息写入失败：{e}"))?;
    }

    // 落库成功后，把这条消息回送给**本机所有窗口**。
    //
    // 为什么必须由后端做、而不是靠发起方乐观插入：群任务看板跑在独立窗口 `todos.html`
    // 里，那份 `useChatStore` 是**另一个实例**，它 `enqueueMessage` 的记录主聊天窗完全看不见
    // ⇒ 用户自己发的任务/投票/接龙在自己的时间线上不出现，要重进会话才看得见。
    // 同形的群发送（群文件/公告 `group_announcements.rs`）早就在写库后自 emit，
    // 缺的正是内核这一句 —— 补在这里，所有走内核的 kind 一起修好，不必每个入口挂一次。
    //
    // 位置两处都是硬约束：必须在上面的锁作用域**闭合之后**（持锁 emit 是既有不变量），
    // 且 `tx.commit()` 成功之后（emit 一条没落库的消息会让前端显示一条刷新即消失的记录）。
    // 重复渲染不用担心：前端 `applyIncoming` 按 `msg_id` upsert，自发的那条也不计未读。
    let _ = s.app.emit("message-received", &rec);

    // §29 可观测性：这一行是「发起方自己为什么看得见」唯一的**行为**证据 —— 双实例 harness
    // 没有任何入口让应用自己执行一次动作（全仓只认 `GOSSLAN_INSTANCE`/`GOSSLAN_AUTOSTART`），
    // 所以"A 库里那行"永远是 harness 自己写的、判了就是循环论证；而"本机回送确实发生过"
    // 只有在这里留痕才判得了。位置硬约束同 emit：晚于 commit、在锁作用域之外。只记 id 与 kind。
    s.logger.info(
        "group",
        format!("群消息已回送本机窗口 msg={} kind={}", rec.msg_id, kind),
    );

    broadcast_gossip(s, env).await;

    // INV-P24 的群侧：**只报事实，不拦发送**。这条 kind 若有成员**确知**渲染不了，
    // 往前端发一句提示，消息照发。
    //
    // 为什么群不像 1:1 那样硬门控（本轮对 git 历史的考古结论，不是怕吵）：
    //   · 群 kind 不在 `MsgKind` 枚举里，它在群密钥加密的 Gossip 载荷内，接收端
    //     `parse_gossip_plaintext` 按**自由字符串**解析（同一份实现逐字存在于 v2.1.2 /
    //     v4.3.9 / v4.8.2 / v4.20.0），DB 列 `kind TEXT` 也没有 CHECK ⇒ 老成员不丢帧、
    //     不断链、不会假报"发送失败"，退化只发生在**渲染**（看成一段原始文本，
    //     因为 V3b 那层兜底只修了我们这一侧）；
    //   · 1:1 恰恰相反：老对端的 `ChatMessage.kind` 是枚举，不认识的 kind 整帧解析失败，
    //     而它的读循环 `Err(_) => break` ⇒ 丢帧之外还断链 —— 那边才配"不门控不许发"。
    // 接在**内核**而不是命令入口：文本/代码/合并/任务/投票/公告全走这里，将来新增受门控
    // 的 kind 自动被覆盖，不必记得在第二个入口再挂一次。
    let (missing_ids, unknown, gated) = {
        let features = s
            .peer_content_features
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::protocol::kind_audience(kind, |id| features.get(id).copied(), &group_members, &s.device_id)
    };
    if gated {
        // 显示名要在位图锁**外**解析：`resolve_nickname` 自己会去锁 peers 表。
        let names: Vec<String> = missing_ids
            .iter()
            .map(|id| resolve_nickname(s, id))
            .collect();
        let hint = crate::protocol::kind_audience_hint(kind, &names, unknown);
        if !hint.is_empty() {
            // `let _ =`：提示送不出去不该影响已经发出去的消息（它只是解释，不是结果）。
            let _ = s.app.emit(
                "content-audience",
                json!({ "conv_id": conv_id, "msg_id": rec.msg_id, "hint": hint }),
            );
        }
    }

    Ok(rec)
}
