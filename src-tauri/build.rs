fn main() {
    tauri_build::build();

    // 2026-10-23（CI 诊断直接点名 comctl32.dll!TaskDialogIndirect）：`rfd`
    // （tauri-plugin-dialog）静态导入这个只有 Common-Controls **v6** 才有的符号；
    // 正式二进制由 tauri-build 嵌了带 v6 依赖的清单，而 libtest 的测试壳没有 ⇒
    // Windows 上 `cargo test` 在**加载期**就以 0xc0000139 死掉、零测试输出。
    // 只给**测试目标**补一条 v6 依赖（app 构建不受影响，也不改全局 rustflags）。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}
