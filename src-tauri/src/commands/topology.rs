// 「我的网络」的**本地布局偏好**（阶段 2，2026-11-16）。
//
// 用户拖过节点后，把坐标记在 `settings` 表（**不动 SQLite 表结构** —— schema 属
// Frozen Core）。这是**本机偏好**，不进网络协议、不跟 peer 同步。
//
// 命令层刻意薄：序列化 / 形状校验在前端纯函数 `utils/topologySemantics.ts` 里做，
// 这里只负责「存一个 JSON 字符串 / 读一个 JSON 字符串 / 删掉」—— 这样两端判据
// 各自可单测，且不把解析规则抄两份。
//
// ⚠️ 这个文件是 `include!` 进 `commands.rs` 的 ⇒ 不能写文件级 `#![…]`，
//    也不能重复 import `serde` / `Arc` / `State` / `db` / `AppState`（上层已导入，
//    重复 import 会 E0252 —— 本文件第一次编译就踩到了）。

/// settings 表里的键。独立于其它偏好（更新源、授权记忆等）。
pub const TOPOLOGY_LAYOUT_KEY: &str = "topology_layout_v1";

/// 读用户拖拽过的节点坐标（原始 JSON 字符串）。没存过 ⇒ 空串。
///
/// 用 `get_setting_checked`（Result）而不是 `get_setting`（Option）：「读失败」与
/// 「没这条」必须可分（B1-F7）—— 折叠成空串会把用户拖过的布局悄悄抹掉。
#[tauri::command(async)]
pub async fn topology_layout_load(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let s = state.inner().clone();
    // 读库进阻塞池（R-18 棘轮：命令体不许留 `db::` 而无 `spawn_blocking(`）。
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        // `?` 必须在 `.unwrap_or_default()` **之前**：读失败当场类型化上抛，
        // `unwrap_or_default()` 只折叠「没这条」（B1-F7 判据认可的形状）。
        Ok(db::get_setting_checked(&dbc, TOPOLOGY_LAYOUT_KEY)
            .map_err(|e| format!("code=TOPOLOGY_LAYOUT_READ_FAILED：{e}"))?
            .unwrap_or_default())
    })
    .await
    .map_err(|e| format!("布局读取任务中断：{e}"))?
}

/// 保存用户拖拽过的节点坐标（`raw` = 前端序列化好的 JSON）。
///
/// 前端负责形状校验（`parseLayoutOverride`），这里只再做一道**长度闸**
/// （settings 表是共享的，别让一个坏调用方塞进几 MB 的 JSON）。
#[tauri::command(async)]
pub async fn topology_layout_save(
    state: State<'_, Arc<AppState>>,
    raw: String,
) -> Result<(), String> {
    if raw.len() > 256 * 1024 {
        return Err("布局数据过大（上限 256 KiB）".into());
    }
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::set_setting(&dbc, TOPOLOGY_LAYOUT_KEY, &raw)
            .map_err(|e| format!("code=TOPOLOGY_LAYOUT_SAVE_FAILED：{e}"))
    })
    .await
    .map_err(|e| format!("布局保存任务中断：{e}"))??;
    Ok(())
}

/// 恢复默认布局：删掉这条偏好 ⇒ 之后全部节点走确定性分档网格。
#[tauri::command(async)]
pub async fn topology_layout_reset(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let s = state.inner().clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let dbc = s.db.lock().unwrap_or_else(|e| e.into_inner());
        db::delete_setting(&dbc, TOPOLOGY_LAYOUT_KEY)
            .map_err(|e| format!("code=TOPOLOGY_LAYOUT_RESET_FAILED：{e}"))
    })
    .await
    .map_err(|e| format!("布局重置任务中断：{e}"))??;
    Ok(())
}

// ---------------- 判据 ----------------

#[cfg(test)]
mod topology_layout_tests {
    use super::*;

    /// 三个命令都必须把 DB 访问放进阻塞池（R-18 棘轮），否则等锁会占住 tokio worker。
    #[test]
    fn all_layout_commands_are_worker_bound() {
        let src = include_str!("topology.rs");
        let prod = &src[..src.find("mod topology_layout_tests").unwrap_or(src.len())];
        assert_eq!(
            prod.matches("spawn_blocking(move ||").count(),
            3,
            "读/存/删三个命令都必须各进一次阻塞池（按调用形状数，注释里的字面量不算）",
        );
        assert!(
            prod.contains("get_setting_checked("),
            "读取必须用 Result 版：读失败不许折叠成「没存过」",
        );
        assert!(!prod.contains("crate::db::get_setting("), "不许用吞错误的 get_setting");
    }

    /// 状态键必须带版本号：将来布局算法改了，旧坐标不能喂给新布局。
    #[test]
    fn the_layout_key_is_versioned() {
        assert_eq!(TOPOLOGY_LAYOUT_KEY, "topology_layout_v1");
        assert!(
            TOPOLOGY_LAYOUT_KEY.ends_with("_v1"),
            "布局键必须带版本号（算法换了要能作废旧坐标）",
        );
    }

    /// 前端解析坏 JSON 时不能炸开页面 —— 纯函数那侧有判据，这里钉住"命令层不自己解析"。
    #[test]
    fn the_command_layer_does_not_parse_json() {
        let src = include_str!("topology.rs");
        let prod = &src[..src.find("mod topology_layout_tests").unwrap_or(src.len())];
        assert!(
            !prod.contains("serde_json::from_str"),
            "解析规则只有一份（前端 parseLayoutOverride）—— 命令层不许抄第二份",
        );
    }
}
