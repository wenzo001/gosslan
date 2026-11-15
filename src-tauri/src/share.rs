// 外部分享到会话（share-to-conversation）的**协议核心**：解析 + 内存排队。
//
// 职责边界（与设备认证同一条口径）：
// - 这里只做「外部内容 → 一条待处理分享」的解析与限额，**不发消息**：发送仍由前端在用户
//   显式点选会话后走既有的 `send` → `send_message` / `send_group_message`。
// - 不联网。分享内容全部来自链接本身（内联参数），因此没有 SSRF / 抓取预览的风险面。
// - 不做信任判断：`claimed_origin` 只是「调用方自称是谁」，用于在面板上给用户一个线索，
//   任何安全结论都不许建立在它上面（活契约 §6/§D：认证与分享不得混成网页桥）。
//
// 为什么是深链而不是本地 HTTP 服务：本仓是 P2P 客户端，开一个本地 HTTP 端口等于给任意
// 网页一个可探测的入口，要额外做 CORS/来源白名单/CSRF/端口冲突处理，收益却不如一条
// 用户能看见、必须自己确认的链接。这条取舍写在接入文档里（`docs/notes/external-integration-guide-*.md`）。
//
// 三种入口形态（fail closed，只认这三种）：
//   gosslan://share?url=…&title=…&text=…   任意 Web 页面 / 任意应用都能拉起（内联内容）
//   https://<host>/share?url=…&title=…      已做域名关联的站点（内联，来源取链接主机）
//   gosslan://share/<ref>?origin=…          RP 受控引用（需 RP 侧解析端点，本期未接）
// 前两种是「内联分享」；第三种复用 `device_auth::parse_share_link` 的形状校验，命令层
// 明确回「本期不支持」，而不是静默失败或先联网再失败。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::device_auth::{normalize_rp_origin, parse_share_link, ShareLinkRef};
use crate::error_codes;

/// 待处理分享的存活时长：够用户从浏览器切回来点几下，又不至于让内容在内存里躺一天。
pub const PENDING_TTL_MS: i64 = 10 * 60 * 1000;
/// 同时待处理上限：不淘汰用户还没处理的那几笔，满了就明确拒新的（与设备认证同一取舍）。
pub const MAX_PENDING: usize = 8;

/// 标题长度上限（按 Unicode 码点，与全仓长度口径一致：Rust `chars()` == JS 码点数）。
pub const MAX_TITLE_CHARS: usize = 300;
/// 正文长度上限。面板里的输入框也用这个数（前端从 `share_policy` 拿不到就写常量，
/// 两处必须一致，由 `src/utils/share.test.ts` 与 Rust 用例各自钉住同一个数）。
pub const MAX_TEXT_CHARS: usize = 2000;
/// 分享内容 URL 长度上限。
pub const MAX_URL_CHARS: usize = 2048;

/// 一条被分享进来的内容。三个正文字段都可缺，但**至少要有一个非空**。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePayload {
    /// 被分享的链接（只可能是 http/https；`javascript:` / `data:` / `file:` 在解析时就被拒）。
    pub url: Option<String>,
    pub title: Option<String>,
    /// 调用方给的原文/选中的文字。
    pub text: Option<String>,
    /// 调用方**自称**的来源（https origin）。只用于展示线索，不参与任何信任判断。
    pub claimed_origin: Option<String>,
}

impl SharePayload {
    pub fn is_empty(&self) -> bool {
        self.url.is_none() && self.title.is_none() && self.text.is_none()
    }

    /// 去重键：同一份内容被重复拉取（浏览器双击、系统重发、页面重试）不该出现两个面板。
    /// 用不可见分隔符拼，避免 "a|b" 与 "a" + "|b" 撞车。
    pub fn dedupe_key(&self) -> String {
        format!(
            "{}\u{1f}{}\u{1f}{}",
            self.url.as_deref().unwrap_or(""),
            self.title.as_deref().unwrap_or(""),
            self.text.as_deref().unwrap_or("")
        )
    }
}

/// 排队中的一条分享。字段与前端 `SharePrompt` 一一对应（camelCase 过 FFI）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePrompt {
    pub share_id: String,
    pub payload: SharePayload,
    pub received_at_ms: i64,
    pub expires_at_ms: i64,
}

/// 解析结果。受控引用与内联分享分开建模：两者的下一步完全不同（一个要联网解析，
/// 一个直接进面板），混成一个结构会让「有没有内容」变成隐式约定。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShareIntent {
    Inline(SharePayload),
    Reference(ShareLinkRef),
}

fn coded(code: &'static str, msg: impl Into<String>) -> String {
    error_codes::coded(code, msg.into())
}

/// 去掉首尾空白；全空白视为「没给」。
fn clean(raw: Option<String>) -> Option<String> {
    raw.map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// 这条链接是不是**本应用的分享入口**（用于把深链/启动参数分派给分享而不是设备认证）。
///
/// 刻意宽松：只看 scheme + host/path 的形状，解析细节交给 `parse_share_intent`。
/// 这样分派器不会因为参数缺失就把一条「本来想分享」的链接丢给设备认证去报错。
pub fn is_share_entry(raw: &str) -> bool {
    let Ok(parsed) = Url::parse(raw.trim()) else {
        return false;
    };
    match parsed.scheme() {
        "gosslan" => parsed.host_str() == Some("share"),
        "https" => parsed
            .path_segments()
            .and_then(|mut s| s.find(|x| !x.is_empty()))
            .is_some_and(|first| first == "share"),
        _ => false,
    }
}

/// 从启动参数/单实例转发的 argv 里挑出分享链接（冷启动与二次唤起都要用）。
pub fn share_link_from_args(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| is_share_entry(a))
        .map(|a| a.to_string())
}

/// 解析分享入口。**失败关闭**：任何形状不对的地方都回具名码，不做「尽力猜」。
pub fn parse_share_intent(raw: &str) -> Result<ShareIntent, String> {
    let trimmed = raw.trim();
    let parsed = Url::parse(trimmed).map_err(|_| {
        coded(
            error_codes::EXTERNAL_SHARE_INVALID_LINK,
            "分享链接格式不正确",
        )
    })?;
    // 尾斜杠折出的空段忽略；其余段逐个保留用于判形状。
    let segments: Vec<String> = parsed
        .path_segments()
        .map(|s| s.filter(|x| !x.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();

    match parsed.scheme() {
        "gosslan" => {
            if parsed.host_str() != Some("share") {
                return Err(coded(
                    error_codes::EXTERNAL_SHARE_INVALID_LINK,
                    "不是分享入口（应为 gosslan://share）",
                ));
            }
            match segments.len() {
                // 内联：内容全在 query 里。
                0 => Ok(ShareIntent::Inline(payload_from_query(&parsed, None)?)),
                // 受控引用：`gosslan://share/<ref>?origin=…`（形状校验复用设备认证那一份）。
                1 => parse_share_link(trimmed)
                    .map(ShareIntent::Reference)
                    .ok_or_else(|| {
                        coded(
                            error_codes::EXTERNAL_SHARE_INVALID_LINK,
                            "受控分享链接缺少合法的 origin 或引用",
                        )
                    }),
                _ => Err(coded(
                    error_codes::EXTERNAL_SHARE_INVALID_LINK,
                    "分享链接路径段过多",
                )),
            }
        }
        "https" => {
            if segments.first().map(String::as_str) != Some("share") {
                return Err(coded(
                    error_codes::EXTERNAL_SHARE_INVALID_LINK,
                    "不是分享入口（应为 https://<站点>/share）",
                ));
            }
            // 来源取链接自身的主机（与设备认证同一套 HTTPS 同源收紧口径）。
            let origin =
                normalize_rp_origin(&parsed[..url::Position::AfterPort]).map_err(|_| {
                    coded(
                        error_codes::EXTERNAL_SHARE_INVALID_LINK,
                        "分享链接的来源不是合法 HTTPS 站点",
                    )
                })?;
            match segments.len() {
                1 => Ok(ShareIntent::Inline(payload_from_query(
                    &parsed,
                    Some(origin),
                )?)),
                2 => parse_share_link(trimmed)
                    .map(ShareIntent::Reference)
                    .ok_or_else(|| {
                        coded(
                            error_codes::EXTERNAL_SHARE_INVALID_LINK,
                            "受控分享链接缺少合法引用",
                        )
                    }),
                _ => Err(coded(
                    error_codes::EXTERNAL_SHARE_INVALID_LINK,
                    "分享链接路径段过多",
                )),
            }
        }
        _ => Err(coded(
            error_codes::EXTERNAL_SHARE_INVALID_LINK,
            "只支持 gosslan:// 或 https:// 的分享链接",
        )),
    }
}

/// 从 query 里取内联内容。
///
/// 未知参数一律忽略（接入方以后加参数不该让整笔失败）；已知参数值不合法则**整笔拒**，
/// 不静默丢弃 —— 丢掉 `url` 只留标题，用户会以为分享的就是那段文字。
fn payload_from_query(parsed: &Url, origin_hint: Option<String>) -> Result<SharePayload, String> {
    let mut url = None;
    let mut title = None;
    let mut text = None;
    let mut claimed = None;
    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "url" => url = Some(v.into_owned()),
            "title" => title = Some(v.into_owned()),
            "text" => text = Some(v.into_owned()),
            "origin" => claimed = Some(v.into_owned()),
            _ => {}
        }
    }
    payload_from_fields(url, title, text, claimed, origin_hint)
}

/// 由原始字段构造并校验一份分享内容（**唯一的构造入口**）。
///
/// 深链（`payload_from_query`）与系统分享目标的落地区（`incoming_share.rs`）**共用这一处**：
/// 两条入口的字段限额、scheme 收紧、空内容判定必须完全一致 —— 分成两处写，
/// 迟早会漂成「深链拦得住、落地区拦不住」（落地区是别的进程写进来的文件，
/// 比深链更该按同一把尺子量）。
pub fn payload_from_fields(
    url: Option<String>,
    title: Option<String>,
    text: Option<String>,
    claimed: Option<String>,
    origin_hint: Option<String>,
) -> Result<SharePayload, String> {
    let url = clean(url);
    if let Some(raw) = &url {
        let p = Url::parse(raw).map_err(|_| {
            coded(
                error_codes::EXTERNAL_SHARE_BAD_CONTENT,
                "分享的链接格式不正确",
            )
        })?;
        if p.scheme() != "http" && p.scheme() != "https" {
            return Err(coded(
                error_codes::EXTERNAL_SHARE_BAD_CONTENT,
                "只能分享 http/https 链接",
            ));
        }
    }

    // 自称来源只认 HTTPS origin；给了但不合法就拒（不降级成「没给」，否则用户看到的是
    // 一个没有来源线索的面板，却以为自己分享了来自那个站点的一页）。
    let claimed_origin = match clean(claimed) {
        Some(raw) => Some(normalize_rp_origin(&raw).map_err(|_| {
            coded(
                error_codes::EXTERNAL_SHARE_BAD_CONTENT,
                "来源标识必须是 HTTPS 站点",
            )
        })?),
        None => origin_hint,
    };

    let payload = SharePayload {
        url,
        title: clean(title),
        text: clean(text),
        claimed_origin,
    };
    if payload.is_empty() {
        return Err(coded(
            error_codes::EXTERNAL_SHARE_BAD_CONTENT,
            "分享内容为空（至少要有 url / title / text 之一）",
        ));
    }
    if payload
        .url
        .as_deref()
        .is_some_and(|v| v.chars().count() > MAX_URL_CHARS)
        || payload
            .title
            .as_deref()
            .is_some_and(|v| v.chars().count() > MAX_TITLE_CHARS)
        || payload
            .text
            .as_deref()
            .is_some_and(|v| v.chars().count() > MAX_TEXT_CHARS)
    {
        return Err(coded(
            error_codes::EXTERNAL_SHARE_TOO_LARGE,
            format!("分享内容超出长度上限（url≤{MAX_URL_CHARS} / 标题≤{MAX_TITLE_CHARS} / 正文≤{MAX_TEXT_CHARS} 字）"),
        ));
    }
    Ok(payload)
}

/// 入队。返回**最终留在队列里的那一条**（重复内容会复用已有条目，因此返回的可能不是传进来的）。
pub fn admit(
    map: &mut HashMap<String, SharePrompt>,
    prompt: SharePrompt,
    now_ms: i64,
    cap: usize,
) -> Result<SharePrompt, String> {
    map.retain(|_, p| p.expires_at_ms > now_ms);
    let key = prompt.payload.dedupe_key();
    if let Some(existing) = map.values_mut().find(|p| p.payload.dedupe_key() == key) {
        // 同一份内容再来一次：只续命，不新建面板（也不会把用户已选好的会话顶掉）。
        existing.expires_at_ms = prompt.expires_at_ms;
        return Ok(existing.clone());
    }
    if map.len() >= cap {
        return Err(coded(
            error_codes::EXTERNAL_SHARE_BUSY,
            format!("待处理分享已达上限 {cap} 条，请先在应用内处理"),
        ));
    }
    map.insert(prompt.share_id.clone(), prompt.clone());
    Ok(prompt)
}

/// 取最新的一条（冷启动时前端不知道 id，只能问「有没有待处理的」）。
///
/// 只有这一个读取口：面板一次只处理一条，队列里其余的等前一条处理完再轮询出来
/// （`newest_live` 同时负责清过期，所以轮询不会让内存涨）。
pub fn newest_live(map: &mut HashMap<String, SharePrompt>, now_ms: i64) -> Option<SharePrompt> {
    map.retain(|_, p| p.expires_at_ms > now_ms);
    map.values().max_by_key(|p| p.received_at_ms).cloned()
}

/// 用户处理完（发送成功或主动关掉）就移出队列。返回是否真的删掉了。
pub fn dismiss(map: &mut HashMap<String, SharePrompt>, share_id: &str) -> bool {
    map.remove(share_id).is_some()
}

#[cfg(test)]
mod share_tests {
    use super::*;

    const ORIGIN: &str = "https://rp.example.com";

    fn prompt(url: &str) -> SharePrompt {
        SharePrompt {
            share_id: "s1".into(),
            payload: SharePayload {
                url: Some(url.into()),
                title: None,
                text: None,
                claimed_origin: None,
            },
            received_at_ms: 1_000,
            expires_at_ms: 2_000,
        }
    }

    /// 自定义 scheme 的内联形态：内容全在 query，来源来自 `origin` 参数。
    #[test]
    fn inline_custom_scheme_reads_query_and_origin() {
        let raw = "gosslan://share?url=https%3A%2F%2Fnews.example.com%2Fa&title=标题&text=说点什么&origin=https%3A%2F%2Frp.example.com";
        let ShareIntent::Inline(p) = parse_share_intent(raw).expect("应解析成功") else {
            panic!("内联形态必须解析成 Inline");
        };
        assert_eq!(p.url.as_deref(), Some("https://news.example.com/a"));
        assert_eq!(p.title.as_deref(), Some("标题"));
        assert_eq!(p.text.as_deref(), Some("说点什么"));
        assert_eq!(p.claimed_origin.as_deref(), Some(ORIGIN));
    }

    /// HTTPS 形态：来源取**链接自身的主机**，不需要调用方再自报。
    #[test]
    fn inline_https_takes_origin_from_the_link_itself() {
        let raw = "https://rp.example.com/share?title=hi";
        let ShareIntent::Inline(p) = parse_share_intent(raw).expect("应解析成功") else {
            panic!("内联形态必须解析成 Inline");
        };
        assert_eq!(p.claimed_origin.as_deref(), Some(ORIGIN));
        assert_eq!(p.title.as_deref(), Some("hi"));
    }

    /// 安全边界：内容 URL 只认 http(s)。`javascript:` / `data:` / `file:` 一律拒。
    #[test]
    fn content_url_rejects_non_http_schemes() {
        for bad in [
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "file:///etc/passwd",
        ] {
            let raw = format!("gosslan://share?url={}", urlencoding_minimal(bad));
            let err = parse_share_intent(&raw).expect_err("必须拒绝");
            assert!(
                err.contains(error_codes::EXTERNAL_SHARE_BAD_CONTENT),
                "应回具名码而不是笼统失败：{err}"
            );
        }
    }

    /// 空内容不能变成一条空面板（用户会以为分享成功但没东西可发）。
    #[test]
    fn empty_payload_is_rejected() {
        let err = parse_share_intent("gosslan://share?title=%20%20").expect_err("全空白必须拒");
        assert!(err.contains(error_codes::EXTERNAL_SHARE_BAD_CONTENT));
    }

    /// 长度上限按**码点**算，三个字段各自有界。
    #[test]
    fn oversized_fields_are_rejected_per_field() {
        let long_title = "标".repeat(MAX_TITLE_CHARS + 1);
        let raw = format!("gosslan://share?title={}", urlencoding_minimal(&long_title));
        let err = parse_share_intent(&raw).expect_err("超长标题必须拒");
        assert!(err.contains(error_codes::EXTERNAL_SHARE_TOO_LARGE));

        let ok_title = "标".repeat(MAX_TITLE_CHARS);
        let raw = format!("gosslan://share?title={}", urlencoding_minimal(&ok_title));
        assert!(
            parse_share_intent(&raw).is_ok(),
            "恰好等于上限必须放行（差一位就红会让人以为上限是 {MAX_TITLE_CHARS}-1）"
        );
    }

    /// 受控引用形态必须**解析得出来**（说明骨架已接线），而不是当成坏链接。
    #[test]
    fn reference_form_is_recognised_not_rejected() {
        let raw = format!("gosslan://share/opaque-ref-123?origin={ORIGIN}");
        let ShareIntent::Reference(r) = parse_share_intent(&raw).expect("应解析成功") else {
            panic!("受控引用必须解析成 Reference");
        };
        assert_eq!(r.share_ref, "opaque-ref-123");
        assert_eq!(r.rp_origin, ORIGIN);
    }

    /// 未知参数忽略、已知参数非法整笔拒 —— 两条口径都不是"尽力猜"。
    #[test]
    fn unknown_params_are_ignored_but_bad_origin_is_not() {
        let ok = "gosslan://share?title=hi&utm=whatever&v=2";
        assert!(parse_share_intent(ok).is_ok(), "未知参数不该让整笔失败");
        let bad = "gosslan://share?title=hi&origin=http%3A%2F%2Frp.example.com";
        let err = parse_share_intent(bad).expect_err("http 来源必须拒");
        assert!(err.contains(error_codes::EXTERNAL_SHARE_BAD_CONTENT));
    }

    /// 同一份内容重复到达只留一条（浏览器双击 / 系统重发不该出两个面板）。
    #[test]
    fn duplicate_payload_reuses_the_existing_entry() {
        let mut map = HashMap::new();
        let first = admit(
            &mut map,
            prompt("https://a.example.com"),
            1_000,
            MAX_PENDING,
        )
        .unwrap();
        let mut again = first.clone();
        again.share_id = "s2".into();
        again.expires_at_ms = 9_000;
        let kept = admit(&mut map, again, 1_100, MAX_PENDING).unwrap();
        assert_eq!(kept.share_id, "s1", "重复内容必须复用原条目");
        assert_eq!(map.len(), 1, "队列里不许出现两条一样的");
        assert_eq!(
            kept.expires_at_ms, 9_000,
            "复用时要续命，否则用户切回来就没了"
        );
    }

    /// 队列满了明确拒绝并回具名码，**不淘汰**已有条目。
    #[test]
    fn full_queue_rejects_without_evicting() {
        let mut map = HashMap::new();
        for i in 0..MAX_PENDING {
            let mut p = prompt(&format!("https://a.example.com/{i}"));
            p.share_id = format!("s{i}");
            admit(&mut map, p, 1_000, MAX_PENDING).unwrap();
        }
        let mut extra = prompt("https://a.example.com/overflow");
        extra.share_id = "overflow".into();
        let err = admit(&mut map, extra, 1_000, MAX_PENDING).expect_err("满了必须拒");
        assert!(err.contains(error_codes::EXTERNAL_SHARE_BUSY));
        assert_eq!(map.len(), MAX_PENDING, "拒绝新条目但不许淘汰老的");
        assert!(map.contains_key("s0"), "最早那条也必须在");
    }

    /// 过期条目在读取/入队时被清掉（内存不涨），读不到就是读不到。
    #[test]
    fn expired_entries_are_reaped_on_access() {
        let mut map = HashMap::new();
        admit(
            &mut map,
            prompt("https://a.example.com"),
            1_000,
            MAX_PENDING,
        )
        .unwrap();
        assert!(newest_live(&mut map, 1_500).is_some());
        assert!(newest_live(&mut map, 2_001).is_none(), "过期后不许再返回");
        assert!(map.is_empty(), "过期条目应被清掉");
    }

    /// 分派器只认分享入口，不许把授权深链抢走（否则快捷登录会静默失效）。
    #[test]
    fn dispatcher_does_not_steal_authorize_links() {
        assert!(is_share_entry(
            "gosslan://share?url=https%3A%2F%2Fa.example.com"
        ));
        assert!(is_share_entry("https://rp.example.com/share?title=x"));
        assert!(!is_share_entry(
            "gosslan://authorize/req-1?origin=https%3A%2F%2Frp.example.com"
        ));
        assert!(!is_share_entry("https://rp.example.com/authorize/req-1"));
        assert!(!is_share_entry("not a url"));
    }

    /// 冷启动 argv 里挑分享链接：要跳过 argv[0]（可执行文件路径），且不认无关参数。
    #[test]
    fn argv_picks_the_share_link_only() {
        let args = vec![
            "/Applications/Gosslan.app/Contents/MacOS/gosslan".to_string(),
            "--flag".to_string(),
            "gosslan://share?title=hi".to_string(),
        ];
        assert_eq!(
            share_link_from_args(&args).as_deref(),
            Some("gosslan://share?title=hi")
        );
        assert!(
            share_link_from_args(&args[..1]).is_none(),
            "只有 argv[0] 时不许误判"
        );
    }

    /// 极简 percent-encode：只给测试用，避免为一个夹具引入依赖。
    fn urlencoding_minimal(raw: &str) -> String {
        let mut out = String::new();
        for b in raw.as_bytes() {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(*b as char)
                }
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    }
}
