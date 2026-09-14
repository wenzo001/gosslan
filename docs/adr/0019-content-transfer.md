# ADR-0019: 统一可靠的内容传输（消息 / 文件 / 图片同一套生命周期）

- Status: Accepted（Phase 1 + Phase 3 已落地；Phase 2 断点续传待实现）
- Date: 2026-09-14
- Owners: Gosslan
- Related:
  - CHANGELOG: 4.4.0 / 4.5.0 / 4.6.0 / 4.7.0
  - 代码：src-tauri/src/content/（逻辑层）、src-tauri/src/network/{file,transport}.rs
  - Protocol: 新增 Hello.content_features（**不参与签名**）与 Message::ContentRequest

---

## 1. Context

文本消息是可靠的（outbox + Ack + gossip 中继 + msg_id 去重）；但文件/图片的传输状态
分散在三套词汇里（file_transfers 的 pending/active/done/failed、group_file_recipients 的
pending/sending/completed/failed、内存 FileReceiver），且：

- 没有 incomplete 概念：断在中途只剩 failed，接收方**没有任何办法再要一次**；
- 只能原始发送方**推**；对端离线或只经中继可达时，接收方拿不到；
- 失败不区分可恢复与终态，也无法自动重试。

用户要求：无论文本还是文件，都要有"发送 / 发送中 / 结束"的清晰状态；断了也不丢，
网络好时自动重发，网络差时明确告知并可重试；点一下就能从对方再取一份，**对方不用确认**。

## 2. Decision

### 2.1 一条生命周期（逻辑层 content）
queued → active → verifying → complete；失败分两类：
- 可恢复（LinkDown/Timeout/Partial/Local）⇒ **incomplete**，指数退避后自动重试；
- 终态（HashMismatch/SourceGone/Unsupported）⇒ **rejected**，只能换源或放弃。

落库 content_transfers：cid / peer_id / group_id / direction / status / received /
attempts / next_attempt_at / last_error / path。**received 只进不退**。

### 2.2 内容寻址
cid = 明文 SHA-256。**任何持有完整字节的端都是种子**（原始发送方，或已收完的任意群友）。

### 2.3 拉取式补取（拥有即授权）
ContentRequest { from, cid, name, size }：接收方按 cid 请求；持有方校验
（from == 链路对端 且 是好友或该群成员）后直接回发 FileOffer，复用既有 Chunk/Done/Ack。
**对方无需人工确认。**

### 2.4 能力协商（向后兼容的硬前提）
Hello 带 content_features 位图，**不进入 hello_signing_bytes** ⇒ 老端忽略、验签照过；
对端未声明 CONTENT_FEATURE_PULL 时**不发新帧**，自动退化为推送式。

### 2.5 自动重试
建链 / Hello 时扫描该 peer 名下可恢复的**接收**记录：Incomplete 按退避到点、
Active 闲置 >60s 也重试；只对支持拉取的对端发 ContentRequest。
发送方向的重试由既有 file_outbox 负责。

## 3. 分层（各层独立、只通过能力函数调用、都能扩展）

- 网络层：链路 / 分帧 / 中继 / **能力协商**；暴露 发给谁 / 广播 / 有没有链路 / 能否拉取。
- 逻辑层 content/：模型 + 状态机 + 重试策略 + 持久化（**不依赖网络**，可脱离网络单测）。
- 业务层：ContentRequest 服务、commands、群投递。
- 功能层：前端只消费统一状态与命令，不关心链路。

## 4. 已完成

- **Phase 1**（4.6.0 / 4.7.0）：统一状态 + 退避 + 建链自动重试；文件卡片「重新获取」。
- **Phase 3**（4.4.0 / 4.5.0）：内容寻址 + ContentRequest 拉取 + 能力协商 + 点击重取；
  接收方做种 + 群成员可拉。

## 5. 待实现：Phase 2 断点续传（From(seq)）

**目标**：弱网/大文件从中断处继续，而不是整份重来。

**协议**：ContentRequest 增加 from_seq: u32（serde default 0）。请求方按自己已持有的
**完整分片数**填 from_seq；服务方从第 from_seq 片开始发。

**难点与既定解法**：
1. **保留半成品**：现在 fail_receive 会删 .part 并移除接收状态；断链/超时属于可恢复，
   应**保留** receiver + .part + hasher，只把内容标 Incomplete，并挂 TTL（例如 24h）
   由清理任务收割 —— 否则中断无法续传，只能整份重来。
2. **续传对齐**：只能从**分片边界**续传（received % FILE_CHUNK == 0）；尾部有半片时，
   回退到"重传最后一整片"（丢弃该半片）以保证 hasher 与 seq 对齐。
3. **hasher 不能重来**：续传必须复用同一个 receiver（同一 hasher）；因此续传的 offer
   必须命中既有 receiver（现有"重复 offer 幂等 accept"已具备该判据），而不是新建。
4. **服务端 seek**：send_file_from_path 增加 from_seq 参数，stream_file 从
   from_seq * FILE_CHUNK 处读文件、seq 从 from_seq 起编号。

**验收（ADR-0010 失败注入）**：传一半断链 → 重连自动从断点继续 → 最终 SHA 通过；
尾部半片 → 回退整片仍能完成；对端一直不回来 → TTL 后清理 .part，不泄漏磁盘/内存。

## 6. Consequences

- 新旧端互通：老端不发/不认新帧，退化为推送式，功能不残。
- 内容可用性与投递状态解耦：find_source 只看本地是否有完整字节。
- 成本：多一张表与一点退避状态；收益是"断了不丢、能自愈、点一下就来"。
