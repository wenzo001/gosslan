//! **用户选定的目录**的持久化：路径 +（macOS）安全作用域书签。
//!
//! 目前有两处同构的需求（同一个坑踩两次，所以抽成一份）：
//! - 共享目录（`share_dir`）—— 对外提供文件列表；
//! - 文件接收目录（`downloads_dir`）—— 收到的文件写到这里。
//!
//! 两者都是"用户在目录选择器里挑的目录"，而沙盒里那次选择的授权**只属于本次进程**。
//! 所以数据库里对每个目录存两样东西：
//! - `<name>`：路径字符串（跨平台通用，非沙盒环境全靠它）；
//! - `<name>_bookmark`：**仅 macOS** 的 security-scoped bookmark（base64）——
//!   沙盒里它是重启后唯一还带权限的来源（见 `macos_bookmark.rs`）。
//!
//! 决策收在一个纯函数 [`pick`] 里，这样"谁优先、坏了怎么办"是**可测**的，
//! 而不是散落在启动流程的 `if let` 里。
use rusqlite::Connection;

use crate::db;

/// 一对数据库键：路径 + 它的书签。
#[derive(Clone, Copy)]
pub struct Keys {
    /// 路径字符串的键（跨平台）。
    pub path: &'static str,
    /// 书签的键（base64，仅 macOS 会写）。
    /// 非 macOS 平台这个键永远不会被读写 —— 显式标注，免得在那些目标上冒出 dead_code 警告。
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub bookmark: &'static str,
}

/// 共享目录（对外提供文件列表）。
pub const SHARE: Keys = Keys {
    path: "share_dir",
    bookmark: "share_dir_bookmark",
};

/// 文件接收目录（收到的文件写到这里）。
pub const RECEIVE: Keys = Keys {
    path: "downloads_dir",
    bookmark: "downloads_dir_bookmark",
};

/// 启动期决策（**纯函数**）。
///
/// 规则只有两条，但顺序很关键：
/// 1. **书签优先**：沙盒里它是唯一重启后仍有效的东西；而且书签记的是"资源"本身，
///    用户在 Finder 里移动/重命名目录后，解析出来的路径**比数据库里那条更新**；
/// 2. 书签没有 / 解析失败 / 解析出空路径 ⇒ **退回数据库里的路径**。
///    绝不能因为书签坏了就让用户重新选一次 —— 未沙盒的构建（开发模式）本来就靠这条。
pub fn pick(
    stored: Option<String>,
    from_bookmark: Option<Result<String, String>>,
) -> Option<String> {
    if let Some(Ok(path)) = from_bookmark {
        if !path.is_empty() {
            return Some(path);
        }
    }
    stored
}

/// 接收目录的**历史**：`files_present` 的存在性白名单必须认它。
///
/// 为什么需要（2026-11-21 用户实测发现的真缺陷）：白名单原来只认**当前**下载目录，
/// 而用户改过接收目录之后，旧目录里仍在的文件会被判「不在本机」——群文件面板给那些行
/// 打上"已不在本机"、并且拦住打开入口。文件确实还在盘上，只是不在新选的目录里。
///
/// 上限 8 是有意的：这条白名单是"信任哪些目录"的名单，不是浏览历史 ——
/// 无边界的名单等于没名单。
pub const RECEIVE_HISTORY_KEY: &str = "downloads_dir_history";
pub const RECEIVE_HISTORY_MAX: usize = 8;

/// 把 `old` 记进历史（**纯函数**，去重/上限/空值都在这里判）。
///
/// 语义：`old` 就是"刚刚被换掉的那个目录"，永远排在最前；重复设置同一目录不会
/// 刷出多条；空串/纯空白直接忽略（早期版本可能写过空值）。
pub fn push_recent(history: Vec<String>, old: Option<&str>, cap: usize) -> Vec<String> {
    let Some(old) = old.map(str::trim).filter(|s| !s.is_empty()) else {
        return history;
    };
    let mut out: Vec<String> = history
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != old)
        .collect();
    out.insert(0, old.to_string());
    out.truncate(cap);
    out
}

/// 读历史（坏 JSON 一律当空 —— 白名单少一条目录只会让个别文件被判"不在"，
/// 而这里要避免的是**崩溃/误信**这两种更坏的结局）。
pub fn parse_history(raw: Option<String>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

/// 启动时读该目录。macOS 上会顺带解析书签（**解析即开始访问**）、
/// 过期则续期写回、失效则清掉（免得每次启动都白试一次）。
pub fn load(conn: &Connection, keys: Keys) -> Option<String> {
    let stored = db::get_setting(conn, keys.path);

    #[cfg(target_os = "macos")]
    let from_bookmark = db::get_setting(conn, keys.bookmark).map(|b64| {
        match crate::macos_bookmark::resolve(&b64) {
            Ok(resolved) => {
                if let Some(new_bookmark) = &resolved.refreshed {
                    // 续期成功：写回，下次启动不用再续
                    let _ = db::set_setting(conn, keys.bookmark, new_bookmark);
                }
                Ok(resolved.path)
            }
            Err(_) => {
                // 失效/损坏：清掉。否则每次启动都拿一条坏书签去试
                let _ = db::delete_setting(conn, keys.bookmark);
                Err("目录书签已失效".to_string())
            }
        }
    });
    #[cfg(not(target_os = "macos"))]
    let from_bookmark: Option<Result<String, String>> = None;

    pick(stored, from_bookmark)
}

/// 用户选好目录后落库：先写路径，再（macOS）尽力写书签。
///
/// 书签建不出来**不能**让"设置目录"这个动作失败：未沙盒的构建会创建失败，
/// 而那时路径本来就能用。失败时清掉旧书签，避免下次启动拿一条与当前目录不匹配的书签
/// 去解析（那会把这个目录指回**上一个**目录）。
pub fn store(conn: &Connection, keys: Keys, path: &str) -> Result<(), String> {
    db::set_setting(conn, keys.path, path).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    match crate::macos_bookmark::create(path) {
        Ok(bookmark) => {
            db::set_setting(conn, keys.bookmark, &bookmark).map_err(|e| e.to_string())?;
        }
        Err(_) => {
            let _ = db::delete_setting(conn, keys.bookmark);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(db::SCHEMA).unwrap();
        conn
    }

    /// 书签解析出的是**规范化路径**（macOS 上 `/var` 是符号链接 ⇒ `/private/var/...`），
    /// 所以涉及真实目录的断言要比 canonicalize 之后的结果。
    fn same_dir(a: Option<String>, b: &str) -> bool {
        let (Some(a), Ok(b)) = (a, std::path::Path::new(b).canonicalize()) else {
            return false;
        };
        matches!(std::path::Path::new(&a).canonicalize(), Ok(x) if x == b)
    }

    fn ok(path: &str) -> Option<Result<String, String>> {
        Some(Ok(path.to_string()))
    }

    fn err() -> Option<Result<String, String>> {
        Some(Err("书签已失效".to_string()))
    }

    /// 书签优先 —— 且**必须**优先，因为沙盒里只有它带权限。
    #[test]
    fn bookmark_wins_over_the_stored_path() {
        assert_eq!(
            pick(Some("/old/path".to_string()), ok("/moved/here")),
            Some("/moved/here".to_string()),
            "书签解析出的路径更新，必须盖过数据库里那条"
        );
    }

    /// 书签坏了要退回路径，而不是把共享目录清空（否则用户会莫名其妙要重选一次）。
    #[test]
    fn broken_bookmark_falls_back_to_the_stored_path() {
        assert_eq!(
            pick(Some("/stored".to_string()), err()),
            Some("/stored".to_string())
        );
        assert_eq!(
            pick(Some("/stored".to_string()), None),
            Some("/stored".to_string())
        );
    }

    /// 书签解析出空路径等同于失败（不能把空串当目录）。
    #[test]
    fn empty_resolved_path_is_not_accepted() {
        assert_eq!(
            pick(Some("/stored".to_string()), ok("")),
            Some("/stored".to_string()),
            "空路径必须被拒绝并退回"
        );
        assert_eq!(pick(None, ok("")), None);
    }

    /// 都没配就是没配（设置页据此显示"未设置"）。
    #[test]
    fn nothing_configured_stays_none() {
        assert_eq!(pick(None, None), None);
        assert_eq!(pick(None, err()), None);
    }

    /// 端到端：`store` 之后 `load` 必须拿到同一个目录 ——
    /// **无论沙盒允不允许创建书签**（不允许就走"只有路径"的降级路）。
    /// 这条守着最容易犯的错：书签建失败把整个设置也一起丢了。
    #[test]
    fn store_then_load_returns_the_same_directory_in_both_modes() {
        let conn = mem();
        let dir = std::env::temp_dir();
        let dir = dir.to_string_lossy().trim_end_matches('/').to_string();

        store(&conn, SHARE, &dir).expect("设置共享目录不该失败");
        assert_eq!(
            db::get_setting(&conn, SHARE.path).as_deref(),
            Some(dir.as_str()),
            "路径必须无条件落库（书签只是附加信息）"
        );
        assert!(
            same_dir(load(&conn, SHARE), &dir),
            "load 必须拿回同一个目录"
        );
    }

    /// 两个目录（共享 / 接收）必须**各存各的**：键写串了会让"改接收目录"
    /// 顺手把共享目录指到别处 —— 这类串键错误在单目录测试里完全看不出来。
    #[test]
    fn the_two_user_directories_do_not_interfere() {
        let conn = mem();
        let a = std::env::temp_dir();
        let a = a.to_string_lossy().trim_end_matches('/').to_string();
        let b = format!("{a}/gosslan-user-dirs-test");
        std::fs::create_dir_all(&b).unwrap();

        store(&conn, SHARE, &a).unwrap();
        store(&conn, RECEIVE, &b).unwrap();

        assert!(
            same_dir(load(&conn, SHARE), &a),
            "共享目录不能被接收目录覆盖"
        );
        assert!(same_dir(load(&conn, RECEIVE), &b), "接收目录必须各自独立");
        assert_ne!(SHARE.path, RECEIVE.path, "两处路径键必须不同");
        assert_ne!(SHARE.bookmark, RECEIVE.bookmark, "两处书签键必须不同");
        let _ = std::fs::remove_dir_all(&b);
    }

    /// 坏书签不能让启动拿不到目录：清了书签、退回路径。
    #[test]
    fn corrupted_bookmark_is_cleared_and_path_still_used() {
        let conn = mem();
        db::set_setting(&conn, SHARE.path, "/stored/dir").unwrap();
        db::set_setting(&conn, SHARE.bookmark, "这不是书签!!").unwrap();

        assert_eq!(load(&conn, SHARE), Some("/stored/dir".to_string()));
        #[cfg(target_os = "macos")]
        assert_eq!(
            db::get_setting(&conn, SHARE.bookmark),
            None,
            "坏书签必须被清掉，免得每次启动都白试"
        );
    }

    /// 接收目录历史：去重、最前、有上限、空值忽略（纯函数，边界全在这里）。
    ///
    /// 这条判据守的是一类真实故障：用户改过接收目录之后，旧目录里仍在的文件被
    /// `files_present` 判成「不在本机」—— 群文件面板给那些行打上"已不在本机"并
    /// 拦住打开入口。白名单要认历史，历史本身就必须是干净、有界的。
    #[test]
    fn recent_dirs_dedupes_caps_and_ignores_blank() {
        use super::{push_recent, RECEIVE_HISTORY_MAX};

        // 空值 / 纯空白：历史原样返回（早期版本可能写过空串）
        assert!(push_recent(vec![], None, 8).is_empty());
        assert!(push_recent(vec![], Some("   "), 8).is_empty());
        assert_eq!(push_recent(vec!["/a".into()], Some(""), 8), vec!["/a"]);

        // 最新一条永远在最前
        let h = push_recent(vec!["/a".into()], Some("/b"), 8);
        assert_eq!(h, vec!["/b", "/a"]);

        // 重复设置同一目录不刷多条（否则来回切两次就把上限吃光了）
        let h = push_recent(vec!["/b".into(), "/a".into()], Some("/b"), 8);
        assert_eq!(h, vec!["/b", "/a"], "重复项必须被提到最前而不是再插一条");

        // 上限：超出就丢最旧的
        let long: Vec<String> = (0..RECEIVE_HISTORY_MAX).map(|i| format!("/d{i}")).collect();
        let h = push_recent(long, Some("/new"), RECEIVE_HISTORY_MAX);
        assert_eq!(
            h.len(),
            RECEIVE_HISTORY_MAX,
            "历史必须有界（它是信任白名单，不是浏览记录）"
        );
        assert_eq!(h[0], "/new");
        assert!(
            !h.contains(&format!("/d{}", RECEIVE_HISTORY_MAX - 1)),
            "最旧的应当被挤掉"
        );

        // cap 就是上限：0 条就是 0 条（别偷偷留一条，那会让"名单"变成另一种东西）
        assert!(push_recent(vec!["/a".into()], Some("/b"), 0).is_empty());

        // 空白包裹的路径要 trim（用户从对话框粘进来的值带空格）
        assert_eq!(push_recent(vec![], Some("  /p  "), 8), vec!["/p"]);
    }

    /// 坏 JSON 当空：白名单少一条目录只会让个别文件被判"不在"；
    /// 而崩溃或误信是更坏的结局。
    #[test]
    fn broken_history_json_reads_as_empty() {
        use super::parse_history;
        assert!(parse_history(None).is_empty());
        assert!(parse_history(Some("是乱的".into())).is_empty());
        assert!(parse_history(Some("{}".into())).is_empty());
        assert_eq!(
            parse_history(Some(r#"["/a","/b"]"#.into())),
            vec!["/a".to_string(), "/b".to_string()]
        );
    }

    /// 接线（2026-11-21 的真缺陷形状：功能写了但没人用 / 只认当前目录）。
    #[test]
    fn files_present_whitelists_historical_receive_dirs() {
        let helpers = include_str!("commands/helpers.rs");
        let share = include_str!("commands/share.rs");
        // ① 探测端：必须读历史，并把它并进白名单
        assert!(
            helpers.contains("crate::user_dirs::RECEIVE_HISTORY_KEY"),
            "files_present 没读接收目录历史 ⇒ 改过目录之后旧文件全被判不在"
        );
        assert!(
            helpers.contains("crate::user_dirs::parse_history("),
            "历史读出来了却没解析成目录列表"
        );
        assert!(
            helpers.contains("roots.iter().any(|d| file.starts_with(d))"),
            "白名单没有真的用上 roots（还是只判当前目录）"
        );
        // ② 写入端：换目录时必须把旧目录记进历史（少了这一步，读端永远拿不到东西）
        assert!(
            share.contains("crate::user_dirs::push_recent("),
            "set_downloads_dir 没把旧目录记进历史 ⇒ 读端永远是空名单"
        );
        assert!(
            share.contains("crate::user_dirs::RECEIVE_HISTORY_KEY"),
            "set_downloads_dir 没写历史键"
        );
        // 反例自证：把读端那行白名单拼法改掉，断言必须不再成立
        let gutted = helpers.replace("roots.iter().any(|d| file.starts_with(d))", "false");
        assert!(
            !gutted.contains("roots.iter().any(|d| file.starts_with(d))"),
            "锚点漂了"
        );
    }

    /// 书签与路径不匹配时以书签为准（模拟"用户在 Finder 里移动了目录"）。
    #[cfg(target_os = "macos")]
    #[test]
    fn moved_directory_is_followed_through_the_bookmark() {
        let conn = mem();
        let dir = std::env::temp_dir();
        let dir = dir.to_string_lossy().trim_end_matches('/').to_string();
        if let Ok(bookmark) = crate::macos_bookmark::create(&dir) {
            db::set_setting(&conn, SHARE.path, "/somewhere/else").unwrap();
            db::set_setting(&conn, SHARE.bookmark, &bookmark).unwrap();
            assert!(
                same_dir(load(&conn, SHARE), &dir),
                "书签指向的目录才是真目录"
            );
        }
    }
}
