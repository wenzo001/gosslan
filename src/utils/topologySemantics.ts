/**
 * 「我的网络」视图的**语义层**（纯逻辑，可单测）。
 *
 * ## 为什么要有这一层
 *
 * 网络拓扑页此前把「合成的公网中转/ Mesh 中枢」画成了图上的**节点**，
 * 于是用户看到「中心设备带一圈节点」—— 那是中心化误读。
 * 方案（`docs/notes/network-topology-visualization-plan-2026-11-16.md`）要求：
 *
 * 1. 图的主语是「**本机正在观察到什么**」，本机是**观察端点**，不是网络中心；
 * 2. 节点与边分开：节点 = 稳定设备身份，边 = **有来源、有时间**的路径关系；
 * 3. Relay / Routed / Mesh Hop **分开表达**（它们不是同一种中继）；
 * 4. 未知状态显式保留（没有链路 ≠ 离线 ≠ 无连接）；
 * 5. **不推断**关系：后端没有远端 peer-peer 边，就不许画 peer-peer 边；
 *    多跳只知道跳数、不知道中间是谁，就不许画中间节点。
 *
 * ## 后端现在能给什么（2026-11-16 实读）
 *
 * - `Peer.link`：本机到该 Peer 的**当前选路**类型（`lan` / `routed` / `relay` / `bluetooth`），
 *   **不是**该 Peer 的全部健康路径；
 * - `get_conv_link`（好友会话）：`path` + `hop`（hop > 0 = 经其他节点转发，**中间节点身份不可见**）；
 * - **没有**：任意两个远端 Peer 之间的边、中间节点身份、边的观测时间戳。
 *
 * ⇒ 本模块产出的图**永远只有「本机 → Peer」的边**，且每条边都能指回上面某个字段。
 */

/** 路径种类。`unknown` = 本地没有关系证据（不是「离线」，也不是「零跳」）。 */
export type PathKind = "lan" | "routed" | "bluetooth" | "relay" | "mesh" | "unknown";

/** 直接路径（不经任何中继）：LAN / 路由 IP / 蓝牙。 */
export function isDirectPath(kind: PathKind): boolean {
  return kind === "lan" || kind === "routed" || kind === "bluetooth";
}

/**
 * 需要「中间节点当前不可见」提示的路径：公网中转与 Mesh 多跳。
 *
 * ⚠️ `routed` **不算**：路由 IP 是对端真实 IP 可达，中间没有转发节点。
 */
export function needsIntermediateNotice(kind: PathKind): boolean {
  return kind === "relay" || kind === "mesh";
}

/**
 * 路径种类判定（唯一口径）。
 *
 * `link` 是 `Peer.link`（本机当前选路）；`hop` 是好友会话的跳数（`get_conv_link`）。
 * - `hop > 0` 且没有具体 link ⇒ Mesh 多跳（经其他 Gosslan 节点转发）；
 * - `link = relay` ⇒ 公网中转电路；
 * - 都不认识 ⇒ `unknown`（**显式的「不知道」**，不许折叠成离线或零跳）。
 */
export function pathKindOf(
  link: string | null | undefined,
  hop: number | null | undefined,
): PathKind {
  const h = typeof hop === "number" && Number.isFinite(hop) && hop > 0 ? hop : 0;
  if (link === "lan" || link === "routed" || link === "bluetooth") return link;
  if (link === "relay") return "relay";
  if (h > 0) return "mesh";
  return "unknown";
}

/** 路径标签的 i18n 键（`topology.link.*`）。多跳带跳数。 */
export function pathLabelKey(kind: PathKind, _hop?: number | null): string {
  switch (kind) {
    case "lan":
      return "topology.link.lan";
    case "routed":
      return "topology.link.routed";
    case "bluetooth":
      return "topology.link.bluetooth";
    case "relay":
      return "topology.link.relay";
    case "mesh":
      return "topology.link.hop";
    default:
      return "topology.link.unknown";
  }
}

/** 「我的网络」里的一个设备节点（不含坐标 —— 坐标是布局的事，不是语义的事）。 */
export interface TopologyPeer {
  id: string;
  label: string;
  avatar: string | null;
  deviceType?: string;
  /** 是好友（决定节点着色与可执行动作）。 */
  isFriend: boolean;
  /** 本机此刻能观测到它（在线 peer 名单里的）。 */
  online: boolean;
  /** 本机到它的当前选路（`unknown` = 没有关系证据）。 */
  pathKind: PathKind;
  /** 会话链路给出的跳数（> 0 = 经其他节点转发，中间身份不可见）。 */
  hop: number;
  /** 到它的往返延迟（毫秒）；`null` = 没有测到。 */
  rttMs: number | null;
  /** 首次发现时间（布局的插入序，保证老节点不跳位）。 */
  firstSeen: number;
}

/** 拼装拓扑时要用的输入（与具体 store 解耦，便于单测）。 */
export interface TopologyInput {
  /** 当前在线的 peer（后端 `peers` 名单）。 */
  peers: {
    device_id: string;
    nickname: string;
    avatar: string | null;
    device_type?: string;
    link?: string | null;
    rtt_ms?: number | null;
    first_seen?: number | null;
    last_seen?: number | null;
  }[];
  /** 好友名单（含离线的）。 */
  friends: {
    device_id: string;
    nickname: string;
    avatar: string | null;
    device_type?: string;
  }[];
  /** 好友会话链路（`get_conv_link`）：`device_id → { path, hop }`。 */
  convLinks: Record<string, { path?: string | null; hop?: number | null } | undefined>;
}

/** 拓扑的统计与分组摘要（**路径摘要**，不是设备清单）。 */
export interface TopologySummary {
  /** 本机此刻观测到的设备数。 */
  observed: number;
  /** 其中好友数。 */
  friends: number;
  /** 经公网中转的路径条数（**路径类型**，不是中转设备数）。 */
  relayed: number;
  /** 经 Mesh 转发可达的设备数（中间节点身份不可见）。 */
  mesh: number;
  /** 离线好友数（**不进图**，只进列表/筛选）。 */
  offlineFriends: number;
}

/**
 * 拼装「我的网络」的节点清单。
 *
 * 口径（方案 §信息架构 A）：
 * - **在线 peer** ⇒ 进图（画在本机周围，带当前选路标签）；
 * - **离线好友** ⇒ 不进图（否则会画成「仍在线」），只在列表与筛选里出现；
 * - **relay / mesh** ⇒ 节点仍然是那个 peer 本身（**不合成中转节点**），
 *   边上标出路径类型；中间节点身份不可见 ⇒ 只给文字提示。
 */
export function buildTopologyPeers(input: TopologyInput): {
  peers: TopologyPeer[];
  summary: TopologySummary;
} {
  const friendById = new Map(input.friends.map((f) => [f.device_id, f]));
  const onlineIds = new Set(input.peers.map((p) => p.device_id));
  const peers: TopologyPeer[] = [];

  for (const p of input.peers) {
    const friend = friendById.get(p.device_id);
    const conv = input.convLinks[p.device_id];
    const hop = typeof conv?.hop === "number" && conv.hop > 0 ? conv.hop : 0;
    // 优先用会话链路的 path（更贴近「这条会话现在走哪条路」），没有才退回 peer.link。
    const link = conv?.path ?? p.link ?? null;
    peers.push({
      id: p.device_id,
      label: p.nickname || friend?.nickname || p.device_id.slice(0, 12),
      avatar: p.avatar ?? friend?.avatar ?? null,
      deviceType: p.device_type || friend?.device_type,
      isFriend: Boolean(friend),
      online: true,
      pathKind: pathKindOf(link, hop),
      hop,
      rttMs: p.rtt_ms ?? null,
      firstSeen: p.first_seen ?? p.last_seen ?? 0,
    });
  }

  const summary: TopologySummary = {
    observed: peers.length,
    friends: peers.filter((p) => p.isFriend).length,
    relayed: peers.filter((p) => p.pathKind === "relay").length,
    mesh: peers.filter((p) => p.pathKind === "mesh").length,
    offlineFriends: input.friends.filter((f) => !onlineIds.has(f.device_id)).length,
  };
  return { peers, summary };
}

/** 列表筛选（**只影响呈现，不改数据**）。 */
export type TopologyFilter = "all" | "friends" | "offline";

/**
 * 列表视图的条目：在线设备 + 离线好友。
 *
 * 离线好友**没有路径事实**（`pathKind = unknown`）—— 不能画成「有连接」，
 * 也不能说成「故障」，只能说「现在离线」。
 */
export interface TopologyListItem extends TopologyPeer {
  offline: boolean;
}

export function buildTopologyList(input: TopologyInput): TopologyListItem[] {
  const { peers, summary } = buildTopologyPeers(input);
  const onlineIds = new Set(peers.map((p) => p.id));
  const items: TopologyListItem[] = peers.map((p) => ({ ...p, offline: false }));
  for (const f of input.friends) {
    if (onlineIds.has(f.device_id)) continue;
    items.push({
      id: f.device_id,
      label: f.nickname || f.device_id.slice(0, 12),
      avatar: f.avatar ?? null,
      deviceType: f.device_type,
      isFriend: true,
      online: false,
      pathKind: "unknown",
      hop: 0,
      rttMs: null,
      firstSeen: 0,
      offline: true,
    });
  }
  void summary;
  return items;
}

export function filterTopologyList(
  items: TopologyListItem[],
  filter: TopologyFilter,
): TopologyListItem[] {
  if (filter === "friends") return items.filter((i) => i.isFriend);
  if (filter === "offline") return items.filter((i) => i.offline);
  return items;
}

/** ---------------- 邻域布局（纯函数，坐标由它算） ---------------- */

/** 布局只需要的节点形状（与渲染无关）。 */
export interface LayoutNode {
  id: string;
  /** 插入序（first_seen）：老节点在前。 */
  ts: number;
  /** 本机节点（观察端点）。 */
  self?: boolean;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

export interface NeighborhoodLayout {
  /** 本机锚点坐标。 */
  anchor: { x: number; y: number };
  /** 每个设备节点的坐标（按 id 索引）。 */
  points: Map<string, { x: number; y: number }>;
  /** 节点是否按窄屏（竖屏扇形）布局。 */
  narrow: boolean;
  /** 图上最多能放多少个设备（超出的只在列表里）—— 保证最外一行也不出画布。 */
  maxNodes: number;
}

/**
 * 邻域布局：**本机是观察端点**（宽屏在左、窄屏在底），设备节点向另一侧展开成扇形。
 *
 * 为什么不是「本机在中心的一圈」：那读成「本机在中心路由全网」（方案 §信息架构 A 的
 * 「本机不得表现为权威根节点」）。扇形展开把「本机 → 其它设备」的方向性说清楚。
 *
 * 稳定性（方案 §布局）：
 * - 槽位按插入序分配（`ts` 升序，同序按 id）⇒ **新节点只追加，老节点不跳位**；
 * - 每环的角度槽是 `[0, +Δ, −Δ, +2Δ, −2Δ, …]` ⇒ 头几个节点也居中，不偏向一侧；
 * - 全部坐标**现算**（fx/fy 钉死）⇒ 没有力模拟动画，刷新不抖。
 */
export function layoutNeighborhood(
  nodes: LayoutNode[],
  w: number,
  h: number,
): NeighborhoodLayout {
  const narrow = w < 768;
  const margin = narrow ? 64 : 96;
  const self = nodes.find((n) => n.self);
  const others = nodes
    .filter((n) => !n.self)
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));

  // 本机锚点：宽屏在左侧中部、窄屏在底部中央（**观察端点**，不是网络中心）。
  const ax = narrow ? 0 : -(w / 2 - margin);
  const ay = narrow ? h / 2 - margin : 0;

  // 「邻域云」用**网格**排布，不用圆弧。
  //
  // 为什么不用圆弧（2026-11-16 review 实测）：圆弧在宽画布上只占一条**窄带**
  // （x 从 -404 到 -155，右边三分之二空着），而且环半径一大就**溢出画布**
  // （1440×900 时算到 y=488 > 可见区 450 ⇒ 节点被画到屏幕外、点不到）。
  // 网格两向都填得满，且每个格子的位置**只由画布尺寸决定** ⇒ 稳定、不溢出。
  const cols = narrow ? 2 : 4;
  const availW = Math.max(w - margin * 2, 160);
  const availH = Math.max(h - margin * 2, 160);
  const gapFromSelf = narrow ? 96 : 118;
  // 列距：云从本机右侧一路铺到画布右缘（不留空地）。
  const cellX = Math.max(narrow ? 74 : 96, (availW - gapFromSelf) / Math.max(1, cols - 1 || 1));
  const cellY = narrow ? 84 : Math.min(96, Math.max(72, (availH / 2) * 0.5));
  // 行数上限：保证**最外一行也在可见区内**（超出的设备只在列表里，见下）。
  const maxRows = Math.max(1, Math.floor(availH / 2 / cellY) + 1);
  const maxNodes = cols * maxRows;

  const points = new Map<string, { x: number; y: number }>();
  if (self) points.set(self.id, { x: ax, y: ay });
  others.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // 行交替向上/向下 ⇒ 头几行也居中，不偏向一侧；老节点的位置只由 (col,row) 决定。
    const rowOffset = row === 0 ? 0 : Math.ceil(row / 2) * (row % 2 === 1 ? 1 : -1);
    const x = narrow
      ? ax + (col - (cols - 1) / 2) * cellX
      : ax + gapFromSelf + col * cellX;
    const y = narrow ? ay - gapFromSelf - row * cellY : ay + rowOffset * cellY;
    points.set(n.id, { x, y });
  });
  return { anchor: { x: ax, y: ay }, points, narrow, maxNodes };
}
