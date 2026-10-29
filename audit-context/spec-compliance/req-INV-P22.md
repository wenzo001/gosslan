## REQ-INV-P22 — 例外必须登记（代码标记 ⋈ 文档登记，双向校验）

> "上面 21 节的不变量默认是**无条件**的。若某条代码路径**必须**偏离它，必须**同时**做两件事：
> ```
> ① 在代码处留标记：  // INV-EXCEPTION: INV-PXX — <为什么必须破例>
> ② 在本节登记：      不变量 id + 理由 + 引入出处
> ```
> 两件事缺一不可，由 `scripts/check-invariant-exceptions.mjs` **双向**校验：
> 代码标了而本节没登记 ⇒ FAIL；本节登记了而代码没标 ⇒ FAIL。"
> — docs/protocol-invariants.md §22. Invariant Exceptions / INV-P22, line 711

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 每一条偏离不变量的代码路径，必须在代码处留 `// INV-EXCEPTION: INV-PXX` 标记**且**在规范文档的例外登记区里有对应条目；两者缺一不可，由脚本双向校验。

**Where enforcement lives:**

```js
// scripts/check-invariant-exceptions.mjs:60-62
const ID_RE = /INV-P\d+/g;
const MARKER_RE = /INV-EXCEPTION\s*:\s*([^\n]*)/;
const SOURCE_ROOTS = ["src-tauri/src", "src"];
const SOURCE_EXT = [".rs", ".ts", ".vue"];
```

```js
// scripts/check-invariant-exceptions.mjs:100-113（文档侧：只取登记区内的 id）
const region = text.slice(start + BEGIN.length, stop);
return { ids: new Set(region.match(ID_RE) ?? []), region };
```

```js
// scripts/check-invariant-exceptions.mjs:118-137（代码侧：扫源码根取标记里的 id）
for (const root of SOURCE_ROOTS) {
  for (const file of collectFiles(path.join(ROOT, root))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("INV-EXCEPTION")) continue;
    for (const line of text.split("\n")) {
      const m = MARKER_RE.exec(line); if (!m) continue;
      for (const id of m[1].match(ID_RE) ?? []) { ... }
    }
  }
}
```

```js
// scripts/check-invariant-exceptions.mjs:140-160（三个方向都会红）
const unregistered = [...code.keys()].filter((id) => !doc.ids.has(id));   // 代码标了、文档没登记
const stale = [...doc.ids].filter((id) => !code.has(id));                 // 文档登记了、代码没标
const typos = [...doc.ids].filter((id) => !definedIds.has(id));            // 登记了不存在的 id
```

文档侧的登记区由显式边界注释划出（`:59-60`）：

```
<!-- BEGIN EXCEPTION REGISTRY -->
| INV-P03 | 自聊不经过 `queued → sending → waiting_ack → delivered`，落库即终态 `read` | 本机既是发送方也是接收方，不存在"在途"阶段，没有可等待的 ACK | `7c03341`（2026-09-16） |
| INV-P04 | `insert_self_message` 走 `db::insert_message`，**不**写 outbox | outbox 的唯一出队条件是收到对端 Ack。自聊没有收件人、永远等不到 Ack ⇒ 那一行永远留在库里，被每次心跳/建链的 `flush_outbox` 反复重发，反而把「outbox 必然排空」破掉 | `7c03341`（2026-09-16） |
<!-- END EXCEPTION REGISTRY -->
```

代码侧标记：

```rust
// src-tauri/src/commands/chat.rs:1013
// INV-EXCEPTION: INV-P03, INV-P04 — 自聊收发双方都是本机，没有对端可等 Ack：
```

实测 `node scripts/check-invariant-exceptions.mjs` 输出：`✓ 不变量例外：代码标记与文档登记一致（2 条） —— INV-P03、INV-P04`，代码侧 `INV-P03 ← src-tauri/src/commands/chat.rs`、`INV-P04 ← src-tauri/src/commands/chat.rs`。

- What it checks, and against what：代码侧 id 集合必须 ⊆ 文档登记 id 集合（否则红）；文档登记 id 集合必须 ⊆ 代码侧 id 集合（否则红）；文档登记的 id 必须在文档里真被定义过（`^### (INV-P\d+)` 收集的 `definedIds`，否则红）。
- Which paths reach it, and which do not：扫描面是 `src-tauri/src` 与 `src`（递归，跳过 `vendor`/`target`/`node_modules`），后缀 `.rs`/`.ts`/`.vue`。**不扫** `scripts/`、`docs/`（除规范文档本身）、`e2e/`。

**Paths walked:**
- 代码标 `INV-P05`（假设）而文档没登记 ⇒ `unregistered` 非空 ⇒ FAIL ✓
- 文档登记 `INV-P09` 而代码里没有标记 ⇒ `stale` 非空 ⇒ FAIL ✓
- 文档登记 `INV-P99`（不存在）⇒ `typos` 非空 ⇒ FAIL ✓
- 当前状态：两侧都是 `{INV-P03, INV-P04}` ⇒ 三项检查全过 ✓

**Searched:**
- `INV-EXCEPTION` → 2 hits：`src-tauri/src/commands/chat.rs:1013`（真标记）、`src/utils/retrySend.test.ts:136`（**测试代码**里的一处字符串，用来截取上面那个函数的边界 —— 它不含 `INV-P\d+` 模式，所以脚本从它抽不出 id）。⇒ 代码侧实际只有**一处**真标记。
- `INV-P\d+` in `src-tauri/src` + `src` → 仅 `commands/chat.rs:1013` 一处命中 ⇒ 两条例外共处一行。
- `BEGIN EXCEPTION REGISTRY` / `END EXCEPTION REGISTRY` → `docs/protocol-invariants.md:759` / `:766`（各 1 处）⇒ 边界注释完整。
- 例外登记表里的 `引入` 列 ⇒ `7c03341`（2026-09-16），两条都有出处 ✓；`理由` 列两条都填了 ✓
- `check-invariant-exceptions.mjs` 是否接进门禁 → `grep "check-invariant-exceptions" scripts/verify.mjs`：`scripts/verify.mjs` 里含该文件名 ⇒ 已接进门禁 ✓（`check-invariant-hooks.mjs` 的 `wired` 检查同样通过）
- **本仓其余 34 条不变量有没有"偏离但没标记"的情况** → 脚本**管不到**：它只能发现"标了没登记"与"登记了没标"，无法发现"既没标也没登记"的偏离。这与文档的机制设计一致（文档写的是"若某条代码路径必须偏离它，必须同时做两件事"），但意味着本条的覆盖面依赖**作者自觉标记**。

**Hook verification:**
- `scripts/check-invariant-exceptions.mjs` — **存在**（约 175 行）。**已接进门禁**（`scripts/verify.mjs` 含该文件名；`check-invariant-hooks.mjs` 的 `scripts/` 形态要求 `verify.mjs` 或 `package.json` 能搜到文件名 ⇒ 通过）。实测退出码 0。
- `guards:自聊消息必须留在本地` — **存在**：`scripts/guard_cases/desktop_misc.py:301`。实测 name 命中 1 次 ✓

**How the verdict was reached:** 文档要求的"双向校验"由脚本三个数组（`unregistered` / `stale` / `typos`）逐条实现，三项都在脚本里可见（`scripts/check-invariant-exceptions.mjs:140-142`），脚本已接进门禁并实测退出码 0。文档点名的两条登记（INV-P03 / INV-P04）在代码侧有对应标记、在文档侧有含理由与出处的表格行。定为 `implemented` 而非 `partial`：脚本实现的就是文档描述的那个机制，两侧内容也对上。**但要注意一个边界**（见 Open questions）：本条能防住的是"标记与登记不一致"，防不住"偏离了却两边都没写" —— 这是文档自己设计的机制边界，不是实现的缺陷，所以不改判。

**Open questions:**
- 本仓 34 条不变量里有没有"事实上偏离但既没标也没登记"的路径？脚本结构上看不见这类。（审计 `docs/archive/audit/evidence-2026-10-16/reliability-silence.md` 记录了 223 格吞错，其中接收侧 `insert_message` 落库失败被 `.ok()` 吞掉 —— 那些路径相对 INV-P14「DB 不是缓存」是否算偏离？若算，则本条的一个真实缺口是"偏离未被登记"。）
- 文档的登记表在 `## 22. Invariant Exceptions` 之内，但同名的 `# 22. Invariant Change Procedure` 是另一个顶级标题（`docs/protocol-invariants.md:791`）。两个"22"并存是有意的还是编号漂移？
- 例外只有一条代码标记（`commands/chat.rs:1013` 同时标了 P03 与 P04）。若某条不变量有两处不同位置的例外，脚本无法区分"同一处标两个 id"与"两处各标一个"—— 是否需要按标记粒度（文件:行）登记？
