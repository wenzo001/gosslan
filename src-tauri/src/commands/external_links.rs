// 职责边界：
// - 外链管理（add/remove/list_link、validate_external_url）
// ---------------- 外部链接（左栏「链接」视图 → 点开在独立窗口加载） ----------------

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
        return Err("网址不能为空".to_string());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "网址格式不正确".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("网址必须以 http:// 或 https:// 开头".to_string());
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err("网址缺少主机名".to_string());
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
        return Err("请填写名称".to_string());
    }
    if name.chars().count() > MAX_LINK_NAME_CHARS {
        return Err(format!("名称最长 {MAX_LINK_NAME_CHARS} 个字符"));
    }
    let url = validate_external_url(url)?;
    if list
        .iter()
        .any(|l| l.url == url && Some(l.id.as_str()) != except_id)
    {
        return Err("该网址已存在".to_string());
    }
    Ok((name, url))
}

/// 列出全部外部链接。
#[tauri::command(async)]
pub async fn list_external_links(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ExternalLink>, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<ExternalLink>, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        Ok(parse_external_links(
            &db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| format!("读取外链列表失败: {e}"))?.unwrap_or_default(),
        ))
    })
    .await
    .map_err(|e| format!("外链列表读取被线程池中断: {e}"))?
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
            parse_external_links(&db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| format!("读取外链列表失败: {e}"))?.unwrap_or_default());
        if list.len() >= MAX_EXTERNAL_LINKS {
            return Err(format!("最多只能添加 {MAX_EXTERNAL_LINKS} 个链接"));
        }
        let (name, url) = normalize_link_input(&list, &name, &url, None)?;
        list.push(ExternalLink {
            id: Uuid::new_v4().to_string(),
            name,
            url,
        });
        db::set_setting(&dbc, EXTERNAL_LINKS_KEY, &encode_external_links(&list))
            .map_err(|e| format!("保存失败: {e}"))?;
        Ok(list)
    })
    .await
    .map_err(|e| format!("外链写入被线程池中断: {e}"))?
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
            parse_external_links(&db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| format!("读取外链列表失败: {e}"))?.unwrap_or_default());
        // 先算规范化值（不可变借用），再取可变引用落值 —— 否则 `list` 同时被借两次。
        let (name, url) = normalize_link_input(&list, &name, &url, Some(&id))?;
        let Some(target) = list.iter_mut().find(|l| l.id == id) else {
            return Err("链接不存在".to_string());
        };
        target.name = name;
        target.url = url;
        db::set_setting(&dbc, EXTERNAL_LINKS_KEY, &encode_external_links(&list))
            .map_err(|e| format!("保存失败: {e}"))?;
        Ok(list)
    })
    .await
    .map_err(|e| format!("外链写入被线程池中断: {e}"))?
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
            parse_external_links(&db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| format!("读取外链列表失败: {e}"))?.unwrap_or_default());
        let before = list.len();
        list.retain(|l| l.id != id);
        if list.len() != before {
            db::set_setting(&dbc, EXTERNAL_LINKS_KEY, &encode_external_links(&list))
                .map_err(|e| format!("保存失败: {e}"))?;
        }
        Ok(list)
    })
    .await
    .map_err(|e| format!("外链写入被线程池中断: {e}"))?
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
        serde_json::from_str(raw).map_err(|_| "JSON 格式不正确：需要链接数组或 { links: [...] }".to_string())?;
    Ok(match payload {
        ImportPayload::List(v) => v,
        ImportPayload::Wrapped { links } => links,
    })
}

/// 导入并合并（按规范化后的 URL 去重；不覆盖已有条目的名字）。
///
/// 入参从 `&State<'_, Arc<AppState>>` 改成 `&Arc<AppState>`：前者那个生命周期把它钉在
/// 一次 IPC 调用上，**没法搬进阻塞池**（`spawn_blocking` 要 `'static`）。
fn import_external_links_raw(
    s: &Arc<AppState>,
    raw: &str,
) -> Result<ExternalLinkImportResult, String> {
    if raw.len() > MAX_IMPORT_BYTES {
        return Err(format!("导入内容超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024));
    }
    let inputs = parse_import_payload(raw)?;
    let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
    let mut list =
        parse_external_links(&db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| format!("读取外链列表失败: {e}"))?.unwrap_or_default());
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
    if added > 0 {
        db::set_setting(&dbc, EXTERNAL_LINKS_KEY, &encode_external_links(&list))
            .map_err(|e| format!("保存失败: {e}"))?;
    }
    Ok(ExternalLinkImportResult {
        links: list,
        added,
        skipped,
        invalid,
    })
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
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败：{e}"))?;
        let path = dir.join(format!("gosslan-links-{}.json", Uuid::new_v4()));
        let list = {
            let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
            parse_external_links(&db::get_setting_checked(&dbc, EXTERNAL_LINKS_KEY).map_err(|e| format!("读取外链列表失败: {e}"))?.unwrap_or_default())
        };
        let json = serde_json::to_string_pretty(&list).map_err(|e| format!("序列化失败：{e}"))?;
        std::fs::write(&path, json).map_err(|e| format!("写入导出文件失败：{e}"))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("外链导出被线程池中断: {e}"))?
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
            return Err("拒绝清理导出目录之外的路径".to_string());
        }
        match std::fs::remove_file(&p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("清理导出文件失败：{e}")),
        }
    })
    .await
    .map_err(|e| format!("导出临时文件清理被线程池中断: {e}"))?
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
        let meta = std::fs::metadata(&path).map_err(|e| format!("读取导入文件失败：{e}"))?;
        if meta.len() > MAX_IMPORT_BYTES as u64 {
            return Err(format!("导入文件超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024));
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| format!("读取导入文件失败：{e}"))?;
        import_external_links_raw(&s, &raw)
    })
    .await
    .map_err(|e| format!("外链导入被线程池中断: {e}"))?
}

/// 从 HTTPS/HTTP 链接拉取 JSON 导入（后端拉取，避免 WebView 的 CORS 限制）。
#[tauri::command(async)]
pub async fn import_external_links_from_url(
    state: tauri::State<'_, Arc<AppState>>,
    url: String,
) -> Result<ExternalLinkImportResult, String> {
    let url = validate_external_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| format!("网络初始化失败：{e}"))?;
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    if resp.content_length().unwrap_or(0) > MAX_IMPORT_BYTES as u64 {
        return Err(format!("下载内容超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024));
    }
    // 逐块收口：不能先 `bytes()` 再量大小 —— 没有 Content-Length 的服务端可以先把
    // 几个 GB 拉进内存，再被这一行拒绝。流式累计到上限立即中止。
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取下载内容失败：{e}"))? {
        if bytes.len() + chunk.len() > MAX_IMPORT_BYTES {
            return Err(format!("下载内容超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024));
        }
        bytes.extend_from_slice(&chunk);
    }
    let raw = String::from_utf8(bytes).map_err(|_| "下载内容不是 UTF-8 文本".to_string())?;
    // 下载（await）留在 worker 之外的异步侧；合并写库那一段进阻塞池（审计 R-18）。
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<ExternalLinkImportResult, String> {
        import_external_links_raw(&s, &raw)
    })
    .await
    .map_err(|e| format!("外链导入被线程池中断: {e}"))?
}
