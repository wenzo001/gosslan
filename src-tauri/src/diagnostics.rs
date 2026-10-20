//! 用户可导出的**脱敏诊断包**（5.0.37）。
//!
//! ## 为什么要有它
//! 崩溃留存做得再好，用户说不出"我这边发生了什么"仍然等于零：以前只有两条路 ——
//! 要么让用户自己钻 app data 目录抄文件（真实日志里逐行带着设备指纹、对端 id 与局域网
//! IP，直接发给别人就是把隐私一起发出去），要么由我们后台上传（**本仓不做遥测**，
//! 这条路根本不成立）。所以剩下唯一诚实的形状：**用户按一个钮，拿到一份可以自己决定
//! 发不发、发给谁的文本**，里面该留的证据都在，能认出人的东西先去掉。
//!
//! ## 与 `export.rs` 同一口径：只产纯文本
//! 崩溃现场与日志行里会带**对端送来的文件名**。把它渲染成 HTML 再用浏览器打开，
//! 等于让对端内容在本机执行脚本 —— 那是我们自己造出来的 XSS 通道。纯文本在任何
//! 编辑器里都只是字。
//!
//! ## 边界（写在这里是为了不让人误读这个模块）
//! - 不联网、不后台生成、不落第二份副本：只有 `export_diagnostics_bundle` 被调用时
//!   才读那三份文件并写到**用户选好的**那个路径（路径由界面的保存对话框给，Rust 不替
//!   用户决定落点，见 `commands::export_diagnostics_bundle`）。
//! - 脱敏是**形状级**的，不是语义级的：只处理下面四类真机里现读到的形状，
//!   不做通用 PII 猜测（那会连带把"bytes=379"这种排障要用的数字也啃掉）。
//! - 文件名与文件大小**故意保留** —— 传输类故障没有它就查不动；这一点也写进了包的头部，
//!   让用户在发出去之前知道自己交出去的是什么。

use std::borrow::Cow;

use crate::logging::Logger;

/// 一份文件最多带这么多字节，超出只取**尾部**（最近的那段 = 最可能相关的那段）。
/// 三份封顶 768 KiB + 头部 ≈ 不到 1 MiB，用户随手就能通过聊天/邮件发出去。
const MAX_PART_BYTES: usize = 256 * 1024;

/// 回给界面的导出摘要：`redactions` 是"这条命令确实把敏感形状去掉了几处"，
/// 用户看得见这个数，才谈得上"知道自己发出去的是什么"。
#[derive(serde::Serialize)]
pub struct BundleSummary {
    /// 实际落盘字节数
    pub bytes: u64,
    /// 真正读到的文件份数（本轮日志 / 上一代 / 崩溃现场；没有就是 0 份）
    pub files: usize,
    /// 脱敏命中处数
    pub redactions: usize,
    /// 实际落盘路径
    pub path: String,
}

/// 日志位置三件套（供界面显示与"复制路径"）。全部由本轮解析出的 stem 给，
/// 不让前端自己拼 —— 多实例时 `gosslan-1.log` 与 `gosslan.log` 只差一个数字，拼错就是
/// 让用户去复制别人的那一份。
#[derive(serde::Serialize)]
pub struct LogLocations {
    pub dir: String,
    pub current: String,
    pub crash: String,
}

pub fn locations(logger: &Logger) -> LogLocations {
    let p = |path: std::path::PathBuf| path.to_string_lossy().into_owned();
    LogLocations {
        dir: p(logger.log_dir()),
        current: p(logger.current_path()),
        crash: p(logger.crash_path()),
    }
}

/// 取一份文本的**尾部**至多 `cap` 字节，且不切断多字节字符（从最近的 `\n` 起切）。
fn tail_bytes(text: &str, cap: usize) -> String {
    if text.len() <= cap {
        return text.to_string();
    }
    let mut start = text.len() - cap;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    // 再往后对齐到行首，避免包的第一行是半条日志（读起来像被截断的证据）
    match text[start..].find('\n') {
        Some(n) if n + 1 < text.len() - start => text[start + n + 1..].to_string(),
        _ => String::new(),
    }
}

/// 组装诊断包正文（纯函数：读文件这一步留给调用方，方便单测）。
pub fn bundle_text(
    logger: &Logger,
    parts: &[(&str, String)],
    utc_now: &str,
    home: Option<&str>,
) -> (String, usize) {
    let mut hits = 0usize;
    let mut out = String::with_capacity(4096);
    out.push_str("==== Gosslan 诊断包 ====\n");
    out.push_str(&format!("生成时刻(UTC): {utc_now}\n"));
    out.push_str(&format!(
        "版本: {} · {}-{} · {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    ));
    out.push_str(&format!("本轮运行标识: {}\n", logger.run_id()));
    out.push_str(&format!(
        "落盘失败次数: {}（不为 0 说明这段时间里日志文件没写进去，只有内存环里有）\n",
        logger.write_fails()
    ));
    out.push_str(
        "已脱敏: 设备指纹→[本机]、设备 id 与 BLE 端点→前 4 位…、IPv4→首.*.*.尾、家目录→~\n",
    );
    out.push_str("未包含: 消息正文、密钥、通讯录、数据库\n");
    out.push_str(
        "仍保留: 端口、字节数与消息类型（日志规范本来就不写消息正文与文件名，导出前也核过）\n",
    );
    out.push('\n');
    for (label, body) in parts {
        let (red, n) = redact(body, logger.fingerprint(), home);
        hits += n;
        out.push_str(&format!("---- {label} ----\n"));
        out.push_str(&red);
        if !red.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
    }
    (out, hits)
}

/// 读那三份文件 → 脱敏 → 写到用户选好的路径。
///
/// 读不到的那份按"缺失"处理而不是报错：新装完就导包时 `.old.log` 根本不存在，
/// 而"上一次崩没崩"恰恰是这时候要查的。
pub fn write_bundle(
    logger: &Logger,
    destination: &str,
    home: Option<&str>,
) -> Result<BundleSummary, String> {
    if destination.trim().is_empty() {
        return Err("导出路径为空".to_string());
    }
    let sources = [
        ("本轮运行日志", logger.current_path()),
        ("上一代运行日志", logger.old_path()),
        ("崩溃现场", logger.crash_path()),
    ];
    let mut parts: Vec<(&str, String)> = Vec::with_capacity(sources.len());
    let mut files = 0usize;
    for (label, path) in sources {
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                files += 1;
                parts.push((label, tail_bytes(&text, MAX_PART_BYTES)));
            }
            Err(_) => parts.push((label, format!("（没有这份文件：{}）\n", path.display()))),
        }
    }
    let (text, redactions) = bundle_text(
        logger,
        &parts,
        &crate::logging::format_utc(crate::logging::now_ms()),
        home,
    );
    std::fs::write(destination, text.as_bytes()).map_err(|e| format!("写入诊断包失败：{e}"))?;
    Ok(BundleSummary {
        bytes: text.len() as u64,
        files,
        redactions,
        path: destination.to_string(),
    })
}

/// 五类形状的脱敏（形状不是猜的 —— 2026-10-20 从真机
/// `…/com.gosslan.app/logs/*.log` 里现读的样本）：
/// - 设备指纹 `[dev:Mac-wendon]`（里面就是机器名）→ `[本机]`
/// - IPv4 `192.168.31.229` → `192.*.*.229`。**留首尾两段**是刻意的：`send_bind` 与
///   组播目标 `…255` 只差最后一段，全糊掉就查不动"广播发到了哪"，而留最后一段又足够
///   认出是哪台机器 —— 于是糊中间：同一子网这一事实留下，主机身份留下**相对**信息、
///   丢掉网段。
/// - 设备 id `gosslan-044bb98f6d33b-i1` → `gosslan-044b…-i1`（留 4 位，够把同一个对端
///   在几行日志里串起来，不够反查是谁）
/// - BLE 端点 `ep=ble:312FF2DD-…` → `ep=ble:312F…`（CoreBluetooth 的稳定标识）
/// - 家目录（`$HOME` / `%USERPROFILE%`）→ `~`
///
/// `ep=ble:312FF2DD-5BC5-62A5-FDD5-625F2D87FF48` → `ep=ble:312F…`。
///
/// 第五个形状是 2026-10-20 从同一批真机日志里**补**上来的：BLE 那几行
/// （`[SEND]/[RECV] type=group_key … ep=ble:<UUID>`）里的 UUID 是 macOS CoreBluetooth
/// 给外围设备的**稳定**标识 —— 对端换了随机蓝牙地址它也不变，同一台 Mac 认得出来。
/// 一份"可以发给别人"的包里留着它，等于把"这台机器见过哪台手机"交出去。
/// 留前 4 位足够把同一个对端在几行日志里串起来。
fn mask_ble_ep(s: &str) -> (String, usize) {
    const MARK: &str = "ble:";
    let c: Vec<char> = s.chars().collect();
    let m: Vec<char> = MARK.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut hits = 0usize;
    let mut i = 0usize;
    while i < c.len() {
        if i + m.len() <= c.len() && c[i..i + m.len()] == m[..] {
            let start = i + m.len();
            let mut p = start;
            while p < c.len() && (c[p].is_ascii_hexdigit() || c[p] == '-') {
                p += 1;
            }
            if p - start >= 16 {
                let keep: String = c[start..start + 4].iter().collect();
                out.push_str(MARK);
                out.push_str(&keep);
                out.push('…');
                hits += 1;
                i = p;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    (out, hits)
}

/// 返回 `(文本, 命中数)`。逐行处理，所以行里的时间戳与 `bytes=379` 这类数字不受影响。
pub fn redact(input: &str, fingerprint: &str, home: Option<&str>) -> (String, usize) {
    let mut hits = 0usize;
    let mut out = String::with_capacity(input.len());
    // 空串必须跳过：`str::replace("")` 会在每个字符之间插入替换值，把整份日志刷成
    // `[本机][本机]…` —— 那不是脱敏，那是把证据销毁。桩值短（`[dev:t]`）照样按指纹替换，
    // 因为它就是那个测试世界里的指纹，跳过它反而让"指纹有没有被替换"这一格测不到。
    let use_fp = !fingerprint.is_empty();
    // 家目录同理要挡退化值：`HOME=/` 参与替换会把每一个斜杠都变成 `~`。
    let use_home = home.map(|h| h.chars().count() >= 2).unwrap_or(false);
    for line in input.lines() {
        let mut cur: Cow<'_, str> = Cow::Borrowed(line);
        if use_fp {
            let (t, n) = replace_count(&cur, fingerprint, "[本机]");
            hits += n;
            cur = Cow::Owned(t);
        }
        if use_home {
            let (t, n) = replace_count(&cur, home.unwrap_or(""), "~");
            hits += n;
            cur = Cow::Owned(t);
        }
        let (t, n) = mask_ipv4(&cur);
        hits += n;
        cur = Cow::Owned(t);
        let (t, n) = mask_device_id(&cur);
        hits += n;
        cur = Cow::Owned(t);
        let (t, n) = mask_ble_ep(&cur);
        hits += n;
        cur = Cow::Owned(t);
        out.push_str(&cur);
        out.push('\n');
    }
    (out, hits)
}

fn replace_count(s: &str, from: &str, to: &str) -> (String, usize) {
    if from.is_empty() {
        return (s.to_string(), 0);
    }
    let n = s.matches(from).count();
    (s.replace(from, to), n)
}

fn is_id_char(c: char) -> bool {
    // 设备 id 是十六进制小写（`044bb98f6d33b`），所以数字也算 id 的一部分。
    // 只认 `is_ascii_lowercase` 会让扫描在第一个数字处停下 ⇒ 整条 id 原样漏出去。
    c.is_ascii_digit() || c.is_ascii_lowercase()
}

/// 手写 IPv4 扫描（本仓不带 `regex`，为一格脱敏引依赖不划算 —— 见 `Cargo.toml`）。
/// 只认"四段十进制、每段 ≤255、前后不粘着数字/点/字母"这一种形状。
fn mask_ipv4(s: &str) -> (String, usize) {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut hits = 0usize;
    let mut i = 0usize;
    while i < c.len() {
        let prev_ok = i == 0
            || !(c[i - 1].is_ascii_digit() || c[i - 1] == '.' || c[i - 1].is_ascii_alphabetic());
        if c[i].is_ascii_digit() && prev_ok {
            if let Some((end, groups)) = ipv4_at(&c, i) {
                out.push_str(&format!("{}.*.*.{}", groups[0], groups[3]));
                hits += 1;
                i = end;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    (out, hits)
}

/// 从 `i` 起能不能读出一个完整 IPv4；返回**结束下标**与四段值。
fn ipv4_at(c: &[char], i: usize) -> Option<(usize, [u16; 4])> {
    let mut groups = [0u16; 4];
    let mut p = i;
    for (g, slot) in groups.iter_mut().enumerate() {
        let start = p;
        let mut v: u32 = 0;
        while p < c.len() && c[p].is_ascii_digit() {
            v = v * 10 + (c[p] as u32).wrapping_sub('0' as u32);
            p += 1;
            if v > 255 {
                return None;
            }
        }
        if p == start {
            return None; // 空段
        }
        *slot = v as u16;
        if g < 3 {
            if p < c.len() && c[p] == '.' {
                p += 1;
            } else {
                return None;
            }
        }
    }
    // 尾巴不能再接数字/点/字母：`4.44.0` 那种版本号只差一段就撞形，靠这一条区分；
    // `1.2.3.4.5` 这种畸形串整条都不许糊（糊了一半比不糊更容易骗人）。
    if p < c.len() && (c[p].is_ascii_digit() || c[p] == '.' || c[p].is_ascii_alphabetic()) {
        return None;
    }
    Some((p, groups))
}

/// `gosslan-<id>…` 只留 id 的前 4 位。`-i1` 这类实例后缀本来就不在 `[0-9a-z_]` 里，
/// 于是自然留在结果中 —— 多实例排查要用的正是这一位。
fn mask_device_id(s: &str) -> (String, usize) {
    const MARK: &str = "gosslan-";
    let c: Vec<char> = s.chars().collect();
    let m: Vec<char> = MARK.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut hits = 0usize;
    let mut i = 0usize;
    while i < c.len() {
        if i + m.len() <= c.len() && c[i..i + m.len()] == m[..] {
            let start = i + m.len();
            let mut p = start;
            while p < c.len() && is_id_char(c[p]) {
                p += 1;
            }
            let id_len = p - start;
            if id_len >= 8 {
                let keep: String = c[start..start + 4].iter().collect();
                out.push_str(MARK);
                out.push_str(&keep);
                out.push('…');
                hits += 1;
                i = p;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    (out, hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 正控：真机里现读到的四种形状，一条都不许漏；漏了就是"包发出去了但没脱敏"。
    #[test]
    fn redact_masks_the_four_shapes_seen_in_real_logs() {
        let fp = "[dev:Mac-wendongfu]";
        let line = "[dev:Mac-wendongfu] 2026-10-19 09:47:39 info [discovery] \
                    diag/discovery_started: send_bind=192.168.31.229, recv_bind=0.0.0.0, \
                    target=192.168.31.255:59991 peer=gosslan-044bb98f6d33b-i1 \
                    path=/Users/wendongfu/Library/Application Support/com.gosslan.app/logs \
                    [ble] [RECV] type=group_key ep=ble:312FF2DD-5BC5-62A5-FDD5-625F2D87FF48 bytes=360";
        let (out, hits) = redact(line, fp, Some("/Users/wendongfu"));
        assert!(
            !out.contains("Mac-wendongfu"),
            "设备指纹必须整条消失：{out}"
        );
        assert!(!out.contains("192.168.31"), "网段必须被糊掉：{out}");
        assert!(!out.contains("044bb98f6d33b"), "对端 id 不许留全：{out}");
        assert!(!out.contains("/Users/wendongfu"), "家目录不许留：{out}");
        assert!(!out.contains("312FF2DD-5BC5"), "BLE 端点整条不许留：{out}");
        assert!(out.contains("ep=ble:312F…"), "BLE 端点要糊成前 4 位：{out}");
        assert!(hits >= 5, "五类形状至少各命中一次，实测 {hits}");
        // 留 4 位 + 实例后缀是**契约**的一部分：全糊掉就串不起同一个对端，
        // 一位都不糊就是没脱敏。两头都要钉住。
        assert!(
            out.contains("gosslan-044b…-i1"),
            "对端 id 要糊成前 4 位 + 实例后缀，实测：{out}"
        );
    }

    /// 反向：脱敏不许把**排障要用的东西**啃掉。只测上一条就等于允许一个"把所有数字都
    /// 抹成 *"的实现通过 —— 那种包谁都能发,但收到的人也查不了任何东西。
    #[test]
    fn redact_keeps_the_triage_signal() {
        let fp = "[dev:Mac-wendongfu]";
        let (a, _) = redact(
            "send_bind=192.168.31.229 target=192.168.31.255:59991",
            fp,
            None,
        );
        assert_eq!(
            a.trim_end(),
            "send_bind=192.*.*.229 target=192.*.*.255:59991",
            "自机与组播地址必须仍可区分：{a}"
        );
        // id 那一条也要钉**形状**：只糊中间 9 位、留 4 位与 `-iN` 后缀。
        // 钉成"包含 gosslan-"这种弱断言会放过两种坏实现：一位不糊（没脱敏）与整条删掉（串不起对端）。
        let (g, _) = redact("peer=gosslan-044bb98f6d33b-i1 name=ok", fp, None);
        assert_eq!(
            g.trim_end(),
            "peer=gosslan-044b…-i1 name=ok",
            "对端 id 只许糊中间：{g}"
        );
        // 版本号差一段就撞 IPv4 形状：`4.44.0` 是三段，必须原样留着
        let (b, _) = redact("版本 4.44.0 · macos-aarch64 · release", fp, None);
        assert_eq!(
            b.trim_end(),
            "版本 4.44.0 · macos-aarch64 · release",
            "版本号不许被当成 IP：{b}"
        );
        // 五段畸形串整条不糊（糊一半会造出一个看似合理的假地址）
        let (d, _) = redact("odd=1.2.3.4.5", fp, None);
        assert_eq!(d.trim_end(), "odd=1.2.3.4.5", "畸形数字串不许部分脱敏：{d}");
        // 短 hex 串（比如 UUID 的前 8 位单独出现）不该被 BLE 那道吃掉
        let (u, nu) = redact("ep=ble:312FF2DD bytes=360", fp, None);
        assert_eq!(
            u.trim_end(),
            "ep=ble:312FF2DD bytes=360",
            "不足 16 位的 hex 段不该当 UUID：{u}"
        );
        assert_eq!(nu, 0);
        let (c, _) = redact("diag/bc_directed: bytes=379, ok=true", fp, None);
        assert_eq!(
            c.trim_end(),
            "diag/bc_directed: bytes=379, ok=true",
            "普通数字与文件名不许动：{c}"
        );
        let (e, _) = redact("收到 照片 2026-10-19.jpg (3.2 MB)", fp, None);
        assert!(e.contains("照片 2026-10-19.jpg"), "传输文件名要留着：{e}");
        // 退化输入必须跳过替换：空指纹会让 `replace("")` 在每个字符之间插 `[本机]`，
        // `HOME=/` 会把每个斜杠变成 `~` —— 那不是脱敏，是把证据销毁。
        let (f, hits) = redact("[dev:t] hello", "", Some("/"));
        assert_eq!(f.trim_end(), "[dev:t] hello", "退化输入不许参与替换：{f}");
        assert_eq!(hits, 0, "退化输入不该计成命中：{hits}");
        // 短桩指纹（`[dev:t]`）仍按指纹处理：这条钉的是"只要给了指纹就替换"，
        // 换成"短就不替换"会让上面那格变成唯一有效的格。
        let (h, hits2) = redact("[dev:t] hello", "[dev:t]", None);
        assert_eq!(h.trim_end(), "[本机] hello", "给出的桩指纹也要被替换：{h}");
        assert_eq!(hits2, 1);
    }

    /// 建一棵**自己的**临时树 `<tmp>/gosslan-diag-<tag>-<纳秒>/logs`，返回的 logger 指向
    /// 里面那层 `logs`。为什么多一层：测试收尾要 `remove_dir_all` 的是自己那棵树，
    /// 而 `log_dir().parent()` 一旦直接就是 `/tmp`，删除就会把整个临时目录端掉。
    /// 下面那条 `is_some_and(contains)` 断言就是拦这个的 —— 少一层它就直接红。
    fn logger_at(tag: &str) -> Logger {
        let root = std::env::temp_dir().join(format!(
            "gosslan-diag-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&root);
        Logger::new(root.join("logs"), tag, "[dev:Mac-wendongfu]".to_string())
    }

    /// 只删自己建的那棵树：路径里必须带 `gosslan-diag-`，否则一颗星都不删。
    fn remove_own_tree(path: &std::path::Path) {
        let owned = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("gosslan-diag-"));
        assert!(
            owned,
            "收尾删除的路径不是本测试建的树，拒绝删除：{}",
            path.display()
        );
        let _ = std::fs::remove_dir_all(path);
    }

    /// 整包三格：本轮 / 上一代 / 崩溃现场都要在，缺的那份要写明"没有"而不是静默跳过。
    #[test]
    fn bundle_covers_the_three_files_and_says_what_is_missing() {
        let logger = logger_at("dg1");
        logger.info("test", "diag/bc_directed: target=192.168.31.255:59991");
        logger.error(
            "panic",
            "panic @ src/x.rs:7:1：peer=gosslan-044bb98f6d33b-i1",
        );
        let (text, hits) = bundle_text(
            &logger,
            &[
                (
                    "本轮运行日志",
                    std::fs::read_to_string(logger.current_path()).unwrap(),
                ),
                ("上一代运行日志", "（没有这份文件）\n".to_string()),
                (
                    "崩溃现场",
                    std::fs::read_to_string(logger.crash_path()).unwrap(),
                ),
            ],
            "2026-10-20 00:00:00",
            None,
        );
        assert!(
            text.contains("---- 本轮运行日志 ----"),
            "本轮那格丢了：{text}"
        );
        assert!(text.contains("---- 崩溃现场 ----"), "现场那格丢了");
        assert!(
            text.contains("---- 上一代运行日志 ----"),
            "缺的那格也要点名"
        );
        assert!(
            text.contains(&format!("本轮运行标识: {}", logger.run_id())),
            "运行标识要能对上路标"
        );
        assert!(
            hits > 0,
            "这份包里必然有可脱敏的形状，命中 0 说明 redact 没接上"
        );
        assert!(!text.contains("Mac-wendongfu"), "包正文里不许有设备指纹");
        assert!(!text.contains("192.168.31"), "包正文里不许有网段");
        remove_own_tree(logger.log_dir().parent().unwrap());
    }

    /// 上界：单份文件只取尾部，包不会把 512 KiB×3 的旧内容整份塞给用户。
    #[test]
    fn bundle_takes_the_tail_not_the_whole_file() {
        let big: String = (0..40_000)
            .map(|i| format!("line {i:05} 192.168.31.1 x\n"))
            .collect();
        assert!(
            big.len() > MAX_PART_BYTES * 2,
            "前置条件不成立：这份测试数据不够大"
        );
        let t = tail_bytes(&big, MAX_PART_BYTES);
        assert!(
            t.len() <= MAX_PART_BYTES,
            "尾部没截住：{} > {}",
            t.len(),
            MAX_PART_BYTES
        );
        assert!(
            t.starts_with("line "),
            "尾部该从整行开始，实测：{}",
            &t[..20.min(t.len())]
        );
        assert!(t.contains("line 39999"), "留的必须是**最近**那段");
        // 多字节字符不能被切断（日志里有中文）
        let utf8 = "测".repeat(MAX_PART_BYTES / 3) + "\n最后一行\n";
        let t2 = tail_bytes(&utf8, MAX_PART_BYTES);
        assert!(t2.is_char_boundary(t2.len()), "尾部切断了多字节字符");
        assert!(t2.ends_with("最后一行\n"), "尾部要落在整行上");
    }

    /// 落盘那一步：路径交给用户选的，Rust 不猜；空路径要报错而不是写到一个怪地方。
    #[test]
    fn write_bundle_rejects_an_empty_destination_and_writes_the_summary() {
        let logger = logger_at("dg2");
        logger.warn(
            "test",
            "diag/announce_verified: from=peer target=192.168.31.7",
        );
        assert!(
            write_bundle(&logger, "   ", None).is_err(),
            "空路径必须报错"
        );

        let dest = logger
            .log_dir()
            .parent()
            .unwrap()
            .join("bundle-out.txt")
            .to_string_lossy()
            .into_owned();
        let s = write_bundle(&logger, &dest, None).expect("导出必须成功");
        assert_eq!(s.path, dest);
        assert!(
            s.bytes > 0 && s.files >= 2,
            "至少要有本轮日志 + 崩溃现场，实测 {:?}",
            s.files
        );
        assert!(s.redactions > 0, "摘要要如实报出脱敏命中数");
        let body = std::fs::read_to_string(&dest).unwrap();
        assert!(!body.contains("192.168.31"), "写到磁盘的那份也要是脱敏后的");
        remove_own_tree(logger.log_dir().parent().unwrap());
    }
}
