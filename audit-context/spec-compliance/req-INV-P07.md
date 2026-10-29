## REQ-INV-P07 — Gossip Must Converge

> "Gossip 消息允许多路径到达。
>
> 必须：
>
> ```text
> TTL bounded
> → dedupe bounded
> → fanout bounded
> ```
>
> 禁止无限传播。"
> — docs/protocol-invariants.md §INV-P07, line 241-251

**Verdict:** implemented · confidence: high

**What this demands of an implementation:** 三条界都必须有：**TTL** 有上限（不能被对端自报值放大）、**去重表**有界（不能随时间无限增长）、**扇出**有界（一次转发不能发给所有邻居）。三条任缺其一，就存在无限传播的形状。

**Where enforcement lives:**

1) **TTL 有界 —— 唯一真相是 MeshRouter**：

```rust
// src-tauri/src/mesh/router.rs:202-L241
pub fn on_receive(&mut self, frame: MeshFrame, my_node_id: &str) -> ForwardDecision {
    // 1. TTL（先按上限裁剪，防止对端自报超大 TTL）
    let effective = frame.ttl.min(self.max_ttl);
    if effective == 0 { return ForwardDecision::Drop(DropReason::TtlExhausted); }
    // 2. 全局去重（只有过得了 TTL 的帧才登记）
    if !self.is_new_frame(&frame.frame_id) { return ForwardDecision::Drop(DropReason::Duplicate); }
    let remaining = effective - 1;
    ...
    let mut next = frame;
    next.ttl = remaining;
    ForwardDecision::Forward { deliver_locally: for_me, frame: next }
}
```
`max_ttl` 生产值 = 6（`state.rs:2210`：`MeshRouter::new(100_000, 10_000, 6, 4, 256)`）。⇒ 对端自报 `ttl=255` 会被裁到 6，再减一 ⇒ 转发出去的 ttl 最多 5。

2) **转发出去的 TTL 只能取路由器的裁决，不许用信封自报值**：

```rust
// src-tauri/src/network/transport/gossip.rs:185-L195
/// 本机可继续转发时，转发信封应带的 TTL；`None` = 不再转发。
/// 唯一真相是 [`MeshRouter::on_receive`] 的 Forward 决策（`max_ttl` 裁剪 + 递减）。
/// TTL 不在 Ed25519 签名范围内，绝不能拿信封自报的 `env.ttl` 直接减一 ——
/// 对端自报 255 时那就是一条能跨 254 跳扩散的信封（设计上限 6）。
fn forward_ttl_from(decision: &ForwardDecision) -> Option<u8> { ... }
```
应用点：`gossip.rs:279`（`fwd.ttl = fwd_ttl;`）—— 转发信封的 TTL 来自 `forward_ttl_from(decision)`，不是 `env.ttl - 1`。

3) **去重有界 —— 两级结构，容量固定**：

```rust
// src-tauri/src/gossip_engine.rs:134-L143
pub struct GossipEngine { bloom: BloomFilter, seen: LruSet, allow_retry: LruSet, pub fanout: usize, pub ttl: u8 }
impl GossipEngine {
    pub fn new(bloom_capacity: usize, seen_capacity: usize, fanout: usize, ttl: u8) -> Self {
        Self { bloom: BloomFilter::new(bloom_capacity, 0.01), seen: LruSet::new(seen_capacity), allow_retry: LruSet::new(256), fanout, ttl }
    }
```
- 生产值：`GossipEngine::new(100_000, 10_000, 4, 6)`（`state.rs:2200`）⇒ Bloom 容量 100k（满了轮换位图，`gossip_engine.rs:52-L61`），LRU 精确集 10k（`LruSet::insert` 超容量淘汰最旧，`gossip_engine.rs:98-L109`），放行名单 256（`:139`）。
- Mesh 层另有一份同构去重：`MeshRouter { bloom, seen, allow_retry }`（`mesh/router.rs:137-L149`，生产值同为 100_000/10_000，`state.rs:2210`）。
- 两级去重**互相独立**（这是设计要求，见 `network/transport/gossip_tests.rs:522-L536`）。

4) **扇出有界 —— `choose_fanout` 截断**：

```rust
// src-tauri/src/gossip_engine.rs:166-L179
pub fn choose_fanout(&self, candidates: &[String], exclude: &str) -> Vec<String> {
    let mut pool = candidates.iter().filter(|p| p.as_str() != exclude).cloned().collect();
    let mut rng = OsRng;
    for i in (1..pool.len()).rev() { let j = rng.next_u64() % (i as u64 + 1) as usize; pool.swap(i, j); }
    pool.truncate(self.fanout.min(pool.len()));
    pool
}
```
生产 `fanout = 4`（`state.rs:2200`）。调用点：`gossip.rs:468`（定向洪泛兜底）、`gossip.rs:474`（广播扇出）、`transport.rs:1215`（不透明外部帧扇出）。

5) **源发广播用 `exclude_source`（不按 fanout 截断）—— 这是一条刻意的不对称**：

```rust
// src-tauri/src/mesh/router.rs:268-L283
/// 只做 source exclusion，**不按 fanout 截断**。
/// 用于**源发广播**（发送方把帧发给自己的所有直连节点）：此时必须保证覆盖，
/// 一旦截断，连接数超过 fanout 的节点就收不到 —— 群消息会静默漏发。
pub fn exclude_source<'a>(&self, candidates: &'a [String], source_node_id: &str) -> Vec<&'a str> { ... }
```
注释 `mesh/router.rs:250-L254` 明确登记"生产路径不走 `select_outgoing`"。⇒ 源发一跳的扇出 = 直连数（**不是** 4），但这只发生**一跳**（发出去的信封 ttl 仍受 `max_ttl` 与递减约束），后续每一跳的转发扇出都被 `choose_fanout` 截到 4 ⇒ **仍然有界**。

6) **授权闸（额外一层，限制"替别人转发"）**：`decide_forward`（`mesh/relay_policy.rs:182-L202`）—— 定向帧到达目标后停止转发、ttl ≤ 1 不转发、替别人转发要过策略（默认 `All`）。

7) **待转发队列有界**：`MeshRouter.pending: RingBuffer<MeshFrame>`（`mesh/router.rs:148`，生产容量 256），`RingBuffer::push` 满了覆盖最旧（`mesh/router.rs:105-L111`）。

**Paths walked:**
- 对端自报 `ttl=255` 的 Gossip → `effective = min(255, 6) = 6` → `remaining = 5` → 转发出去的 ttl = 5 ⇒ **不可能跨 254 跳** ✓
- 对端自报 `ttl=0` → `Drop(TtlExhausted)`，**且不烧掉去重槽位**（`mesh/router.rs:205-L207` 在 `is_new_frame` 之前 return）⇒ 之后的合法副本仍能进 ✓
- 广播帧 `ttl=1` → `remaining=0` → `for_me && !should_forward` ⇒ `Deliver`（本机收，不再扩散）✓
- 同一 `message_id` 到达两次 → `GossipEngine::is_new` 第二次返 false ⇒ `gossip.rs:304-L306` 直接 return ⇒ 不再扇出 ✓
- 同一 `frame_id` 在 Mesh 层到达两次 → `MeshRouter::is_new_frame` 第二次返 false ⇒ `Drop(Duplicate)` ✓
- 节点有 20 个邻居 → 转发扇出 `choose_fanout` 截到 4 ✓
- 源发节点有 20 个直连 → 广播给全部 20 个（**一跳**），每个收件人的后续转发扇出 ≤ 4 ⇒ 总量有界 ✓
- 放行名单（`allow_retry`）增长 → `LruSet` 容量 256，满了淘汰最旧 ⇒ 有界 ✓
- Bloom 满 → `gossip_engine.rs:52-L61` 轮换位图（`self.bits.fill(0); self.count = 0;`）⇒ 有界 ✓
- Mesh 层待转发队列满 → `RingBuffer::push` 覆盖最旧 ⇒ 有界 ✓

**Searched:**
- `max_ttl` → `mesh/router.rs:144`（字段）、`:204`（裁剪）、`state.rs:2210`（生产值 6）
- `choose_fanout` → 4 hits：`gossip_engine.rs:166`（定义）、`gossip.rs:468`、`gossip.rs:474`、`transport.rs:1215`
- `select_outgoing` → 3 hits：`mesh/router.rs:255`（定义）、`mesh/router.rs:295` 一带的测试、`mesh/router.rs:250-L254` 注释自陈"生产路径不走这个函数" ⇒ **生产代码里没有调用点**（除了测试）
- `exclude_source` → 2 hits：`mesh/router.rs:275`（定义）、`network/transport/outbound.rs:471`（生产唯一调用点）
- `GossipEngine::new` → 1 处生产构造：`state.rs:2200`（`100_000, 10_000, 4, 6`）
- `MeshRouter::new` → 1 处生产构造：`state.rs:2210`（`100_000, 10_000, 6, 4, 256`）
- `env.ttl - 1` / `ttl - 1` → **0 hits**（旧写法已删；`gossip.rs:282-L284` 注释自陈"旧写法用 `env.ttl - 1` 重建信封 ⇒ 一条 Gossip 可跨 254 跳扩散"）
- `ttl` 自报值直接使用 → 仅在 `decide_forward` 的 `ttl <= 1` 判定里（`mesh/relay_policy.rs:189`），那里喂的是**入站** ttl，不影响转发值（`gossip.rs:428-L431` 注释明示）
- `BloomFilter::insert` 轮换 → `gossip_engine.rs:52-L61`
- `LruSet::insert` 淘汰 → `gossip_engine.rs:98-L109`

**Hook verification:**
- `mesh::router::tests::zero_ttl_is_dropped` → `src-tauri/src/mesh/router.rs:381`；两平台基线在册 ✓
- `mesh::router::tests::broadcast_with_ttl_one_delivers_without_forwarding` → `src-tauri/src/mesh/router.rs:416`；两平台基线在册 ✓
- `gossip_engine::tests::bloom_and_lru_dedup` → `src-tauri/src/gossip_engine.rs:251`；两平台基线在册 ✓
- `network::transport::tests::business_duplicate_still_enters_the_propagation_layer` → `src-tauri/src/network/transport/gossip_tests.rs:544`；两平台基线在册 ✓
- 支撑（spec 未点名但在册）：`mesh::router::tests::zero_ttl_frame_does_not_burn_the_dedup_slot`（`mesh/router.rs:394`）、`mesh::router::tests::duplicate_frame_is_dropped`（`:371`）、`gossip_engine::tests::bloom_rotates_when_full`（`gossip_engine.rs:261`）、`gossip_engine::tests::fanout_excludes_sender`（`:271`）、`network::transport::gossip_tests::forwarded_ttl_is_clamped_by_the_mesh_router`（`gossip_tests.rs:575`，断言 255 被压到 5）

**How the verdict was reached:** spec 列的三条界各有独立的实现点，且都能在生产代码里指出具体行与具体值：TTL 上限 6（`state.rs:2210`）+ 路由器裁剪（`mesh/router.rs:204`）；去重两级各有固定容量（`state.rs:2200`/`:2210`）；扇出 `choose_fanout` 截到 4（`gossip_engine.rs:177`）。唯一可能读成"无界"的是源发广播的 `exclude_source`（一次发给所有直连），但它只发生一跳且被 `mesh/router.rs:268-L283` 的注释明确登记为刻意设计（截断会静默漏发群成员），后续每一跳仍受 fanout 截断 ⇒ **总量有界**。所以判 `implemented` 而不是 `partial`。

**Open questions:**
- **源发广播不按 fanout 截断**这件事，spec 的 "fanout bounded" 字面上覆盖不到（源发一跳的扇出 = 直连数，无固定上限）。代码有明确的理由（`mesh/router.rs:268-L283`）与后果说明，但它**确实是"一次扇出无固定上界"**。若把 spec 的 "fanout bounded" 读成"任何一次扇出都 ≤ 某常数"，那这条在源发侧不成立。**需要确认 spec 指的是"每跳转发扇出有界"还是"任意扇出都有固定上界"。**
- `MeshRouter::select_outgoing`（带 fanout 截断的那份）在生产代码里**没有调用点**（`mesh/router.rs:250-L254` 自陈"架构复审 0-A2 明确登记，不是待接线"）⇒ 它的 fanout 截断逻辑只被自身测试覆盖。spec 的钩子 `mesh::router::tests::broadcast_with_ttl_one_delivers_without_forwarding` 判的是 TTL 那一半，不判扇出截断。
- 生产 `fanout = 4`（`state.rs:2200`）这个值本身没有测试钉住（`gossip_engine::tests::fanout_excludes_sender` 用的是自造值 2）。改这个常量不会让任何测试变红。
- `GossipEngine.ttl = 6` 与 `MeshRouter.max_ttl = 6` 是两个**独立**的 6（`state.rs:2200` 与 `:2210`），没有断言把两者绑在一起。若一个被改成 5 而另一个仍是 6，实际生效的是路由器的 `max_ttl`（`gossip.rs:285-L301` 用路由器的裁决），而 `GossipEngine.ttl` 只在 `build_envelope` 里给新信封设初值（`gossip_engine.rs:201`）。**需要确认这两处是否应当有约束关系。**
