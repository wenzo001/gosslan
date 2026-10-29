## REQ-INV-P29 — 群任务编号 = 类型字母 + 组内永久递增数字，短码只是显示态

> "> 群任务编号 = 当前类型字母 + 永久递增数字；数字从 1 开始、唯一、删除/归档后永不复用；
> > 类型变化只改字母，优先级完全独立；数字超过 4 位时紧凑界面默认只显后四位，
> > 并且必须能让用户看到完整编号。"
> "**"唯一"的范围先写清楚**（这句是刻意留的，因为"全局"能被读成两种）：数字是**群内全局**唯一 ——
> 一个群内三种类型共用同一条序列（所以会出现 `R1 / B2 / T3 / R4 / B5` 这种穿插），
> 每个群各自从 1 起。"
> "**为什么字母坚决不存进库里**（这条如果被"顺手优化"成存字符串，规则 3 就会变成一次数据迁移）：
> 存了 `R12` 之后，"需求改成缺陷"要改所有已同步的事件、要和老对端争夺同一格、要在折叠里再判一次谁赢 ——
> 那是把同一件事写成两个事实来源。字母能由类型现推，所以它**只能是显示态**。"
> — docs/protocol-invariants.md §29. Group Todo Numbering / INV-P29, line 1346

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 编号 = 字母 + 数字；数字在群内全局唯一、从 1 起、只增、删除/归档都不回收；改类型只换字母、数字不动；优先级不参与编号；超过 4 位时紧凑界面只显后四位且用户能看到全码；短码只是视觉，库/同步/引用一律用完整编号 + 内部 id；多人同时发起撞号时折叠层确定性收敛（不级联）。

**Where enforcement lives:**

**字母与算码（前端唯一家）：**

```ts
// src/utils/todos.ts:215
export const TODO_CATEGORY_LETTER: Record<TodoCategory, string> = { ... };
// src/utils/todos.ts:255
export const TODO_CODE_DIGITS = 4;
// src/utils/todos.ts:270-279
export function todoCode(category: unknown, number: unknown): TodoCode | null {
  ...
  const letter = TODO_CATEGORY_LETTER[category];
  const shortened = digits.length > TODO_CODE_DIGITS;
  return { full, label: shortened ? `${letter}${digits.slice(-TODO_CODE_DIGITS)}` : full, shortened };
}
```

**数字分配（后端唯一家）：**

```rust
// src-tauri/src/db/groups.rs:456-464
pub fn next_todo_number(conn: &Connection, group_id: &str) -> Result<i64> {
    let next = todo_number_high_water(conn, group_id) + 1;
    crate::db::set_setting(conn, &todo_number_key(group_id), &next.to_string())?;
    Ok(next)
}

// src-tauri/src/db/groups.rs:427-454
pub fn todo_number_high_water(conn: &Connection, group_id: &str) -> i64 {
    let stored: i64 = crate::db::get_setting(conn, &todo_number_key(group_id))
        .and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    if stored > 0 { return stored; }     // 本机权威高水位 ⇒ 有值就不必全群扫
    let mut seen = 0i64;
    // 只在从未分配过时回扫历史载荷，找对端自己分配的号（Lamport 式躲避）
    ...
    stored.max(seen)
}
```

- What it checks, and against what：高水位两个来源取大（`settings` 里那份 + 扫过的载荷里最大号）⇒ "见过就要躲"。`stored > 0` 时直接返回（性能优化，`db/groups.rs:431-437` 注释解释大群扫描慢）。
- Which paths reach it, and which do not：`next_todo_number` 只在**创建**一条任务时调用（`db/groups.rs:458` 注释："改状态 / 改标题 / 归档都不走这里（编号不重分配）"）。

**撞号折叠（纯函数，不级联）：**

```ts
// src/utils/todos.ts:561-584
export function resolveTodoNumbers(defs: { todoId: string; number: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const groups = new Map<number, string[]>();
  for (const d of defs) {
    if (d.number <= 0) continue;         // 旧版对端建的没有号：不参与编号，也不占号
    ...
  }
  if (groups.size === 0) return out;
  let next = Math.max(...groups.keys()) + 1;
  for (const n of [...groups.keys()].sort((a, b) => a - b)) {
    const ids = groups.get(n)!.sort();
    out.set(ids[0], n);                  // 组内 todo_id 最小的保住原号
    for (const id of ids.slice(1)) out.set(id, next++);   // 其余让到最大号之后
  }
  return out;
}
```

- What it checks, and against what：**不级联**（只有撞号那条让号，且让到 `max+1` 之后）；组内 `todo_id` 小的保号 ⇒ 各端可复算的同一条规则（纯函数 ⇒ 不需要仲裁帧）。
- Which paths reach it, and which do not：`src/utils/todos.ts:622`（`foldTodos` 内）一处调用。

**字母不落库：**

```rust
// src-tauri/src/protocol.rs:1184-1190（TodoPayload）
    /// 群内**固定**任务编号（1 起递增、组内唯一、永不复用）。
    ...
    #[serde(default)]
    pub number: i64,
```

`TodoPayload` 里**没有** `letter` 字段（`protocol.rs:1124-1200` 全文）。类型在 `category`（`protocol.rs:1160-1166`），字母由前端从 `category` 现推。

**Searched:**
- `letter` in `src-tauri/src/protocol.rs` → **0 hits** ⇒ 载荷里没有这一格 ✓（判据 `designGuards.test.ts:2415` 直接扫 `protocol.rs` 断言 `!/\bletter\b/.test(protocol)`）
- `pub number: i64` → `protocol.rs:1189` ✓
- `TODO_CATEGORY_LETTER` → `src/utils/todos.ts:215`（定义）+ `todos.ts:274`（使用）+ `todos.test.ts:890`（断言 `{requirement:"R", bug:"B", task:"T", custom:"C"}`）。**生产定义只有一处** ✓
- `TODO_CODE_DIGITS` → `src/utils/todos.ts:255`（定义）+ `:276/278`（使用）。**生产定义只有一处** ✓（判据 `designGuards.test.ts:2407` 断言三处界面里不出现它）
- `todoCode(` → 三处界面各调一次：`components/TodoCardBubble.vue`、`components/GroupTasksBoard.vue`、`components/TodoDetailDialog.vue`（判据 `designGuards.test.ts:2402-2407` 逐个断言）+ `todos.ts:689`（实时表）
- `ordinals` → 判据 `designGuards.test.ts:2405` 断言三处界面里**不**出现（位置序号不能当编号）✓
- `resolveTodoNumbers` → `todos.ts:561`（定义）+ `todos.ts:622`（`foldTodos` 内调用）+ 测试四处
- `next_todo_number` → `db/groups.rs:460`（定义）+ 调用点（创建路径）
- `todo_num:` / `todo_number_key` → `db/groups.rs`（settings 键）；`clear_all_data` 只删 `key LIKE 'gk:%'`（`commands/favorites.rs:561`）⇒ **高水位不被清除聊天记录清零** ✓
- `number <= 0` / 无号 → `todos.ts:570`（`if (d.number <= 0) continue;`）+ `todoCode` 对 `0`/负数/`undefined` 返回 `null`（`todos.test.ts:909-913`）⇒ 不猜、不补号 ✓
- 优先级不参与编号 → `todoCode(category, number)` 只读这两格（`todos.ts:270`）✓（判据 `todos.test.ts#优先级怎么改都不进编号`）

**Paths walked:**
- 创建任务 → `db::next_todo_number` ⇒ 高水位 +1 并持久化 ✓（数字从 1 起、只增）
- 删除/归档任务 → **不走** `next_todo_number`（`db/groups.rs:458` 注释 + 实现）⇒ 号不复用 ✓
- 清除聊天记录 → `clear_all_data` 只删 `gk:%` ⇒ `todo_num:<群>` 保留 ⇒ 号不归零 ✓
- 老对端建的任务（载荷里没有 `number`）→ `#[serde(default)]` ⇒ `number = 0` ⇒ `resolveTodoNumbers` 跳过（不参与、不占号）、`todoCode` 返回 `null` ⇒ 三处界面留空 ✓
- 两人同时发起撞同一个号 → `resolveTodoNumbers` ⇒ 小的保号、其余让到 `max+1` 之后 ⇒ 各端算出同一套号（纯函数）✓
- 改类型 → `category` 变、字母现推 ⇒ 数字不动 ✓
- 改优先级 → 与编号无关 ✓
- 数字 > 4 位 → `todoCode().label` 只显后四位，`full` 保留全码 ✓

**Searched (2) — 数字超过 4 位时的用户可见性：**
- `todoCode` 返回 `{ full, label, shortened }`（`todos.ts:278`）⇒ 界面取 `label`（紧凑）而全码在 `full`
- 判据 `todos.test.ts#超过 4 位只留后四位并标出被缩短`（`todos.test.ts:898-906` 附近）验证 `todoCode("requirement", 9_999)` / `todoCode("requirement", 10_000)` / `todoCode("bug", 12_345)` 的 `full` 与 `label` 两份
- 文档规则 6 要求"缩短时必须让用户知道这不是全码"（PC 悬停 `title`、读屏 `aria-label` 永远给全码、移动端进详情看全码）—— **这一格在代码里未查到独立的机器判据**（`designGuards.test.ts` ㉖ 只管"三处界面都调 `todoCode` 且不自己数位数"）。人工复核：`TodoDetailDialog.vue` 用 `todoCode(...)` ⇒ 详情标题写的就是全码（`full`）；卡片/看板用 `label`。

**Hook verification:**
- `db::todo_number_tests::numbers_start_at_one_and_increment_within_the_group` — **存在**：`src-tauri/src/db/groups.rs:500` ✓（基线命中）
- `db::todo_number_tests::numbers_are_not_reused_after_messages_are_deleted` — **存在**：`db/groups.rs:510` ✓
- `db::todo_number_tests::peer_allocated_numbers_are_avoided` — **存在**：`db/groups.rs:535` ✓
- `db::todo_number_tests::legacy_payload_without_number_still_parses_as_zero` — **存在**：`db/groups.rs:545` ✓
- `db::tests::clear_all_data_sql_deletes_and_preserves` — **存在**：`src-tauri/src/db/favorites_tests.rs:1396` ✓（基线命中）
- `src/utils/todos.test.ts#改类型只换字母、数字一字不动` — **存在**：`src/utils/todos.test.ts` 内 ✓
- `src/utils/todos.test.ts#优先级怎么改都不进编号` — **存在** ✓
- `src/utils/todos.test.ts#超过 4 位只留后四位并标出被缩短` — **存在** ✓
- `src/utils/todos.test.ts#撞号时两端算出同一套号` — **存在**：`todos.test.ts:817`（`resolveTodoNumbers` 的顺序无关断言）✓
- `src/utils/todos.test.ts#同一号撞了三个人` — **存在**：`todos.test.ts:829` ✓
- `src/utils/todos.test.ts#别人的新任务到达后，已经显示过的号一个都不漂移` — **存在** ✓（这是"不级联"的反向判据）
- `src/utils/todos.test.ts#实时表给的是当前状态` — **存在** ✓
- `src/utils/designGuards.test.ts#群任务编号只有一个家` — **存在**：`designGuards.test.ts:2386` ✓
- `src/utils/channelState.test.ts#群任务三处外显同源` — **存在**：`channelState.test.ts:667` ✓

全部 14 条钩子存在并注册。

**How the verdict was reached:** 八条规则逐条对上：字母表 + 位数规则 + 算码函数只有一处（`todos.ts`）；数字分配只有一处（`db::next_todo_number` = 高水位 +1）；高水位取两个来源的大；改类型只换字母（字母不落库，载荷里只有 `number`）；优先级不参与编号；`todoCode` 返回 `full`/`label` 两份供不同场景用；短码不进库不进载荷（判据直接扫 `protocol.rs` 断言无 `letter`）；撞号由纯函数确定性收敛且**不级联**。文档明确点名的 14 条钩子全部存在并注册。定为 `implemented`。

**Open questions:**
- 文档规则 6 要求"缩短时必须让用户知道这不是全码"（PC 悬停 `title`、读屏 `aria-label` 永远给全码）。代码里 `todoCode` 提供了 `full` 与 `label` 两份，但**没有一条机器判据**钉"卡片/看板的 `title` 与 `aria-label` 必须用 `full`"。这一格靠人工复核（`todos.test.ts#超过 4 位只留后四位并标出被缩短` 只判 `todoCode` 的返回值，不判界面怎么用）。
- 文档规则 7 说"所有引用键是 `todo_id`"，同时又说"短码只是视觉"。人工复核：`resolveTodoNumbers` 与 `todoCode` 都以 `todoId` 为键 ✓，但"引用"侧（评论/提醒/任务详情跳转）是否**只**用 `todo_id`，未查到独立的判据。
- 文档说"清除聊天记录不会把号清零"这条判据跑的是**测试里重抄的那段 SQL**（`db::tests::clear_all_data_sql_deletes_and_preserves`），不是生产函数本身 —— 文档自己如实标了这个边界。生产侧 `commands/favorites.rs:561` 的 `DELETE FROM settings WHERE key LIKE 'gk:%'` 确实不含 `todo_num:` 前缀，但两者之间没有机器连线。
- `todo_number_high_water` 的 `stored > 0` 快速路径意味着**从不清过高水位的机器**（例如刚被拉进群、本机从未分配过）会在第一次分配时回扫历史载荷。这条路径下若对端也从未声明过号（全是 0），第一批号从 1 起 —— 与"组内全局唯一"没有冲突，但两台从未交互过的机器首次建任务可能都拿到 1（撞号 ⇒ 由 `resolveTodoNumbers` 收敛）。文档规则 8 覆盖了这个情形。
