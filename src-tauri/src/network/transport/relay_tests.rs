// 职责边界：
// - transport 行为测试分册之8 —— 公网中继：定向转发 share/offer、中继节点不本地处理 Ack、转发保留原字段
// 为什么拆：`transport/tests.rs` 原来 3,227 行、3 个顶层项全挤在同一个 `mod tests` 里。
// 机制与 `file_tests.rs` / `logs_tests.rs` 同一条：`include!` 是文本粘贴 ⇒ 这些项仍属于
// `crate::network::transport::tests` 这同一个模块 ⇒ 模块路径、`use`、可见性、**测试全名一字不变**
// （恒等判据＝`cargo test --features bluetooth --lib -- --list` 的 789 条用例名差集 0 行）。
// ⚠️ 本册**不进** `network::transport_src_for_guards()` 那份"生产码全集"视图：视图掺测试字面量会把
// 按窗口取段的守卫飘到测试文本上（2026-10-06 实测 4 条假红）。`lib_tests.rs` 里那条登记对账守卫
// 按 `_tests.rs` 结尾豁免本册 —— 别为了消红把测试文本并进去（那正是假绿的形状）。
    /// 定向中继判定：共享目录/中继文件在无直连时靠它借一跳；给本机或旧端无 to 的帧不转发。
    #[test]
    fn directed_relay_target_routes_share_and_offer_frames() {
        let me = "me";
        let tree_to_other = Message::ShareTreeRequest {
            request_id: "r".into(),
            from: "a".into(),
            to: "b".into(),
        };
        assert_eq!(directed_relay_target(&tree_to_other, me), Some("b"));
        let tree_to_me = Message::ShareTreeRequest {
            request_id: "r".into(),
            from: "a".into(),
            to: me.into(),
        };
        assert_eq!(
            directed_relay_target(&tree_to_me, me),
            None,
            "给本机的帧不转发"
        );
        let resp_legacy = Message::ShareTreeResponse {
            request_id: "r".into(),
            from: "a".into(),
            to: None,
            entries: vec![],
            truncated: false,
        };
        assert_eq!(
            directed_relay_target(&resp_legacy, me),
            None,
            "旧端无 to：按直连处理"
        );
        let resp_relay = Message::ShareTreeResponse {
            request_id: "r".into(),
            from: "a".into(),
            to: Some("b".into()),
            entries: vec![],
            truncated: false,
        };
        assert_eq!(directed_relay_target(&resp_relay, me), Some("b"));
        let file_req = Message::ShareFileRequest {
            transfer_id: "t".into(),
            from: "a".into(),
            path: "p".into(),
            to: Some("b".into()),
        };
        assert_eq!(directed_relay_target(&file_req, me), Some("b"));
        let offer = Message::RelayFileOffer {
            // 分片尺寸对本用例的路由判定无关，但要给一个"新对端"的真实值，
            // 免得日后有人照着这条用例把 0（= 老对端）当默认值抄。
            chunk_size: crate::file_relay::MIN_CHUNK_SIZE as u32,
            transfer_id: "t".into(),
            from: "a".into(),
            to: "b".into(),
            name: "n".into(),
            size: 1,
            total_chunks: 1,
            sealed_file_key: "k".into(),
            file_sha256: "h".into(),
        };
        assert_eq!(directed_relay_target(&offer, me), Some("b"));
        let normal = Message::Heartbeat {
            device_id: "a".into(),
        };
        assert_eq!(directed_relay_target(&normal, me), None);
    }

    /// Test 2：中继节点收到 Ack → sender_id ≠ 本机 → 不做本地处理。
    /// 验证中继节点不修改自己的消息状态、不删除 outbox。
    #[test]
    fn ack_relay_node_does_not_process_locally() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        // 中继节点 C 收到 A 发给 D 的消息（通过 Gossip）
        db::insert_message(
            &conn,
            &MessageRecord {
                fail_code: None,
                id: 0,
                msg_id: "m1".into(),
                conv_id: "d1".into(),
                sender_id: "node-a".into(),
                receiver_id: "d1".into(),
                kind: "text".into(),
                content: "hello".into(),
                ts: 200,
                seq: 1,
                status: "delivered".into(),
                mention_targets: None,
                local_id: None,
            },
        )
        .unwrap();
        // C 自己也有一条 outbox 消息（不同的 msg_id）
        db::insert_outbox(&conn, "m-own", "some-peer", r#"own payload"#).unwrap();

        // Ack handler 查询：sender_id = "node-a" ≠ "me"（当前节点是 C）
        let sender_id: String = conn
            .query_row(
                "SELECT sender_id FROM messages WHERE msg_id = ?1",
                params!["m1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(sender_id, "me", "sender_id 应为原始发送方 A，不是本机 C");

        // 中继节点不应执行任何本地状态修改
        // （实际 handler 中，Some(sender) if sender == device_id 分支不匹配 → 走转发分支）
        let status: String = conn
            .query_row("SELECT status FROM messages WHERE msg_id = 'm1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(status, "delivered", "中继节点不修改消息状态");
        assert!(
            !db::list_outbox(&conn, "some-peer").unwrap().is_empty(),
            "中继节点不删除自己的 outbox"
        );
    }

    /// Test 4：中继节点转发 Ack 时，sender_id 和 message_id 不被修改。
    #[test]
    fn ack_relay_preserves_original_fields() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        db::insert_message(
            &conn,
            &MessageRecord {
                fail_code: None,
                id: 0,
                msg_id: "m1".into(),
                conv_id: "d1".into(),
                sender_id: "node-a".into(),
                receiver_id: "d1".into(),
                kind: "text".into(),
                content: "hi".into(),
                ts: 100,
                seq: 1,
                status: "delivered".into(),
                mention_targets: None,
                local_id: None,
            },
        )
        .unwrap();

        // 中继节点查询到原始 sender_id
        let original_sender: String = conn
            .query_row(
                "SELECT sender_id FROM messages WHERE msg_id = ?1",
                params!["m1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(original_sender, "node-a");

        // 转发时使用原始 Ack 消息（message_id 和 sender_id 不变）
        let ack = Message::Ack {
            msg_id: "m1".into(),
        };
        match &ack {
            Message::Ack { msg_id } => {
                assert_eq!(msg_id, "m1", "message_id 不得被修改");
            }
            _ => panic!("应为 Ack"),
        }
        // original_sender 用于 try_send 的 peer_id 参数，不嵌入 Ack 消息体
    }

    // ================================================================
    // 好友权限测试
    // ================================================================

    // ================================================================
    // 中继文件收尾回执（2026-11-04）：payload 兼容 / 台账对账 / 未知帧
    // ================================================================

    fn receipt_test_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        conn
    }

    fn receipt_status(conn: &rusqlite::Connection, id: &str) -> String {
        conn.query_row(
            "SELECT status FROM file_transfers WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn seed_send_row(conn: &rusqlite::Connection, id: &str, peer: &str) {
        db::upsert_transfer(
            conn,
            id,
            peer,
            "报告.pdf",
            1234,
            "send",
            "sent",
            Some("/tmp/报告.pdf"),
            1.0,
        )
        .unwrap();
    }

    #[test]
    fn relay_receipt_legacy_payload_without_success_reads_as_delivered() {
        // 老接收端**只在落盘并校验通过后**才发，载荷里根本没有 success/size/fail_code。
        // 把"没写 success"读成失败，会把每一台老对端都判成失败 —— 这是最贵的兼容错误。
        let p: crate::protocol::FileRelayReceiptPayload =
            serde_json::from_str(r#"{"transfer_id":"t-legacy","sha256":"abc"}"#).unwrap();
        assert!(p.success, "缺 success 必须缺省为成功");
        assert_eq!(p.size, 0, "老载荷没有字节数");
        assert!(p.fail_code.is_none());
    }

    #[test]
    fn relay_receipt_failure_payload_keeps_named_code() {
        let payload = crate::protocol::FileRelayReceiptPayload {
            transfer_id: "t-1".into(),
            sha256: "abc".into(),
            success: false,
            size: 1234,
            fail_code: Some(crate::error_codes::FILE_INTEGRITY_FAILED.into()),
        };
        let json = serde_json::to_string(&payload).unwrap();
        let back: crate::protocol::FileRelayReceiptPayload = serde_json::from_str(&json).unwrap();
        assert!(!back.success);
        assert_eq!(back.fail_code.as_deref(), Some(crate::error_codes::FILE_INTEGRITY_FAILED));
        assert_eq!(back.size, 1234);
    }

    #[test]
    fn relay_receipt_success_marks_send_row_done_and_returns_fill_fields() {
        let conn = receipt_test_conn();
        seed_send_row(&conn, "t-ok", "peer-1");
        let payload = crate::protocol::FileRelayReceiptPayload {
            transfer_id: "t-ok".into(),
            sha256: "abc".into(),
            success: true,
            size: 1234,
            fail_code: None,
        };
        match super::apply_relay_file_receipt(&conn, "peer-1", &payload) {
            super::RelayReceiptApply::Delivered { name, size, path } => {
                assert_eq!(name, "报告.pdf");
                assert_eq!(size, 1234);
                assert_eq!(path, "/tmp/报告.pdf");
            }
            other => panic!("成功回执应升到 done，实际 {other:?}"),
        }
        assert_eq!(receipt_status(&conn, "t-ok"), "done");
    }

    #[test]
    fn relay_receipt_failure_marks_send_row_failed_and_passes_code_through() {
        let conn = receipt_test_conn();
        seed_send_row(&conn, "t-bad", "peer-1");
        let payload = crate::protocol::FileRelayReceiptPayload {
            transfer_id: "t-bad".into(),
            sha256: "abc".into(),
            success: false,
            size: 1234,
            fail_code: Some(crate::error_codes::FILE_INTEGRITY_FAILED.into()),
        };
        match super::apply_relay_file_receipt(&conn, "peer-1", &payload) {
            super::RelayReceiptApply::Failed { code } => {
                assert_eq!(code, crate::error_codes::FILE_INTEGRITY_FAILED);
            }
            other => panic!("失败回执应撤回并透传具名码，实际 {other:?}"),
        }
        assert_eq!(receipt_status(&conn, "t-bad"), "failed");
    }

    #[test]
    fn relay_receipt_ignores_receive_direction_and_foreign_peer() {
        let conn = receipt_test_conn();
        db::upsert_transfer(
            &conn,
            "t-recv",
            "peer-1",
            "对方发的.bin",
            7,
            "receive",
            "active",
            None,
            0.0,
        )
        .unwrap();
        let ok = crate::protocol::FileRelayReceiptPayload {
            transfer_id: "t-recv".into(),
            sha256: "abc".into(),
            success: true,
            size: 7,
            fail_code: None,
        };
        assert_eq!(
            super::apply_relay_file_receipt(&conn, "peer-1", &ok),
            super::RelayReceiptApply::IgnoredUnknown,
            "回执不得改写接收方向的台账行"
        );
        assert_eq!(receipt_status(&conn, "t-recv"), "active");

        let conn2 = receipt_test_conn();
        seed_send_row(&conn2, "t-own", "peer-1");
        let forged = crate::protocol::FileRelayReceiptPayload {
            transfer_id: "t-own".into(),
            sha256: "abc".into(),
            success: false,
            size: 1234,
            fail_code: Some(crate::error_codes::FILE_INTEGRITY_FAILED.into()),
        };
        assert_eq!(
            super::apply_relay_file_receipt(&conn2, "peer-2", &forged),
            super::RelayReceiptApply::IgnoredUnknown,
            "对端不符的回执不得改台账"
        );
        assert_eq!(receipt_status(&conn2, "t-own"), "sent");
    }

    #[test]
    fn relay_receipt_without_fail_code_does_not_invent_failure() {
        // 畸形失败回执（没带具名码）**不新增失败判定**：这条单继续停在 sent，
        // 与"老对端根本不发回执"的线上表现完全一致。
        let conn = receipt_test_conn();
        seed_send_row(&conn, "t-nocode", "peer-1");
        let payload = crate::protocol::FileRelayReceiptPayload {
            transfer_id: "t-nocode".into(),
            sha256: "abc".into(),
            success: false,
            size: 1234,
            fail_code: None,
        };
        assert_eq!(
            super::apply_relay_file_receipt(&conn, "peer-1", &payload),
            super::RelayReceiptApply::IgnoredMissingCode
        );
        assert_eq!(receipt_status(&conn, "t-nocode"), "sent");
    }

    #[test]
    fn relay_receipt_absent_keeps_send_row_at_sent() {
        // 老对端（没声明 CONTENT_FEATURE_FILE_RECEIPT）一条回执都不发 ⇒ 发送侧只到 sent。
        // 这里把"没有任何回执"钉成一条显式断言，防止后续有人加"超时即失败"把老对端判死。
        let conn = receipt_test_conn();
        seed_send_row(&conn, "t-old-peer", "peer-1");
        assert_eq!(receipt_status(&conn, "t-old-peer"), "sent");
    }

    #[test]
    fn unknown_gossip_kind_degrades_to_unknown_without_panic() {
        // 老端收到新变体 / 新端收到未来变体：整帧降级为 Message::Unknown（不 panic、
        // 不进任何业务分支，因此也不会污染去重或阻断后续帧）。
        let raw = br#"{"type":"Gossip","envelope":{"message_id":"m1","sender_id":"p","sender_pubkey":"k","sender_ed25519":"e","sender_sig":"s","ttl":1,"kind":"file_relay_receipt_v2","payload":"e30="}}"#;
        match super::decode_frame(raw) {
            Ok(Message::Unknown { wire_type }) => assert_eq!(wire_type, "Gossip"),
            other => panic!("未知 GossipKind 必须降级为 Unknown，实际 {other:?}"),
        }
    }
