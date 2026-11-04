// 职责边界：
// - 外链管理（add/remove/list_link、validate_external_url）
// ---------------- 外部链接（左栏「链接」视图 → 点开在独立窗口加载） ----------------

use rusqlite::Connection;
use std::collections::HashSet;

/// 一条用户配置的外部链接。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLink {
    /// 稳定主键：改名字/改网址都按它匹配，不会跟丢。
    pub id: String,
    pub name: String,
    pub url: String,
}

/// 导入结果：`links` 是导入后的完整列表，另外三个数只为界面说清“发生了什么”。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLinkImportResult {
    pub links: Vec<ExternalLink>,
    pub added: usize,
    pub skipped: usize,
    pub invalid: usize,
}

const EXTERNAL_LINKS_KEY: &str = "external_links";
/// 最近一次「从网址导入」用的那个链接。刷新按钮按它重拉，用户只有主动再导入才会换掉。
const EXTERNAL_LINKS_SOURCE_KEY: &str = "external_links_import_source";
/// 数量上限（防呆：这是一排给人点的入口，不是书签管理器）。
const MAX_EXTERNAL_LINKS: usize = 20;
/// 显示名长度上限（字符数）。
const MAX_LINK_NAME_CHARS: usize = 32;
/// 导入 JSON 的文件/响应体上限：这是 20 条短链接，256 KiB 已经非常宽松。
const MAX_IMPORT_BYTES: usize = 256 * 1024;

/// 校验并规范化一个外部网址 —— **只允许 http/https 且 host 非空**。
///
/// 为什么必须做协议白名单：这个网址会被 [`open_link_window`] 交给 `WebviewUrl::External`
/// 直接加载，`javascript:`/`data:`/`file:`/`tauri:` 之类要么能执行脚本、要么能读本机文件 ——
/// 等于把一条本机攻击面交给用户随手粘贴的字符串。与 `utils/linkify.ts` 只认 `https?://`
/// 是同一条口径（消息里的链接也受同一限制）。
pub fn validate_external_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_URL_EMPTY,
            "网址不能为空",
        ));
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| {
        crate::error_codes::coded(crate::error_codes::LINK_URL_INVALID, "网址格式不正确")
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_URL_SCHEME,
            "网址必须以 http:// 或 https:// 开头",
        ));
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_URL_NO_HOST,
            "网址缺少主机名",
        ));
    }
    Ok(parsed.to_string())
}

/// 容错解析：逐条跳过坏数据，绝不因一条脏数据让整张表消失（与 `parse_endpoints` 同口径）。
fn parse_external_links(raw: &str) -> Vec<ExternalLink> {
    serde_json::from_str::<Vec<ExternalLink>>(raw)
        .map(|list| {
            list.into_iter()
                .filter(|l| {
                    !l.id.is_empty() && !l.name.is_empty() && validate_external_url(&l.url).is_ok()
                })
                .take(MAX_EXTERNAL_LINKS)
                .collect()
        })
        .unwrap_or_default()
}

fn encode_external_links(list: &[ExternalLink]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".to_string())
}

/// 规范化编辑输入并做重复校验（`except_id` = 编辑时排除自己那条）。
fn normalize_link_input(
    list: &[ExternalLink],
    name: &str,
    url: &str,
    except_id: Option<&str>,
) -> Result<(String, String), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_NAME_EMPTY,
            "请填写名称",
        ));
    }
    if name.chars().count() > MAX_LINK_NAME_CHARS {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_NAME_TOO_LONG,
            format!("名称最长 {MAX_LINK_NAME_CHARS} 个字符"),
        ));
    }
    let url = validate_external_url(url)?;
    if list
        .iter()
        .any(|l| l.url == url && Some(l.id.as_str()) != except_id)
    {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_URL_DUPLICATE,
            "该网址已存在",
        ));
    }
    Ok((name, url))
}

/// 列出全部外部链接。
/// 外链导入/清理的**失败与拒绝**要留痕：`code=LINK_ACTION_REJECTED action=… reason=…`。
///
/// 一个码 + action/reason（同族多格共用一个码），与 `GROUP_ACTION_REJECTED` 同口径。
/// ⚠️ `clean_export/outside_export` 是**安全信号**（有人让本机删导出目录之外的文件）。
/// 纯输入校验（空网址/名字/上限）不在此列。
fn reject_link(s: &Arc<AppState>, action: &str, reason: &str, msg: &str) -> String {
    s.logger.warn(
        "links",
        format!("code=LINK_ACTION_REJECTED action={action} reason={reason}"),
    );
    msg.to_string()
}

#[tauri::command(async)]
pub async fn list_external_links(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ExternalLink>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<ExternalLink>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(parse_external_links(
            &db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| {
                crate::error_codes::coded(
                    crate::error_codes::LINK_LIST_READ_FAILED,
                    format!("读取外链列表失败: {e}"),
                )
            })?.unwrap_or_default(),
        ))
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_LIST_READ_FAILED,
            format!("外链列表读取被线程池中断: {e}"),
        )
    })?
}

/// 添加一条外部链接，返回更新后的完整列表。
#[tauri::command(async)]
pub async fn add_external_link(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    url: String,
) -> Result<Vec<ExternalLink>, String> {
    let s = state.inner().clone();
    // 读-改-写整段在一把 db 锁里（审计 R-18）；上限与规范化都留在这次持锁内，
    // 因为规范化判据要看**当前列表**（搬出来就是另一份读、另一个答案）。
    tokio::task::spawn_blocking(move || -> Result<Vec<ExternalLink>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut list =
            parse_external_links(&db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| {
                crate::error_codes::coded(
                    crate::error_codes::LINK_LIST_READ_FAILED,
                    format!("读取外链列表失败: {e}"),
                )
            })?.unwrap_or_default());
        if list.len() >= MAX_EXTERNAL_LINKS {
            return Err(crate::error_codes::coded(
                crate::error_codes::LINK_LIMIT_REACHED,
                format!("最多只能添加 {MAX_EXTERNAL_LINKS} 个链接"),
            ));
        }
        let (name, url) = normalize_link_input(&list, &name, &url, None)?;
        list.push(ExternalLink {
            id: Uuid::new_v4().to_string(),
            name,
            url,
        });
        db::set_setting(&dbc, EXTERNAL_LINKS_KEY, &encode_external_links(&list)).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_SAVE_FAILED,
                format!("保存失败: {e}"),
            )
        })?;
        Ok(list)
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_SAVE_FAILED,
            format!("外链写入被线程池中断: {e}"),
        )
    })?
}

/// 修改一条外部链接（按 `id` 匹配），返回更新后的完整列表。
#[tauri::command(async)]
pub async fn update_external_link(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    name: String,
    url: String,
) -> Result<Vec<ExternalLink>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<ExternalLink>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut list =
            parse_external_links(&db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| {
                crate::error_codes::coded(
                    crate::error_codes::LINK_LIST_READ_FAILED,
                    format!("读取外链列表失败: {e}"),
                )
            })?.unwrap_or_default());
        // 先算规范化值（不可变借用），再取可变引用落值 —— 否则 `list` 同时被借两次。
        let (name, url) = normalize_link_input(&list, &name, &url, Some(&id))?;
        let Some(target) = list.iter_mut().find(|l| l.id == id) else {
            return Err(crate::error_codes::coded(
                crate::error_codes::LINK_NOT_FOUND,
                "链接不存在",
            ));
        };
        target.name = name;
        target.url = url;
        db::set_setting(&dbc, EXTERNAL_LINKS_KEY, &encode_external_links(&list)).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_SAVE_FAILED,
                format!("保存失败: {e}"),
            )
        })?;
        Ok(list)
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_SAVE_FAILED,
            format!("外链写入被线程池中断: {e}"),
        )
    })?
}

/// 删除一条外部链接（按 `id` 匹配），返回更新后的完整列表。
#[tauri::command(async)]
pub async fn remove_external_link(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<ExternalLink>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<ExternalLink>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        let mut list =
            parse_external_links(&db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| {
                crate::error_codes::coded(
                    crate::error_codes::LINK_LIST_READ_FAILED,
                    format!("读取外链列表失败: {e}"),
                )
            })?.unwrap_or_default());
        let before = list.len();
        list.retain(|l| l.id != id);
        if list.len() != before {
            db::set_setting(&dbc, EXTERNAL_LINKS_KEY, &encode_external_links(&list))
                .map_err(|e| {
                    crate::error_codes::coded(
                        crate::error_codes::LINK_SAVE_FAILED,
                        format!("保存失败: {e}"),
                    )
                })?;
        }
        Ok(list)
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_SAVE_FAILED,
            format!("外链写入被线程池中断: {e}"),
        )
    })?
}

#[derive(Deserialize)]
struct ImportLink {
    name: String,
    url: String,
}

/// 兼容两种线上/文件格式：裸数组，或 `{ "links": [...] }`。
#[derive(Deserialize)]
#[serde(untagged)]
enum ImportPayload {
    List(Vec<ImportLink>),
    Wrapped { links: Vec<ImportLink> },
}

fn parse_import_payload(raw: &str) -> Result<Vec<ImportLink>, String> {
    let payload: ImportPayload =
        serde_json::from_str(raw).map_err(|_| {
            crate::error_codes::coded(
                crate::error_codes::LINK_IMPORT_JSON_INVALID,
                "JSON 格式不正确：需要链接数组或 { links: [...] }",
            )
        })?;
    Ok(match payload {
        ImportPayload::List(v) => v,
        ImportPayload::Wrapped { links } => links,
    })
}

/// 纯合并：按规范化后的 URL 去重，且**不覆盖已有条目的名字**（同名的旧行优先保留）。
///
/// 抽成纯函数是为了让「刷新」这条路径能被直接判：同一份旧列表 + 同一份新数据
/// 必须每次收敛到同一个结果，且旧行一条不丢。
fn merge_imported_links(
    mut list: Vec<ExternalLink>,
    inputs: Vec<ImportLink>,
) -> (Vec<ExternalLink>, usize, usize, usize) {
    let mut seen: HashSet<String> = list.iter().map(|l| l.url.clone()).collect();
    let mut added = 0usize;
    let mut skipped = 0usize;
    let mut invalid = 0usize;
    for input in inputs {
        let name = input.name.trim();
        let url = match validate_external_url(&input.url) {
            Ok(u) => u,
            Err(_) => {
                invalid += 1;
                continue;
            }
        };
        if name.is_empty() || name.chars().count() > MAX_LINK_NAME_CHARS {
            invalid += 1;
            continue;
        }
        if !seen.insert(url.clone()) || list.len() >= MAX_EXTERNAL_LINKS {
            skipped += 1;
            continue;
        }
        list.push(ExternalLink {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            url,
        });
        added += 1;
    }
    (list, added, skipped, invalid)
}

/// 导入 + 落库的**唯一核心**（连接级，便于用真实文件库判「重启后还在」）。
///
/// `source_url` 是这次导入用的网址：**解析成功就记下来**（哪怕 `added == 0`），
/// 因为"刷新按钮该拉哪里"取决于用户最后一次导入了哪份数据，与这次新增了几条无关。
/// 文件导入传 `None`，不会动掉之前记下的来源。
fn import_external_links_into(
    conn: &Connection,
    raw: &str,
    source_url: Option<&str>,
) -> Result<ExternalLinkImportResult, String> {
    if raw.len() > MAX_IMPORT_BYTES {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_TOO_LARGE,
            format!("导入内容超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024),
        ));
    }
    let inputs = parse_import_payload(raw)?;
    // 读失败在 `?` 处上抛，`unwrap_or_default` 只兜「从没存过」（与既有读路径同口径）。
    let stored = db::get_setting_checked(conn, EXTERNAL_LINKS_KEY).map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_LIST_READ_FAILED,
            format!("读取外链列表失败: {e}"),
        )
    })?;
    let existing = parse_external_links(&stored.unwrap_or_default());
    let (list, added, skipped, invalid) = merge_imported_links(existing, inputs);
    if added > 0 {
        db::set_setting(conn, EXTERNAL_LINKS_KEY, &encode_external_links(&list)).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_SAVE_FAILED,
                format!("保存失败: {e}"),
            )
        })?;
    }
    if let Some(url) = source_url {
        db::set_setting(conn, EXTERNAL_LINKS_SOURCE_KEY, url).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_SAVE_FAILED,
                format!("保存导入来源失败: {e}"),
            )
        })?;
    }
    Ok(ExternalLinkImportResult {
        links: list,
        added,
        skipped,
        invalid,
    })
}

/// 导入并合并（按规范化后的 URL 去重；不覆盖已有条目的名字）。
///
/// 入参从 `&State<'_, Arc<AppState>>` 改成 `&Arc<AppState>`：前者那个生命周期把它钉在
/// 一次 IPC 调用上，**没法搬进阻塞池**（`spawn_blocking` 要 `'static`）。
fn import_external_links_raw(
    s: &Arc<AppState>,
    raw: &str,
    source_url: Option<&str>,
) -> Result<ExternalLinkImportResult, String> {
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    import_external_links_into(&dbc, raw, source_url)
}

/// 读取最近一次「从网址导入」的来源；从没导入过 ⇒ `None`（界面不显示来源条与刷新键）。
#[tauri::command(async)]
pub async fn get_external_links_import_source(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::get_setting_checked(&dbc, EXTERNAL_LINKS_SOURCE_KEY).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_LIST_READ_FAILED,
                format!("读取导入来源失败: {e}"),
            )
        })
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_LIST_READ_FAILED,
            format!("导入来源读取被线程池中断: {e}"),
        )
    })?
}

/// 导出到缓存目录，返回**真实路径**；移动端随后交给系统保存对话框。
#[tauri::command(async)]
pub async fn export_external_links(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let s = state.inner().clone();
    // 建目录 + 序列化整份列表 + 写文件（还有中间那次 db 读）都在文件系统段里 ⇒ 进阻塞池。
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let dir = s.cache_dir.join("exports");
        std::fs::create_dir_all(&dir).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_EXPORT_FAILED,
                format!("创建导出目录失败：{e}"),
            )
        })?;
        let path = dir.join(format!("gosslan-links-{}.json", Uuid::new_v4()));
        let list = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            parse_external_links(&db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| {
                crate::error_codes::coded(
                    crate::error_codes::LINK_LIST_READ_FAILED,
                    format!("读取外链列表失败: {e}"),
                )
            })?.unwrap_or_default())
        };
        let json = serde_json::to_string_pretty(&list).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_EXPORT_FAILED,
                format!("序列化失败：{e}"),
            )
        })?;
        std::fs::write(&path, json).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_EXPORT_FAILED,
                format!("写入导出文件失败：{e}"),
            )
        })?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_EXPORT_FAILED,
            format!("外链导出被线程池中断: {e}"),
        )
    })?
}

/// 「这条路径是不是本命令生成的导出产物」——清理命令的安全闸（纯函数，便于判据盯着）。
///
/// ⚠️ 不能用 `Path::starts_with` 当安全闸：它按**路径分量词法**比较，
/// `cache/exports/../../x` 也会通过，随后 `remove_file` 会按 OS 语义解析 `..` 删到目录外。
/// 这里要求「父目录恰好是 exports」且「文件名确实是导出命令生成的那一形状」。
pub(crate) fn is_export_artifact_path(dir: &std::path::Path, path: &std::path::Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    path.parent().is_some_and(|parent| parent == dir)
        && name.starts_with("gosslan-links-")
        && name.ends_with(".json")
        && !name.contains("..")
}

/// 清理自己刚导出的临时文件（只允许删 `cache/exports` 下由本命令生成的路径）。
#[tauri::command(async)]
pub async fn cleanup_external_links_export(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<(), String> {
    let s = state.inner().clone();
    // 安全闸仍在删文件**之前**判（`is_export_artifact_path`），搬池子不改这个顺序。
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dir = s.cache_dir.join("exports");
        let p = std::path::PathBuf::from(path);
        if !is_export_artifact_path(&dir, &p) {
            return Err(crate::error_codes::coded(
                crate::error_codes::LINK_CLEAN_OUTSIDE_EXPORT,
                reject_link(&s, "clean_export", "outside_export", "拒绝清理导出目录之外的路径"),
            ));
        }
        match std::fs::remove_file(&p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(crate::error_codes::coded(
                crate::error_codes::LINK_CLEAN_FAILED,
                format!("清理导出文件失败：{e}"),
            )),
        }
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_CLEAN_FAILED,
            format!("导出临时文件清理被线程池中断: {e}"),
        )
    })?
}

/// 从本地 JSON 文件导入；`path` 由前端选择并已通过 `import_picked_file` 落地。
#[tauri::command(async)]
pub async fn import_external_links_file(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<ExternalLinkImportResult, String> {
    let s = state.inner().clone();
    // 上限预检（要 stat）+ 整份读入 + 合并写库都在文件/锁段里 ⇒ 进阻塞池（审计 R-18）。
    tokio::task::spawn_blocking(move || -> Result<ExternalLinkImportResult, String> {
        let meta = std::fs::metadata(&path).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_IMPORT_READ_FAILED,
                format!("读取导入文件失败：{e}"),
            )
        })?;
        if meta.len() > MAX_IMPORT_BYTES as u64 {
            return Err(crate::error_codes::coded(
                crate::error_codes::LINK_IMPORT_TOO_LARGE,
                format!("导入文件超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024),
            ));
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_IMPORT_READ_FAILED,
                format!("读取导入文件失败：{e}"),
            )
        })?;
        // 文件导入不改变「从网址导入」的来源（刷新按钮仍指向用户上次填的那个链接）。
        import_external_links_raw(&s, &raw, None)
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_POOL_FAILED,
            format!("外链导入被线程池中断: {e}"),
        )
    })?
}

/// 从 HTTPS/HTTP 链接拉取 JSON 导入（后端拉取，避免 WebView 的 CORS 限制）。
#[tauri::command(async)]
pub async fn import_external_links_from_url(
    state: tauri::State<'_, Arc<AppState>>,
    url: String,
) -> Result<ExternalLinkImportResult, String> {
    let url = validate_external_url(&url)?;
    // 下载阶段的失败也要留痕 ⇒ 这里就取一次 state（后面写库那段的同一个 `s` 沿用它）。
    let s = state.inner().clone();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_NETWORK_INIT_FAILED,
                format!("网络初始化失败：{e}"),
            )
        })?;
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_IMPORT_READ_FAILED,
                format!("下载失败：{e}"),
            )
        })?;
    if !resp.status().is_success() {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_DOWNLOAD_HTTP_FAILED,
            reject_link(&s, "import", "http_status", &format!("下载失败：HTTP {}", resp.status())),
        ));
    }
    if resp.content_length().unwrap_or(0) > MAX_IMPORT_BYTES as u64 {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_TOO_LARGE,
            reject_link(
                &s,
                "import",
                "too_large",
                &format!("下载内容超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024),
            ),
        ));
    }
    // 逐块收口：不能先 `bytes()` 再量大小 —— 没有 Content-Length 的服务端可以先把
    // 几个 GB 拉进内存，再被这一行拒绝。流式累计到上限立即中止。
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_READ_FAILED,
            format!("读取下载内容失败：{e}"),
        )
    })? {
        if bytes.len() + chunk.len() > MAX_IMPORT_BYTES {
            return Err(crate::error_codes::coded(
                crate::error_codes::LINK_IMPORT_TOO_LARGE,
                reject_link(
                    &s,
                    "import",
                    "too_large",
                    &format!("下载内容超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024),
                ),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let raw = String::from_utf8(bytes).map_err(|_| {
        crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_NOT_UTF8,
            "下载内容不是 UTF-8 文本",
        )
    })?;
    // 下载（await）留在 worker 之外的异步侧；合并写库那一段进阻塞池（审计 R-18）。
    // 来源网址与链接在同一个写库段落盘：刷新按钮读的就是它。
    tokio::task::spawn_blocking(move || -> Result<ExternalLinkImportResult, String> {
        import_external_links_raw(&s, &raw, Some(&url))
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_POOL_FAILED,
            format!("外链导入被线程池中断: {e}"),
        )
    })?
}

#[cfg(test)]
mod link_input_tests {
    use super::*;

    /// F-PRE-019：外链的**输入闸**是纯函数，全部形状都在这里钉住。
    ///
    /// 尤其 `javascript:` / `ftp:` 这类非 http(s) 一律拒 —— 这是防注入的第一道（界面里点开
    /// 外链会交给系统浏览器，scheme 不设限等于把任意协议丢给 OS）。
    #[test]
    fn url_validation_rejects_every_shape_the_ui_can_send() {
        for bad in [
            "",
            "   ",
            "ftp://example.com",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "http://",
        ] {
            assert!(
                validate_external_url(bad).is_err(),
                "这个形状必须被拒：{bad:?}"
            );
        }
        let ok = validate_external_url("  https://example.com/a?b=1  ").unwrap();
        assert!(ok.starts_with("https://example.com/"), "两端空白要被 trim：{ok}");
        assert!(
            validate_external_url("http://10.0.0.2:8080").is_ok(),
            "http 要允许（用户自己的内网服务）"
        );
    }

    #[test]
    fn normalize_rejects_bad_names_and_duplicate_urls_but_spares_self_on_edit() {
        let existing = vec![ExternalLink {
            id: "x1".into(),
            name: "旧".into(),
            url: "https://a.example/".into(),
        }];
        assert!(normalize_link_input(&existing, "  ", "https://b.example/", None).is_err());
        let long = "名".repeat(MAX_LINK_NAME_CHARS + 1);
        assert!(
            normalize_link_input(&existing, &long, "https://b.example/", None).is_err(),
            "超长名称必须拒（上限 {MAX_LINK_NAME_CHARS} 字）"
        );
        assert_eq!(
            normalize_link_input(&existing, "新", "https://a.example", None).unwrap_err(),
            crate::error_codes::coded(crate::error_codes::LINK_URL_DUPLICATE, "该网址已存在"),
            "规范化后的同一 URL 要算重复（少写尾斜杠也算）"
        );
        assert!(
            normalize_link_input(&existing, "新", "https://a.example", Some("x1")).is_ok(),
            "编辑自己那条不算重复"
        );
        let (name, url) =
            normalize_link_input(&existing, "  新名字  ", " https://b.example/x ", None).unwrap();
        assert_eq!(name, "新名字", "名称两端空白要 trim");
        assert!(url.starts_with("https://b.example/x"), "URL 也要规范化：{url}");
    }
}

#[cfg(test)]
mod import_source_tests {
    use super::*;

    /// 一份最小的真实文件库：用真实路径前后各开一次连接，模拟两个进程（`:memory:` 证不了重启）。
    fn with_db(name: &str, body: impl FnOnce(&Connection)) {
        let dir = std::env::temp_dir().join(format!("gosslan-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("links.db");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(crate::db::SCHEMA).unwrap();
            body(&conn);
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    fn source_of(conn: &Connection) -> Option<String> {
        db::get_setting_checked(conn, EXTERNAL_LINKS_SOURCE_KEY).unwrap()
    }

    fn links_of(conn: &Connection) -> Vec<ExternalLink> {
        let stored = db::get_setting_checked(conn, EXTERNAL_LINKS_KEY).expect("读取测试库外链失败");
        parse_external_links(&stored.unwrap_or_default())
    }

    /// 链接来源必须**固定保留**：导入一次后关掉连接再打开，来源与链接都还在；
    /// 再导入同一份数据（= 点刷新）不会把来源或旧行弄丢。
    #[test]
    fn imported_source_and_links_survive_a_process_restart() {
        let dir = std::env::temp_dir().join(format!("gosslan-links-restart-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("links.db");
        let _ = std::fs::remove_file(&path);
        let payload = r#"[{"name":"公司内网","url":"https://intra.example.com"}]"#;
        let source = "https://backup.example.com/links.json";
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(crate::db::SCHEMA).unwrap();
            let res = import_external_links_into(&conn, payload, Some(source)).unwrap();
            assert_eq!(res.added, 1);
            assert_eq!(source_of(&conn).as_deref(), Some(source));
        }
        // 第二个"进程"：同一路径重新打开。
        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(
                source_of(&conn).as_deref(),
                Some(source),
                "重启后来源链接必须还在（刷新按钮要按它拉数据）"
            );
            let links = links_of(&conn);
            assert_eq!(links.len(), 1, "重启后导入的链接也必须还在");
            assert!(links[0].url.contains("intra.example.com"));
            // 刷新 = 再导入同一份数据：不新增、不丢旧行、来源不变。
            let again = import_external_links_into(&conn, payload, Some(source)).unwrap();
            assert_eq!(again.added, 0);
            assert_eq!(again.skipped, 1);
            assert_eq!(links_of(&conn).len(), 1, "刷新不许清空上一次成功的数据");
            assert_eq!(source_of(&conn).as_deref(), Some(source));
        }
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }

    /// 只有用户主动换一个链接才改来源；文件导入（`None`）不许覆盖已有的来源。
    #[test]
    fn only_url_import_replaces_the_source() {
        with_db("links-source-replace", |conn| {
            import_external_links_into(conn, r#"[]"#, Some("https://a.example/list.json")).unwrap();
            assert_eq!(source_of(conn).as_deref(), Some("https://a.example/list.json"));
            import_external_links_into(conn, r#"[]"#, None).unwrap();
            assert_eq!(
                source_of(conn).as_deref(),
                Some("https://a.example/list.json"),
                "文件导入 / 解析失败都不许把来源清掉"
            );
            import_external_links_into(conn, r#"[]"#, Some("https://b.example/list.json")).unwrap();
            assert_eq!(
                source_of(conn).as_deref(),
                Some("https://b.example/list.json"),
                "主动换链接才改来源"
            );
        });
    }

    /// 合并口径：同 URL 的旧行名字不被新数据覆盖，脏数据只计数、不落库。
    #[test]
    fn merge_keeps_existing_rows_and_skips_bad_input() {
        let existing = vec![ExternalLink {
            id: "keep".into(),
            name: "旧名字".into(),
            url: "https://a.example/".into(),
        }];
        let inputs = vec![
            ImportLink {
                name: "新名字".into(),
                url: "https://a.example".into(),
            },
            ImportLink {
                name: "新增".into(),
                url: "https://b.example".into(),
            },
            ImportLink {
                name: "".into(),
                url: "https://c.example".into(),
            },
            ImportLink {
                name: "协议不对".into(),
                url: "javascript:alert(1)".into(),
            },
        ];
        let (list, added, skipped, invalid) = merge_imported_links(existing, inputs);
        assert_eq!((added, skipped, invalid), (1, 1, 2));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "旧名字", "已有条目的名字不许被覆盖");
    }

    /// 解析失败必须**原样不动**：旧链接与来源都留在库里，界面才能继续显示上一次成功的数据。
    #[test]
    fn invalid_payload_leaves_links_and_source_untouched() {
        with_db("links-invalid-payload", |conn| {
            import_external_links_into(
                conn,
                r#"[{"name":"旧","url":"https://old.example"}]"#,
                Some("https://src.example/list.json"),
            )
            .unwrap();
            let err = import_external_links_into(conn, "<html>not json</html>", Some("https://src.example/list.json"))
                .unwrap_err();
            assert!(err.contains(crate::error_codes::LINK_IMPORT_JSON_INVALID), "{err}");
            assert_eq!(links_of(conn).len(), 1, "失败不许清空旧数据");
            assert_eq!(source_of(conn).as_deref(), Some("https://src.example/list.json"));
        });
    }
}
