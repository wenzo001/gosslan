// 职责边界：
// - 外链管理（add/remove/list_link、validate_external_url）
// ---------------- 外部链接（左栏「链接」视图 → 点开在独立窗口加载） ----------------

use rusqlite::Connection;
use std::collections::HashSet;

/// 一条用户配置的外部链接。
///
/// 字段分侧（同步语义的唯一依据，改字段前先读这里）：
/// - 远程字段：`name`、`url` —— 刷新 / JSON 快照可以覆盖；
/// - 本地字段：`id`、`source` —— 任何导入都不改 `id`，`source` 只按来源规则迁移；
/// - 同步簿记：`remote_url` —— 远程身份。用户手改了 `url` 之后，刷新仍按远程身份
///   找到同一条并还原远程 URL，**不派生新条目**（用户 2026-11-05 的 A 条）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLink {
    /// 稳定主键：改名字/改网址都按它匹配，不会跟丢。
    pub id: String,
    pub name: String,
    pub url: String,
    /// 来源：`user` / `url:<来源网址>` / `json:<文件名>`。
    /// 旧数据没有这个字段 ⇒ 空串（未定），读取与展示一律按 `user` 保守保护，绝不删。
    #[serde(default)]
    pub source: String,
    /// 上一次从远程拿到的 URL（远程身份）。用户改 `url` 后靠它找回原条目；
    /// `user` 条目没有远程身份，留空。
    #[serde(default)]
    pub remote_url: String,
}

/// 一条将要新增 / 更新 / 删除的链接（预览清单用）。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLinkChange {
    pub name: String,
    pub url: String,
    pub source: String,
}

/// JSON 导入预览：只看不写。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLinkImportPreview {
    pub added: Vec<ExternalLinkChange>,
    pub updated: Vec<ExternalLinkChange>,
    pub removed: Vec<ExternalLinkChange>,
    pub skipped: usize,
    pub invalid: usize,
    pub unchanged: usize,
}

/// 导入结果：`links` 是导入后的完整列表，其余数字只为界面说清“发生了什么”。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalLinkImportResult {
    pub links: Vec<ExternalLink>,
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub skipped: usize,
    pub invalid: usize,
    pub unchanged: usize,
}

const EXTERNAL_LINKS_KEY: &str = "external_links";
/// 注入锚点（`scripts/guard_cases/desktop_misc.py` 的「主线程守卫」把一条合成违规命令插在这行之前）。
///
/// 必须永久留在模块层：钉在真实命令上时，那条命令哪天被搬进阻塞池，锚点就会跟着消失，
/// 守卫从此查不到东西 —— 不是变绿，而是**静默空转**。本文件重写同步语义时曾因此让
/// `verify-guards.py --list` 报红一次（2026-11-05），所以锚点改成不依附任何业务函数。
///
/// 来源标记：用户手动添加（以及旧数据的保守归属）。
const SOURCE_USER: &str = "user";
/// 来源前缀：从某个网址导入。
const SOURCE_URL_PREFIX: &str = "url:";
/// 来源前缀：从某个 JSON 文件导入。
const SOURCE_JSON_PREFIX: &str = "json:";
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

fn url_source(source_url: &str) -> String {
    format!("{SOURCE_URL_PREFIX}{source_url}")
}

fn json_source(file_label: &str) -> String {
    format!("{SOURCE_JSON_PREFIX}{file_label}")
}

/// 受保护来源：`user` 与旧数据（空串）。任何导入都不得修改或删除它们。
///
/// 这是规则 3 的唯一判据 —— 放宽成「非空即非 user」或删掉空串这一支，
/// `import_source_tests` 里两条反例自证会直接变红。
fn is_protected_source(source: &str) -> bool {
    source.is_empty() || source == SOURCE_USER
}

/// 远程身份：优先用上一次同步记下的 `remoteUrl`，老数据没有就退回当前 `url`。
fn link_identity(link: &ExternalLink) -> &str {
    if link.remote_url.is_empty() {
        &link.url
    } else {
        &link.remote_url
    }
}

fn change_of(link: &ExternalLink) -> ExternalLinkChange {
    ExternalLinkChange {
        name: link.name.clone(),
        url: link.url.clone(),
        source: link.source.clone(),
    }
}

fn load_links(conn: &Connection) -> Result<Vec<ExternalLink>, String> {
    let stored = db::get_setting_checked(conn, EXTERNAL_LINKS_KEY).map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_LIST_READ_FAILED,
            format!("读取外链列表失败: {e}"),
        )
    })?;
    Ok(parse_external_links(&stored.unwrap_or_default()))
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
            source: SOURCE_USER.to_string(),
            remote_url: String::new(),
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
    /// 备份文件可能带来源：只有显式 `user` 会被保留为用户条目（保护它们不被下一次
    /// 文件导入删掉）；其它值一律按“本次文件导入”处理。
    #[serde(default)]
    source: String,
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

#[derive(Clone, Copy)]
enum PlanMode<'a> {
    /// 刷新 / 从网址导入：只加、只改，**绝不删**。
    UrlSync(&'a str),
    /// JSON 文件导入：权威快照，只删「非 user 且不在文件里」的条目。
    JsonSnapshot(&'a str),
}

struct PlanOutcome {
    list: Vec<ExternalLink>,
    added: Vec<ExternalLinkChange>,
    updated: Vec<ExternalLinkChange>,
    removed: Vec<ExternalLinkChange>,
    skipped: usize,
    invalid: usize,
    unchanged: usize,
}

/// 纯计算：把一份输入套到现有列表上，不碰数据库。
///
/// 两条路径共用同一份匹配逻辑，差别只在：
/// - `UrlSync`：只更新「同来源」或可迁移的旧数据；本地多出来的一律保留；
/// - `JsonSnapshot`：更新所有非 user 条目，并在最后删掉「非 user 且不在文件里」的条目。
///
/// 匹配顺序：远程身份（`remoteUrl`）→ 同来源的当前 URL → 旧数据当前 URL。
/// 因此用户手改了 `url:` 条目的 URL 后，刷新仍会按远程身份找回同一条并还原。
fn plan_import(
    mut list: Vec<ExternalLink>,
    inputs: Vec<ImportLink>,
    mode: PlanMode<'_>,
) -> PlanOutcome {
    let mut added = Vec::new();
    let mut updated = Vec::new();
    let mut removed = Vec::new();
    let mut skipped = 0usize;
    let mut invalid = 0usize;
    let mut unchanged = 0usize;
    let mut seen: HashSet<String> = HashSet::new();
    let mut present: HashSet<String> = HashSet::new();

    for input in inputs {
        let name = input.name.trim();
        let url = match validate_external_url(&input.url) {
            Ok(u) => u,
            Err(_) => {
                invalid += 1;
                continue;
            }
        };
        // 先登记「文件里出现过这个 URL」再去校验名称：否则一条名称不合法但 URL 存在的
        // 记录会保护不了本地同 URL 条目，快照删除时会把用户数据误删。
        present.insert(url.clone());
        if name.is_empty() || name.chars().count() > MAX_LINK_NAME_CHARS {
            invalid += 1;
            continue;
        }
        if !seen.insert(url.clone()) {
            skipped += 1;
            continue;
        }

        let target_source = match mode {
            PlanMode::UrlSync(source_url) => url_source(source_url),
            PlanMode::JsonSnapshot(file_label) => {
                if input.source == SOURCE_USER {
                    SOURCE_USER.to_string()
                } else {
                    json_source(file_label)
                }
            }
        };

        let matched = match mode {
            PlanMode::UrlSync(source_url) => {
                let want = url_source(source_url);
                list.iter()
                    .position(|l| l.source == want && link_identity(l) == url)
                    .or_else(|| list.iter().position(|l| l.source == want && l.url == url))
                    .or_else(|| list.iter().position(|l| l.source.is_empty() && l.url == url))
            }
            PlanMode::JsonSnapshot(_) => list.iter().position(|l| link_identity(l) == url),
        };

        if let Some(i) = matched {
            // user 条目永不因任何导入被改；旧数据（空来源）在 URL 同步里允许迁移到当前来源，
            // 但在 JSON 快照里按 user 保护（规则 1：归不了当前来源的标 user、绝不删）。
            let protected = match mode {
                PlanMode::UrlSync(_) => list[i].source == SOURCE_USER,
                PlanMode::JsonSnapshot(_) => is_protected_source(&list[i].source),
            };
            if protected || target_source == SOURCE_USER {
                skipped += 1;
                continue;
            }
            // 身份命中但新 URL 已被另一条占用 ⇒ 按「同 URL 不同来源去重」，不制造重复。
            if list.iter().enumerate().any(|(j, l)| j != i && l.url == url) {
                skipped += 1;
                continue;
            }
            let migrate = list[i].source.is_empty();
            let changed = list[i].name != name
                || list[i].url != url
                || link_identity(&list[i]) != url
                || migrate;
            if migrate {
                list[i].source = target_source;
            }
            list[i].name = name.to_string();
            list[i].url = url.clone();
            list[i].remote_url = url;
            if changed {
                updated.push(change_of(&list[i]));
            } else {
                unchanged += 1;
            }
            continue;
        }

        // 同 URL 已有别的来源 ⇒ 不碰它、也不新增重复。
        if list.iter().any(|l| l.url == url) {
            skipped += 1;
            continue;
        }
        if list.len() >= MAX_EXTERNAL_LINKS {
            skipped += 1;
            continue;
        }
        let link = ExternalLink {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            url: url.clone(),
            source: target_source,
            remote_url: url,
        };
        added.push(change_of(&link));
        list.push(link);
    }

    if matches!(mode, PlanMode::JsonSnapshot(_)) {
        let mut kept = Vec::with_capacity(list.len());
        for link in list {
            if !is_protected_source(&link.source) && !present.contains(link_identity(&link)) {
                removed.push(change_of(&link));
                continue;
            }
            kept.push(link);
        }
        list = kept;
    }

    PlanOutcome {
        list,
        added,
        updated,
        removed,
        skipped,
        invalid,
        unchanged,
    }
}

fn read_payload(
    conn: &Connection,
    raw: &str,
) -> Result<(Vec<ExternalLink>, Vec<ImportLink>), String> {
    if raw.len() > MAX_IMPORT_BYTES {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_TOO_LARGE,
            format!("导入内容超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024),
        ));
    }
    let inputs = parse_import_payload(raw)?;
    let existing = load_links(conn)?;
    Ok((existing, inputs))
}

/// 一次事务里把整份列表（以及可能的来源）落库：任何一步失败都整体回滚，
/// 不会留下「链接写了、来源没写」的半套状态。
fn apply_outcome(
    conn: &Connection,
    before: &[ExternalLink],
    outcome: PlanOutcome,
    source_write: Option<&str>,
) -> Result<ExternalLinkImportResult, String> {
    let tx = conn.unchecked_transaction().map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_SAVE_FAILED,
            format!("开启导入事务失败: {e}"),
        )
    })?;
    if outcome.list != before {
        db::set_setting(&tx, EXTERNAL_LINKS_KEY, &encode_external_links(&outcome.list)).map_err(
            |e| {
                crate::error_codes::coded(
                    crate::error_codes::LINK_SAVE_FAILED,
                    format!("保存失败: {e}"),
                )
            },
        )?;
    }
    if let Some(url) = source_write {
        db::set_setting(&tx, EXTERNAL_LINKS_SOURCE_KEY, url).map_err(|e| {
            crate::error_codes::coded(
                crate::error_codes::LINK_SAVE_FAILED,
                format!("保存导入来源失败: {e}"),
            )
        })?;
    }
    tx.commit().map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_SAVE_FAILED,
            format!("提交导入事务失败: {e}"),
        )
    })?;
    Ok(ExternalLinkImportResult {
        links: outcome.list,
        added: outcome.added.len(),
        updated: outcome.updated.len(),
        removed: outcome.removed.len(),
        skipped: outcome.skipped,
        invalid: outcome.invalid,
        unchanged: outcome.unchanged,
    })
}

/// 刷新 / 从网址导入的连接级核心（真实临时库测试直接调它）。
fn import_external_links_into(
    conn: &Connection,
    raw: &str,
    source_url: &str,
) -> Result<ExternalLinkImportResult, String> {
    let (existing, inputs) = read_payload(conn, raw)?;
    let before = existing.clone();
    let outcome = plan_import(existing, inputs, PlanMode::UrlSync(source_url));
    apply_outcome(conn, &before, outcome, Some(source_url))
}

/// JSON 文件导入的连接级核心。`file_label` 写进来源标记（`json:<文件名>`）。
fn import_external_links_file_into(
    conn: &Connection,
    raw: &str,
    file_label: &str,
) -> Result<ExternalLinkImportResult, String> {
    let (existing, inputs) = read_payload(conn, raw)?;
    let before = existing.clone();
    let outcome = plan_import(existing, inputs, PlanMode::JsonSnapshot(file_label));
    apply_outcome(conn, &before, outcome, None)
}

/// JSON 导入预览的连接级核心：只算不写。
fn preview_external_links_into(
    conn: &Connection,
    raw: &str,
    file_label: &str,
) -> Result<ExternalLinkImportPreview, String> {
    let (existing, inputs) = read_payload(conn, raw)?;
    let outcome = plan_import(existing, inputs, PlanMode::JsonSnapshot(file_label));
    Ok(ExternalLinkImportPreview {
        added: outcome.added,
        updated: outcome.updated,
        removed: outcome.removed,
        skipped: outcome.skipped,
        invalid: outcome.invalid,
        unchanged: outcome.unchanged,
    })
}

/// 读 JSON 文件：大小、UTF-8、文件系统错误都在落库之前判掉。
fn read_import_file(path: &str) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_READ_FAILED,
            format!("读取导入文件失败: {e}"),
        )
    })?;
    if meta.len() > MAX_IMPORT_BYTES as u64 {
        return Err(crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_TOO_LARGE,
            format!("导入文件超过 {} KiB 上限", MAX_IMPORT_BYTES / 1024),
        ));
    }
    std::fs::read_to_string(path).map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_READ_FAILED,
            format!("读取导入文件失败: {e}"),
        )
    })
}

fn import_file_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("links.json")
        .to_string()
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

/// JSON 导入预览：只读文件并算「将新增 / 更新 / 删除」，不写库。
///
/// 删除只发生在 `import_external_links_file`（用户确认之后），预览命令永远零写入。
#[tauri::command(async)]
pub async fn preview_external_links_file(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<ExternalLinkImportPreview, String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<ExternalLinkImportPreview, String> {
        let raw = read_import_file(&path)?;
        let label = import_file_label(&path);
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        preview_external_links_into(&dbc, &raw, &label)
    })
    .await
    .map_err(|e| {
        crate::error_codes::coded(
            crate::error_codes::LINK_IMPORT_POOL_FAILED,
            format!("外链导入预览被线程池中断: {e}"),
        )
    })?
}

/// 从本地 JSON 文件导入（权威快照）；`path` 由前端选择并已通过 `import_picked_file` 落地。
///
/// 前端必须先调 `preview_external_links_file` 并把结果给用户确认；这个命令本身不再
/// 二次弹窗 —— 删除边界全在 `plan_import` 里（user / 旧数据永不删）。
#[tauri::command(async)]
pub async fn import_external_links_file(
    state: tauri::State<'_, Arc<AppState>>,
    path: String,
) -> Result<ExternalLinkImportResult, String> {
    let s = state.inner().clone();
    // 上限预检（要 stat）+ 整份读入 + 合并写库都在文件/锁段里 ⇒ 进阻塞池（审计 R-18）。
    tokio::task::spawn_blocking(move || -> Result<ExternalLinkImportResult, String> {
        let raw = read_import_file(&path)?;
        let label = import_file_label(&path);
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        // 文件导入不改变「从网址导入」的来源（刷新按钮仍指向用户上次填的那个链接）。
        import_external_links_file_into(&dbc, &raw, &label)
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
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        import_external_links_into(&dbc, &raw, &url)
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
            source: SOURCE_USER.into(),
            remote_url: String::new(),
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
    use std::path::{Path, PathBuf};

    fn db_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("gosslan-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("links.db");
        let _ = std::fs::remove_file(&path);
        path
    }

    fn open_with_schema(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(crate::db::SCHEMA).unwrap();
        conn
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_file(path);
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    }

    /// 一份最小的真实文件库：用真实路径前后各开一次连接，模拟两个进程（`:memory:` 证不了重启）。
    fn with_db(name: &str, body: impl FnOnce(&Connection)) {
        let path = db_path(name);
        {
            let conn = open_with_schema(&path);
            body(&conn);
        }
        cleanup(&path);
    }

    fn source_of(conn: &Connection) -> Option<String> {
        db::get_setting_checked(conn, EXTERNAL_LINKS_SOURCE_KEY).unwrap()
    }

    fn links_of(conn: &Connection) -> Vec<ExternalLink> {
        let stored = db::get_setting_checked(conn, EXTERNAL_LINKS_KEY).expect("读取测试库外链失败");
        parse_external_links(&stored.unwrap_or_default())
    }

    fn seed(conn: &Connection, links: Vec<ExternalLink>) {
        db::set_setting(conn, EXTERNAL_LINKS_KEY, &encode_external_links(&links)).unwrap();
    }

    fn entry(id: &str, name: &str, url: &str, source: &str, remote_url: &str) -> ExternalLink {
        ExternalLink {
            id: id.into(),
            name: name.into(),
            url: url.into(),
            source: source.into(),
            remote_url: remote_url.into(),
        }
    }

    fn user(id: &str, name: &str, url: &str) -> ExternalLink {
        entry(id, name, url, SOURCE_USER, "")
    }

    fn same_source(id: &str, name: &str, url: &str, source_url: &str) -> ExternalLink {
        entry(id, name, url, &url_source(source_url), url)
    }

    fn find<'a>(list: &'a [ExternalLink], url: &str) -> &'a ExternalLink {
        list.iter()
            .find(|l| l.url == url)
            .unwrap_or_else(|| panic!("列表里找不到 {url}：{list:?}"))
    }

    const SOURCE_A: &str = "https://a.example/links.json";
    const SOURCE_B: &str = "https://b.example/links.json";

    /// 规则 1：旧数据没有 `source`。能归到当前来源的归过去；归不了的保留并按 user 保护。
    #[test]
    fn legacy_rows_are_migrated_only_when_the_current_source_confirms_them() {
        let path = db_path("links-legacy-migrate");
        {
            let conn = open_with_schema(&path);
            seed(
                &conn,
                vec![
                    entry("old-1", "旧名", "https://keep.example/x", "", ""),
                    entry("old-2", "旧名2", "https://orphan.example/y", "", ""),
                ],
            );
        }
        {
            let conn = open_with_schema(&path);
            let payload = r#"[
                {"name":"远程新名","url":"https://keep.example/x"},
                {"name":"新增","url":"https://new.example/z"}
            ]"#;
            let res = import_external_links_into(&conn, payload, SOURCE_A).unwrap();
            assert_eq!(res.added, 1);
            assert_eq!(res.updated, 1, "被远程确认的旧条目要算一次更新（含来源迁移）");

            let links = links_of(&conn);
            let keep = find(&links, "https://keep.example/x");
            assert_eq!(keep.id, "old-1", "迁移只改来源/远程字段，主键不变");
            assert_eq!(keep.source, url_source(SOURCE_A), "能归的要归到当前来源");
            assert_eq!(keep.name, "远程新名");
            assert_eq!(keep.remote_url, "https://keep.example/x");

            let orphan = find(&links, "https://orphan.example/y");
            assert_eq!(orphan.source, "", "归不了的旧数据保持未定，读取时按 user 保护");
            assert_eq!(orphan.name, "旧名2", "归不了的旧数据不许被刷新改动");

            assert_eq!(find(&links, "https://new.example/z").source, url_source(SOURCE_A));
        }
        cleanup(&path);
    }

    /// 规则 2：刷新只加/改，绝不删；同来源覆盖，其它来源一律不碰。
    #[test]
    fn refresh_adds_and_updates_but_never_deletes() {
        with_db("links-refresh-add-update", |conn| {
            seed(
                conn,
                vec![
                    user("u", "用户条目", "https://user.example/x"),
                    same_source("k", "本地保留", "https://keep.example/k", SOURCE_A),
                    same_source("r", "旧名字", "https://remote.example/r", SOURCE_A),
                    entry("j", "文件条目", "https://json.example/j", "json:old.json", ""),
                ],
            );
            let payload = r#"[
                {"name":"远程新名字","url":"https://remote.example/r"},
                {"name":"新增","url":"https://add.example/n"},
                {"name":"碰用户","url":"https://user.example/x"}
            ]"#;
            let res = import_external_links_into(conn, payload, SOURCE_A).unwrap();
            assert_eq!(res.added, 1);
            assert_eq!(res.updated, 1);
            assert_eq!(res.removed, 0, "刷新永远不删");
            assert_eq!(res.skipped, 1, "同 URL 的用户条目占位 ⇒ 跳过、不新增重复");

            let links = links_of(conn);
            assert_eq!(links.len(), 5, "本地多出的 / 其它来源的条目一条都不许丢");
            assert_eq!(find(&links, "https://remote.example/r").name, "远程新名字");
            assert_eq!(find(&links, "https://remote.example/r").source, url_source(SOURCE_A));
            assert_eq!(
                find(&links, "https://user.example/x").name,
                "用户条目",
                "user 条目不许被刷新改写"
            );
            assert_eq!(find(&links, "https://keep.example/k").name, "本地保留");
            assert_eq!(find(&links, "https://json.example/j").source, "json:old.json");
            assert_eq!(find(&links, "https://add.example/n").source, url_source(SOURCE_A));
        });
    }

    /// 规则 A：用户改了 `url:` 条目的 URL 本身，刷新按远程身份还原，不派生新条目。
    #[test]
    fn user_edited_url_is_restored_by_remote_identity_without_deriving_a_new_row() {
        with_db("links-edited-url-restore", |conn| {
            seed(
                conn,
                vec![entry(
                    "edited",
                    "用户改过名字",
                    "https://local-edited.example/y",
                    &url_source(SOURCE_A),
                    "https://remote.example/x",
                )],
            );
            let payload = r#"[{"name":"远程名字","url":"https://remote.example/x"}]"#;
            let res = import_external_links_into(conn, payload, SOURCE_A).unwrap();
            assert_eq!(res.added, 0, "必须按远程身份找回原条目，不许新增");
            assert_eq!(res.updated, 1);

            let links = links_of(conn);
            assert_eq!(links.len(), 1, "不派生新条目");
            assert_eq!(links[0].id, "edited", "主键不变");
            assert_eq!(links[0].url, "https://remote.example/x", "改动的 URL 被还原");
            assert_eq!(links[0].name, "远程名字");
        });
    }

    /// 规则 5 / B：换来源后旧 `url:` 条目保留、标旧来源；换回同一来源仍可同步。
    #[test]
    fn switching_source_keeps_old_rows_and_switching_back_still_syncs_them() {
        with_db("links-switch-source", |conn| {
            import_external_links_into(
                conn,
                r#"[{"name":"A 的名字","url":"https://same.example/x"}]"#,
                SOURCE_A,
            )
            .unwrap();
            assert_eq!(source_of(conn).as_deref(), Some(SOURCE_A));
            assert_eq!(links_of(conn)[0].source, url_source(SOURCE_A));

            // 换到 B，同一 URL 不新增重复、不碰 A 的旧条目。
            let res = import_external_links_into(
                conn,
                r#"[{"name":"B 的名字","url":"https://same.example/x"}]"#,
                SOURCE_B,
            )
            .unwrap();
            assert_eq!(res.added, 0);
            assert_eq!(res.removed, 0, "换来源不许自动删");
            assert_eq!(links_of(conn).len(), 1);
            assert_eq!(links_of(conn)[0].source, url_source(SOURCE_A), "旧来源标记保留");
            assert_eq!(links_of(conn)[0].name, "A 的名字", "旧来源条目不再被 B 同步");
            assert_eq!(source_of(conn).as_deref(), Some(SOURCE_B));

            // 换回 A：旧条目重新成为当前来源，可以继续同步。
            let res = import_external_links_into(
                conn,
                r#"[{"name":"A 新名字","url":"https://same.example/x"}]"#,
                SOURCE_A,
            )
            .unwrap();
            assert_eq!(res.updated, 1);
            assert_eq!(links_of(conn)[0].name, "A 新名字");
            assert_eq!(source_of(conn).as_deref(), Some(SOURCE_A));
        });
    }

    /// 规则 2 + 矩阵 7：同 URL 不同来源去重，先到者保留。
    #[test]
    fn same_url_with_different_source_is_deduped() {
        with_db("links-same-url-dedupe", |conn| {
            seed(conn, vec![user("u", "用户加的名字", "https://same.example/x")]);
            let res = import_external_links_into(
                conn,
                r#"[
                    {"name":"远程名字","url":"https://same.example/x"},
                    {"name":"远程新增","url":"https://a.example/y"}
                ]"#,
                SOURCE_A,
            )
            .unwrap();
            assert_eq!(res.added, 1, "只新增真正没有的 URL");
            assert_eq!(res.updated, 0);
            assert_eq!(res.skipped, 1);
            let links = links_of(conn);
            assert_eq!(links.iter().filter(|l| l.url == "https://same.example/x").count(), 1);
            assert_eq!(find(&links, "https://same.example/x").name, "用户加的名字");
        });
    }

    /// 规则 6：失败时旧数据与旧来源都不动；坏 JSON 和字段缺失都整体拒绝。
    #[test]
    fn failed_import_leaves_rows_and_source_untouched() {
        with_db("links-failed-import", |conn| {
            import_external_links_into(
                conn,
                r#"[{"name":"旧","url":"https://old.example/x"}]"#,
                SOURCE_A,
            )
            .unwrap();
            for bad in ["<html>not json</html>", r#"[{"name":"缺字段"}]"#] {
                let err = import_external_links_into(conn, bad, SOURCE_B).unwrap_err();
                assert!(!err.is_empty());
                assert_eq!(links_of(conn).len(), 1, "失败不许清空旧数据");
                assert_eq!(source_of(conn).as_deref(), Some(SOURCE_A), "失败不许改来源");
                assert_eq!(links_of(conn)[0].name, "旧");
            }
        });
    }

    /// 规则 3 / 4：JSON 预览只看不写，计数与清单要能对上。
    #[test]
    fn json_preview_is_read_only_and_counts_add_updated_removed() {
        with_db("links-json-preview", |conn| {
            seed(
                conn,
                vec![
                    user("u", "用户条目", "https://user.example/x"),
                    same_source("a", "旧名字", "https://a.example/a", SOURCE_A),
                    same_source("b", "将删除", "https://a.example/b", SOURCE_A),
                    entry("j", "文件旧条目", "https://json.example/j", "json:old.json", ""),
                ],
            );
            let before = links_of(conn);
            let payload = r#"[
                {"name":"更新后的名字","url":"https://a.example/a"},
                {"name":"新条目","url":"https://a.example/d"},
                {"name":"碰用户","url":"https://user.example/x"}
            ]"#;
            let preview = preview_external_links_into(conn, payload, "snapshot.json").unwrap();
            assert_eq!(preview.added.len(), 1);
            assert_eq!(preview.updated.len(), 1);
            assert_eq!(preview.removed.len(), 2, "两个非 user 条目不在文件里 ⇒ 预览要列出");
            assert_eq!(preview.skipped, 1, "user 条目占位 ⇒ 跳过");
            assert_eq!(
                links_of(conn),
                before,
                "预览必须零写入（列表不变）"
            );
            assert_eq!(source_of(conn), None, "预览不许写来源设置");
        });
    }

    /// 规则 3 + 反例自证：把「只删非 user」放宽，这个测试必红。
    #[test]
    fn json_snapshot_deletes_only_non_user_rows_that_are_absent_from_the_file() {
        with_db("links-json-delete-boundary", |conn| {
            seed(
                conn,
                vec![
                    user("u", "用户条目", "https://user.example/x"),
                    same_source("a", "保留并更新", "https://a.example/a", SOURCE_A),
                    same_source("b", "不在文件里", "https://a.example/b", SOURCE_A),
                    entry("j", "文件旧条目", "https://json.example/j", "json:old.json", ""),
                    entry("legacy", "旧数据", "https://legacy.example/l", "", ""),
                ],
            );
            let payload = r#"[
                {"name":"更新后的名字","url":"https://a.example/a"},
                {"name":"新条目","url":"https://new.example/n"}
            ]"#;
            let res = import_external_links_file_into(conn, payload, "snapshot.json").unwrap();
            assert_eq!(res.added, 1);
            assert_eq!(res.updated, 1);
            assert_eq!(res.removed, 2, "只删非 user 且不在文件里的条目");
            assert_eq!(res.skipped, 0);

            let links = links_of(conn);
            assert!(links.iter().any(|l| l.id == "u"), "user 条目永不因导入被删");
            assert_eq!(find(&links, "https://user.example/x").name, "用户条目");
            assert!(
                links.iter().any(|l| l.id == "legacy"),
                "旧数据归不了来源 ⇒ 按 user 保守保护，不许删"
            );
            assert!(links.iter().all(|l| l.url != "https://a.example/b"), "非 user 缺失条目要删");
            assert!(links.iter().all(|l| l.url != "https://json.example/j"), "json 来源缺失条目也要删");
            assert_eq!(find(&links, "https://a.example/a").name, "更新后的名字");
            assert_eq!(find(&links, "https://a.example/a").source, url_source(SOURCE_A), "更新保留原来源");
            assert_eq!(find(&links, "https://new.example/n").source, json_source("snapshot.json"));
            assert_eq!(source_of(conn), None, "文件导入不改 URL 来源");
        });
    }

    /// 反例自证：删掉「user 条目永不因导入被改」这一步，这个测试必红。
    #[test]
    fn json_snapshot_never_touches_user_rows() {
        with_db("links-json-user-protected", |conn| {
            seed(conn, vec![user("u", "用户自己的名字", "https://user.example/x")]);
            let res = import_external_links_file_into(
                conn,
                r#"[{"name":"文件里的名字","url":"https://user.example/x"}]"#,
                "snapshot.json",
            )
            .unwrap();
            assert_eq!(res.added, 0);
            assert_eq!(res.updated, 0, "user 条目不许被文件更新");
            assert_eq!(res.removed, 0);
            assert_eq!(res.skipped, 1);
            let links = links_of(conn);
            assert_eq!(links.len(), 1);
            assert_eq!(links[0].name, "用户自己的名字");
            assert_eq!(links[0].source, SOURCE_USER);
        });
    }

    /// 规则 6：坏 JSON / 字段缺失整体回滚，列表与来源都保持。
    #[test]
    fn json_import_failure_rolls_back_without_partial_rows() {
        with_db("links-json-rollback", |conn| {
            seed(conn, vec![user("u", "保留", "https://user.example/x")]);
            import_external_links_into(
                conn,
                r#"[{"name":"URL 来源","url":"https://a.example/a"}]"#,
                SOURCE_A,
            )
            .unwrap();
            let before = links_of(conn);
            for bad in [
                "{ broken",
                r#"{"links":[{"name":"缺 URL"}]}"#,
                r#"[{"url":"https://no-name.example/x"}]"#,
            ] {
                assert!(
                    import_external_links_file_into(conn, bad, "bad.json").is_err(),
                    "坏文件必须整体拒绝：{bad}"
                );
                assert_eq!(links_of(conn), before, "失败不许留下半套");
                assert_eq!(source_of(conn).as_deref(), Some(SOURCE_A));
            }
        });
    }

    /// 真实临时库关重开：来源、来源标记都持久化；重开后刷新与删除边界仍按同一套规则。
    #[test]
    fn source_tags_and_deletion_boundaries_survive_close_and_reopen() {
        let path = db_path("links-reopen-boundary");
        {
            let conn = open_with_schema(&path);
            seed(&conn, vec![user("u", "用户条目", "https://user.example/x")]);
            import_external_links_into(
                &conn,
                r#"[
                    {"name":"远程条目","url":"https://a.example/a"},
                    {"name":"远程保留","url":"https://a.example/keep"}
                ]"#,
                SOURCE_A,
            )
            .unwrap();
        }
        // 第二个"进程"：同一路径重新打开。
        {
            let conn = open_with_schema(&path);
            assert_eq!(
                source_of(&conn).as_deref(),
                Some(SOURCE_A),
                "重启后来源链接必须还在（刷新按钮要按它拉数据）"
            );
            let links = links_of(&conn);
            assert_eq!(find(&links, "https://a.example/a").source, url_source(SOURCE_A), "来源标记持久化");
            assert_eq!(find(&links, "https://user.example/x").source, SOURCE_USER);

            // 重开后刷新：同来源覆盖，本地多出的保留。
            let res = import_external_links_into(
                &conn,
                r#"[{"name":"远程改名","url":"https://a.example/a"}]"#,
                SOURCE_A,
            )
            .unwrap();
            assert_eq!(res.updated, 1);
            assert_eq!(res.removed, 0);
            let links = links_of(&conn);
            assert_eq!(find(&links, "https://a.example/a").name, "远程改名");
            assert_eq!(find(&links, "https://a.example/keep").name, "远程保留", "远程没有的本地条目保留");

            // 重开后 JSON 快照：只删非 user，user 与远程保留的边界不变。
            let res = import_external_links_file_into(
                &conn,
                r#"[{"name":"快照保留","url":"https://a.example/a"}]"#,
                "snapshot.json",
            )
            .unwrap();
            assert_eq!(res.removed, 1, "只删不在快照里的非 user 条目");
            let links = links_of(&conn);
            assert!(links.iter().any(|l| l.id == "u"), "user 条目永不因导入被删");
            assert_eq!(find(&links, "https://a.example/a").name, "快照保留");
            assert_eq!(find(&links, "https://a.example/a").source, url_source(SOURCE_A));
        }
        cleanup(&path);
    }

    /// 矩阵 22：上限只影响新增，绝不为了腾位置删已有条目。
    #[test]
    fn limit_skips_new_rows_without_deleting_existing_ones() {
        with_db("links-limit", |conn| {
            let mut list = Vec::new();
            for i in 0..MAX_EXTERNAL_LINKS {
                list.push(user(
                    &format!("u{i}"),
                    &format!("用户 {i}"),
                    &format!("https://user.example/{i}"),
                ));
            }
            seed(conn, list);
            let res = import_external_links_into(
                conn,
                r#"[{"name":"超限新增","url":"https://over.example/x"}]"#,
                SOURCE_A,
            )
            .unwrap();
            assert_eq!(res.added, 0);
            assert_eq!(res.skipped, 1);
            assert_eq!(links_of(conn).len(), MAX_EXTERNAL_LINKS);
        });
    }
}
