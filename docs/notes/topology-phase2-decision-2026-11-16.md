# 「我的网络」阶段 2：稳定布局决策记录（2026-11-16）

> 对应方案：`docs/notes/network-topology-visualization-plan-2026-11-16.md` §阶段 2。
> 阶段 0/1 已实施（见 `network-topology-semantics-2026-11-16.md`）；本文是阶段 2 的交付物。
> **阶段 3（真实全网关系）仍未做**——它要改协议 + 隐私评审，产品已裁决这轮不做。

## 1. 布局策略：确定性分档网格（阶段 1 已选，阶段 2 不改）

方案要求「轻量确定性约束图布局，不用无边依据的 pure force simulation」。阶段 1 的
分档网格已经满足：

- 档位阶梯 `4→6→8→10→12→16→20→24→32→40→48→64`（k×k 格子）；
- **同一档内**新节点只占下一个格子 ⇒ 老节点一个像素都不动；
- **跨档才重排**（格子变小塞下更多节点）—— 这是有理由的重排，不是抖动；
- 引擎侧 `fx/fy` 全部钉死、`cooldownTicks(0)` / `warmupTicks(0)` ⇒ **没有力模拟动画**。

⇒ 阶段 2 **没有再造力学算法**，复用同一份纯函数 `layoutNeighborhood`。

## 2. 稳定 seed + 局部解碰撞 → 用「覆盖」实现

方案第 2 条要求「稳定 seed 给新节点位置，节点稳定后固定；只对新增/移除邻居做局部解碰撞」。

**落法**：不引入 seed 参数，而是用 `first_seen`（插入序）+ id 作为天然稳定键 —— 这比
随机 seed 更稳（同一批节点在任何时候重排都落到同一个槽位）。「节点稳定后固定」由
`fx/fy` 钉死实现。「局部解碰撞」的取舍：**拖拽过的节点不自动解碰撞** ——
用户是故意把它放那儿的，自动挪开等于跟他抢相机（与「用户相机归属」同一口径）；
新节点若压上去，由用户自己拖开。

## 3. 拖拽位置持久化（本轮真新增）

- **存哪**：`settings` 表的 `topology_layout_v1` 键（**不动 SQLite 表结构** —— schema 属
  Frozen Core）。这是**本机呈现偏好**，不进网络协议、不跟 peer 同步 —— 由
  `topologySemantics.test.ts` 的判据钉住（mesh/protocol 模块里不许出现该键）。
- **存什么**：只存**用户拖过的节点**的坐标（`{id:{x,y},…}`），不存整张图。没拖过的仍走
  确定性网格 ⇒ 新节点照常出现、老节点没拖过就照常稳定。
- **读失败不折叠**：命令层用 `get_setting_checked(..)?`（读失败类型化上抛）再
  `unwrap_or_default()`（只折叠「没这条」）—— B1-F7 口径；前端 `parseLayoutOverride`
  对坏 JSON 返回 `{}`（不炸开页面）。
- **本机不许拖**（它是观察端点），天文数字坐标（手改 settings）一律丢弃。
- **恢复默认**：按钮（`topology_layout_reset` 命令）删掉偏好并重排，失败的可见提示。

### 命令（3 个）

| 命令 | 作用 |
|---|---|
| `topology_layout_load` | 读 JSON 字符串（空串 = 没存过） |
| `topology_layout_save(raw)` | 存（256 KiB 长度闸，防坏调用方塞巨串） |
| `topology_layout_reset` | 删偏好 ⇒ 回默认网格 |

## 4. 性能预算（实测）

纯布局计算（不含 Canvas 绘制），1440×900，每档跑 200 次取均值：

| 节点数 | 耗时 | 16.7ms/帧预算占比 |
|---|---|---|
| 10 | 0.007 ms | < 0.1% |
| 50 | 0.011 ms | < 0.1% |
| 200 | 0.019 ms | 0.1% |
| 500 | 0.051 ms | 0.3% |

⇒ 布局计算**远不是瓶颈**；绘制成本主要在 `drawNode`（节点半径/标签密度已随档位自适应，
见阶段 1）。**未做**：真机帧率实测（`NOT RUN`，当前环境无浏览器）。

## 5. 判据与反证

- `topologySemantics.test.ts`（+3 条）：
  · 拖拽覆盖只影响拖过的节点、本机不许拖、天文数字/坏 JSON 丢弃；
  · 三命令存在、读失败不折叠、进阻塞池、键带版本号；
  · 接线：首帧加载 → 覆盖 → 保存 → 恢复默认；偏好不进 mesh/protocol。
- **反例自证**：把 `applyLayoutOverride` 的调用换成 `l.points` ⇒ 接线判据当场红，
  还原后绿（已实跑）。
- Rust 侧 `commands/topology.rs` 3 条：三命令都进阻塞池、用 `get_setting_checked`、
  命令层不自己解析 JSON（解析规则只有前端一份）。

## 6. 复跑

```bash
node --experimental-strip-types --test src/utils/topologySemantics.test.ts
cd src-tauri && cargo test --features bluetooth --lib topology_layout
```
