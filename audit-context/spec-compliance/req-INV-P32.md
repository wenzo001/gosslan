## REQ-INV-P32 — 一台机器上正常使用只许有一个实例（多开只在测试里）

> "| # | 规则 | 今天靠什么成立（不是靠谁记得） |
> | 1 | 第二个进程不许建窗、不许起第二份后台，只能把已有的主窗叫到前台 | 单实例插件注册在 `lib.rs`；`tests::second_launch_focuses_the_running_app_instead_of_duplicating_it` 钉"注册处必须调 `show_main_window`"，`guards:第二次启动` 那一条注入钉"不许绕过出口判定" |
> | 2 | 多开只允许出现在开发/测试里，且必须显式声明 | 出口是一个纯函数 `allow_second_instance_launch`，只认 `GOSSLAN_INSTANCE` / `GOSSLAN_AUTOSTART=1`；真值表判据 `tests::second_instance_exit_is_only_the_dev_multi_open` 双向钉（无变量⇒拦 / 带变量⇒放行 / `AUTOSTART` 非 `1` 不算放行） |
> | 3 | 这条守卫不许顺手把移动端构建弄坏 | 注册处（`allow_second_instance_launch` 那个判定块，在 `lib.rs`）带 `#[cfg(all(desktop, any(target_os = "macos", windows, target_os = "linux")))]`，依赖声明在 `Cargo.toml` 的 `[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]` 那一节。⚠️ **这条判据今天钉的是两件事**：注册处那串 `cfg` 字面量恰好是这三家桌面 + `Cargo.toml` 里**有**这条依赖；它**不**逐字比对两边清单是否同构 ⇒ 只把依赖那一节的平台清单改宽，这条判据不会红 |
> **边界（如实写下，别当成已解决）**：插件按"同一个可执行文件/应用标识"分组，所以**不同 bundle 之间不去重** —— 同时跑 dev 构建与已安装的那份，仍然是两个进程。"
> — docs/protocol-invariants.md §32. INV-P32, line 1528

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 正常使用（真用户环境）时第二个进程不许建窗、不许起第二份后台，只能把已开的主窗叫到前台；多开只允许出现在开发/测试里且必须显式声明；这条守卫不许顺手把移动端构建弄坏。

**Where enforcement lives:**

**出口判定（纯函数）：**

```rust
// src-tauri/src/lib.rs:304-318
/// 「这第二次启动该不该真的起一个新进程」的判定（纯函数、可单测）。
///
/// 只有**开发与测试的多开出口**算该：双实例 E2E harness 起实例时带
/// `GOSSLAN_INSTANCE=<n>`（见 `scripts/e2e/core.mjs`），并常配 `GOSSLAN_AUTOSTART=1` 选绑定地址。
#[cfg(all(desktop, any(target_os = "macos", windows, target_os = "linux")))]
pub(crate) fn allow_second_instance_launch(
    instance_env: Option<&str>,
    autostart_env: Option<&str>,
) -> bool {
    instance_env.is_some() || autostart_env == Some("1")
}
```

**注册处：**

```rust
// src-tauri/src/lib.rs:372-382
// 单实例守卫：第二个进程不再建窗，而是把**已有那份**主窗叫到前台。
// 平台清单必须与 Cargo.toml 里那条依赖的 `cfg` 同一组（判据在 lib_startup_config_tests）。
#[cfg(all(desktop, any(target_os = "macos", windows, target_os = "linux")))]
if !allow_second_instance_launch(
    std::env::var("GOSSLAN_INSTANCE").ok().as_deref(),
    std::env::var("GOSSLAN_AUTOSTART").ok().as_deref(),
) {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        crate::tray::show_main_window(app);
    }));
}
```

- What it checks, and against what：
  - 规则 1：插件回调里**只**调 `crate::tray::show_main_window(app)`（`:380`）—— 不建窗、不起后台 ⇒ 第二个进程的结局是"把已有主窗叫到前台" ✓
  - 规则 2：`allow_second_instance_launch` 是纯函数，只认 `GOSSLAN_INSTANCE`（**存在**即放行，含空串）或 `GOSSLAN_AUTOSTART == "1"`（**严格等于 "1"**）⇒ 真用户环境（两个变量都没设）⇒ 拦 ✓
  - 规则 3：注册处与纯函数本体都带 `#[cfg(all(desktop, any(target_os = "macos", windows, target_os = "linux")))]` ⇒ 移动端不编译这段 ✓

**依赖声明：**

```toml
# src-tauri/Cargo.toml 的 [target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies] 一节
tauri-plugin-single-instance = ...
```

**Paths walked:**
- 真用户第二次启动（`GOSSLAN_INSTANCE` 未设、`GOSSLAN_AUTOSTART` 未设）⇒ `allow_second_instance_launch(None, None)` = `false` ⇒ `!false` = true ⇒ **插件被注册** ⇒ 第二个进程被插件拦下并把已有主窗叫到前台 ✓
- 双实例 E2E harness（`GOSSLAN_INSTANCE=2`）⇒ `instance_env.is_some()` = true ⇒ `allow_second_instance_launch` = true ⇒ `!true` = false ⇒ **插件不注册** ⇒ 放行第二实例 ✓
- headless 起绑定地址（`GOSSLAN_AUTOSTART=1`，无 `GOSSLAN_INSTANCE`）⇒ `autostart_env == Some("1")` = true ⇒ 放行 ✓
- `GOSSLAN_AUTOSTART=0` 或 `="yes"` ⇒ `== Some("1")` 为 false ⇒ `instance_env` 也不存在 ⇒ **拦** ✓（真值表判据的反证两格）
- 移动端（android/ios）⇒ 整个 `if` 块被 `#[cfg(all(desktop, any(...)))]` 排除 ⇒ 不注册插件、不编译 `allow_second_instance_launch` ⇒ 移动端构建不受影响 ✓

**Searched:**
- `allow_second_instance_launch` → `lib.rs:313`（定义）+ `lib.rs:375`（唯一生产调用）+ `lib_startup_config_tests.rs:319/349-358`（真值表）✓ **生产调用点恰好 1 处**
- `tauri_plugin_single_instance::init` → `lib.rs:379`（唯一注册处）✓
- `GOSSLAN_INSTANCE` → `lib.rs:307`（注释）/`:376`（读）/ `state.rs:2885`（多开实例号解析，`--instance N` 优先其次环境变量）/ `lib_startup_config_tests.rs` ✓
- `GOSSLAN_AUTOSTART` → `lib.rs:307`（注释）/`:377`（读）/`:543`（**另一个职责**：选绑定地址 0.0.0.0）/`:555`（`forced`）/ `lib_startup_config_tests.rs:164`（另一条用例：`GOSSLAN_AUTOSTART=1` **不许**把用户显式关掉的局域网判成开）⇒ 这个变量有两个职责：单实例放行 + 绑定地址；两条判据分别钉住（`lib_startup_config_tests.rs:154-190` 与 `:349-358`）✓
- `show_main_window` → `lib.rs:380`（唯一调用点）+ `src-tauri/src/tray.rs`（定义）✓
- `tauri-plugin-single-instance` in `Cargo.toml` → 命中（判据 `lib_startup_config_tests.rs:331-335` 断言 `code_flat(cargo).contains("tauri-plugin-single-instance")`）✓
- `[target.'cfg(any(target_os = "macos", windows, target_os = "linux"))'.dependencies]` → 命中（`lib_startup_config_tests.rs:341-343` 断言 `cfg(all(desktop,any(target_os="macos",windows,target_os="linux")))` 这串字面量）✓
- `WebviewWindowBuilder` → 文档说"全仓只有 `commands/logs.rs` 的五处辅助窗在用，前端 0 处 `new WebviewWindow`"—— 未逐条复验，但 `lib_window_tests.rs` 有"谁都不许按 label 分支渲染聊天"的判据（文档 §32 引它作为"两扇主框只能是两个进程"的依据）

**Hook verification:**
- `tests::second_launch_focuses_the_running_app_instead_of_duplicating_it` — **存在**：`src-tauri/src/lib_startup_config_tests.rs:300` ✓（基线命中）。它断言四件事：① `src.contains("tauri_plugin_single_instance::init(")`；② 注册处**上下 1200/600 字节窗口**内含 `allow_second_instance_launch(`；③ 同窗口内含 `crate::tray::show_main_window(`；④ `Cargo.toml` 含该依赖 + `lib.rs` 含那串 `cfg` 字面量。
- `tests::second_instance_exit_is_only_the_dev_multi_open` — **存在**：`lib_startup_config_tests.rs:348` ✓（基线命中）。六格真值表：无变量⇒拦 / `Some("2")`⇒放行 / `Some("1")` autostart⇒放行 / `Some("0")`⇒拦 / `Some("yes")`⇒拦 / `Some("")`⇒放行。
- `guards:第二次启动` — **存在**：`scripts/guard_cases/desktop_misc.py:255`，name 为"第二次启动不许再起一个实例（只能回显已有的那个）" ✓（实测 name 命中 1 次）

三条全部存在并注册。

**How the verdict was reached:** 三条规则逐条对上号：规则 1 的插件回调只调 `show_main_window`（不建窗、不起后台）；规则 2 的出口判定是纯函数且真值表双向钉住（6 格）；规则 3 的 `cfg` 与 Cargo.toml 依赖两处都在且被形状判据钉住。文档自己如实登记的边界（"不同 bundle 之间不去重 ⇒ dev 构建与已安装那份仍是两个进程"）在代码里**确实如此**（插件按可执行文件/应用标识分组），文档没有把它说成已解决。定为 `implemented`。

**Open questions:**
- 文档规则 3 自陈的不足："只把 `Cargo.toml` 那一节的平台清单改宽，今天不会红（判据只要求'这条依赖存在'）"。这一点在代码里成立 —— `lib_startup_config_tests.rs:331-343` 的两条断言分别检查"依赖存在"与"注册处那串 cfg 字面量"，**没有**比对两边的平台清单是否同构。一致性靠注释 + 移动端构建门禁。
- 文档说"不同 bundle 之间不去重"是已知边界；这条边界今天是否还有别的入口（`app identifier` 互斥）由负责人决定 —— 代码里没有按 app identifier 的互斥实现。
- `GOSSLAN_AUTOSTART` 有两个职责（单实例放行 + 绑定地址）。若某个用户环境里这个变量恰好被设为 `"1"`（例如某个 shell profile），则第二个进程会被**放行** ⇒ 单实例守卫失效。文档没有讨论这个环境变量泄漏到用户环境的风险。
