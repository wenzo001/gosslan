#!/usr/bin/env python3
"""非空转验证（guard non-vacuity harness）。

## 为什么要有这个脚本
本项目有一条铁律：**每加一条守门测试，都必须证明它真的会失败**（"临时改坏 → 判据必须 FAIL →
恢复 → 才提交"）。此前这一步靠人手做，于是有三类真实风险：

1. 写了护栏但**从没验证过它会失败**（等于没有护栏）；
2. 验证时改坏的地方**改回去了没有、有没有残留**，全靠自觉；
3. 换人/换轮次后，没人知道哪条护栏被证明过。

本脚本把这件事变成一条命令：对每条护栏施加一处**最小、真实**的破坏，
断言对应测试**必须失败**（且红必须由它自己声明的那句 `expect_fail_hint` 报出来）；
然后**逐字节**恢复源码并核对确实回到原样；干净源码上"这些测试是绿的"由**每通道一次基线**负责。
最后逐条打印结果与耗时账，并保证无论如何都恢复现场（`try/finally` + 内容级恢复）。

⚠️ 2026-10-26 之前这里是"恢复后再把整条命令跑一遍"。那一遍证的就是上面后两件事，
而两件事都有更强也更便宜的证法（字节比对是"无残留"的定义本身；基线跑的是整套断言），
所以逐条重跑被撤了 —— **不是放宽，是同一语义换到更强的证据上**，详见 `verify()` 里那段注释。

## 用法
    python3 scripts/verify-guards.py                # 全部用例（条数看 --print-lanes 的 all=）
    python3 scripts/verify-guards.py --print-lanes  # 只报通道分母，不注入不编译
    python3 scripts/verify-guards.py --lane cargo   # 只跑某个耗时通道（通道按 cmd 现推，见 lane_of）
    python3 scripts/verify-guards.py --only rust    # 只跑名字/标签里含该子串的用例
    python3 scripts/verify-guards.py --only frontend  # 每次 push 的 CI 前端腿就是这个筛法
    python3 scripts/verify-guards.py --list         # 只跑起跑前静态核对并列用例（不注入、不编译）

耗时**一律看每次跑打印的 `GUARD_TIMING` 与通道账**，这里不留可抄的数（2026-10-26 之前
  这一段就抄过"十几秒"和"约 10 分钟"两个错值）。当时的量级读数：一次整库重编译 ≈ 30s，
  `node --test` 通道每条 1~4s，`script` 通道每条 <1s。

## 被中断也安全
`SIGTERM`/`SIGINT`（Ctrl-C）会**先把当前注入的文件恢复**再退出，
`atexit` 再兜一层 —— 否则一次误杀会留下一个"被改坏"的工作区（这个坑真踩过）。

退出码：0 = 全部符合预期；1 = 有护栏"改坏了也不报"或"恢复后仍失败"。
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path



def read_source(path: Path) -> str:
    """读源码文本 —— **逐字节保真**（`newline=""` + 显式 UTF-8）。

    为什么不能直接用 `read_text()`：
    · 默认的通用换行会把 CRLF 收成 LF，写回去时又按 `os.linesep` 变成 CRLF；
    · 默认编码是**系统 locale**（中文 Windows 上是 GBK）。

    于是一轮护栏跑完就能把工作区的 LF 文件改成 CRLF（仓库明确要求 LF，见 `.gitattributes`），
    中文注释还可能被按错误编码往返一次。2026-09-16 在 Windows 上实测到了这个副作用。

    ⚠️ 为什么要走 `path.open()` 而不是 `path.read_text(newline=…)`：`newline` 是
    **Python 3.13** 才加进 `Path.read_text/write_text` 的参数，在 3.12 上直接
    `TypeError: read_text() got an unexpected keyword argument 'newline'` ——
    整份 verify-guards 会因此**一条都跑不了**（表现为 40 条全报"验证过程出错"；
    2026-09-17 在 Windows + Python 3.12.10 上实测）。`Path.open()` 自 3.0 起就接受
    `newline`，与原来的语义完全一致。
    """
    with path.open("r", encoding="utf-8", newline="") as f:
        return f.read()


def _list_includes(root_file: Path) -> list[Path]:
    """递归解析根文件里的 `include!("...");` 指令，返回所有被包含的子模块路径。

    物理拆分后 commands.rs / db.rs 只剩 include! 指令，但锚点可能藏在任何一层
    子模块里（子模块里还可以 include 别的子模块 — Rust 的 include! 是递归的）。
    本函数模拟 Rust 的解析行为，帮助定位锚点真正在的文件。
    """
    result: list[Path] = []
    root_dir = root_file.parent

    def _walk(p: Path) -> None:
        src = read_source(p)
        for m in re.finditer(r'include!\("([^"]+)"\);', src):
            child = (p.parent / m.group(1)).resolve()
            if child not in result:
                result.append(child)
                _walk(child)

    _walk(root_file)
    return result


def _resolve_anchor_file(root_file: Path, anchor: str) -> Path:
    """在根文件及其 include! 子模块树里，找到真正包含 anchor 的那个文件。

    返回的是**应该被写回**的文件（不是根文件）。如果根文件本身有锚点就返回根文件；
    否则遍历 include! 子模块。要求 anchor 在恰好一个文件里出现恰好一次。
    """
    # 先看根文件自己
    root_text = read_source(root_file)
    root_count = root_text.count(anchor)
    if root_count == 1:
        return root_file
    if root_count > 1:
        # 这里以前只判「在不在」，不判「几次」：同一个文件里出现多次也照样返回去注入，
        # 于是唯一性只能等到真注入那一步的 assert 才暴出来 —— 而真注入是整跑 75~90 分钟的事。
        raise AssertionError(
            f"注入锚点在 {root_file.name} 里出现 {root_count} 次（要求恰好 1 次）："
            f"请加更长的锚点或按 `extra_injections` 逐处点名 ⇒ {anchor[:80]!r}"
        )

    # 再搜所有 include! 子模块
    candidates = _list_includes(root_file)
    hits: list[tuple[Path, int]] = []
    for child in candidates:
        try:
            text = read_source(child)
        except OSError:
            continue
        count = text.count(anchor)
        if count > 0:
            hits.append((child, count))

    if not hits:
        raise AssertionError(
            f"注入锚点在 {root_file.name} 及其 {len(candidates)} 个 include! 子模块里"
            f"**都找不到**：{anchor[:80]!r}"
        )
    if len(hits) > 1:
        detail = ", ".join(f"{p.relative_to(root_file.parent.parent)}({c})" for p, c in hits)
        raise AssertionError(
            f"注入锚点在多个文件里都出现了：{detail} —— 请明确指定 file="
            f"或加更长的锚点"
        )
    if hits[0][1] != 1:
        raise AssertionError(
            f"注入锚点在 {hits[0][0].name} 里出现 {hits[0][1]} 次（要求恰好 1 次）："
            f"include! 拆册后同一形状可能落在好几个对称路径里 ⇒ 加更长的锚点（带各自上文）"
            f"，或把每一处拆成独立用例 ⇒ {anchor[:80]!r}"
        )
    return hits[0][0]


def write_source(path: Path, text: str) -> None:
    """写回源码文本（与 [`read_source`] 对称：不翻译行尾，理由同上）。"""
    with path.open("w", encoding="utf-8", newline="") as f:
        f.write(text)


def npm_test_corpus() -> tuple[set[str], list[str]]:
    """现算 `npm test` 真正会跑的文件集合 —— 唯一真源是 package.json 的 `test` 脚本。

    为什么要现算而不是写死一份名单：收窄后的用例只跑点名的文件，而"通道基线跑过它"这条
    蕴含关系成立的前提就是**点名文件必须落在这条命令的语料里**。抄一份 glob 清单一定会漂
    （新增一册测试忘了同步 ⇒ 那条用例从此没人正面验过干净态）。

    ⚠️ 这条核对自己是"缺席型"的（它判的是"在不在"），所以自带正控：解析不到 glob、
    或展开出来的文件数低于下限，一律当成语义不明抛错 —— 检索读空了会报绿，那是最坏的一种假绿。
    """
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf8"))
    test_cmd = pkg.get("scripts", {}).get("test", "")
    globs = [t for t in re.findall(r'"([^"]*)"', test_cmd) if "*" in t]
    if not globs:
        raise RuntimeError(f"从 `npm test` 里解析不到任何 glob，命令串是：{test_cmd!r}")
    corpus = {str(p.relative_to(ROOT)) for g in globs for p in ROOT.glob(g)}
    if len(corpus) < 10:
        raise RuntimeError(f"`npm test` 的 glob {globs} 只展开出 {len(corpus)} 个文件，量具不可信")
    return corpus, globs


#: 当前正在被注入的文件与它的原始内容 —— 被 Ctrl-C / kill 打断时也要能恢复。
#: 有的护栏要同时改坏**两个**文件（例如"事实来源 + 注入副本"必须一致），所以这里是列表。
_CURRENT: list[tuple[Path, str]] = []


def restore_now() -> None:
    """把"当前注入现场"恢复回原始内容（幂等）。"""
    global _CURRENT
    for path, original in _CURRENT:
        write_source(path, original)
    _CURRENT = []


def _on_signal(signum: int, _frame: object) -> None:
    """被中断时先把源码恢复再退出 —— 否则会留下一个"被改坏"的工作区。"""
    paths = "、".join(str(p) for p, _ in _CURRENT)
    restore_now()
    where = f"（已恢复 {paths}）" if paths else ""
    print(f"\n[中断] 收到信号 {signum}{where}，退出", file=sys.stderr)
    sys.exit(130)


signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)
atexit.register(restore_now)


import sys as _sys

# 把自己所在目录放进 `sys.path`：作为脚本跑时 Python 已经这么做了，但**被别人 import** 时没有。
# `docs/final-architecture-review.md` 里就有一条用 `spec_from_file_location` 数 `CASES` 的复跑命令，
# 那种加载方式下 `from guard_cases import ...` 会 ModuleNotFoundError ⇒ 指路句变成假指路（实测过）。
_sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 2026-10-07：202 条 `Case` 按域切进 `scripts/guard_cases/`（本文件原来 4,176 行，光那一份
# `CASES` 字面量就占 3,747 行）。`MODULES` 与目录有一起跑前的对账 ⇒ 新分册忘了点名会当场炸，
# 不会静默少跑；判据 E 改按 `guard_cases/*.py` 现算条数（见 `scripts/check-doc-numbers.mjs`）。
# `ROOT`/`TAURI`/`Case`/`cargo()`/`npm()` 的唯一份定义也在 `guard_cases/base.py`（原来这两行
# 与本文件里的 `@dataclass` 就是它的原文 ⇒ 这里删掉本地定义，不留第二个家）。
from guard_cases import CASES
from guard_cases.base import ROOT, Case




def _resolve_program(name: str) -> str:
    """把 `npm` / `cargo` 解析成**真正可执行的文件**。

    为什么需要（2026-09-13，Windows 首次跑本脚本）：Windows 上 `npm` 实际是 `npm.cmd`
    批处理，而 `subprocess.run(["npm", ...])` **不走 shell**、CreateProcess 也不会补
    `.cmd`/`.bat` 后缀 ⇒ 直接 `[WinError 2] 系统找不到指定的文件`。结果是本脚本里所有
    前端用例（占一多半）在 Windows 上全部"验证过程出错"，看起来像护栏坏了，其实是
    调用方式不对。这里显式解析出全路径，既修好 Windows，又保持 `shell=False`
    （不引入 shell 引号/注入面的变化）。
    """
    if os.name != "nt":
        return name
    found = shutil.which(name)
    if found:
        return found
    for ext in (".cmd", ".bat", ".exe"):
        found = shutil.which(name + ext)
        if found:
            return found
    return name  # 交给 subprocess 报它自己的错（错误信息更明确）


def run(cmd: list[str], cwd: Path, timeout: int = 900, extra_env: dict[str, str] | None = None) -> tuple[int, str]:
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    # 沙箱/CI 里写不了 ~/.cargo：仓库内已有一份 CARGO_HOME 时优先用它
    local_cargo = ROOT / "target" / "cargo-home"
    if "CARGO_HOME" not in env and local_cargo.is_dir():
        env["CARGO_HOME"] = str(local_cargo)
    # 顺带把 UTF-8 固定下来：Windows 默认 cp1252 会把测试输出里的中文变成
    # UnicodeDecodeError（本脚本在 Windows 上第一次跑就是这么挂的）。
    env.setdefault("PYTHONUTF8", "1")
    resolved = [_resolve_program(cmd[0]), *cmd[1:]]
    proc = subprocess.run(
        resolved,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    return proc.returncode, proc.stdout + proc.stderr


#: 通道顺序固定写死在这里 —— 机器可读行与耗时账都按它排，别让解析方去猜。
LANES = ("cargo", "npm", "node", "script")


def lanes_line() -> str:
    """`GUARD_LANES cargo=143 npm=0 … all=266` —— 通道分母的唯一一份打印。

    数的是**全部 CASES**，与本次筛出来几条无关；`check-ci-guard-coverage.mjs` 拿它当分母，
    所以这行必须与逐通道之和自洽（那边会核对 `all=` 与求和是否相等，不相等就当尺子坏了）。
    """
    counts = {lane: sum(1 for c in CASES if lane_of(c) == lane) for lane in LANES}
    return "GUARD_LANES " + " ".join(f"{lane}={counts[lane]}" for lane in LANES) + f" all={len(CASES)}"


def lane_of(case: Case) -> str:
    """这条用例属于哪个**耗时通道**，只按 `case.cmd` 现推。

    为什么不按标签推（2026-10-26 实测）：`--only rust` 按名字/标签选中 146 条，其中只有
    142 条真的是 cargo 命令 —— 另外 4 条跑的是 `npm test` / `check-*.mjs`（亚秒级）。
    拿标签当分母去估"这一通道多少条 × 单条成本"必然算错（本文件第一版就把 cargo 单条
    估成 40s，实测 25~34s；而 cargo 用例数比标签口径少 4 条，两边都会偏）。
    """
    cmd = case.cmd
    if cmd[0] == "cargo":
        return "cargo"
    if cmd[0] == "node" and len(cmd) > 1 and cmd[1] == "--test":
        return "node"
    if cmd[0] == "npm" and len(cmd) > 1 and cmd[1] == "test":
        return "npm"
    return "script"


def verify(case: Case, *, rerun_after_restore: bool = True) -> tuple[str, str]:
    global _CURRENT
    #: [(文件, [(原文, 替换), …])] —— 主文件 + 需要"同时改坏"的其它文件
    targets: list[tuple[Path, list[tuple[str, str]]]] = [(case.file, case.injections)]
    targets += [(p, [(old, new)]) for (p, old, new) in case.extra_injections]

    # --- 注入前预处理：把每条 injection 解析到真正包含锚点的文件 ---
    # 物理拆分后 commands.rs / db.rs 只剩 include! 指令，锚点可能在任何子模块里。
    # 这里做一次"锚点→目标文件"的解析，后续所有操作都在正确的子模块上进行。
    resolved_targets: list[tuple[Path, list[tuple[str, str]]]] = []
    for root_path, injections in targets:
        if not injections:
            resolved_targets.append((root_path, injections))
            continue
        # 如果所有锚点都在同一个文件（根文件自己或某个子模块），保持原行为
        all_same: Path | None = None
        per_file: dict[Path, list[tuple[str, str]]] = {}
        for old, new in injections:
            try:
                target = _resolve_anchor_file(root_path, old)
            except AssertionError as e:
                # 兼容：如果不是 commands.rs/db.rs 这类 include! 根，就当作普通文件。
                # 但**根文件里一次都没有**时不能吞掉原因：吞了就会报
                # 「锚点在 commands.rs 里出现 0 次」这种假线索，而真原因是它在某个
                # include! 分册里出现多次 —— 原样上抛，让这条用例报出真话。
                if read_source(root_path).count(old) == 0:
                    raise
                target = root_path
            if target not in per_file:
                per_file[target] = []
            per_file[target].append((old, new))
        resolved_targets.extend(per_file.items())
    targets = resolved_targets

    originals = [(path, read_source(path)) for path, _ in targets]
    try:
        for path, injections in targets:
            text = read_source(path)
            for old, new in injections:
                assert text.count(old) == 1, (
                    f"注入锚点在 {path.name} 里出现 {text.count(old)} 次（要求恰好 1 次）："
                    f"源码可能已改动，请更新 verify-guards.py"
                )
                # ⚠️ 必须在**上一次替换的结果**上继续改（逐条累积），否则一条用例里写多个
                # 注入时只有最后一条生效 —— 这条旧实现的坑在这里一并修掉。
                text = text.replace(old, new, 1)
            write_source(path, text)
        _CURRENT = list(originals)  # 登记现场：被信号打断时可恢复

        code, out = run(case.cmd, case.cwd, extra_env=case.env)
        if code == 0:
            # 环境不支持该用例时测试会打印 GUARD_ENV_SKIP 并以 0 退出。这与
            # 「注入没被守住」是两回事：前者要换支持环境重跑，后者才是护栏空转。
            # 两种情况过去都判 False ⇒ CI 被"环境限制"长期顶红、真空转被淹掉（2026-10-21 修）。
            # 现在分成两个 verdict，且**只有用例显式声明了理由**才允许走 ENV_SKIP：
            # 不声明 = 仍然失败（见 Case.env_skip 的三层防线）。
            if "GUARD_ENV_SKIP" in out:
                env_line = next(
                    (ln.strip() for ln in out.splitlines() if "GUARD_ENV_SKIP" in ln),
                    "",
                )
                if not case.env_skip:
                    return "FAIL", (
                        "改坏之后测试因**环境不支持而跳过**（GUARD_ENV_SKIP），而这条用例"
                        "**没有声明** `env_skip` 理由 ⇒ 按失败处理（不允许免检）：\n"
                        f"  {env_line}"
                    )
                return "ENV_SKIP", (
                    f"环境不支持，非空转在本机无法证明（不等于护栏空转）：{case.env_skip}\n"
                    f"  {env_line}"
                )
            return "FAIL", "改坏之后测试**仍然通过** ⇒ 这条护栏是空转的（没在守东西）"
        # ★ 2026-10-07：`expect_fail_hint` 从"只附一句提示"改成**判据**（不匹配就 FAIL）。
        # 为什么：注入后红了不代表红的是我声明的那一格。真实形状：local 层那条 hint 永远匹配不上
        # （第 15 趟抓到、e9cdd32 换成判据真会打印的那句），而 advisory 的写法让这种过期
        # **只出现在没人读的 detail 里**。现算 202/202 条 Case 都声明了 hint ⇒ 它就是契约的一部分：
        # 不匹配 = 这条护栏正在守别的东西，必须响亮，不能附一句谁也看不见的括号。
        hint_missing = bool(case.expect_fail_hint) and case.expect_fail_hint not in out

        for path, original in originals:  # 先恢复，再判"恢复得干不干净"
            write_source(path, original)
        _CURRENT = []
        if rerun_after_restore:
            code2, out2 = run(case.cmd, case.cwd, extra_env=case.env)
            if code2 != 0:
                return "FAIL", f"恢复源码之后测试**仍然失败** ⇒ 源码或环境已被破坏：\n{out2[-800:]}"
        else:
            # 2026-10-26：这里原来是"恢复源码后再跑一遍整条命令"。那一遍同时证两件事，
            # 而两件事现在都有**更强也更便宜**的证法，所以逐条重跑被撤了 ——
            # ⚠️ 这不是放宽：两半判据都还在，只是从"每条重复一遍"改成"字节级逐条 + 整套一次"。
            #   ① "现场没有残留" ⇒ 逐字节比对注入前的快照。残留的定义就是字节差；
            #      旧写法是行为代理，改了但恰好没人断言那处的那个文件它会放过去（更强在这里）。
            #   ② "干净源码上这些测试是绿的" ⇒ 由本通道那**一次**基线负责（见 main 的基线段），
            #      它跑的是整套断言，比这一条用例自己那条命令覆盖面更大。
            # 省下的：cargo 通道每条一次整库重编译（按 --lane cargo 的通道账现算，别抄）。
            residue = [str(p.relative_to(ROOT)) for p, o in originals if read_source(p) != o]
            if residue:
                return "FAIL", "恢复源码之后文件与注入前快照**字节不一致** ⇒ 现场有残留：" + "、".join(residue)
        if hint_missing:
            return "FAIL", (
                f"注入后是红了，但失败输出里**没有**声明的那句判据关键词 `{case.expect_fail_hint}`\n"
                f"  ⇒ 两种可能，都得人来分：① 那条判据的措辞改了（声明过期 ⇒ 换成它真会打印的那句）；"
                f"② 红的是别的东西（这条注入其实没被那一格守住）。\n"
                f"  实际失败输出尾部（挑新 hint 用）：\n{out[-2500:]}"
            )
        return "PASS", (
            "改坏即 FAIL、恢复即 PASS，且红由声明的那条判据报出"
            if rerun_after_restore
            else "改坏即 FAIL 且红由声明的那条判据报出、恢复后逐字节一致（干净态由通道基线证）"
        )
    finally:
        # 无论上面发生什么（断言失败/超时/异常），内容级恢复现场
        for path, original in originals:
            if read_source(path) != original:
                write_source(path, original)
        _CURRENT = []


def main() -> int:
    ap = argparse.ArgumentParser(description="非空转验证：故意改坏每条护栏，确认测试真的会失败")
    ap.add_argument("--only", default="", help="只跑名字/标签里包含该子串的用例")
    ap.add_argument(
        "--lane",
        default="all",
        help="只跑这些耗时通道（逗号分隔，如 `--lane node,script`；通道由 `case.cmd` 现推，"
        "不按标签 ⇒ 见 lane_of 的 why）；与 --only 是**与**关系，可组合出 `--only ble --lane cargo`",
    )
    ap.add_argument(
        "--shard",
        default="",
        help="把筛出来的用例按序号取模分片：`--shard 1/3` = 第 2 片（共 3 片），给 CI 并行跑用；"
        "必须与 --lane 一起用，否则切片之间会混着跑不同成本的通道",
    )
    ap.add_argument("--list", action="store_true", help="只列出用例")
    ap.add_argument(
        "--print-lanes",
        action="store_true",
        help="只打印 `GUARD_LANES` 那一行就退出（**不做**起跑前锚点核对）—— 给 "
        "`scripts/check-ci-guard-coverage.mjs` 当分母用。为什么不能让它去调 `--list`：那条用例"
        "跑起来时源码正处于**注入态**，`--list` 的锚点核对会发现「它自己的锚点找不到」而退 1 ⇒ "
        "对账读不到分母，红的形状还是「量具坏了」而不是它本该报的那一格（2026-10-26 实测到）。",
    )
    ap.add_argument(
        "--strict-platform",
        action="store_true",
        help="把「平台不适用而跳过」也算失败（默认跳过只提示，见 Case.platforms）",
    )
    ap.add_argument(
        "--strict-env",
        action="store_true",
        help="把「环境不支持而未证明」也算失败（默认只提示，见 Case.env_skip）",
    )
    args = ap.parse_args()

    if args.print_lanes:  # 只给分母，不做任何核对（见该参数的 help）
        print(lanes_line())
        return 0

    cases = [c for c in CASES if not args.only or args.only in c.name or args.only in c.tags]
    lanes = [x.strip() for x in args.lane.split(",") if x.strip()]
    bad_lane = [x for x in lanes if x not in LANES and x != "all"]
    if bad_lane:
        print(f"❌ `--lane` 不认这些名字：{bad_lane}（合法：{'、'.join(LANES)} 或 all）", file=sys.stderr)
        return 1
    if lanes and lanes != ["all"]:
        cases = [c for c in cases if lane_of(c) in lanes]
    shard_note = ""
    if args.shard:
        m = re.fullmatch(r"\s*(\d+)\s*/\s*(\d+)\s*", args.shard)
        if not m:
            print(f"❌ `--shard` 要写成 `<序号>/<总数>`，例如 `0/3`（收到 {args.shard!r}）", file=sys.stderr)
            return 1
        idx, total = int(m.group(1)), int(m.group(2))
        if total < 1 or not 0 <= idx < total:
            print(f"❌ `--shard {args.shard}` 非法：总数要 ≥1，序号要落在 0..{total - 1}", file=sys.stderr)
            return 1
        if total > 1 and lanes == ["all"]:
            # 混着切会慢死：一片里只要有一条 cargo 就决定整片墙钟，而 CI 拆片的唯一理由就是
            # cargo 通道每条要重编译一次整库。要并行就按通道分，别按序号随机分。
            print(
                "❌ `--shard` 必须与 `--lane <某个通道>` 一起用"
                " ⇒ 否则各片混跑不同成本的通道，慢的那条决定整轮墙钟",
                file=sys.stderr,
            )
            return 1
        cases = [c for i, c in enumerate(cases) if i % total == idx]
        shard_note = f" + `--shard {idx}/{total}`"
    if not cases:
        # ⚠️ 别把"空跑"当"通过"：`--only` 写错一个字符就会一条都不跑，
        # 而下面的汇总照样打印 ✅（真实踩过：`--only CoreBluetooth状态回执` 少了空格）。
        # `--lane` 与 `--shard` 同样会空跑（`--lane npm` 在 68 条收窄后就是 0 条）⇒ 三个筛子都要点名。
        given = [
            f"`--only {args.only}`" if args.only else "",
            f"`--lane {args.lane}`" if lanes and lanes != ["all"] else "",
            f"`--shard {args.shard}`" if args.shard else "",
        ]
        print(
            f"❌ {' '.join(x for x in given if x)} 没有匹配到任何用例"
            f"（可用 `--list` 看名字/标签；通道按 `cmd` 现推，见 `--help`）",
            file=sys.stderr,
        )
        return 1

    # ---------------- 起跑前：锚点全量静态核对（2026-09-27，roadmap #107）----------------
    # 为什么要有这一段：锚点死了 runner 也会**抛 AssertionError**（不是假绿），但那是在跑到
    # 那一条时才抛 —— 整跑要一个多小时，于是"改坏了锚点"这件事平均要白等半小时才发现
    # （实测：189 条整跑只报 1 条异常，就是那条 `中继收文件的哈希`，而静态核对 1 秒就给同一结论）。
    # 这一段只做**存在性/唯一性**核对，一条测试都不跑；非空转仍然要靠后面的逐条真注入。
    dead_anchors: list[str] = []
    ambiguous_anchors: list[str] = []
    for c in cases:
        pairs: list[tuple[Path, str]] = [(c.file, old) for old, _new in c.injections]
        pairs += [(p, old) for (p, old, _new) in c.extra_injections]
        for path, old in pairs:
            if not old:
                continue  # 纯新增型注入：没有"锚点存在性"可核
            try:
                _resolve_anchor_file(path, old)
            except AssertionError as e:
                msg = str(e)
                line = f"{c.name}\n      文件 {Path(path).name}: {msg}"
                # 「找不到」与「出现多次」不是一回事：前者说明这批锚点整体不可信 ⇒ 中止，省整轮；
                # 后者只坏那一条用例 ⇒ 只点名不中止，否则一条坏锚点会把其余 232 条的读数一起挡掉
                # （它们仍会在自己那一步抛同一个错，末尾汇总照样判红，不丢计数）。
                (ambiguous_anchors if ("要求恰好 1 次" in msg or "多个文件" in msg) else dead_anchors).append(line)
    if dead_anchors:
        print(
            f"❌ 起跑前核对：{len(dead_anchors)} 处注入锚点已失效（一条测试都没跑，省下整轮时间）：",
            file=sys.stderr,
        )
        for d in dead_anchors:
            print(f"   - {d}", file=sys.stderr)
        print(
            "   ⇒ 守卫变强时不许凭猜写新锚点：先确认新形状**可编译**且真能改掉被钉的那个语义。",
            file=sys.stderr,
        )
        return 1
    if ambiguous_anchors:
        print(
            f"⚠️ 起跑前核对：{len(ambiguous_anchors)} 处锚点**不唯一** —— 只点名不中止，"
            f"这些用例会在自己那一步报错，其余照跑：",
            file=sys.stderr,
        )
        for a in ambiguous_anchors:
            print(f"   - {a}", file=sys.stderr)
    # 2026-10-07：`expect_fail_hint` 已经是判据（不匹配就 FAIL），于是"某条 Case 干脆不声明 hint"
    # 就成了这条判据唯一的绕过口 —— 不声明等于不检查，而成功那行照旧打印"且红由声明的那条判据报出"。
    # 现算今天 202/202 条都声明了 ⇒ 把它钉成起跑前核对，别让" convention "退化成"可空字段"。
    no_hint = [c.name for c in cases if not c.expect_fail_hint.strip()]
    if no_hint:
        print(
            f"❌ 起跑前核对：{len(no_hint)} 条用例没声明 expect_fail_hint ⇒ 这条判据对它们根本不存在：",
            file=sys.stderr,
        )
        for n in no_hint:
            print(f"   - {n}", file=sys.stderr)
        return 1

    # ---------------- 起跑前：命令形态核对（2026-10-26）----------------
    # 为什么：npm 通道 68 条原先每条都跑整包（单条两遍实测 16.6s ⇒ 整通道约 19 分钟），
    # 现已全部收窄成 `node_test(<真正会红的那个文件>)`
    #（2026-10-26 当日读数：node 通道 89 条合计 320.3s、均值 3.6s；条数一律看 `--print-lanes`）。
    # 收窄属于**契约变更**：点错文件的那条不会自己报"我跑的是无关测试"，只能靠这两条钉住 ——
    #   ① 点名文件必须真实存在，且在 `npm test` 的语料里（否则"通道基线正面跑过它"不成立）；
    #   ② 不许再有裸 `npm test` 当注入态命令（整套断言"干净态必须绿"改由基线那一次负责，
    #      逐条只该跑真正会红的那个文件）。
    # ⚠️ "收窄没收窄错"的最终证据仍然是**注入真跑**：改坏不红、或红完输出里没有声明的那句 hint
    #    ⇒ 那条判 FAIL。hint 常是模板拼出来的（实测 `不该引用 useChatStore` 在源码里 0 命中，
    #    真实形状是 `${entry} 不该引用 ${bad}`），所以 hint 能不能逐字找到**只当读数、不当判据**。
    try:
        corpus, corpus_globs = npm_test_corpus()
    except (RuntimeError, OSError, ValueError) as e:
        print(f"❌ 起跑前核对：读不出 `npm test` 的语料 ⇒ {e}", file=sys.stderr)
        return 1
    text_cache: dict[str, str] = {}

    def _named_files(c: Case) -> list[str]:
        return [a for a in c.cmd[2:] if not a.startswith("-")]

    not_found: list[str] = []
    off_corpus: list[str] = []
    hint_literal = 0
    narrowed = 0
    for c in cases:
        if c.cmd[:2] != ["node", "--test"]:
            continue
        narrowed += 1
        named = _named_files(c)
        if not named:
            not_found.append(f"{c.name}：一条文件都没点名")
            continue
        for f in named:
            if not (ROOT / f).is_file():
                not_found.append(f"{c.name}：{f}")
            elif f not in corpus:
                off_corpus.append(f"{c.name}：{f}")
        # hint 读数只对**存在**的文件算 —— 对不存在的文件调 `read_source` 会抛 FileNotFoundError，
        # 而它的退码也是 1，看起来就像"这条判据抓住了"（2026-10-26 变异 M2 实测到这一点）。
        existing = [f for f in named if (ROOT / f).is_file()]
        if any(c.expect_fail_hint in text_cache.setdefault(f, read_source(ROOT / f)) for f in existing):
            hint_literal += 1
    bare_npm = [c.name for c in cases if c.cmd[0] == "npm" and len(c.cmd) > 1 and c.cmd[1] == "test"]
    if not_found or off_corpus or bare_npm:
        print("❌ 起跑前核对：用例的命令形态不合格（一条测试都没跑）：", file=sys.stderr)
        for f in not_found:
            print(f"   - 点名的文件不存在：{f}", file=sys.stderr)
        for f in off_corpus:
            print(f"   - 点名的文件不在 `npm test` 语料里（基线跑不到它 ⇒ 干净态没人正面验过）：{f}", file=sys.stderr)
        for n in bare_npm:
            print(
                f"   - 还在用裸 `npm test`（单条两遍实测 16.6s，收窄后 3.6s）：{n}"
                f" ⇒ 改成 `cmd=node_test(\"<真正会红的那个文件>\")`",
                file=sys.stderr,
            )
        return 1
    uniq = len(cases) - len({a.splitlines()[0] for a in ambiguous_anchors})
    print(
        f"· 起跑前核对：{len(cases)} 条用例里锚点**存在且唯一**的 {uniq} 条"
        + f"（不唯一 {len(ambiguous_anchors)} 处已在上面点名）；fail-hint 全部已声明"
    )
    print(
        f"· 命令形态核对：`npm test` 语料 {len(corpus)} 个文件（glob {corpus_globs}）；"
        f"`node --test` 共 {narrowed} 条，点名文件全部存在且都在语料内；裸 `npm test` 0 条；"
        f"其中 {hint_literal} 条的 hint 能在点名文件里逐字找到，其余 {narrowed - hint_literal} 条"
        f"是运行时拼出来的（静态查不了 ⇒ 由注入真跑负责）"
    )

    if args.list:
        print(lanes_line())
        for c in cases:
            print(f"  [{','.join(c.tags)}] {c.name}\n      {c.why}")
        return 0

    # 平台判定：Darwin=macOS、Linux=Android 目标宿主、Windows=Windows
    this_platform = "darwin" if sys.platform == "darwin" else ("win32" if os.name == "nt" else "linux")

    print(
        f"非空转验证：{len(cases)} 条护栏{shard_note}"
        f"（每条「改坏必须 FAIL 且红由声明的那句报出」，恢复后逐字节核对）"
    )
    print(f"当前平台：{this_platform}\n")

    # ---------------- 通道基线：干净源码上"这些测试是绿的"只证一次 ----------------
    # 为什么不在每条用例里各跑一遍 pristine：那一遍把同一句结论重复了每条一遍，
    # cargo 通道每条为此多付一次整库重编译（实测 30.5s × 143 ≈ 73 分钟），而它的证据
    # **并不比一次整套更细**（一次 `npm test` / `cargo test --lib` 逐条都覆盖到了）。
    # ⚠️ cargo 的分组粒度是**编译配置**，不是"一条命令"：带 `--features bluetooth` 与不带的
    # 是两个二进制、两套测试集 ⇒ 一份基线覆盖不了另一份，少一组就是静默假绿。
    # ⚠️ script 通道不建基线：它每条 <1s，保留"逐条双跑"更便宜也更直接（撤它是为改而改）。
    baselines: list[tuple[str, list[str], Path, dict | None, int]] = []
    baseline_secs: list[tuple[str, float]] = []
    fe_lane = [c for c in cases if lane_of(c) in ("node", "npm")]
    if fe_lane:
        baselines.append(("前端基线（npm test 整套）", ["npm", "test"], ROOT, None, len(fe_lane)))
    cargo_lane = [c for c in cases if lane_of(c) == "cargo"]
    if cargo_lane:
        for label, need_bt in (("默认 feature", False), ("带 --features bluetooth", True)):
            grp = [c for c in cargo_lane if ("--features" in c.cmd) == need_bt]
            if grp:
                cmd = ["cargo", "test", "--lib"] + (["--features", "bluetooth"] if need_bt else [])
                # cwd/env 照这一组里第一条用例 —— Windows 的测试链接环境等差异不许在基线这层走样。
                baselines.append((f"cargo 基线（{label}）", cmd, grp[0].cwd, grp[0].env, len(grp)))
    for label, cmd, cwd, env, n in baselines:
        print(f"· 基线：{label} —— 给这 {n} 条用例当「干净态是绿的」那份证据")
        t0 = time.perf_counter()
        try:
            code, out = run(cmd, cwd, extra_env=env)
        except Exception as exc:  # 基线自己起不来（工具链缺件等）不能读成"没坏"
            print(f"❌ 基线跑不起来 ⇒ 非空转验证不开始：{label}\n   {exc}", file=sys.stderr)
            return 1
        baseline_secs.append((label, time.perf_counter() - t0))
        if code != 0:
            print(
                f"\n❌ 基线红 ⇒ 源码/环境本来就坏，非空转验证**未开始**"
                f"（继续跑只会把同一句结论重复 {len(cases)} 遍）：{label}\n"
                f"   输出尾部：\n{out[-1500:]}",
                file=sys.stderr,
            )
            return 1
        print(f"   ✅ 绿（⏱ {baseline_secs[-1][1]:.1f}s）\n")

    bad: list[str] = []
    skipped: list[tuple[str, str]] = []
    #: 因**环境**不支持而未证明的（与平台跳过分开：它换台机器就能证明，护栏本身没坏）
    env_skipped: list[tuple[str, str]] = []
    #: (用例名, 通道, 秒, 结论) —— L1 耗时账的唯一数据源。此前这个工具**一个耗时都不打印**，
    #: 于是"扫描要一小时"拆不到通道，只能整跑一遍去猜（2026-10-26 优化前手上只有
    #: 75.6 min / 883.7s 两个聚合值）。
    timings: list[tuple[str, str, float, str]] = []
    for i, case in enumerate(cases, 1):
        if case.platforms is not None and this_platform not in case.platforms:
            # 目标代码在这个平台上根本不编译 ⇒ "改坏也不会失败"是**必然**的，不是缺陷。
            # 必须显式说出来：否则一堆假失败会把真失败淹掉（这是本次 Windows 首跑的教训）。
            print(f"[{i}/{len(cases)}] {case.name}")
            print(f"      ⏭️  跳过：本用例只适用于 {'/'.join(case.platforms)}，当前是 {this_platform}")
            print()
            skipped.append((case.name, "/".join(case.platforms)))
            continue
        print(f"[{i}/{len(cases)}] {case.name}")
        print(f"      {case.why}")
        # script 通道（<1s/条）与带 `env` 覆盖的用例保留"恢复后再跑一遍"：
        # 前者双跑是白送的，后者那句"干净态是绿的"依赖它自己的环境，通道基线没覆盖那种 env。
        rerun = lane_of(case) == "script" or bool(case.env)
        t_case = time.perf_counter()
        try:
            verdict, detail = verify(case, rerun_after_restore=rerun)
        except Exception as exc:  # 锚点过期、超时、断言等 —— 报告出来，别让整个脚本崩
            verdict, detail = "FAIL", f"验证过程出错：{exc}"
        elapsed = time.perf_counter() - t_case
        timings.append((case.name, lane_of(case), elapsed, verdict))
        # ★ 失败时把**用例名和形状放在同一行**：CI 那条注解只挑含 `❌` 的关键行
        # （`scripts/ci-run.sh` 的 grep），上一轮三条标记全都读得出形状、读不出是谁 ——
        # 名字落在上一行 `[i/233] 名字`，被过滤掉了，而 job 日志匿名 403，只能等下次跑。
        # 耗时放在**行尾**：它不是关键行的一部分，不该挤掉 CI 注解里那 10 条（ci-run.sh 只留
        # 匹配到的前 10 行 + 逐字保留的末 25 行，这一行两头都还在原位置）。
        mark = {"PASS": "✅", "ENV_SKIP": "⏭️ "}.get(verdict, "❌ " + case.name + " ⇒")
        print(f"      {mark} {detail}（⏱ {elapsed:.1f}s）")
        if verdict == "FAIL":
            bad.append(case.name)
        elif verdict == "ENV_SKIP":
            env_skipped.append((case.name, case.env_skip))
        print()

    # 收尾再核一次整套：基线只在开头看过一次，而这一轮真的反复改过源码 ——
    # 这一格把"量具走完，树仍然是好的"留在读数里，不靠人相信 `finally`。
    if fe_lane:
        t0 = time.perf_counter()
        code, out = run(["npm", "test"], ROOT)
        baseline_secs.append(("收尾复核（npm test 整套）", time.perf_counter() - t0))
        if code != 0:
            print(
                f"\n❌ 收尾复核红 ⇒ 这一轮跑完源码已经不再干净（残留或环境坏了）：\n{out[-1500:]}",
                file=sys.stderr,
            )
            return 1
        print(f"· 收尾复核：npm test 整套 ✅ 绿（⏱ {baseline_secs[-1][1]:.1f}s）\n")

    if timings:
        # ---------------- 耗时账（L1 量具，不参与退出码）----------------
        # 为什么单独打一段：此前整跑只有一个聚合值可查（见 `timings` 的声明处），
        # 通道拆不开就没法判断「该砍哪一半」。慢不是缺陷，改坏不红才是 —— 所以这一段只读数。
        by_lane: dict[str, list[float]] = {lane: [] for lane in LANES}
        for _name, lane, secs, _v in timings:
            by_lane[lane].append(secs)
        print("· 耗时账（只计真跑过的用例；平台/环境跳过不计）：")
        for lane in LANES:
            v = by_lane[lane]
            if v:
                print(
                    f"   {lane:7s} {len(v):3d} 条  合计 {sum(v):8.1f}s"
                    f"  均值 {sum(v) / len(v):5.1f}s  最慢 {max(v):6.1f}s"
                )
        print("   最慢 10 条：")
        for name, lane, secs, _v in sorted(timings, key=lambda t: -t[2])[:10]:
            print(f"     {secs:6.1f}s  [{lane}] {name}")
        # 机器可读一行：用例名带中文与空格，不进这行（解析方只需要通道与秒数）。
        slowest = max(timings, key=lambda t: t[2])
        lane_secs = " ".join(f"{lane}={sum(by_lane[lane]):.1f}s" for lane in LANES if by_lane[lane])
        base_secs = f" baselines={sum(s for _l, s in baseline_secs):.1f}s" if baseline_secs else ""
        print(
            f"GUARD_TIMING ran={len(timings)} {lane_secs}{base_secs} "
            f"total={sum(t[2] for t in timings) + sum(s for _l, s in baseline_secs):.1f}s "
            f"slowest={slowest[2]:.1f}s@{slowest[1]}"
        )
        print()

    if skipped:
        print(f"⏭️  {len(skipped)} 条因平台不适用而跳过（目标代码在本平台不编译）：")
        for name, plats in skipped:
            print(f"   - {name}（只适用于 {plats}）")
        print()
    if env_skipped:
        print(f"⏭️  {len(env_skipped)} 条因**环境**不支持而未证明（护栏本身没坏，换支持环境重跑即可）：")
        for name, reason in env_skipped:
            print(f"   - {name}")
            print(f"     理由：{reason}")
        print()
    if bad:
        print(f"❌ {len(bad)} 条不符合预期：")
        for name in bad:
            print(f"   - {name}")
        return 1
    if (skipped and args.strict_platform) or (env_skipped and args.strict_env):
        parts = []
        if skipped:
            parts.append(f"平台 {len(skipped)}")
        if env_skipped:
            parts.append(f"环境 {len(env_skipped)}")
        print(f"❌ --strict-platform/--strict-env：{'、'.join(parts)} 条被跳过，不算全绿")
        return 1
    proven = len(cases) - len(skipped) - len(env_skipped)
    print(
        f"✅ {proven} 条护栏通过非空转验证"
        f"（每条：改坏必须 FAIL、红由它自己声明的 hint 报出、恢复后逐字节一致）"
    )
    if baseline_secs:
        print(
            f"   「干净源码上是绿的」不逐条重跑，由这些一次性证据负责："
            + "、".join(f"{l}（{s:.1f}s）" for l, s in baseline_secs)
        )
    if env_skipped:
        print(f"⚠️  另有 {len(env_skipped)} 条只因环境未证明（见上）—— 别把这一行读成「全都验过了」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
