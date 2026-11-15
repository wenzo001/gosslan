// 系统分享目标（从别的应用分享到本机）的**落地区协议**：文件格式 + 校验 + 限额。
//
// 为什么协议是「文件」而不是别的通道：
// - macOS 的 Share Extension 与主应用是**两个进程**，扩展不能直接调主应用；
//   它能写的只有共享容器（App Group）。
// - Windows 的 MSIX share target 同理，只能写共享目录。
// 所以唯一两边都做得到的通道就是「写文件 → 主应用读文件」。
//
// 落地区是**不可信输入**：任何能往那个目录写文件的进程都可能塞东西进来
// （同一台机器上的另一个用户程序、上一版的残留、用户自己拷进去的）。
// 因此读取端必须：只认**严格文件名**、限大小、限时间、逐字段走 `share.rs` 的同一把尺子，
// 并且最终一定要用户在面板里点确认才会发出去（见 `share.rs` 的既有口径）。
//
// 平台侧的**写入端不在本仓**：macOS 要 Share Extension（Xcode target）、Windows 要 MSIX
// share target，两者都要签名打包。骨架与契约见
// `docs/notes/system-share-target-design-2026-11-15.md`。

use serde::{Deserialize, Serialize};

use crate::share::{payload_from_fields, SharePayload};

/// 落地区目录名（挂在 `app_local_data_dir()` 下）。
pub const INCOMING_DIR_NAME: &str = "incoming-shares";

/// 单个文件的大小上限（字节）。分享内容本身有更严的字段限额，这个只是防「拿一个
/// 几百 MB 的文件喂给解析器」。
pub const MAX_FILE_BYTES: u64 = 64 * 1024;

/// 文件存活上限（毫秒）：超过就当过期。
///
/// 取 30 分钟而不是 10 分钟：平台扩展写完文件后，用户可能过一会儿才切回本应用；
/// 但也不能留一天 —— 那意味着第二天打开应用会收到一条昨天的分享。
pub const INCOMING_TTL_MS: i64 = 30 * 60 * 1000;

/// 允许的时钟超前（毫秒）。扩展与主应用的系统时钟可能差几秒；差太多说明这份文件
/// 来路不正（或系统时钟被改过），直接拒。
pub const CLOCK_SKEW_ALLOW_MS: i64 = 60 * 1000;

/// 文件名固定前缀。
pub const FILE_PREFIX: &str = "incoming-";
/// 文件名固定后缀。
pub const FILE_SUFFIX: &str = ".json";
/// 文件名里的 id 长度（十六进制字符数）。
pub const FILE_ID_HEX_LEN: usize = 32;
/// 落地区文件的格式版本。
pub const FORMAT_VERSION: u32 = 1;

/// 落地区文件的内容（v1）。**扁平**：字段少、语义窄，扩展那边照抄即可。
///
/// `id` 必须与文件名里的 id 一致 —— 文件名是唯一的真源，正文里的 id 只是冗余校验：
/// 两者不一致说明有人把一个文件改名成另一个（那样会顶掉别人的待处理分享）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingShareFile {
    /// 格式版本。
    pub v: u32,
    /// 与文件名一致的分享 id。
    pub id: String,
    /// 扩展写下这份文件的时刻（毫秒时间戳，UTC）。
    pub received_at_ms: i64,
    /// 分享内容本体。
    pub payload: IncomingPayload,
}

/// 文件里的分享内容（**原样**字段：清洗与限额由 `share.rs` 的同一把尺子做）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingPayload {
    pub url: Option<String>,
    pub title: Option<String>,
    pub text: Option<String>,
}

/// 一条通过校验的待处理分享。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingShare {
    pub id: String,
    pub payload: SharePayload,
    pub received_at_ms: i64,
}

/// 文件的判定结果。结局要分开，因为**处理方式不同**：
/// 可用 ⇒ 入队；过期 ⇒ 静默删掉；内容不合规 ⇒ 记日志后删掉；读不了 ⇒ 先留着（可能是临时的）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncomingVerdict {
    /// 可用。
    Ready(IncomingShare),
    /// 已过期（超过存活上限）。
    Expired,
    /// 内容不合规（文件名 / 版本 / 正文 / 大小）—— 留着只会一直失败 ⇒ 记日志后删掉。
    Malformed(String),
    /// 读不了这个文件（IO 失败、权限问题）—— 可能是临时的 ⇒ 记日志后**先留着**。
    Unreadable(String),
}

/// 严格校验文件名。
///
/// 只认 `incoming-<32 位小写十六进制>.json` 这一种形状：
/// - 十六进制 ⇒ 不含路径分隔符、不含 `..`，**目录穿越在这一层就被堵死**；
/// - 前缀固定 ⇒ 落地区里其它用途的文件不会被误当成待处理分享；
/// - 后缀固定 ⇒ 扩展临时文件（`.tmp`）不会被当成成品。
pub fn is_valid_file_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix(FILE_PREFIX)
        .and_then(|s| s.strip_suffix(FILE_SUFFIX))
    else {
        return false;
    };
    stem.len() == FILE_ID_HEX_LEN
        && stem
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 从文件名里取出 id（校验不过就给 None）。
pub fn file_id(name: &str) -> Option<&str> {
    if !is_valid_file_name(name) {
        return None;
    }
    name.strip_prefix(FILE_PREFIX)
        .and_then(|s| s.strip_suffix(FILE_SUFFIX))
}

/// 校验并解析一个落地区文件。
///
/// `now_ms` 是当前时刻；过期判定以**文件里的** `received_at_ms` 为准
/// （不看文件 mtime：mtime 会被拷贝/同步改掉，不可靠）。
pub fn parse_file(name: &str, bytes: &[u8], now_ms: i64) -> IncomingVerdict {
    let Some(id) = file_id(name) else {
        return IncomingVerdict::Malformed("文件名不合规".into());
    };
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return IncomingVerdict::Malformed(format!(
            "文件过大（{} 字节，上限 {MAX_FILE_BYTES}）",
            bytes.len()
        ));
    }
    let file: IncomingShareFile = match serde_json::from_slice(bytes) {
        Ok(f) => f,
        Err(e) => return IncomingVerdict::Malformed(format!("不是合法的落地区文件：{e}")),
    };
    if file.v != FORMAT_VERSION {
        return IncomingVerdict::Malformed(format!("格式版本不支持：{}", file.v));
    }
    if file.id != id {
        return IncomingVerdict::Malformed("正文 id 与文件名不一致".into());
    }
    // 未来太多 ⇒ 来路不正；过去太多 ⇒ 过期。
    if file.received_at_ms > now_ms + CLOCK_SKEW_ALLOW_MS {
        return IncomingVerdict::Malformed("时间戳超前过多".into());
    }
    if now_ms - file.received_at_ms > INCOMING_TTL_MS {
        return IncomingVerdict::Expired;
    }
    // 内容校验走 `share.rs` 的**同一个**构造入口：深链拦得住的，落地区也必须拦得住。
    let payload = match payload_from_fields(
        file.payload.url,
        file.payload.title,
        file.payload.text,
        None,
        None,
    ) {
        Ok(p) => p,
        Err(e) => return IncomingVerdict::Malformed(format!("内容不合规：{e}")),
    };
    IncomingVerdict::Ready(IncomingShare {
        id: id.to_string(),
        payload,
        received_at_ms: file.received_at_ms,
    })
}

/// 落地区目录（挂在本地数据目录下；**不是**漫游目录 —— 分享是本机的事，不该跟着账号跑）。
pub fn incoming_dir(local_data_dir: &std::path::Path) -> std::path::PathBuf {
    local_data_dir.join(INCOMING_DIR_NAME)
}

/// 扫一个落地区目录：返回每个候选文件与其判定。
///
/// **只读不删**：删不删由上层决定（入队成功才删 —— 先删后入队会在中途崩溃时丢分享）。
/// 目录不存在时返回空 vec（没装平台扩展是常态，不是错误）。
pub fn scan_dir(dir: &std::path::Path, now_ms: i64) -> Vec<(std::path::PathBuf, IncomingVerdict)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 文件名不合规 ⇒ 不是落地区文件（可能是扩展的临时文件或用户自己放的）⇒ 不动它。
        if !is_valid_file_name(&name) {
            continue;
        }
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(e) => {
                out.push((
                    path,
                    IncomingVerdict::Unreadable(format!("取不到元信息：{e}")),
                ));
                continue;
            }
        };
        if meta.len() > MAX_FILE_BYTES {
            out.push((
                path,
                IncomingVerdict::Malformed(format!("文件过大（{} 字节）", meta.len())),
            ));
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                out.push((path, IncomingVerdict::Unreadable(format!("读不了：{e}"))));
                continue;
            }
        };
        let verdict = parse_file(&name, &bytes, now_ms);
        out.push((path, verdict));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id_hex() -> String {
        "0123456789abcdef0123456789abcdef".to_string()
    }

    fn file_name(id: &str) -> String {
        format!("{FILE_PREFIX}{id}{FILE_SUFFIX}")
    }

    fn body(id: &str, received_at_ms: i64, url: Option<&str>, text: Option<&str>) -> Vec<u8> {
        serde_json::to_vec(&IncomingShareFile {
            v: FORMAT_VERSION,
            id: id.to_string(),
            received_at_ms,
            payload: IncomingPayload {
                url: url.map(|s| s.to_string()),
                title: Some("标题".into()),
                text: text.map(|s| s.to_string()),
            },
        })
        .unwrap()
    }

    #[test]
    fn file_name_shape_is_strict() {
        assert!(is_valid_file_name(&file_name(&id_hex())));
        // 大写十六进制不认（写入端统一小写，避免同一台机器上大小写两套 id）。
        assert!(!is_valid_file_name(&format!(
            "{FILE_PREFIX}0123456789ABCDEF0123456789ABCDEF{FILE_SUFFIX}"
        )));
        // 长度不对。
        assert!(!is_valid_file_name(&format!(
            "{FILE_PREFIX}0123{FILE_SUFFIX}"
        )));
        // 前缀/后缀不对。
        assert!(!is_valid_file_name(
            "share-0123456789abcdef0123456789abcdef.json"
        ));
        assert!(!is_valid_file_name(&format!(
            "{FILE_PREFIX}{}{FILE_SUFFIX}.tmp",
            id_hex()
        )));
        // 目录穿越：文件名里带分隔符或 .. 一律不认。
        assert!(!is_valid_file_name("../../etc/passwd"));
        assert!(!is_valid_file_name(&format!(
            "{FILE_PREFIX}../evil{FILE_SUFFIX}"
        )));
        assert!(!is_valid_file_name(&format!(
            "{FILE_PREFIX}0123456789abcdef0123456789abcde/{FILE_SUFFIX}"
        )));
    }

    #[test]
    fn ready_file_is_parsed() {
        let id = id_hex();
        let now = 1_700_000_000_000i64;
        let bytes = body(&id, now - 1000, Some("https://example.com/a"), None);
        match parse_file(&file_name(&id), &bytes, now) {
            IncomingVerdict::Ready(s) => {
                assert_eq!(s.id, id);
                assert_eq!(s.payload.url.as_deref(), Some("https://example.com/a"));
                assert_eq!(s.payload.title.as_deref(), Some("标题"));
                // 落地区不带自称来源（扩展说不上来，也不该由它自称）。
                assert!(s.payload.claimed_origin.is_none());
            }
            other => panic!("应当可用，实际：{other:?}"),
        }
    }

    #[test]
    fn expired_file_is_not_an_error() {
        let id = id_hex();
        let now = 1_700_000_000_000i64;
        let bytes = body(
            &id,
            now - INCOMING_TTL_MS - 1,
            Some("https://example.com/a"),
            None,
        );
        assert_eq!(
            parse_file(&file_name(&id), &bytes, now),
            IncomingVerdict::Expired
        );
    }

    #[test]
    fn clock_skew_beyond_allowance_is_rejected() {
        let id = id_hex();
        let now = 1_700_000_000_000i64;
        let bytes = body(
            &id,
            now + CLOCK_SKEW_ALLOW_MS + 1,
            Some("https://example.com/a"),
            None,
        );
        match parse_file(&file_name(&id), &bytes, now) {
            IncomingVerdict::Malformed(_) => {}
            other => panic!("超前过多必须拒，实际：{other:?}"),
        }
        // 允许范围内的超前不算事。
        let bytes = body(&id, now + 1000, Some("https://example.com/a"), None);
        assert!(matches!(
            parse_file(&file_name(&id), &bytes, now),
            IncomingVerdict::Ready(_)
        ));
    }

    #[test]
    fn id_mismatch_is_rejected() {
        let id = id_hex();
        let other = "ffffffffffffffffffffffffffffffff".to_string();
        let now = 1_700_000_000_000i64;
        let bytes = body(&other, now, Some("https://example.com/a"), None);
        match parse_file(&file_name(&id), &bytes, now) {
            IncomingVerdict::Malformed(_) => {}
            other => panic!("正文 id 与文件名不一致必须拒，实际：{other:?}"),
        }
    }

    #[test]
    fn bad_version_and_bad_json_are_rejected() {
        let id = id_hex();
        let now = 1_700_000_000_000i64;
        let mut bytes = body(&id, now, Some("https://example.com/a"), None);
        bytes[0] = b'x';
        assert!(matches!(
            parse_file(&file_name(&id), &bytes, now),
            IncomingVerdict::Malformed(_)
        ));
        assert!(matches!(
            parse_file(&file_name(&id), b"not json", now),
            IncomingVerdict::Malformed(_)
        ));
    }

    #[test]
    fn content_limits_match_the_deep_link_path() {
        // 落地区必须与深链**同一把尺子**：非 http(s) 链接、空内容、超长正文都要拒。
        let id = id_hex();
        let now = 1_700_000_000_000i64;
        let bytes = body(&id, now, Some("javascript:alert(1)"), None);
        assert!(matches!(
            parse_file(&file_name(&id), &bytes, now),
            IncomingVerdict::Malformed(_)
        ));

        let long = "x".repeat(crate::share::MAX_TEXT_CHARS + 1);
        let bytes = body(&id, now, None, Some(&long));
        assert!(matches!(
            parse_file(&file_name(&id), &bytes, now),
            IncomingVerdict::Malformed(_)
        ));

        // 全空 ⇒ 拒（与深链同口径）。这里不能用 `body()`：那个夹具永远带标题。
        let empty = serde_json::to_vec(&IncomingShareFile {
            v: FORMAT_VERSION,
            id: id.clone(),
            received_at_ms: now,
            payload: IncomingPayload {
                url: None,
                title: None,
                text: Some("   ".into()),
            },
        })
        .unwrap();
        assert!(matches!(
            parse_file(&file_name(&id), &empty, now),
            IncomingVerdict::Malformed(_)
        ));
    }

    #[test]
    fn oversized_file_is_rejected_before_parsing() {
        let id = id_hex();
        let now = 1_700_000_000_000i64;
        let big = vec![b'x'; (MAX_FILE_BYTES + 1) as usize];
        match parse_file(&file_name(&id), &big, now) {
            IncomingVerdict::Malformed(_) => {}
            other => panic!("超大文件必须拒，实际：{other:?}"),
        }
    }

    // ---------------- 扫盘（真实文件，临时目录）----------------

    /// 扫盘：只认严格文件名的文件，其余文件**原样留着**（不能动别人的东西）。
    #[test]
    fn scan_dir_only_touches_strictly_named_files() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_700_000_000_000i64;
        let id = id_hex();
        std::fs::write(
            dir.path().join(file_name(&id)),
            body(&id, now, Some("https://example.com/a"), None),
        )
        .unwrap();
        // 三份「不是落地区文件」的东西：临时文件、别的前缀、随便一个文件。
        std::fs::write(
            dir.path()
                .join(format!("{FILE_PREFIX}{id}{FILE_SUFFIX}.tmp")),
            b"x",
        )
        .unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        std::fs::write(dir.path().join(format!("other-{id}{FILE_SUFFIX}")), b"x").unwrap();

        let found = scan_dir(dir.path(), now);
        assert_eq!(found.len(), 1, "只应认出那一份合规文件，实际：{found:?}");
        assert!(matches!(found[0].1, IncomingVerdict::Ready(_)));
        // 其余三个文件必须还在原地（读取端不许删别人的东西）。
        assert!(dir
            .path()
            .join(format!("{FILE_PREFIX}{id}{FILE_SUFFIX}.tmp"))
            .exists());
        assert!(dir.path().join("notes.txt").exists());
        assert!(dir.path().join(format!("other-{id}{FILE_SUFFIX}")).exists());
    }

    /// 扫盘：过期与不合规的文件照样被认出（由上层决定删不删）。
    #[test]
    fn scan_dir_reports_expired_and_invalid_separately() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_700_000_000_000i64;
        let old_id = id_hex();
        let bad_id = "ffffffffffffffffffffffffffffffff".to_string();
        std::fs::write(
            dir.path().join(file_name(&old_id)),
            body(
                &old_id,
                now - INCOMING_TTL_MS - 1,
                Some("https://example.com/a"),
                None,
            ),
        )
        .unwrap();
        std::fs::write(dir.path().join(file_name(&bad_id)), b"not json").unwrap();

        let found = scan_dir(dir.path(), now);
        assert_eq!(found.len(), 2);
        let mut expired = 0;
        let mut invalid = 0;
        for (_, v) in found {
            match v {
                IncomingVerdict::Expired => expired += 1,
                IncomingVerdict::Malformed(_) => invalid += 1,
                other => panic!("不该有别的结局：{other:?}"),
            }
        }
        assert_eq!(expired, 1);
        assert_eq!(invalid, 1);
    }

    /// 目录不存在 = 常态（没装平台扩展），必须安静回空，不能当错误。
    #[test]
    fn scan_dir_on_missing_directory_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert!(scan_dir(&missing, 1_700_000_000_000).is_empty());
    }

    /// **整条链**（真实文件 → 扫盘 → 入队 → 面板能取到）：
    /// 平台扩展写下文件 ⇒ 读取端认出 ⇒ 进队列 ⇒ `newest_live` 取得到。
    ///
    /// 这条把「协议对、但队列接不上」的缝堵住 —— 单测各段都绿不等于整条链通。
    #[test]
    fn file_to_queue_chain_works_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_700_000_000_000i64;
        let id = id_hex();
        std::fs::write(
            dir.path().join(file_name(&id)),
            body(&id, now - 1000, Some("https://example.com/a"), Some("正文")),
        )
        .unwrap();

        let mut map: std::collections::HashMap<String, crate::share::SharePrompt> =
            std::collections::HashMap::new();
        let found = scan_dir(dir.path(), now);
        assert_eq!(found.len(), 1);
        let ready = match found.into_iter().next().map(|(_, v)| v) {
            Some(IncomingVerdict::Ready(s)) => s,
            other => panic!("应当可用，实际：{other:?}"),
        };
        let prompt = crate::share::SharePrompt {
            share_id: "s-incoming-1".into(),
            payload: ready.payload,
            received_at_ms: now,
            expires_at_ms: now + crate::share::PENDING_TTL_MS,
        };
        let admitted = crate::share::admit(&mut map, prompt, now, crate::share::MAX_PENDING)
            .expect("应当入队成功");
        assert_eq!(
            admitted.payload.url.as_deref(),
            Some("https://example.com/a")
        );
        // 面板取得到它（前端就是靠这条读到待处理分享的）。
        let newest = crate::share::newest_live(&mut map, now).expect("面板应当能取到");
        assert_eq!(newest.share_id, "s-incoming-1");
    }
}
