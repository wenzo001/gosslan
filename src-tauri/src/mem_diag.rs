//! 进程内存与 GUI 句柄读数 —— 崩溃现场里唯一还缺的那一格证据。
//!
//! ## 为什么现在必须有它
//! 2026-10-26 那台 Windows 的现场是两条：`code=HANG scope=main_thread seconds=3` 与
//! `scope=ui_renderer seconds=3` **在同一秒**写下（主线程 `run_on_main_thread` 探针没回 +
//! 前端心跳没跳 ⇒ 整个进程被冻住，不是某一层卡住），而应用日志就在同一秒断掉，之后既没有
//! `HANG_END` 也没有"正常退出"。同一台机器 10-21 那次更直白：分配失败钩子报
//! 「重分配失败：请求 326350 字节」——一个进程连 **318 KB** 都提交不了，说明提交内存
//! （commit）已经见底；`panic = "abort"` 下这条路走 `handle_alloc_error`→abort，
//! 根本不过 panic 钩子（见 `lib.rs` 的 `NotingAlloc`）。
//!
//! 两种死法都指向同一件事，可**没有任何一条读数能指认是谁吃的**：`state.rs` 里那条
//! `RUNTIME_SNAPSHOT` 顶部明写"刻意不在这一行里读 RSS"，理由是"跨平台读进程内存需要新增
//! 平台依赖/外部命令"。这条理由今天现算就不成立 —— `windows-sys`（0.45/0.59/0.61.2）与
//! `libc 0.2.189` 早就在 `Cargo.lock` 里被别的依赖用着，给它们开 feature 既不下新 crate，
//! 也不 fork 任何命令。于是"下次再崩还是定不死"成了我们自己的选择。这一格把选择改掉。
//!
//! ## 为什么连 GDI/USER 句柄一起读
//! 用户报的是"崩溃还连带影响别的应用，尤其 WebView2 这一类"。本机状态能打到别人身上只有
//! 三条通道：**系统提交电荷**、**桌面堆与 GDI/USER 句柄配额**（这两个是窗口站级共享资源，
//! 我们耗光 = 同会话所有 GUI 应用一起难受）、**显卡驱动 TDR**。前两条现在都有读数了；
//! 第三条由 Windows 事件 4101 自己留痕，本机现查历史里没有。
//!
//! ## 三条边界
//! - **只在诊断点采样**：5 分钟一格的 `RUNTIME_SNAPSHOT`、一次 HANG、一次分配失败。
//!   每帧每消息的热路径一律不采样（帧读那一格是纯原子加减，不是采样）。
//! - **读不到就写 `-`**，不折成 0：`commit=0MiB` 会被读成"机器还能提交 0 字节"，
//!   而它真实的意思是"这个平台上我没读到"。这是两种完全不同的处置。
//! - **钩子里不许出事**：分配失败钩子跑在 abort 前面，任何 panic/死锁都会把"留痕"变成
//!   二次死亡。这里用的全是非分配的系统调用；写行仍走 [`crate::logging::crash_note`]
//!   那份再入闸（`logging.rs` 的 `NOTE_IN_PROGRESS`）。
//!
//! ## ⚠️ 还差一格，别把这份读数当全貌（本仓 2026-10-15 就定过这条口径）
//! 这里读的是**主进程自己**（工作集/私有提交量）+ 系统级提交余量 + GDI/USER。
//! 而真正吃掉几百 MB 的往往是 WebView2 那棵**子进程**树（renderer / GPU / utility）——
//! 本仓的取证账本写明"内存问题必须测 webview2 子进程，只测主进程＝读错对象"。
//! 枚举子进程树要跨平台进程遍历，不是这一格该顺手做的事：
//! `ws` 小而系统 `avail_commit` 已经很低 ⇒ 才说明压力在子进程那侧，这条推断现在**可读得出来**，
//! 但要说"就是它"仍需外部采样（那台机器上的 PowerShell 采集段仍在取证账本里）。

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

/// "没有读数"的原子哨兵。与 [`MemSample`] 里的 `None` 同义，只是缓存那边用原子量存。
const NONE: u64 = u64::MAX;

/// 一次采样的结果。**每个字段都是 `Option`**（理由见模块头的第二条边界）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MemSample {
    /// 本进程当前占用的物理内存（Windows 的 WorkingSetSize；Linux/Android 的 VmRSS）。
    pub working_set: Option<u64>,
    /// 本进程物理内存峰值（macOS 只有这一格 —— `getrusage` 给的是 peak RSS）。
    pub peak_working_set: Option<u64>,
    /// 本进程的私有提交量：真正计入系统提交电荷的那一份（Windows `PrivateUsage`、
    /// Linux `VmSwap`+`VmRSS` 的近似）。**内存耗尽型崩溃要看这个，不是看工作集**。
    pub private_commit: Option<u64>,
    /// 系统还能提交多少（Windows `ullAvailPageFile`；Linux `MemAvailable`+`SwapFree`）。
    /// 这一格归零 ⇒ 任何进程下一个小分配都会失败，包括我们自己那 318 KB。
    pub sys_avail_commit: Option<u64>,
    /// 系统提交上限（Linux 的 `CommitLimit`；Windows 取 `ullTotalPageFile`）。
    pub sys_total_commit: Option<u64>,
    /// 系统物理内存使用率（Windows `dwMemoryLoad`；其它平台由总量与可用量算）。
    pub sys_memory_load_pct: Option<u32>,
    /// GDI 对象句柄数与峰值（窗口站配额，Windows 专有）。
    pub gdi_objects: Option<u32>,
    pub peak_gdi_objects: Option<u32>,
    /// USER 对象句柄数与峰值（同上；每扇窗、每个控件都算它）。
    pub user_objects: Option<u32>,
    pub peak_user_objects: Option<u32>,
    /// **我们家那棵 WebView2 树的进程数**（不含自己）—— 真正吃掉几百 MB 的常在这棵树里，
    /// 只读主进程等于读错对象（本仓 2026-10-15 就定过这条口径，见崩溃取证账本）。
    pub tree_procs: Option<u32>,
    /// 那棵树的私有提交量之和（不含自己）。与 `commit` 两列并排看才不会把两边混成一个数。
    pub tree_private_commit: Option<u64>,
    /// **上一次采样以来**整棵子树烧掉的 CPU 毫秒（kernel + user 之和的增量），
    /// 以及那个增量对应的**时间窗**（秒）—— 两者必须一起给，只有一个数算不出占比。
    ///
    /// 这一列是 2026-10-27 那次"渲染层 11 分钟不心跳"的分岔口：
    /// - `tree_cpu=…ms` 跟窗口时长同量级（≈每核 100%）⇒ JS 主线程在空转（卡死循环/死线性的
    ///   正则或布局），进程活着但在烧 CPU；
    /// - `tree_cpu=0ms/<窗口>` ⇒ 这一格里整棵树一个指令都没执行（被挂起，或 `ProcessFailed`
    ///   之后 WebView2 不再驱动它）；
    /// - 只涨一点点（几十毫秒）⇒ 活着且空闲，问题不在这棵树里。
    ///
    /// 三种的修法完全不同，而只看 `tree_procs` 分不开前两种。
    pub tree_cpu_ms: Option<u64>,
    /// `tree_cpu_ms` 那块增量的测量窗口（秒）。没有上一次采样时两列一起是 `-`。
    pub tree_cpu_window_s: Option<u64>,
}

/// 字节 ⇒ MiB。现场行要给**整数**：小数点在按空白分字段的行里没有任何好处，
/// 而 MiB 这个量级足够判"是不是几个 GB"。
fn mib(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

/// 一列的渲染：有值给 `<k>=<MiB>MiB`，没值给 `<k>=-`。**列集合恒定**，
/// 这样读日志的人（和任何解析它的脚本）不会把"这一列没出现"误读成"这一列是 0"。
fn column(k: &'static str, v: Option<u64>) -> String {
    match v {
        Some(b) => format!("{k}={}MiB", mib(b)),
        None => format!("{k}=-"),
    }
}

/// 子树 CPU 那一列：增量**和它的窗口**一起给，缺一次采样就整列 `-`。
///
/// 为什么不拆成两列：`tree_cpu=1500ms` 单独摆在那里，读的人必须去翻上一条同码日志的时间戳
/// 才知道这是 30 秒里烧的（＝卡死）还是 5 分钟里烧的（＝空闲）。窗口就在同一个字段里，
/// 现场一眼能算出占比。
fn column_cpu(ms: Option<u64>, window_s: Option<u64>) -> String {
    match (ms, window_s) {
        (Some(m), Some(w)) => format!("tree_cpu={m}ms/{w}s"),
        // 增量有、窗口没有：正常接线走不到这里（两列同源于上一次采样），但宁可明写未知，
        // 也不要悄悄把窗口当 0 —— `0s` 会把任何增量都算成无穷大的占比。
        (Some(m), None) => format!("tree_cpu={m}ms/-s"),
        (None, _) => "tree_cpu=-".to_string(),
    }
}

fn column_count(k: &'static str, v: Option<u32>) -> String {
    match v {
        Some(n) => format!("{k}={n}"),
        None => format!("{k}=-"),
    }
}

impl MemSample {
    /// 这一格里**至少有一个**读数吗（钩子据此决定用新采样还是退回缓存）。
    pub fn has_any(&self) -> bool {
        self.working_set.is_some()
            || self.peak_working_set.is_some()
            || self.private_commit.is_some()
            || self.sys_avail_commit.is_some()
            || self.sys_total_commit.is_some()
            || self.sys_memory_load_pct.is_some()
            || self.gdi_objects.is_some()
            || self.user_objects.is_some()
    }

    /// 只有**样本列**的那半行（不含帧读仪表）。
    ///
    /// 为什么单独拆出来：仪表列在没有帧在读时本来就该是 `0`（那是真值），而样本列缺读数时
    /// 必须是 `-`。两半混在一起，"不许折成 0"这条断言就只能靠测试并发顺序才成立 ——
    /// 那是量具自己造出来的假红。
    pub fn fields_line(&self) -> String {
        [
            column("ws", self.working_set),
            column("peak_ws", self.peak_working_set),
            column("commit", self.private_commit),
            column("avail_commit", self.sys_avail_commit),
            column("total_commit", self.sys_total_commit),
            match self.sys_memory_load_pct {
                Some(p) => format!("load={p}%"),
                None => "load=-".to_string(),
            },
            column_count("gdi", self.gdi_objects),
            column_count("peak_gdi", self.peak_gdi_objects),
            column_count("user", self.user_objects),
            column_count("peak_user", self.peak_user_objects),
            column_count("tree_procs", self.tree_procs),
            column("tree_commit", self.tree_private_commit),
            column_cpu(self.tree_cpu_ms, self.tree_cpu_window_s),
        ]
        .join(" ")
    }

    /// 渲染成一行短字段（不带换行；调用方把它拼进自己那条日志/现场行）。
    ///
    /// 纯函数、不碰进程 ⇒ 它的形状有真值表（见本模块末尾的测试），不需要真把进程搞大。
    pub fn line(&self) -> String {
        // 三样：样本列（进程/系统/句柄/子树）+ 帧读仪表 + 近期大分配。
        // 大分配环挂在这里，是为了让**每一个**用 `line()` 的出口（快照、HANG、分配钩子、
        // 崩溃块）都自动带上"崩之前在干什么"，不靠某一处记得多写一行。
        format!(
            "{} {} {}",
            self.fields_line(),
            frame_read_line(),
            big_alloc_line()
        )
    }
}

// ==================== 上一格读数缓存（给钩子与看门狗用）====================

/// 缓存的是**分量**而不是整行：钩子里重新渲染一次不依赖任何堆上的旧字符串，
/// 也不会在采样失败时把上一次的值当成这一次的。
static C_WS: AtomicU64 = AtomicU64::new(NONE);
static C_COMMIT: AtomicU64 = AtomicU64::new(NONE);
static C_AVAIL: AtomicU64 = AtomicU64::new(NONE);
static C_GDI: AtomicU64 = AtomicU64::new(NONE);
static C_USER: AtomicU64 = AtomicU64::new(NONE);
/// 上一次成功采样的时刻（`crate::logging::now_ms`）；负数 = 从来没成功过。
static C_AT: AtomicI64 = AtomicI64::new(-1);
/// 上一次采样的子树 CPU 总时长（100ns）。`NONE` = 还没采过 ⇒ 第一格 `tree_cpu=-`。
static TREE_CPU_LAST: AtomicU64 = AtomicU64::new(NONE);
/// 上一次采到子树 CPU 的时刻（ms），和 `tree_cpu` 的窗口一起渲染。与 `TREE_CPU_LAST`
/// 同生同死（同一格里成对读写），所以不需要额外的同步。
static TREE_CPU_AT: AtomicI64 = AtomicI64::new(-1);

/// 存下这一格，供不能再采样的场合（分配失败钩子）读。
///
/// **一条统一策略：有读数才覆盖，一条都没有就整格不动**（包括时间戳）。
/// 反过来的写法有两种坏读法：① 把没有的列写成 `NONE` ⇒ 一次平台失败就**擦掉上一次的好读数**；
/// ② 照常盖时间戳 ⇒ 现场里出现 `cached_age=0s` 而每列都是 `-`，
/// 读的人会把"刚试着采、什么都没采到"当成"刚采到的是 0"。同一模块头的第二条边界说的就是这件事。
pub fn remember(sample: &MemSample) {
    if !sample.has_any() {
        return;
    }
    let put = |slot: &AtomicU64, v: Option<u64>| {
        if let Some(n) = v {
            slot.store(n, Ordering::Relaxed);
        }
    };
    put(&C_WS, sample.working_set);
    put(&C_COMMIT, sample.private_commit);
    put(&C_AVAIL, sample.sys_avail_commit);
    put(&C_GDI, sample.gdi_objects.map(|n| n as u64));
    put(&C_USER, sample.user_objects.map(|n| n as u64));
    C_AT.store(crate::logging::now_ms(), Ordering::Relaxed);
}

/// 上一次缓存的读数 + 它已经过期多久。
///
/// 为什么要有"过期多久"：分配失败钩子里再采一次是安全的（这几个调用都不分配），
/// 但万一平台读不到，退到的就是**五分钟前那一格** —— 把年龄写出来，看现场的人不会
/// 把旧值当成"崩的那一刻"。
pub fn cached_line() -> String {
    let read = |v: u64| -> Option<u64> {
        if v == NONE {
            None
        } else {
            Some(v)
        }
    };
    let age_ms = {
        let at = C_AT.load(Ordering::Relaxed);
        if at < 0 {
            None
        } else {
            Some((crate::logging::now_ms() - at).max(0))
        }
    };
    let s = MemSample {
        working_set: read(C_WS.load(Ordering::Relaxed)),
        private_commit: read(C_COMMIT.load(Ordering::Relaxed)),
        sys_avail_commit: read(C_AVAIL.load(Ordering::Relaxed)),
        gdi_objects: read(C_GDI.load(Ordering::Relaxed)).map(|n| n as u32),
        user_objects: read(C_USER.load(Ordering::Relaxed)).map(|n| n as u32),
        ..Default::default()
    };
    match age_ms {
        // 年龄按秒写：这一格的作用是"告诉读数的人它有多旧"，不是精确计时。
        Some(ms) => format!("{} cached_age={}s", s.line(), ms / 1000),
        None => format!("{} cached_age=-", s.line()),
    }
}

// ==================== 帧读取聚合仪表（本次唯一与热路径有关的一格）====================

/// **正在被读进内存的帧体字节数**（所有连接合计）与它的历史峰值。
///
/// 为什么钉这一格：入站最多 `MAX_INBOUND_CONNECTIONS = 128` 条（`state.rs`），每条认证后
/// 单帧上限 `MAX_FRAME = 64 MiB`（`protocol.rs`），而**跨连接没有任何按字节的预算**
/// （现搜 `acquire_many` 全仓 0 命中；三张 Semaphore 全按"条数"）。理论天花板
/// `128 × 64 MiB = 8 GiB` —— 本仓自己的一条测试注释就写过这个数
/// （`lib_source_view_tests.rs` 的 P2-03），但它只用来钉"别按声明长度一次性预分配"，
/// 没人管"同时有几条真在读"。而最大**合法**帧只有 ~1.5 MB（`GROUP_HISTORY_PAGE_MAX_BYTES`）。
///
/// ⚠️ 这一格**只计量，不拒绝**。负责人 2026-10-26 的拍板是"先补读数，再动手"：
/// 先看真实聚合值是不是那一大块，再决定准入闸给多大 —— 现在就加闸等于在没有读数的情况下
/// 改传输语义。
///
/// ⚠️ 覆盖范围也别读成全貌：它量的是**经 `transport::tcp::read_bytes_capped` 的帧读**
/// （入站接受与本机主动拨出都走这一支）。中继解封器那处同形状增长
/// （`transport/relay_seal.rs` 把内层帧体累进 `self.frame`，上限同样是 `MAX_FRAME`）
/// **还没有接进来** —— 它是流式解析器，守卫得挂在结构体字段上，记进了下一批。
/// 所以 `frame_read` 是**下限**：它涨了说明一定有人在读大帧；它不涨不证明聚合不存在。
static FRAME_READ_BYTES: AtomicU64 = AtomicU64::new(0);
static FRAME_READ_PEAK: AtomicU64 = AtomicU64::new(0);
/// 同时在被读着的**帧数** —— 聚合字节 = 这一格 × 各帧声明长度的那个乘数，缺了它
/// `frame_read` 一个数分不清"一条大帧"与"一百条中帧"。
static FRAME_READ_COUNT: AtomicU64 = AtomicU64::new(0);

/// 一帧的读取守卫。**RAII 是这里唯一正确的形状**：`read_bytes_capped` 有三条出口
/// （成功、长度不符、`read_exact` 出错），手写三条 `fetch_sub` 迟早漏一条，
/// 而漏一次就是永久虚高的仪表 —— 那比没有仪表更坏。
pub struct FrameReadGauge {
    bytes: u64,
}

impl FrameReadGauge {
    pub fn new(bytes: u64) -> Self {
        FRAME_READ_COUNT.fetch_add(1, Ordering::Relaxed);
        let now = FRAME_READ_BYTES.fetch_add(bytes, Ordering::Relaxed) + bytes;
        FRAME_READ_PEAK.fetch_max(now, Ordering::Relaxed);
        Self { bytes }
    }
}

impl Drop for FrameReadGauge {
    fn drop(&mut self) {
        FRAME_READ_BYTES.fetch_sub(self.bytes, Ordering::Relaxed);
        FRAME_READ_COUNT.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 当前/峰值的渲染，拼进 `MemSample::line()` 与任何现场行。
pub fn frame_read_line() -> String {
    format!(
        "frame_read={}MiB frame_read_peak={}MiB frames_reading={}",
        // 走下面那两个出口而不是直接读静态量：出口本身由此成为生产码的一部分
        // （`mod mem_diag` 是私有的，只被测试用到的 `pub fn` 会在 `-D warnings` 下算 dead_code）。
        mib(frame_read_bytes()),
        mib(frame_read_peak()),
        // 当前有多少帧正被读着 = 聚合值的那个"乘数"。
        FRAME_READ_COUNT.load(Ordering::Relaxed)
    )
}

pub fn frame_read_bytes() -> u64 {
    FRAME_READ_BYTES.load(Ordering::Relaxed)
}

pub fn frame_read_peak() -> u64 {
    FRAME_READ_PEAK.load(Ordering::Relaxed)
}

// ==================== 大分配记账（"崩之前在干什么"）====================

/// 多高算"大"。8 MiB 这个数不是随手取的：它是本仓里**合法流量**的上量级门槛
/// （群历史一页 1.5 MB、文件分片 342 KB 都在下面），而真正能把提交内存顶爆的
/// 一次动作（导出全库、64 MiB 级帧、整包更新）都在上面。低于这条线的不记 ——
/// 环只有 12 格，被小动作挤满就等于没有现场。
pub const BIG_ALLOC_BYTES: u64 = 8 * 1024 * 1024;

/// 环的容量。**有界是这条通道存在的前提**：一个"只增"的诊断缓冲会在长跑里
/// 变成它正要查的那个洞（本仓在 `diag_fold` 表上为这个付过一次学费，见 `logging.rs`）。
const BIG_ALLOC_RING: usize = 12;

/// `(时刻, 出生地, 字节)`。
type BigAlloc = (i64, &'static str, u64);

static BIG_ALLOCS: std::sync::Mutex<Vec<BigAlloc>> = std::sync::Mutex::new(Vec::new());

/// 往环里放一笔，并把长度夹回 `BIG_ALLOC_RING`（丢最旧）。
///
/// 纯函数、不碰全局 —— "只留最近 12 笔"这条策略要有真值表，而对着进程级全局数它的长度
/// 会造出一条只在并发顺序不利时才红的用例（同一次 `cargo test` 里别的线程也可能记一笔）。
fn ring_push(ring: &mut Vec<BigAlloc>, now_ms: i64, at: &'static str, bytes: u64) {
    ring.push((now_ms, at, bytes));
    while ring.len() > BIG_ALLOC_RING {
        ring.remove(0);
    }
}

/// 环的渲染（同样是为了可测：`big_alloc_line` 只做"取全局 + 交给这里"）。
fn ring_render(now_ms: i64, ring: &[BigAlloc]) -> String {
    if ring.is_empty() {
        return "big=-".to_string();
    }
    let items: Vec<String> = ring
        .iter()
        .rev()
        .map(|(ts, at, bytes)| format!("{at}:{}MiB/{}s", mib(*bytes), (now_ms - *ts).max(0) / 1000))
        .collect();
    // 一整格、零空格：现场行按空白分字段，`big[a,b]` 那种带括号的写法会被切成好几列，
    // 读的人（和任何解析它的脚本）分不清这是一格还是三格。
    format!("big={}", items.join(","))
}

/// 记一笔"我正要/刚刚拿走这么大一块"。低于阈值的直接丢掉（理由见 `BIG_ALLOC_BYTES`）。
///
/// 只在**已知会很大**的那几处调用（导出、整包更新、大帧读、中继内层帧、群历史一页），
/// 不给通用分配器记账 —— 给每一次分配记账本身就是新的开销与新的噪声。
pub fn note_big_alloc(at: &'static str, bytes: u64) {
    if bytes < BIG_ALLOC_BYTES {
        return;
    }
    let mut ring = BIG_ALLOCS.lock().unwrap_or_else(|e| e.into_inner());
    ring_push(&mut ring, crate::logging::now_ms(), at, bytes);
}

/// 环里最近的几笔，渲染成一格字段（没有记录给 `big=-`，给空串会被读成"没分配过"）。
///
/// 每笔带**年龄（秒）**：现场里"5 秒前的导出"和"40 分钟前的导出"是两种结论 ——
/// 前者指着崩溃，后者只是这台机器开过一次导出。
pub fn big_alloc_line() -> String {
    let now = crate::logging::now_ms();
    let ring: Vec<BigAlloc> = BIG_ALLOCS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    ring_render(now, &ring)
}

// ==================== WebView2 子进程树（"读主进程＝读错对象"那格）====================

/// 从 `pid → 父 pid` 表里算出**以 `me` 为根的整棵树**（含 `me`）。
///
/// 为什么单独做成纯函数：Windows 那边只是把 Toolhelp 的快照喂进来，"谁算我们家的进程"
/// 才是会错的地方 —— WebView2 的 browser 进程是**我们**的子进程，而 renderer/GPU/工具进程
/// 是那个 browser 进程的子孙 ⇒ 只按直接父子或只按进程名都会漏。
/// 纯函数有真值表，跨平台都能测（本仓在 mac 上写、Windows 上跑的那类判据都这个形状）。
///
/// 环（A→B→A）必须能终止：`th32ParentProcessID` 来自系统快照，我们不信它一定无环。
// 只有 Windows 那条分支真的遍历进程快照；macOS/Linux 上这函数只被测试用 ⇒ 不加这句，
// `cargo clippy -D warnings` 会在 lib 目标上报 dead_code（`--all-targets` 看得见测试，lib 看不见）。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn subtree_pids(parent_of: &std::collections::HashMap<u32, u32>, me: u32) -> Vec<u32> {
    let mut children: std::collections::HashMap<u32, Vec<u32>> = std::collections::HashMap::new();
    for (pid, parent) in parent_of {
        children.entry(*parent).or_default().push(*pid);
    }
    let mut out = vec![me];
    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    seen.insert(me);
    let mut stack = vec![me];
    while let Some(pid) = stack.pop() {
        if let Some(kids) = children.get(&pid) {
            for k in kids {
                // `seen` 既防重复入栈，也在父链成环时保证这一圈一定收口。
                if seen.insert(*k) {
                    out.push(*k);
                    stack.push(*k);
                }
            }
        }
    }
    out
}

/// 两次采样的 CPU 总时长差（100ns 单位 ⇒ 出毫秒）。
///
/// 三种情况都必须分得开：**第一次采样**（没有上一次 ⇒ `None`，不许冒充 0，
/// 0 会被读成"这 5 分钟它一点 CPU 都没烧"＝指向挂起）；**正常增量**；
/// 以及**变小了**（子进程死掉重开、或树换了一批新进程 ⇒ 计数器归零，这一格报 0 是诚实的）。
fn cpu_delta_ms(prev_100ns: Option<u64>, now_100ns: u64) -> Option<u64> {
    prev_100ns.map(|p| now_100ns.saturating_sub(p) / 10_000)
}

/// 把每格的 `(kernel_100ns, user_100ns, 这一格拿到了吗)` 折成一个总数。
///
/// **任何一个子进程读不到 ⇒ 整格未知（`None`），而不是把缺的那格当 0。**
/// 这一列唯一要分开的两件事是"挂起（0）"与"卡住（≈窗口时长）"，而一个假的 0 会直接把
/// 读的人送到"挂起"那一侧 —— 指认错方向比"这一格没证据"贵得多（本仓"折叠方向按代价定"那条规矩）。
/// 空集合也是 `None`：没有可数的孩子就没有证据。
// 与 `subtree_pids` 同一格道理：只有 Windows 那条分支真的在遍历进程快照，
// 其它平台上这个纯函数只被测试用 ⇒ 不加这句，lib 目标的 clippy 会报 dead_code。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn fold_tree_cpu(readings: &[(u64, u64, bool)]) -> Option<u64> {
    if readings.is_empty() {
        return None;
    }
    let mut total = 0u64;
    for (kernel, user, ok) in readings {
        if !ok {
            return None;
        }
        total += kernel + user;
    }
    Some(total)
}

/// 我们家那棵 WebView2 树的（进程数, 私有提交量之和, CPU 总时长 100ns）。拿不到 ⇒ `None`。
/// 第三个元素自己也是 `Option`：提交量数得出来、CPU 却有一格读不到，是完全可能的两种结局。
#[cfg(target_os = "windows")]
pub fn child_webview_tree() -> Option<(u32, u64, Option<u64>)> {
    use std::collections::HashMap;
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let me = std::process::id();
    let mut parent_of: HashMap<u32, u32> = HashMap::new();
    // SAFETY: 快照句柄用完即关；`PROCESSENTRY32W` 先置 `dwSize` 再交给 First/Next
    // （不设是 WinAPI 的的经典坑：First 直接返回 FALSE）。
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) == 1 {
            loop {
                parent_of.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                if Process32NextW(snap, &mut entry) != 1 {
                    break;
                }
            }
        }
        CloseHandle(snap);

        let tree = subtree_pids(&parent_of, me);
        let mut procs = 0u32;
        let mut bytes = 0u64;
        // 树里每一个孩子都记一笔，**问不到的那笔也进表**（`ok=false`）：
        // "少问了一个进程"与"问到了、它确实是 0"在 CPU 这列上是两种结论（见 [`fold_tree_cpu`]）。
        let mut readings: Vec<(u64, u64, bool)> = Vec::new();
        for pid in tree.iter().skip(1) {
            // 只统计**子孙**（我们自己的私有提交量在 `commit` 那一列里，加进来会双计）。
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, *pid);
            if h.is_null() {
                // 权限不够或进程刚退：提交量那一列跳过它（不虚报），CPU 那一列标成"没证据"。
                readings.push((0, 0, false));
                continue;
            }
            let mut pmc: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            if K32GetProcessMemoryInfo(
                h,
                &mut pmc as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
                pmc.cb,
            ) == 1
            {
                procs += 1;
                bytes += pmc.PrivateUsage as u64;
                // CPU 时长要单独问一次：它才是"这个子进程是在算，还是根本没在跑"的读数。
                let mut ct = FILETIME {
                    dwLowDateTime: 0,
                    dwHighDateTime: 0,
                };
                let mut et = ct;
                let mut kt = ct;
                let mut ut = ct;
                if GetProcessTimes(h, &mut ct, &mut et, &mut kt, &mut ut) == 1 {
                    let to_ns =
                        |f: &FILETIME| ((f.dwHighDateTime as u64) << 32) | f.dwLowDateTime as u64;
                    readings.push((to_ns(&kt), to_ns(&ut), true));
                } else {
                    readings.push((0, 0, false));
                }
            } else {
                // 连内存信息都没问到 ⇒ CPU 更无从问起，同样标"没证据"。
                readings.push((0, 0, false));
            }
            CloseHandle(h);
        }
        if procs == 0 {
            return None;
        }
        Some((procs, bytes, fold_tree_cpu(&readings)))
    }
}

#[cfg(not(target_os = "windows"))]
pub fn child_webview_tree() -> Option<(u32, u64, Option<u64>)> {
    // 非 Windows 上没有"我们家的 WebView2 树"这个东西可数（macOS 是 WKWebView 同进程族，
    // 计数口径不同）⇒ 明写读不到，不用 0 冒充。
    None
}

/// 提交压力阈值：系统还能提交的量低于这一格，就值得在崩之前先留一行而不是等 5 分钟。
/// 512 MiB 的选择依据：本机最大的那类合法单块（导出、整包更新、大帧）都在这个量级之下，
/// 低于它就意味着"下一次像样的分配随时会失败"——那正是 10-21 那次 318 KB 失败的前夜。
pub const COMMIT_PRESSURE_BYTES: u64 = 512 * 1024 * 1024;

/// 这一格要不要报警（纯函数 ⇒ 阈值与"读不到"两种情况都有真值表）。
pub fn under_commit_pressure(sample: &MemSample) -> bool {
    match sample.sys_avail_commit {
        Some(avail) => avail < COMMIT_PRESSURE_BYTES,
        // 读不到就不报警：宁可漏一次预告，也不要把"这台机器读不到"说成"这台机器快死了"。
        None => false,
    }
}

// ==================== 采样 ====================

/// 采一次。任何平台失败都折成"这一格没有"，绝不 panic、绝不猜。
pub fn sample() -> MemSample {
    let mut s = sample_self_and_system();
    // 子进程树单独一次遍历：它拿不到（非 Windows、权限、进程刚退）时只让那两列变 `-`，
    // 不把主进程/系统那几列一起弄没 —— 两件事没有依赖关系。
    if let Some((procs, bytes, cpu)) = child_webview_tree() {
        s.tree_procs = Some(procs);
        s.tree_private_commit = Some(bytes);
        // CPU 这一列只有**整棵树都问到了**才有值（见 `fold_tree_cpu`）：问不到就留 `-`，
        // 并且**不推进基准** —— 下一格于是报"从上一次有证据的那格起"的增量，窗口同步变长，
        // 占比仍然算得出来；反过来若在没有读数的这一格偷偷推进基准，就等于把一段未知
        // 折成了 0，而那正是这列唯一要避开的假信号。
        if let Some(cpu) = cpu {
            let now = crate::logging::now_ms();
            let prev = TREE_CPU_LAST.load(Ordering::Relaxed);
            let prev_at = TREE_CPU_AT.load(Ordering::Relaxed);
            s.tree_cpu_ms = cpu_delta_ms(if prev == NONE { None } else { Some(prev) }, cpu);
            // 窗口用上一次**采到子树**的时刻，不是本进程启动时刻：这样 `tree_cpu=0ms/30s`
            // 就是一句可以直接照着判读的话（"这 30 秒整棵树没执行过一条指令"）。
            s.tree_cpu_window_s = if prev == NONE || prev_at < 0 || now < prev_at {
                None
            } else {
                // 判定条件里已排除 `now < prev_at` ⇒ 这里不可能是负数，`as` 只做类型收窄。
                Some(((now - prev_at) / 1000) as u64)
            };
            TREE_CPU_LAST.store(cpu, Ordering::Relaxed);
            TREE_CPU_AT.store(now, Ordering::Relaxed);
        }
    }
    s
}

/// 采一次（只含主进程 + 系统 + 句柄，不含子进程树）。拆开的理由见 [`sample`]。
fn sample_self_and_system() -> MemSample {
    #[cfg(target_os = "windows")]
    {
        windows_sample()
    }
    #[cfg(target_os = "macos")]
    {
        macos_sample()
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        procfs_sample()
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux",
        target_os = "android"
    )))]
    {
        MemSample::default()
    }
}

/// Windows：三个非分配的 WinAPI 就把这一格全填上。
///
/// `K32GetProcessMemoryInfo` 要的是 `PROCESS_MEMORY_COUNTERS*`，我们传更宽的那个
/// `PROCESS_MEMORY_COUNTERS_EX` 并把 `cb` 写成它自己的大小 —— 这是 WinAPI 认版本的正规做法
/// （传小了拿不到 `PrivateUsage`，传大了直接失败），不是随手 cast。
#[cfg(target_os = "windows")]
fn windows_sample() -> MemSample {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, GetGuiResources, GR_GDIOBJECTS, GR_GDIOBJECTS_PEAK, GR_USEROBJECTS,
        GR_USEROBJECTS_PEAK,
    };

    let mut s = MemSample::default();
    // SAFETY: 三个调用都只读栈上的结构体；`GetCurrentProcess()` 返回的是伪句柄（不需要、
    // 也不允许 close）；`dwLength`/`cb` 都按各自结构体的真实大小写满，WinAPI 靠它认版本。
    unsafe {
        let me: HANDLE = GetCurrentProcess();
        let mut pmc: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
        pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        if K32GetProcessMemoryInfo(
            me,
            &mut pmc as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            pmc.cb,
        ) != 0
        {
            s.working_set = Some(pmc.WorkingSetSize as u64);
            s.peak_working_set = Some(pmc.PeakWorkingSetSize as u64);
            s.private_commit = Some(pmc.PrivateUsage as u64);
        }
        let mut msx: MEMORYSTATUSEX = std::mem::zeroed();
        msx.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut msx) != 0 {
            s.sys_avail_commit = Some(msx.ullAvailPageFile);
            s.sys_total_commit = Some(msx.ullTotalPageFile);
            s.sys_memory_load_pct = Some(msx.dwMemoryLoad);
        }
        s.gdi_objects = Some(GetGuiResources(me, GR_GDIOBJECTS));
        s.peak_gdi_objects = Some(GetGuiResources(me, GR_GDIOBJECTS_PEAK));
        s.user_objects = Some(GetGuiResources(me, GR_USEROBJECTS));
        s.peak_user_objects = Some(GetGuiResources(me, GR_USEROBJECTS_PEAK));
    }
    s
}

/// macOS：`getrusage(RUSAGE_SELF).ru_maxrss` 在 darwin 上就是**字节**（Linux 上是 KB，
/// 所以两边不共用一个函数）。只有峰值，没有当前工作集 —— 拿它需要 mach 端口，
/// 而这一格的目的只是"长跑趋势"，峰值足够看出单调增长。
#[cfg(target_os = "macos")]
fn macos_sample() -> MemSample {
    let mut s = MemSample::default();
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: `usage` 是我们刚零初始化的栈结构体，`RUSAGE_SELF` 只读本进程；
    // 返回值非 0 时不读它的字段。
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } == 0 {
        s.peak_working_set = Some(usage.ru_maxrss.max(0) as u64);
    }
    s
}

/// Linux / Android：直接读 `/proc`（纯 `std::fs`，零依赖；Android 上同样存在）。
#[cfg(any(target_os = "linux", target_os = "android"))]
fn procfs_sample() -> MemSample {
    let mut s = MemSample::default();
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        let kb = |key: &str| -> Option<u64> {
            status.lines().find_map(|l| {
                l.strip_prefix(key)
                    .and_then(|r| r.trim().strip_suffix(" kB"))
                    .and_then(|n| n.trim().parse::<u64>().ok())
                    .map(|v| v * 1024)
            })
        };
        s.working_set = kb("VmRSS:");
        s.peak_working_set = kb("VmHWM:");
        // 提交量的近似：常驻 + 换出（没有 `/proc/self/smaps` 那么准，但趋势一致）。
        // 复用上面那次的解析结果，不在同一份文本上把同一个字段解析两遍。
        s.private_commit = s.working_set.map(|r| r + kb("VmSwap:").unwrap_or(0));
    }
    if let Ok(mi) = std::fs::read_to_string("/proc/meminfo") {
        let kb = |key: &str| -> Option<u64> {
            mi.lines().find_map(|l| {
                l.split(':')
                    .next()
                    .filter(|k| *k == key.trim_end_matches(':'))
                    .and_then(|_| l.split(':').nth(1))
                    .and_then(|r| r.trim().strip_suffix(" kB"))
                    .and_then(|n| n.trim().parse::<u64>().ok())
                    .map(|v| v * 1024)
            })
        };
        let avail = kb("MemAvailable:");
        let swap_free = kb("SwapFree:");
        s.sys_avail_commit = match (avail, swap_free) {
            (Some(a), Some(sf)) => Some(a + sf),
            (Some(a), None) => Some(a),
            _ => None,
        };
        s.sys_total_commit = kb("CommitLimit:");
        if let (Some(total), Some(avail)) = (kb("MemTotal:"), kb("MemAvailable:")) {
            s.sys_memory_load_pct = Some(
                ((total.saturating_sub(avail)) * 100)
                    .checked_div(total.max(1))
                    .unwrap_or(0) as u32,
            );
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ① 缺字段必须渲染成 `-`，**不许**折成 0 —— 这是这个模块最容易改坏的一处。
    #[test]
    fn missing_readings_render_as_dash_not_zero() {
        let line = MemSample::default().fields_line();
        for k in [
            "ws",
            "peak_ws",
            "commit",
            "avail_commit",
            "total_commit",
            "gdi",
            "user",
            "tree_procs",
            "tree_commit",
            "tree_cpu",
        ] {
            assert!(
                line.contains(&format!("{k}=-")),
                "{k} 缺读数时必须是 `-`（写 0 会被读成\"这台机器剩 0\"）：{line}"
            );
        }
        assert!(!line.contains("0MiB"), "样本列不许出现 0 值：{line}");
        assert!(line.contains("load=-"), "使用率同样不许折 0：{line}");
    }

    /// ② 有读数时按 MiB 整数渲染，且**列集合恒定**（每格都在，值换不换都在）。
    #[test]
    fn present_readings_render_in_mib_and_the_column_set_is_stable() {
        let full = MemSample {
            working_set: Some(3 * 1024 * 1024),
            peak_working_set: Some(5 * 1024 * 1024),
            private_commit: Some(7 * 1024 * 1024),
            sys_avail_commit: Some(9 * 1024 * 1024),
            sys_total_commit: Some(11 * 1024 * 1024),
            sys_memory_load_pct: Some(83),
            gdi_objects: Some(120),
            peak_gdi_objects: Some(130),
            user_objects: Some(45),
            peak_user_objects: Some(50),
            tree_procs: Some(3),
            tree_private_commit: Some(13 * 1024 * 1024),
            tree_cpu_ms: Some(4_200),
            tree_cpu_window_s: Some(30),
        };
        let line = full.fields_line();
        for want in [
            "ws=3MiB",
            "peak_ws=5MiB",
            "commit=7MiB",
            "avail_commit=9MiB",
            "total_commit=11MiB",
            "load=83%",
            "gdi=120",
            "peak_gdi=130",
            "user=45",
            "peak_user=50",
            "tree_procs=3",
            "tree_commit=13MiB",
            "tree_cpu=4200ms/30s",
        ] {
            assert!(line.contains(want), "少了 {want}：{line}");
        }
        // 现场行按空白分字段（`logging.rs` 的 `field_str`），所以值里不许出现空白。
        let cols: Vec<&str> = line.split_whitespace().collect();
        assert_eq!(cols.len(), 13, "每格必须刚好一个空格分隔的字段：{line}");
        assert!(cols.iter().all(|c| c.contains('=')), "全是 k=v：{line}");
        // 空样本与满样本列数一致 —— 解析方（和读日志的人）不会看到"某一列消失了"。
        assert_eq!(
            MemSample::default()
                .fields_line()
                .split_whitespace()
                .count(),
            cols.len(),
            "列集合不随读数有无而变"
        );
        // 仪表列挂在完整行上（`line()`），不在样本列里：两半的"0 的含义"不一样。
        let whole = full.line();
        assert!(
            whole.starts_with(&line)
                && whole.contains("frame_read=")
                && whole.contains("frames_reading=")
                && whole.contains("big="),
            "完整行 = 样本列 + 帧读仪表 + 大分配环（少一样，某个出口就再也带不出它）：{whole}"
        );
    }

    /// ③ 帧读仪表：离开作用域必须归还（RAII），峰值按**聚合**记而不是按单帧。
    ///
    /// ⚠️ 断言用的是一个**别的用例不可能碰到的标记值**（7 GiB），不是"前后相等"：
    /// 这几个静态量是进程级的，`cargo test` 的线程池里别的用例（`transport/tcp.rs` 那几条
    /// 读帧测试）随时在同加同减 —— 拿 `after == base` 当判据会造出一条只在并发顺序不利时
    /// 才红的用例，那正是本仓反复踩过的"量具自己不稳"。标记值方案对并发完全免疫：
    /// 真实现里没有任何一条帧会预约 7 GiB（上限就是 `MAX_FRAME` 的 64 MiB）。
    #[test]
    fn frame_gauge_returns_on_every_exit_and_peaks_on_the_aggregate() {
        const MARK: u64 = 7 * 1024 * 1024 * 1024;
        {
            let _a = FrameReadGauge::new(MARK / 2);
            let _b = FrameReadGauge::new(MARK / 2);
            assert!(
                frame_read_bytes() >= MARK,
                "两帧同时在读 ⇒ 聚合值是两者之和（当前 {}）",
                frame_read_bytes()
            );
            assert!(frame_read_peak() >= MARK, "峰值记的是聚合值，不是单帧大小");
        }
        assert!(
            frame_read_bytes() < MARK,
            "守卫离开作用域后，属于本用例的 7 GiB 必须已经归还（残留 {}）",
            frame_read_bytes()
        );

        // 早退（相当于 `read_exact` 出错时 `?` 直接返回）同样归还。
        fn early_return() -> u64 {
            let _g = FrameReadGauge::new(MARK);
            7
        }
        assert_eq!(early_return(), 7);
        assert!(
            frame_read_bytes() < MARK,
            "出错早退也必须归还（残留 {}）",
            frame_read_bytes()
        );
    }

    /// ④ 缓存的两条性质：**自述年龄** + **有读数才覆盖**。
    ///
    /// ⚠️ 三条断言必须待在同一个测试里顺序跑：缓存是进程级原子量，`cargo test` 的线程池
    /// 会把拆开的用例并发执行 ⇒ 一条刚存完、另一条把别的样本盖进去，红绿都失去意义
    /// （`logging.rs` 的再入闸那条用例是同一条道理）。
    ///
    /// 为什么"有读数才覆盖"值得钉：分配失败钩子退的就是这份缓存。旧写法一次平台失败
    /// 就把上一次的好读数擦成 `-`，同时照常盖时间戳 ⇒ 现场里出现 `cached_age=0s` + 全列 `-`，
    /// 读的人会把"刚试着采、什么都没采到"当成"刚采到的全是 0"。
    #[test]
    fn cache_marks_its_own_age_and_only_overwrites_with_a_reading() {
        let line = cached_line();
        assert!(line.contains("cached_age="), "缓存行必须自述多旧：{line}");

        // (a) 存一整格 ⇒ 读回来就是这一格；没存过的列仍是 `-`，不凭空出现。
        remember(&MemSample {
            working_set: Some(4 * 1024 * 1024),
            private_commit: Some(6 * 1024 * 1024),
            sys_avail_commit: Some(8 * 1024 * 1024),
            gdi_objects: Some(12),
            ..Default::default()
        });
        let after = cached_line();
        assert!(
            after.contains("ws=4MiB") && after.contains("gdi=12"),
            "缓存里读的必须是上一次存的那格：{after}"
        );
        assert!(
            after.contains("peak_ws=-"),
            "没存过的列仍然不能凭空出现：{after}"
        );

        // (b) 空手而归**不许**擦掉上一格，也不许把时间戳冒充成"刚采的"。
        // 先把时间戳推到 60 秒前：若 `remember` 在不该写的时候写了它，这里就会读到 0s。
        C_AT.store(crate::logging::now_ms() - 60_000, Ordering::Relaxed);
        remember(&MemSample::default());
        let stale = cached_line();
        assert!(
            stale.contains("ws=4MiB") && stale.contains("gdi=12"),
            "整格都没有读数 ⇒ 上一次的好读数一个字都不许掉：{stale}"
        );
        assert!(
            stale.contains("cached_age=60s"),
            "没有任何新读数时不许刷新时间戳（否则旧值会冒充此刻）：{stale}"
        );

        // (c) 部分有读数 ⇒ 只更新它那一列，别的列保留。
        remember(&MemSample {
            user_objects: Some(34),
            ..Default::default()
        });
        let partial = cached_line();
        assert!(
            partial.contains("ws=4MiB") && partial.contains("user=34"),
            "有读数才覆盖：`ws` 该留着、`user` 该更新：{partial}"
        );
    }

    /// ⑤ 本平台的采样真的拿得到东西（Windows/Linux/Android 至少一列；macOS 有峰值）。
    ///
    /// 这条是**平台自适应**的断言，不点名平台：它只反对"接线接错了、永远读不到"那种
    /// 看起来全绿的形状。
    #[test]
    fn sample_on_the_host_platform_returns_something() {
        let s = sample();
        #[cfg(target_os = "windows")]
        assert!(
            s.working_set.is_some() && s.sys_avail_commit.is_some() && s.gdi_objects.is_some(),
            "Windows 上这三列必须都有：{}",
            s.line()
        );
        #[cfg(target_os = "macos")]
        assert!(
            s.peak_working_set.is_some(),
            "macOS 上至少要有 peak RSS：{}",
            s.line()
        );
        #[cfg(any(target_os = "linux", target_os = "android"))]
        assert!(
            s.working_set.is_some() || s.sys_avail_commit.is_some(),
            "/proc 读不到就说明接线错了：{}",
            s.line()
        );
    }

    /// ⑥ 大分配环的策略：阈值、只留最近 N 笔、渲染的年龄与"没记过"。
    ///
    /// 打的是**纯函数**（`ring_push` / `ring_render`）而不是那个全局环：环是进程级的，
    /// 同一趟 `cargo test` 里别的线程也可能记一笔，拿"长度正好等于我推的条数"当判据
    /// 会造出一条只在并发顺序不利时才红的用例。
    #[test]
    fn big_alloc_ring_keeps_the_newest_and_renders_age() {
        const MIB: u64 = 1024 * 1024;
        let mut ring: Vec<BigAlloc> = Vec::new();
        let t0 = 1_000_000;
        for i in 0..(BIG_ALLOC_RING + 3) {
            ring_push(&mut ring, t0 + i as i64 * 1000, "leak-me", 9 * MIB);
        }
        assert_eq!(
            ring.len(),
            BIG_ALLOC_RING,
            "环必须有上界（只增的诊断缓冲就是它要查的那个洞）"
        );
        assert_eq!(ring.last().expect("非空").1, "leak-me");
        // 丢的是最旧那三笔，不是随机一笔。
        assert_eq!(ring.first().expect("非空").0, t0 + 3000, "必须从最旧那头丢");
        let line = ring_render(t0 + 99_000, &ring);
        assert!(
            line.starts_with("big=leak-me:9MiB/"),
            "渲染要带 MiB 与年龄：{line}"
        );
        // 整列必须是一个无空格的字段（最新那笔排最前，旧的逗号连着跟在后面）。
        assert!(
            !line.contains(' '),
            "整列得是一个字段，不能被空白切开：{line}"
        );
        assert!(
            line.contains(",leak-me:9MiB/"),
            "环里其它几笔也要都渲染出来：{line}"
        );
        // 没记过 ⇒ `big=-`，不是 `big[]` 也不是省略这一列。
        assert_eq!(ring_render(t0, &[]), "big=-", "空环必须明写\"没记过\"");
        // 阈值本身（低于它不进环）。
        note_big_alloc("small", BIG_ALLOC_BYTES - 1);
        assert!(
            !big_alloc_line().contains("small"),
            "低于阈值的不能进环（环只有 12 格）"
        );
        note_big_alloc("edge", BIG_ALLOC_BYTES);
        assert!(
            big_alloc_line().contains("edge:8MiB"),
            "阈值是\"≥\"，不是\">\"：{}",
            big_alloc_line()
        );
    }

    /// ⑦ "谁算我们家的子进程"必须是纯逻辑且有真值表 —— 子进程树那一列对不对，全看它。
    #[test]
    fn tree_walk_takes_whole_subtree_not_just_children() {
        use std::collections::HashMap;
        // me=10；11 是我们的直接子；12 是 11 的子（WebView2 的 renderer 就是这种孙子层）；
        // 20 是别人的进程；21 的父是 20 ⇒ 整支都不该进来。
        let mut m: HashMap<u32, u32> = HashMap::new();
        m.insert(10, 4);
        m.insert(11, 10);
        m.insert(12, 11);
        m.insert(20, 4);
        m.insert(21, 20);
        let mut got = subtree_pids(&m, 10);
        got.sort_unstable();
        assert_eq!(
            got,
            vec![10, 11, 12],
            "要沿父链把整棵树收全：只收直接子会漏掉 renderer/GPU 那一层"
        );
        // 父链成环也必须收口（`th32ParentProcessID` 来自系统快照，不信它无环）。
        let mut cyc: HashMap<u32, u32> = HashMap::new();
        cyc.insert(1, 2);
        cyc.insert(2, 1);
        let mut g2 = subtree_pids(&cyc, 1);
        g2.sort_unstable();
        assert_eq!(g2, vec![1, 2], "成环时要终止而不是死循环，且仍返回可达集合");
    }

    /// ⑧ 提交压力：只有"确实读到且低于阈值"才报警。
    #[test]
    fn commit_pressure_only_fires_on_a_real_reading() {
        let mib = 1024 * 1024;
        assert!(
            !under_commit_pressure(&MemSample::default()),
            "读不到就不能当成\"快死了\"（宁可漏一次预告）"
        );
        assert!(
            under_commit_pressure(&MemSample {
                sys_avail_commit: Some(COMMIT_PRESSURE_BYTES - mib),
                ..Default::default()
            }),
            "低于阈值必须点亮"
        );
        assert!(
            !under_commit_pressure(&MemSample {
                sys_avail_commit: Some(COMMIT_PRESSURE_BYTES),
                ..Default::default()
            }),
            "刚好等于阈值不算越界（严格小于）"
        );
    }

    /// ⑨ 子树 CPU 增量的真值表 —— 这一列是"渲染进程挂起"和"JS 主线程卡住"唯一的分岔口，
    /// 把第一次采样冒充成 0 会把**每一次**崩溃都误判成前者。
    #[test]
    fn subtree_cpu_delta_distinguishes_never_sampled_from_idle() {
        const T100NS_PER_MS: u64 = 10_000;
        // (a) 第一格：没有"上一次" ⇒ None（渲染成 `tree_cpu=-`），绝不是 0ms。
        assert_eq!(
            cpu_delta_ms(None, 500 * T100NS_PER_MS),
            None,
            "第一格必须空着：0ms 会被读成\"这一格一点 CPU 都没烧\"＝指向挂起"
        );
        // (b) 正常增量：一秒的 CPU ⇒ 1000ms。量纲在这里最容易写反（1ms = 10_000 个 100ns
        //     刻度），反了的话这一格是唯一能抓住它的断言 —— 我自己第一版就写反了。
        assert_eq!(
            cpu_delta_ms(Some(100 * T100NS_PER_MS), 1_100 * T100NS_PER_MS),
            Some(1000)
        );
        // (c) 真·空转：两次采样计数一模一样 ⇒ Some(0)。这才是"挂起/没在跑"的读数。
        assert_eq!(
            cpu_delta_ms(Some(100 * T100NS_PER_MS), 100 * T100NS_PER_MS),
            Some(0),
            "计数不动时必须是 0（与 None 分得开，这一格才是\"挂起\"的证据）"
        );
        // (d) 计数器变小（renderer 被换掉 ⇒ 新进程从 0 开始累计）⇒ 报 0，不许下溢 panic。
        assert_eq!(
            cpu_delta_ms(Some(300 * T100NS_PER_MS), 5 * T100NS_PER_MS),
            Some(0),
            "换进程时减法下溢会直接 panic 在采样路径上"
        );
        // (e) 不足 1ms 的增量诚实地报 0（这列的分辨率就是 1ms，别指望它测毫秒以下）。
        assert_eq!(cpu_delta_ms(Some(0), T100NS_PER_MS - 1), Some(0));

        // (f) 渲染：增量和窗口必须**一起**给。只有毫秒的话，`tree_cpu=1500ms` 到底是
        // "30 秒里烧的"（＝卡死）还是"5 分钟里烧的"（＝空闲）得去翻上一条的时间戳 ——
        // 现场文件是给人一眼判读的，不是一道交叉引用题。
        assert_eq!(column_cpu(Some(1_500), Some(30)), "tree_cpu=1500ms/30s");
        assert_eq!(column_cpu(None, None), "tree_cpu=-");
        // 窗口没跟着算出来时明写未知，不许偷偷当 0（`0s` 会把任何增量算成无穷大占比）。
        assert_eq!(column_cpu(Some(1_500), None), "tree_cpu=1500ms/-s");
        assert_eq!(column_cpu(Some(0), Some(0)), "tree_cpu=0ms/0s");

        // (g) 折总数的方向：**有一个进程问不到 ⇒ 整格没证据**，不许把"少问了一个"折成 0。
        // `0ms` 是这一列里唯一会指认错方向的读数（它的意思就是"挂起"），所以这一格只能空着。
        assert_eq!(fold_tree_cpu(&[]), None, "没有可数的孩子就没有证据");
        assert_eq!(fold_tree_cpu(&[(7, 3, true), (0, 10, true)]), Some(20));
        assert_eq!(
            fold_tree_cpu(&[(7, 3, true), (0, 0, false)]),
            None,
            "一个进程没问到就把整格标成未知：当 0 算会让每次卡死都被读成挂起"
        );
    }
}
