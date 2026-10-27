#!/usr/bin/env bash
# 把一个 tag 的构建产物挂到 GitHub Release。
#
# 为什么从三份 YAML 里抽出来（2026-09-30 实测）：`build.yml` / `build-macos.yml` / `build-android.yml`
# 各带一个 `release:` 任务，同一个 tag 三条**并发**跑，而旧写法是「先查不存在 ⇒ 再创建」——
# 这个窗口里的第二家会拿到 "Release already exists" 而整步判红（⚠️ 但 2026-09-30 那次三条全红**不是**这个 ——
# 见下面「今天的第二次纠正」：真因是缺仓库上下文，这段并发窗口只是它顺手一起收掉的旧隐患）。创建那一步当时**没有**重试，
# 只有上传有；而这段逻辑抄三份本身就是一份会漂的真相。
#
# 今天的第二次纠正（v4.31.40 那次三条全红，逐 step 现读后才看清）：
# ★ 每一条 `gh release ...` 都必须显式带 `--repo`。这个 job 里**没有 actions/checkout**
#   （它只下载产物），而 `gh release create/upload` 要从 git 工作目录或参数里推出仓库上下文 ——
#   不在仓库里又不带 `--repo` 就直接失败。同一段脚本里 `gh api repos/$repo/...` 因为手写全路径
#   "看着是好的"，所以失败点被藏在下一行，CI 只留一句 "Process completed with exit code 1."。
#
# 现在的规则：
# 1. 创建是**幂等**的：已存在就复用；创建失败后**再查一次** —— 被并发的另一条建好就认它并继续上传，
#    仍然不存在才算真失败（401/403/网络坏绝不许被读成"成功"）。
# 2. 上传带退避重试，超过上限就非零退出（不 `continue-on-error`，不发半份）。
# 3. 产物目录不存在或是空的 ⇒ 直接红：宁可不发，也不发一个"看起来发好了而附件少一档"的 Release。
#
# 本地怎么验（不需要凭据、不需要 runner）：`node --test scripts/publishRelease.test.ts`
# 用一份假 `gh` 把七种结局各跑一遍（含"创建真失败必须是红"这一条）。
set -euo pipefail

assets_dir="assets"
max_attempts="${GOSSLAN_RELEASE_UPLOAD_ATTEMPTS:-5}"
sleep_base="${GOSSLAN_RELEASE_SLEEP_BASE:-5}"
gh_bin="${GH_BIN:-gh}"
tag="${GOSSLAN_RELEASE_TAG:-${GITHUB_REF_NAME:-}}"
sha="${GOSSLAN_RELEASE_SHA:-${GITHUB_SHA:-}}"
repo="${GOSSLAN_RELEASE_REPO:-${GITHUB_REPOSITORY:-}}"
# 调用方自报的档位（base / webview2）。**不给默认值** —— 新加一档却忘了声明，
# 应当在这里红掉，而不是默默按 base 放行（那正是 2026-10-03 那个覆盖 bug 的形状）。
label="${GOSSLAN_RELEASE_LABEL:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --assets) assets_dir="$2"; shift 2 ;;
    --tag) tag="$2"; shift 2 ;;
    --sha) sha="$2"; shift 2 ;;
    --repo) repo="$2"; shift 2 ;;
    --attempts) max_attempts="$2"; shift 2 ;;
    --sleep-base) sleep_base="$2"; shift 2 ;;
    --label) label="$2"; shift 2 ;;
    *) echo "未知参数: $1（可用 --assets/--tag/--sha/--repo/--attempts/--sleep-base/--label）" >&2; exit 2 ;;
  esac
done

if [ -z "$tag" ] || [ -z "$repo" ]; then
  echo "缺 tag 或 repo（GITHUB_REF_NAME / GITHUB_REPOSITORY 都要在）" >&2
  exit 2
fi

# 空产物必须在任何 gh 调用**之前**拦下：少一档附件这件事 v4.31.37 已经发生过一次（那次是并发抢，
# 这次如果静默发空 Release，界面上会是"发版成功、下载页少文件" —— 更难查。
if [ ! -d "$assets_dir" ]; then
  echo "没有 $assets_dir 目录 ⇒ download-artifact 一条都没取到，拒绝发空 Release" >&2
  exit 1
fi
files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find "$assets_dir" -type f | sort)
if [ "${#files[@]}" -eq 0 ]; then
  echo "$assets_dir 里一个文件都没有 ⇒ 拒绝发空 Release" >&2
  exit 1
fi

# ⚠️ 档位标识守卫（2026-10-03，用户实报"Release 上看不到内置 WebView2 那个包"）。
#
# 事故机制：Windows 有**两档**产物，而 tauri 生成的 exe 文件名只由 `productName` + version
# 决定 ⇒ 两档的 exe **逐字同名**（`Gosslan_<版本>_<arch>-setup.exe`）。webview2 那档用
# `merge-multiple: true` 下载到同一目录时，**同名文件互相覆盖**，只剩一份，且不带任何
# webview2 标识 ⇒ 这一档在 Release 上彻底消失（而 run 是 Success，产物 176MB/187MB
# 明明都在，看板上一切正常 —— 静默覆盖就是这样藏住的）。
#
# 这道守卫的形状：**调用方必须自报档位**（`--label`）：
#   · `--label base`     = 默认档（裸名 exe 是**基线**，不许拦 —— 用户已经习惯那个文件名）
#   · `--label webview2` = 内置 WebView2 那一档（**必须**每个 exe 都带 `-webview2-bundled`）
# 别的 label 一律拒绝 —— 新加一档而忘了改名，就是下一个"静默覆盖"。
# ⚠️ 为什么不按"有没有裸名"一刀切：默认档的 exe 本来就是裸名（`Gosslan_…-setup.exe`），
#   那样判会把它一起拦掉，等于把唯一能用的那一档也弄红（我第一版就犯了这个错）。
bare_exe=$(find "$assets_dir" -type f -name '*-setup.exe' | sort || true)
labelled_exe=$(find "$assets_dir" -type f -name '*-webview2-bundled.exe' | sort || true)
if [ "$label" = "webview2" ]; then
  if [ -n "$bare_exe" ]; then
    echo "❌ 你是 webview2 那一档，但 $assets_dir 里有**不带标识**的安装包：" >&2
    echo "$bare_exe" | sed 's/^/     /' >&2
    echo "   两档 exe 文件名逐字相同（tauri 只用 productName+version 命名），挂同一个 Release" >&2
    echo "   时会同名覆盖 ⇒ 内置 WebView2 那一档会整个消失。必须先改名成" >&2
    echo "     <原名>-webview2-bundled.exe" >&2
    exit 1
  fi
  if [ -z "$labelled_exe" ]; then
    echo "❌ 你是 webview2 那一档，但 $assets_dir 里一个 *-webview2-bundled.exe 都没有。" >&2
    echo "   这一档就是给"装不上 WebView2 运行时的人"用的（企业版/Server 版 Windows），" >&2
    echo "   没有带标识的包等于这一档没发出来。" >&2
    exit 1
  fi
elif [ "$label" != "base" ]; then
  echo "❌ 未知档位 --label=${label}（可用：base / webview2）。" >&2
  echo "   新加一档时，先想清楚它的 exe 会不会与别的档**重名** —— 会，就必须改名。" >&2
  exit 1
fi

# ---- 发布门禁：同一个 commit 的 Verify 必须是绿的 ----
#
# 为什么闸放在这里而不是 workflow 的 `needs:`：四条构建腿是**各自独立的 workflow**，
# 而 `needs` 只能引用同一个 workflow 里的 job；发布逻辑又只有这一份（见文件头）。
# 于是闸放在"发版唯一入口"上：证明不了"这个 commit 跑过且跑绿了"，就不发。
#
# 只在 Actions 里判（GITHUB_ACTIONS=true）：本地与假 `gh` 的用例不该被网络/凭据卡住。
# 紧急放行：GOSSLAN_SKIP_VERIFY_GATE=1（会在日志里留一行大字）。
if [ "${GOSSLAN_SKIP_VERIFY_GATE:-0}" = "1" ]; then
  echo "⚠️ 已按 GOSSLAN_SKIP_VERIFY_GATE=1 跳过 Verify 门禁"
elif [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  if [ -z "$sha" ]; then
    echo "❌ 发布门禁需要 sha（GITHUB_SHA）才能查 Verify 结论" >&2
    exit 1
  fi
  # 打 tag 时 Verify 与构建是**并发**起来的：构建要十几分钟，通常门禁早就绿了；
  # 但刚推完就发版（或重跑）时它可能还在 queued/in_progress —— 这时**等**，不是立刻拒，
  # 否则"门禁还没跑完"会被读成"门禁失败"。等不到才拒（fail closed）。
  gate_attempts="${GOSSLAN_VERIFY_GATE_ATTEMPTS:-20}"   # 20 × 30s = 10min 上限
  gate_sleep="${GOSSLAN_VERIFY_GATE_SLEEP:-30}"
  attempt=0
  while :; do
    gate=$("$gh_bin" api "repos/$repo/actions/workflows/verify.yml/runs?head_sha=$sha&per_page=50" \
      --jq '[.workflow_runs[] | select(.event == "push")] | sort_by(.created_at) | last | (.conclusion // .status)' \
      2>/dev/null || true)
    case "$gate" in
      success)
        echo "Verify 已绿（sha=${sha}）⇒ 允许发布"
        break ;;
      queued|in_progress|requested|waiting|"")
        attempt=$((attempt + 1))
        if [ "$attempt" -ge "$gate_attempts" ]; then
          echo "❌ 拒绝发布：等了 ${attempt} 轮，commit $sha 的 Verify 仍是『${gate:-查不到}』。" >&2
          echo "   先让 Verify 跑绿；确认要跳过：GOSSLAN_SKIP_VERIFY_GATE=1" >&2
          exit 1
        fi
        echo "Verify 还没结论（${gate:-查不到}），${gate_sleep}s 后重试（${attempt}/${gate_attempts}）"
        sleep "$gate_sleep" ;;
      *)
        echo "❌ 拒绝发布：commit $sha 的 Verify 结论是『${gate}』（要求 success）。" >&2
        echo "   先让 Verify 跑绿再打 tag；确认要跳过：GOSSLAN_SKIP_VERIFY_GATE=1" >&2
        exit 1 ;;
    esac
  done
fi

release_exists() { "$gh_bin" api "repos/$repo/releases/tags/$tag" >/dev/null 2>&1; }
# ⚠️ **草稿 Release** 对 `releases/tags/<tag>` 是 404（2026-10-22 实测：人工在网页上建了草稿，
# 于是本脚本判"不存在"→ 去 create → 被顶成 "already exists" → 复查询又 404 → 整步判红）。
# 列表 API 带得出来（带 token 时草稿可见），所以再补一条"任何状态都算存在"的判据。
#
# ★ 2026-10-25 第三次纠正：这条判据以前只在 **create 失败后的复查询**里用，创建前的预检仍走
#   `releases/tags` ⇒ 四条构建腿（即使被 concurrency 串行）每一条都把前一条建的**草稿**当成
#   "不存在"，四条各建一个同 tag 的 Release（v5.8.0 / v5.8.5 实测各出现 4 个，只有 1 个带资产）。
#   预检必须用列表 API（草稿可见）—— 否则并发组只是让它们排队各建一次而已。
release_exists_any_state() {
  "$gh_bin" api "repos/$repo/releases?per_page=100" \
    --jq ".[] | select(.tag_name == \"$tag\") | .id" 2>/dev/null | grep -q .
}

if release_exists || release_exists_any_state; then
  echo "Release $tag 已存在（含草稿）⇒ 不重复创建，只补文件"
else
  # ★ 创建必须知道挂在哪条提交上。CI 里有 GITHUB_SHA，本地补挂没有 ⇒ 空 `--target` 会被 gh
  #   当成"找一个叫空字符串的对象"，报错还落在下一行，读起来像脚本坏了。所以在这里明确要参数。
  if [ -z "$sha" ]; then
    echo "Release $tag 不存在，而创建它必须知道挂在哪条提交 ⇒ 传 --sha（本地可用 git rev-parse $tag^{commit}）" >&2
    exit 2
  fi
  if ! create_err=$("$gh_bin" release create "$tag" --repo "$repo" --target "$sha" --draft --generate-notes --title "$tag" 2>&1); then
    echo "创建没成功（原样贴出，方便分清是被抢先建好还是权限/网络）："
    echo "$create_err"
    # ★ 竞争窗口就在这一次复查询里收掉：后到的那条不报错，它只是"来晚了"。
    if ! release_exists && ! release_exists_any_state; then
      echo "复查询仍说不存在（含草稿列表）⇒ 这不是并发，是真失败（不发半份）" >&2
      exit 1
    fi
    echo "是并发的另一条 / 或人工草稿 ⇒ 认它，继续上传"
  fi
fi

attempt=0
upload_err=""          # set -u 之下先给个初值：失败分支里那句"把原因贴出来"不许自己变成 unbound
while :; do
  if upload_err=$("$gh_bin" release upload "$tag" --repo "$repo" "${files[@]}" --clobber 2>&1); then
    break
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "挂了 $max_attempts 次仍失败 ⇒ 不假装成功" >&2
    echo "$upload_err" >&2
    exit 1
  fi
  echo "第 $attempt 次上传失败（${upload_err}），等 $((attempt * sleep_base))s 再试"
  sleep $((attempt * sleep_base))
done

echo "已把 ${#files[@]} 个文件挂到 ${tag}："
printf '  %s\n' "${files[@]}"

# ★ draft-until-complete（2026-10-23 用户拍板）：**本脚本绝不发布 Release**。
#   四条腿（mac / win base / webview2 / android）谁先跑完谁先传，谁都不能把半个 Release
#   对外公开 —— v5.5.22 只挂着 Android、v5.5.23 只挂着 WebView2+Android，都是这么来的。
#   「发布」是 `updater-manifest.yml` 那一步的职责：它等到四类产物 + latest.json 都齐了，
#   才 `--draft=false`。这里只负责建草稿、传文件。
echo "Release $tag 保持**草稿**（由 updater-manifest 在产物齐后统一发布）"
