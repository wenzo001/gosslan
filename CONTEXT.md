# 术语表（CONTEXT）

这份文件只放**规范术语**：某个词在这个仓库里指什么、不指什么、以及它的真源在哪。
不放实现细节、不放规格说明、不放"应该怎么改"。

## 会话与消息

- **撤回（Recall）** —— 把一条消息从**它所在的会话时间线**上抹掉的动作。落地形态：消息行
  `kind → "recalled"`、`content` 清空，`sender_id / ts / seq / msg_id` 保留。真源 =
  `group_recalled_messages` 那张 G-Set（墓碑集合），不是 `messages` 行上的某个字段。
- **墓碑（Recall tombstone）** —— `group_recalled_messages(conv_id, msg_id, recaller_id, seq)`
  里的那一行。它是"这条被撤过"的**权威集合**：存在即不可逆，且用来解决"撤回帧先到、消息后到"。
- **已撤回行（recalled 行）** —— 撤回后消息在时间线上的样子：一行"消息已撤回"提示，
  高度按提示行估（与系统提示同一档），不可再次撤回。
- **实体消息** —— 用户写或发的内容：`text / code / merge / image / file`。撤回它们 =
  **再也找不回**（正文清空、不保留本地副本）。
- **卡片消息** —— 时间线上的一张卡，但它背后的东西有**独立真源**：群任务卡（`todo`）之于
  任务看板、群公告（`announcement`）之于公告栏、群文件之于文件台账。
- **离链 ≠ 删本体** —— 撤回只让**那一张卡**离开时间线；卡片背后的本体（任务、公告、文件记录）
  照常在它自己的列表里可见。这是口径，不是遗漏：撤回的语义边界就是"聊天时间线"。
- **静默事件行** —— `system / pin / reaction / remind / recall` 一类不进气泡时间线、
  不计未读、不改预览的机器事件。它们**没有"撤回"这个语义**（本来就看不见）。
- **可撤行（Recallable）** —— 撤回能作用的种类，**两档共用同一份**：
  `text / code / image / file / merge`。三类明确**不在内**，各有实测理由：
  · 静默事件行（`pin / reaction / remind / todo_update / recall`…）：本来就不显示在时间线上，
    「撤」它们不是离链而是回滚那个动作；`todo_update` 是 LWW 状态改动，撤不动也没东西可看；
  · `system` 提示行：`msg_id = sys-<uuid4>` 由**每台设备各自生成、不广播**
    （`commands::insert_system_message`）⇒ 拿它发撤回只有群主自己那台消失 = 假同步；
  · **卡片**（`announcement / todo / poll`）：它们**没有独立真源** —— 看板取数是
    `messages WHERE kind IN ('todo','todo_update')`、公告栏是
    `kind IN ('announcement','announcement_delete')`，库里没有 `group_todos` / 公告表
    ⇒ 撤掉那张卡 = 本体一起消失且不可恢复。这一条曾被写成「群主档多三张卡、卡片离链本体照旧」，
    那是**假事实**（2026-10-28 review 抓到）；要让卡片「离链但本体留着」，前置条件是先给
    看板与公告栏建自己的真源（见 ADR-0023 §3.6）。
  群主特权**不扩大这个分母**，只取消「必须是作者」和「5 分钟窗口」两条限制。

## 群与权限

- **群主（Group Creator）** —— `groups.creator` 那一列的值（一个 device_id）。**唯一**、
  可转让（`transfer_group_creator`）。本仓**没有** admin / 角色列 / 多管理员的概念：
  `group_members(group_id, device_id)` 不区分身份。判权一律是 `group.creator == actor`。
- **特权撤回（群主撤回）** —— 群主对群里**任何人**的任意一条时间线行发起撤回，
  不受"仅原作者"和 5 分钟窗口这两条限制。它是"撤回"的一种授权来源，不是另一种动作：
  落地形态、墓碑、受众与普通撤回同一条路。
- **成员（Member）** —— 出现在 `group_members` 里的 device_id。入群只有"群主单向加人"一条路，
  没有申请/审批概念。
- **受众（Audience）** —— 一条群消息该被哪些成员消费。判据在信封消费侧
  （sender 必须在该群成员表里），能力差异走 `kind_audience`：
  `unsupported` = 那个成员**确实**声明过却没有这个能力位；
  `unknown` = 从没交换过 Hello / 已离线 ⇒ 只说"版本未知"，**不许**并进"版本旧"
  （群成员离线是常态，把"不知道"算成"不支持"会让提示永远在响）。

## 协议与兼容

- **能力位（Feature bit）** —— `kind_required_feature(kind) -> Option<u32>` 给出的那位。
  它回答的是"这个 kind 老版本**渲染**得对不对"，不是"这条命令谁有权发"。
- **接收端不校验时间窗** —— 既有口径：撤回窗口是**产品规则不是安全边界**，
  接收端无法验证对方墙上时钟，所以只在发送端强制。
- **信封签名（Envelope signature）** —— `GossipEnvelope.signing_bytes` 覆盖
  `sender_id / group_creator / group_members / payload / seq`，Ed25519 验证。
  含义：**"这条是谁发的"不可伪造**；但 `group_creator` 那个字段是发送方自报的，
  它的可信度只等于"与本机的 `groups.creator` 相等"。
