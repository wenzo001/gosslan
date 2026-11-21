#!/usr/bin/env bash
# =============================================================================
#  移动端编译门禁（Android target 的 cargo check，含 0 warning 判定）
#
#  为什么需要它：`cargo test --lib` 只按**桌面口径**检查，于是"移动端整包编不出来"
#  能一路合进主干。真实事故（2026-09-12）：`lib.rs` 的 `generate_handler!` 无条件列出
#  四个 `#[cfg(desktop)]` 命令（设置/日志窗口），`#[tauri::command]` 的包装宏跟着函数
#  被裁掉 ⇒ Android 目标 **8 个 E0433**，整个安卓包打不出来，而当时没有任何守门。
#
#  用法：
#    bash scripts/check-mobile.sh              # 两个 ABI 的 cargo check（快，日常用）
#    bash scripts/check-mobile.sh --bluetooth  # 额外验证 BLE feature 在该目标上也能编
#    bash scripts/check-mobile.sh --release    # 额外跑 `cargo build --release --lib`（慢，CI/发版前用）
#
#  为什么有两个 ABI：发版只出 aarch64 + armv7（见 .github/workflows/build-android.yml），
#  门禁必须与发版 ABI 一一对应 —— **只查 64 位会漏掉一整类 32 位问题**。
#  2026-11-21 实测：`MAX_DB_BYTES: usize`（2 GiB）在调用处 `* 2`，armv7 的 32 位 usize 上
#  是 `2^31 * 2 = 2^32` ⇒ `#[deny(arithmetic_overflow)]` 编译失败，而 aarch64 是 64 位、
#  完全通过 ⇒ 本地两档全绿，CI 的 armv7 腿把整条 Android 打包打成红。
#
#  为什么 `--release` 单独一档：上面那条溢出**只在 codegen/优化期**触发，
#  `cargo check`（debug 或 --release）都**不报** —— 实测 aarch64/armv7 的 check 全绿，
#  只有 `cargo build --release` 会红。所以日常用 check 求快，CI 用 --release 求真。
#
#  依赖：已装 Android NDK（默认在 ~/Library/Android/sdk/ndk/<版本>）与
#        `rustup target add aarch64-linux-android armv7-linux-androideabi`。
#  退出码：0 = 通过（且 0 warning）；非 0 = 失败（原因打印在最后）。
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WITH_BT=0
WITH_RELEASE=0
for arg in "$@"; do
  case "$arg" in
    --bluetooth) WITH_BT=1 ;;
    --release) WITH_RELEASE=1 ;;
  esac
done

# 发版 ABI 清单（与 build-android.yml 的 targets 保持一致）
TARGETS=("aarch64-linux-android" "armv7-linux-androideabi")

# ---- 找 NDK ----
NDK_ROOT="${ANDROID_NDK_ROOT:-}"
if [ -z "$NDK_ROOT" ]; then
  # ⚠️ `$ANDROID_HOME` 必须写成 `${ANDROID_HOME:-}`：本脚本开了 `set -u`，而未导出的变量
  # 在 `for` 的**列表展开阶段**就会让脚本当场死掉
  # （`ANDROID_HOME: unbound variable`），连下面那句"找不到 NDK，请设置 ANDROID_NDK_ROOT"
  # 的自带报错都到不了 —— 于是 NDK 其实装在 `~/Library/Android/sdk/ndk/` 的机器
  # （只导出了 ANDROID_NDK_ROOT 或干脆靠默认路径）也照样跑不了这道门禁。
  for base in "$HOME/Library/Android/sdk/ndk" "${ANDROID_HOME:-}/ndk" "/usr/local/share/android-ndk"; do
    [ -d "$base" ] || continue
    NDK_ROOT="$base/$(ls "$base" | sort -V | tail -1)"
    break
  done
fi
if [ -z "$NDK_ROOT" ] || [ ! -d "$NDK_ROOT" ]; then
  echo "[错误] 找不到 Android NDK。请设置 ANDROID_NDK_ROOT，或装到 ~/Library/Android/sdk/ndk/"
  exit 2
fi
HOST_TAG="$(ls "$NDK_ROOT/toolchains/llvm/prebuilt" | head -1)"
TOOLCHAIN="$NDK_ROOT/toolchains/llvm/prebuilt/$HOST_TAG/bin"

# ---- Rust target → NDK ABI 前缀（armv7 在 NDK 里叫 armv7a）----
ndk_triple() {
  case "$1" in
    armv7-linux-androideabi) printf 'armv7a-linux-androideabi' ;;
    *) printf '%s' "$1" ;;
  esac
}

# ---- 目标是否已装（缺一个就不跑：门禁不完整等于没门禁）----
MISSING=""
for t in "${TARGETS[@]}"; do
  rustup target list --installed 2>/dev/null | grep -qx "$t" || MISSING="$MISSING $t"
done
if [ -n "$MISSING" ]; then
  echo "[错误] 缺少 Rust 目标：${MISSING# }"
  echo "       请先：rustup target add ${TARGETS[*]}"
  exit 2
fi

cd "$ROOT/src-tauri" || exit 1

# 每个 target 的 CC/AR/linker 都要单独导出：cargo 按 target 名查环境变量，
# 只设 aarch64 那三个的话 armv7 会去调 host cc ⇒ 链接期一堆 "unknown target"。
setup_target() {
  local target="$1"
  local triple clang und up
  triple="$(ndk_triple "$target")"
  clang="$TOOLCHAIN/${triple}24-clang"
  if [ ! -x "$clang" ]; then
    echo "[错误] 找不到 NDK clang：$clang"
    return 2
  fi
  und="${target//-/_}"
  up="$(printf '%s' "$und" | tr 'a-z' 'A-Z')"
  export "CC_${und}=${clang}"
  export "AR_${und}=${TOOLCHAIN}/llvm-ar"
  export "CARGO_TARGET_${up}_LINKER=${clang}"
  return 0
}

# 包名（`cargo clean -p` 要用）。从 Cargo.toml 读，不写死。
PKG_NAME="$(sed -n 's/^name[[:space:]]*=[[:space:]]*"\(.*\)"/\1/p' Cargo.toml | head -1)"

# ⚠️ 为什么要 `cargo clean -p`：cargo 的增量缓存会**记住**已经报过的 warning 并不再打印，
#    于是"第二次跑 0 warning"只是缓存假象 —— 判据看起来全绿，实际一条都没看到。
#    2026-11-21 在 CI 上实测到这个假绿：日志里明写 `generated 7 warnings`，
#    脚本却判 `PASS（0 warning）`。只清本 crate（不动依赖），代价是一次 ~20s 重编。
force_recompile() {
  [ -n "$PKG_NAME" ] && cargo clean -p "$PKG_NAME" >/dev/null 2>&1 || true
}

# ⚠️ 为什么每条 cargo 命令都带 `--color never`：CI 的 `CARGO_TERM_COLOR=always` 会给
#    `warning:` 前面塞 ANSI 前缀（`\e[1mwarning:`），`grep '^warning'` 就永远数不到。
#    这是同一个假绿的第二半。别依赖外部环境变量，命令里写死。
run_check() {
  local target="$1" label="$2"; shift 2
  echo "==> $label"
  force_recompile
  local out code warns
  out="$(cargo check --lib --color never --target "$target" "$@" 2>&1)"
  code=$?
  echo "$out" | tail -5
  warns="$(printf '%s\n' "$out" | grep -c '^warning' || true)"
  if [ "$code" != "0" ]; then
    echo "FAIL | ${label}: 编译失败（退出码 ${code}）"
    printf '%s\n' "$out" | grep -E '^error' | head -10
    return 1
  fi
  if [ "$warns" != "0" ]; then
    echo "FAIL | ${label}: 有 ${warns} 条 warning（项目铁律是 0 warning）"
    printf '%s\n' "$out" | grep -E '^warning' | head -10
    return 1
  fi
  echo "PASS | ${label}（0 warning）"
}

# 只给 CI / 发版前用：`cargo check` **不做 codegen**，所以那类"常量表达式在 32 位上溢出"
# 的错误它一条也看不见（实测 aarch64/armv7 的 check 全绿，只有 build 红）。
run_release_build() {
  local target="$1" label="$2"; shift 2
  echo "==> $label"
  force_recompile
  local out code
  out="$(cargo build --release --lib --color never --target "$target" "$@" 2>&1)"
  code=$?
  echo "$out" | tail -5
  if [ "$code" != "0" ]; then
    echo "FAIL | ${label}: release 构建失败（退出码 ${code}）"
    printf '%s\n' "$out" | grep -E '^error' -A 5 | head -30
    return 1
  fi
  echo "PASS | ${label}"
}

# 仓库内已有一份 CARGO_HOME（target/ 已被 gitignore）时优先用它：
# 受管沙箱 / 部分 CI 里 `~/.cargo` 是**不可写**的，否则会以
# "failed to open ~/.cargo/registry/cache/….crate: Operation not permitted" 这种
# 与代码无关的形态失败（`scripts/verify-guards.py` 里也是同一个处理）。
if [ -z "${CARGO_HOME:-}" ] && [ -d "$ROOT/target/cargo-home" ]; then
  export CARGO_HOME="$ROOT/target/cargo-home"
fi

FAIL=0

# ---- 静态守卫：`native_method!` 的上一行必须是 `#[allow(deprecated)]` ----
# 为什么单独守：jni-macros 0.22.4 的宏展开体用了 rustc 1.100 起废弃的
# `Atomic::fetch_update`（上游未适配），只能在调用点就地压住。漏一处时，
# 下面的 run_check 只会说「有 1 条 warning」，不会指出是哪一处 —— 所以在这里先点名。
echo "==> 静态守卫：native_method! 的 allow(deprecated)"
while IFS= read -r hit; do
  [ -n "$hit" ] || continue
  f="${hit%%:*}"
  rest="${hit#*:}"
  ln="${rest%%:*}"
  prev="$(sed -n "$((ln - 1))p" "$f" 2>/dev/null)"
  case "$prev" in
    *"#[allow(deprecated)]"*) ;;
    *)
      echo "FAIL | ${f}:${ln} 的 native_method! 上一行缺 #[allow(deprecated)]"
      FAIL=1
      ;;
  esac
done < <(grep -rnE "^[[:space:]]*const [A-Za-z_]+: NativeMethod = native_method! \{" --include=*.rs . 2>/dev/null | sed 's|^\./||')
[ "$FAIL" = "0" ] && echo "PASS | native_method! 调用点全部已压 deprecated"

for T in "${TARGETS[@]}"; do
  setup_target "$T" || { FAIL=1; continue; }
  run_check "$T" "Android ${T}（默认 feature）" || FAIL=1
  if [ "$WITH_BT" = "1" ]; then
    run_check "$T" "Android ${T}（--features bluetooth）" --features bluetooth || FAIL=1
  fi
  # 只对 **32 位** 跑 release 构建：`cargo check` 看不见的 codegen 错误里，最典型的是
  # "常量算术在 32 位 usize 上溢出"（本次事故），而 64 位的 release 构建由
  # build-android.yml 的每次 push 出包覆盖（那里两个 ABI 都编 release），不必在这儿重复。
  if [ "$WITH_RELEASE" = "1" ] && [ "$T" = "armv7-linux-androideabi" ]; then
    run_release_build "$T" "Android ${T}（release --lib，只查 32 位）" || FAIL=1
  fi
done

if [ "$FAIL" = "0" ]; then
  echo "==> 全部通过"
else
  echo "==> 有失败项（见上）"
fi
exit "$FAIL"
