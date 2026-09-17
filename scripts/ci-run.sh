#!/usr/bin/env bash
# =============================================================================
#  CI 命令包装：失败时把「诊断」合成 **一条多行 check 注解**，再以原退出码退出。
#
#  ## 为什么必须有它
#
#  CI 红了之后，三条诊断渠道实测只有一条能用：
#
#    ① `actions/jobs/{id}/logs` API   → 匿名 **403**（"Must have admin rights"）
#    ② 浏览器打开 job 日志页           → **"Sign in to view logs"**
#                                        （**公开仓库也要登录**，用 Playwright 验过）
#    ③ check-run 注解                  → ✅ 可匿名读：
#         https://api.github.com/repos/O/R/check-runs/{job_id}/annotations
#
#  ⇒ 失败诊断必须**放进注解**，否则红了也看不到原因。
#
#  ## 两个踩过的坑（都在下面处理了）
#
#  · **只挑关键行**，不整段照搬 —— GitHub 每个 step 只保留约 **10 条**注解。
#    第一版把日志末 30 行逐行 emit，结果拿到的全是 `... ok`，真正的错误落在截断之外。
#    这里改为合成**一条**多行注解（换行编码为 `%0A`），并只取关键行。
#  · **变量写成 `${var}`** —— 裸写 `$var` 紧跟中文全角括号时会被多字节字符带偏
#    （实测 `$status（` 输出成乱码）。
#
#  ## 用法
#
#      bash scripts/ci-run.sh "<标签>" <命令> [参数...]
#
#  ⚠️ Windows runner 上必须显式 `shell: bash`（用 Git Bash）——
#     本脚本依赖 tee / grep / tail / tr / node，这些在 Git Bash 里都有。
# =============================================================================
set +e

label="$1"
shift

if [ -z "${label}" ] || [ "$#" -eq 0 ]; then
  echo "用法: bash scripts/ci-run.sh \"<标签>\" <命令> [参数...]" >&2
  exit 2
fi

# 标签进文件名：只保留安全字符
slug=$(printf '%s' "${label}" | tr -c 'A-Za-z0-9._-' '_')
log="${TMPDIR:-/tmp}/ci-run-${slug}.log"

"$@" 2>&1 | tee "${log}"
status=${PIPESTATUS[0]}

if [ "${status}" -eq 0 ]; then
  exit 0
fi

{
  echo "[${label}] 退出码 ${status}（输出共 $(wc -l < "${log}") 行）"
  # 磁盘余量：冷编译 tauri 很占空间，runner 磁盘打满是 exit 101 的常见成因
  df -h . 2>/dev/null | tail -1
  echo "---- 关键行（test result / error / failures / panic / 信号 / 本仓库脚本的失败标记）----"
  grep -E 'test result:|^error|^failures:|^---- |FAILED|panicked|SIGKILL|signal|Caused by|No space|✗|❌' \
    "${log}" | tail -10
  # ⚠️ 结尾**逐字**保留 25 行：脚本类失败（清单守卫、护栏）的诊断**常常是"标题行 + 缩进列表"**，
  #    只靠上面的 grep 会只剩标题、把列表整段丢掉 —— 2026-09-16 引导 Windows 基线时踩到：
  #    拿到「基线里的 8 条用例没有跑」，但那 8 个名字一个都没看到，白跑一轮 CI。
  echo "---- 输出最后 25 行（逐字，脚本类失败的列表在这里）----"
  tail -n 25 "${log}"
} > "${log}.diag" 2>/dev/null

cat "${log}.diag"

# 单条多行注解：`%` 先转义成 `%%`，再把换行编码为 `%0A`。
node -e '
  const fs = require("fs");
  const m = fs.readFileSync(process.argv[1], "utf8");
  process.stdout.write(
    "::error::" +
      m.replace(/%/g, "%%").replace(/\r/g, "").replace(/\n+$/, "").replace(/\n/g, "%0A") +
      "\n"
  );
' "${log}.diag"

exit "${status}"
