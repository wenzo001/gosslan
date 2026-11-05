# AOCI 既有偏差登记（2026-11-05）

> 本文件是**已知偏差的账本**，不是待办清单。拍板口径见
> [`docs/aoci-usage.md` §9](../aoci-usage.md#9-2026-11-05-拍板只维护-orphan-与明显错账)。
> 所有数字都必须现算；下面每条读数都挂了复现命令。

## 1. 拍板口径

2026-11-05 决定：AOCI **只维护 orphan 与明显错账**（E 规模档位错配、演进叙事口径），
`code_missing` / `code_stale` / `code_unbaselined` 的存量**作为既有偏差等级**，
不再为了把 `governance_aligned` 拉成 `true` 而逐条追全量对齐。

`aoci check` 因此**长期退 1**。这是登记在案的已知状态，不是新一轮回归：
判「有没有回归」要看本文件的分类计数有没有变坏，而不是看退出码。

## 2. 当次读数（2026-11-05，`aoci check --json`）

| 类别 | 条数 | 说明 |
|---|---:|---|
| `code_skipped` | 291 | 合同免条目（二进制 / 超 1 MiB），不用处理 |
| `code_stale` | 169 | 已收录但源码变了 ⇒ 条目过期（含本轮临时落盘的 `todo_tags.rs`，见 §4） |
| `code_missing` | 129 | 磁盘有、索引没有（见 §3 聚合） |
| `code_unbaselined` | 129 | 未进基线指纹的新文件（与 missing 基本同一批） |
| `code_orphan` | **0** | 已消解（见 §4） |
| **合计** | **718** | |

其它现读：`structure_valid=true`、`governance_aligned=false`、S 覆盖 570/570、
`next_action=authoring_required`、`aoci check` 退 1。

与上一组读数（missing 128 / stale 168 / unbaselined 128 / skipped 291 / orphan 1，合计 716）的差值全部可解释：

- `-1 orphan`：`todo_tags.rs` 落盘后不再是 orphan，转为 `code_stale`（磁盘内容 ≠ 基线指纹）；
- `+1 stale`：即上面那条转移；
- `+2`（missing / unbaselined 各 +1）：本文件自身是新增未收录文件（见 §5）。

**`audit.warnings`**：rc18 的 `check --json` / `verify --json` 顶层都没有这个字段
（`check` 的键只有 `ok`、`exit_code`、`structure_valid`、`governance_aligned`、`findings`、
`next_action`、`governance`）。该版本无此字段，用 `findings` 分类计数替代。

## 3. `code_missing` 按目录聚合（129 条）

| 目录 | 条数 |
|---|---:|
| `src/utils/` | 64 |
| `src/components/` | 26 |
| `src/stores/` | 9 |
| `src/updater/` | 7 |
| `src/composables/` | 6 |
| `src-tauri/src/` | 3 |
| `src/router/` | 3 |
| `src-tauri/`（顶层文件） | 2 |
| `src/boot/` | 2 |
| `src/entries/` | 2 |
| `docs/notes/` | 1 |
| `src/directives/` | 1 |
| `src/styles/` | 1 |
| `src/workers/` | 1 |
| 仓库根 | 1 |

形态说明：绝大多数落在前端 `src/` 下，是并行分支在途文件与新拆模块，属于"条目还没建"，
不是"条目写错"。这批不补，直到下次全量对齐或大改架构时统一重做。

## 4. orphan：已消解（`code_orphan=0`）

`src-tauri/src/db/todo_tags.rs`：该文件在 `origin/main`（`c434df67`）上存在（270 行、11068 字节），
条目 `todo_tags.rs[AP9M]` 与文件内容一致；本地 HEAD（`bc515fcd`）落后远端 1 笔，
且有 6 个在途 Rust 文件与 upstream 改动重叠，`git merge --ff-only` 被拒，治理侧因此判 orphan。

处理：`git checkout origin/main -- src-tauri/src/db/todo_tags.rs` **单文件临时落盘**，
不提交、不 stash、不 rebase（那 6 个文件是别的会话的在途工作）。落盘后 `aoci check`
的 `code_orphan` 从 1 变 0；条目本身**未改**（内容一致，没有可改的理由）。
该文件现读 `code_stale`（磁盘内容 ≠ 基线指纹），等主线本地快进、基线随之刷新后自然一致，
不会被误当新增对象。

## 4.1 E 规模档位错配

机器判据只在 `aoci update-entry` 的校验里出现（`E规模档位错配：文件 N 行按字典应为 X，条目标注 Y`）；
`check` / `verify` 在 Volumes v1 下**不输出**这一项，`aoci index score --dim escale` 直接退 3
（`error_code=config`，「该命令或兼容写入路径不支持修改Volumes v1正式认知」）。
所以下面这个数是用**同一条口径**自算的：全文件行数 vs 字典 `L>400 / M200-400 / S100-200 / T<100`。

| 项 | 数值 | 口径 |
|---|---:|---|
| 本轮实修 | 2 | `AI_PROJECT_HANDOFF.md SG7L→SG7S`（185 行）、`CONTEXT.md SB6S→SB6T`（62 行） |
| 复核为正确、未动 | 2 | `README.md SG8S`（121 行 → S，本就正确）、`docs/domains.data.mjs XG8L`（560 行 → L，本就正确） |
| 全库存量 | 115 | 全文件行数口径（见 §5 复现脚本）；按目录：`src/utils/` 29、`scripts/e2e/rounds/` 17、`scripts/` 13、`src/components/` 11、`src-tauri/src/mesh/` 5 等 |

**115 条系统性错配本轮不动**：rc18 在 Volumes v1 下没有批量 escale 判据，
逐条改需要 115 次单条写入、且多数属于"文件生长跨档"这种良性漂移。
等 `index score --dim escale` 恢复、或 AOCI 二进制升级带来批量判据后统一处理。
（曾有一笔"9 条"的口头记录，可在本仓任何产物里都复现不出来——记忆里只留了
"3 条 E 档位错配 warning 属于文件生长跨档"，对应上面实修的 2 条 + 本就正确的 README 1 条。）

## 5. 复现命令

```bash
# 分类计数
aoci --repo . check --json | python3 -c 'import json,sys,collections;f=json.load(sys.stdin)["findings"];print(collections.Counter(x["code"] for x in f).most_common())'
# 按目录聚合 missing：
aoci --repo . check --json | python3 -c '
import json,sys,collections
d=json.load(sys.stdin);c=collections.Counter()
for f in d["findings"]:
    if f["code"]=="code_missing":
        p=f["target"].split("/");c["/".join(p[:2])+"/" if len(p)>2 else "./"]+=1
print(c.most_common())'
# E 档位自算（与 update-entry 的提示同口径：全文件行数）：
python3 - <<'PY'
import re,os
cur=None;mis=[]
for l in open('aoci.code.txt',encoding='utf-8'):
    m=re.match(r'^===(\S+)===$',l.rstrip('\n'))
    if m: cur=m.group(1); continue
    m=re.match(r'^(\S+\.\w+)\[([A-Z0-9]{2,4})\]: ',l)
    if m and cur:
        p=cur+m.group(1); tag=m.group(2)
        if not os.path.exists(p): continue
        n=sum(1 for _ in open(p,'rb'))
        want='L' if n>400 else 'M' if n>200 else 'S' if n>=100 else 'T'
        if want!=tag[-1]: mis.append((p,tag,n,want))
print(len(mis)); [print(*x) for x in mis]
PY
```

## 6. 什么时候恢复全量对齐

满足任一条件就重做一次逐批维护，直到 `aoci index agent guide --agent <宿主名>` 回到
`stage=aligned / complete=true / next_action=none`：

1. **大改架构**：目录级重构、模块拆分或合并，导致 missing 的分布与条目疆界整体变化；
2. **换 AOCI 二进制大版本**且 `scope` / `budget` 的 policy identity 发生变化（见 `docs/aoci-usage.md` §8.6）；
3. `code_missing` 或 `code_stale` 相对本文件 §2 的读数**明显变坏**（不是抖动，是成批增长）。

除此之外，本轮及后续的日常维护只处理 orphan 与本文件列明的明显错账。
