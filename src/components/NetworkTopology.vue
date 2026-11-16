<script setup lang="ts">
/**
 * 「我的网络」（本机邻域图）：**本机是观察端点**，不是网络中心。
 *
 * ## 与旧版的差别（2026-11-16，按网络拓扑可视化方案阶段 1 改）
 *
 * 旧版把「合成的公网中转 / Mesh 中枢」画成图上的**节点**，于是整张图读成
 * 「中心设备带一圈节点」—— 那是中心化误读。现在：
 *
 * 1. **没有合成节点**：relay / mesh 的对端**就是那个 peer 自己**，边上标路径类型；
 *    中转设备与中间节点身份**不可见** ⇒ 只给文字提示，不画假节点；
 * 2. **本机在侧边（宽屏）/ 底部（窄屏）锚点**，节点向另一侧展开成扇形 ——
 *    「我的观察视角」，不是「本机在中心路由全网」；
 * 3. **路径类型分开**：LAN / 路由 IP / 蓝牙 / 公网中转 / Mesh 多跳 各有各的标签与线型；
 * 4. **未知显式保留**：没有链路证据就是「已发现未建链」，不是离线、不是零跳；
 * 5. **图与列表同源**：同一份语义数据（`src/utils/topologySemantics.ts`），
 *    列表另有筛选与最后更新时间 —— 图给形状，列表给可读与可操作。
 *
 * ## 不变量（方案 §产品表达原则）
 *
 * - 图里**只有**「本机 → Peer」的边：后端没有远端 peer-peer 边，本页也不推断；
 * - 稳定坐标 + 相机归用户：刷新不夺走视角、不让老节点跳位；
 * - 图例、颜色、线型、图标**各自独立**表达路径含义（不靠颜色当唯一信号）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useMediaQuery } from "@vueuse/core";
import ForceGraph from "force-graph";
import Icon from "@/components/ui/Icon.vue";
import AvatarBox from "@/components/ui/AvatarBox.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import Spinner from "@/components/ui/Spinner.vue";
import StateBlock from "@/components/ui/StateBlock.vue";
import { t } from "@/i18n";
import { REDUCED_MOTION_QUERY } from "@/utils/platform";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
import { detailText } from "@/composables/useErrorText";
import {
  buildTopologyList,
  buildTopologyPeers,
  filterTopologyList,
  layoutNeighborhood,
  needsIntermediateNotice,
  pathLabelKey,
  type PathKind,
  type TopologyFilter,
  type TopologyListItem,
} from "@/utils/topologySemantics";
import type { Friend, LinkState, Peer } from "@/types";

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-chat", peerId: string): void;
}>();

const app = useAppStore();
const chat = useChatStore();

const SELF_ID = "__self__";

/** reduce 档只淡入淡出：滑动位移交还给系统偏好（判据见 design-guidelines §11.3.7）。
 *  用媒体查询的**响应式**读数 —— 会话中途开/关"减弱动态"也要跟着换档。 */
const prefersReducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
const panelTransition = computed(() => (prefersReducedMotion.value ? "topo-panel-fade" : "topo-panel"));

interface TopoNode {
  id: string;
  /** `self` = 本机（观察端点）；`friend` / `peer` = 设备节点。
   *  ⚠️ **没有 `hub`**：合成中转节点已被移除（方案阶段 1 第 1 条）——
   *  中转是**路径类型**，不是设备。 */
  kind: "self" | "friend" | "peer";
  /** first_seen（缺省 0）：布局的**插入序** —— 新节点追加在队尾，老节点不动。 */
  ts?: number;
  label: string;
  avatar?: string | null;
  deviceType?: string;
  /** 本机到它的**当前选路**类型（`unknown` = 没有关系证据）。 */
  pathKind?: PathKind;
  hop?: number;
  rtt?: number | null;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
}

interface TopoLink {
  source: string;
  target: string;
  kind: PathKind;
  hop?: number;
}

const convLinks = ref<Record<string, LinkState>>({});
const linksLoading = ref(false);
const selectedId = ref<string | null>(null);
/** 图 / 列表 双视图（方案 §交互：图与列表是**等价入口**，小屏与读屏用户走列表）。 */
const VIEWS = ["graph", "list"] as const;
const view = ref<(typeof VIEWS)[number]>("graph");
/** 列表筛选（**只影响呈现，不改数据**）。 */
const listFilter = ref<TopologyFilter>("all");
/** 路径摘要的解释是否展开（摘要卡点开说明「这是路径类型，不是本机控制中心」）。 */
const summaryOpen = ref(false);
/** 最后一次**成功**刷新的时刻（数据时间；陈旧状态据此判断）。 */
const updatedAt = ref<number | null>(null);
const cooldown = ref<Record<string, number>>({});
const host = ref<HTMLElement | null>(null);
let graph: ForceGraph<TopoNode, TopoLink> | null = null;
let resizeObs: ResizeObserver | null = null;
let boundHost: HTMLElement | null = null;
let refreshTimer = 0;
let cooldownTimer = 0;
let lastSig = "";
/** force-graph 正在画的那份节点。15s 轮询会重算 graphData（签名没变就不重灌），
 *  命中测试必须对**画布上真正画着**的这份对象做，而不是对新算的 graphData.value ——
 *  后者的节点对象是全新的（x=undefined），拿它测距永远点不中（2026-11-11 实测）。 */
let drawnNodes: TopoNode[] = [];

const friendById = computed(() => new Map(chat.friends.map((f) => [f.device_id, f])));
const onlinePeerIds = computed(() => new Set(chat.peers.map((p) => p.device_id)));
const onlineFriends = computed(() =>
  chat.friends.filter((f) => onlinePeerIds.value.has(f.device_id)),
);
const offlineFriendCount = computed(() => chat.friends.length - onlineFriends.value.length);
const outgoingByPeer = computed(
  () => new Map(chat.outgoingRequests.map((r) => [r.peer_id, r])),
);
const pendingFrom = computed(() => new Set(chat.pendingRequests.map((r) => r.from)));

function linkText(kind?: PathKind | null, hop?: number): string {
  const k = kind ?? "unknown";
  const key = pathLabelKey(k, hop);
  return k === "mesh" ? t(key, { n: hop ?? 0 }) : t(key);
}

/** 纯数据拼装：以 self 为中心；relay 与 hop>0 各挂一个合成中枢。
 *  只产出**规格**（不含坐标）—— 坐标由 buildGraphData 的确定性放射布局给。 */
const topologyInput = computed(() => ({
  peers: chat.peers,
  friends: chat.friends,
  convLinks: convLinks.value,
}));
const topoPeers = computed(() => buildTopologyPeers(topologyInput.value));

/** 图的节点与边：**只有**「本机 → Peer」**（后端没有远端 peer-peer 边，本页也不推断）。
 *  relay / mesh 的对端就是那个 peer 自己 —— **没有合成中转节点**。 */
const topoSpec = computed<{ nodes: TopoNode[]; links: TopoLink[] }>(() => {
  const nodes: TopoNode[] = [
    {
      id: SELF_ID,
      kind: "self",
      label: app.device?.nickname || t("topology.me"),
      avatar: app.device?.avatar ?? null,
      deviceType: app.device?.device_type,
    },
  ];
  const links: TopoLink[] = [];
  for (const p of topoPeers.value.peers) {
    nodes.push({
      id: p.id,
      kind: p.isFriend ? "friend" : "peer",
      label: p.label,
      avatar: p.avatar,
      deviceType: p.deviceType,
      pathKind: p.pathKind,
      hop: p.hop,
      rtt: p.rttMs ?? undefined,
      ts: p.firstSeen,
    });
    links.push({ source: SELF_ID, target: p.id, kind: p.pathKind, hop: p.hop || undefined });
  }
  return { nodes, links };
});
const stats = computed(() => ({
  online: topoPeers.value.summary.observed,
  friends: topoPeers.value.summary.friends,
  relay: topoPeers.value.summary.relayed,
  mesh: topoPeers.value.summary.mesh,
}));

/** 列表条目：在线设备 + 离线好友（**同源**：与图共用 `topologyInput`）。 */
const listItems = computed<TopologyListItem[]>(
  () => filterTopologyList(buildTopologyList(topologyInput.value), listFilter.value),
);
/** 数据是否可能已过期（最近一次刷新失败 ⇒ 保留上次成功视图但要说明）。 */
const stale = computed(() => loadError.value !== null);

function updatedAtText(): string {
  if (!updatedAt.value) return t("topology.never");
  const d = new Date(updatedAt.value);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return t("topology.updatedAt", { time: `${hh}:${mm}:${ss}` });
}

const selectedNode = computed(() => {
  if (!selectedId.value) return null;
  return topoSpec.value.nodes.find((n) => n.id === selectedId.value) ?? null;
});
const selectedFriend = computed<Friend | null>(() => {
  const n = selectedNode.value;
  return n && n.kind === "friend" ? friendById.value.get(n.id) ?? null : null;
});
const selectedPeer = computed<Peer | null>(() => {
  const n = selectedNode.value;
  return n && (n.kind === "friend" || n.kind === "peer")
    ? chat.peers.find((p) => p.device_id === n.id) ?? null
    : null;
});

type TopoPalette = ReturnType<typeof buildPalette>;

/** 主题令牌缓存：drawNode 每节点每帧都跑，getComputedStyle 不能跟着跑。
 *  键取 html 的 class + **内联 style 原文** —— applyTheme 换主题/主色改的是内联
 *  变量，只看 class 会拿到旧主色（2026-11-11 review 发现）。 */
let paletteCache: { key: string; value: TopoPalette } | null = null;

function buildPalette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    primary: v("--gosslan-primary", "#3b82f6"),
    panel: v("--gosslan-panel", "#ffffff"),
    text: v("--gosslan-text", "#111827"),
    text2: v("--gosslan-text-2", "#6b7280"),
    border: v("--gosslan-border", "#e5e7eb"),
    warn: v("--gosslan-warning", "#f59e0b"),
  };
}

function palette(): TopoPalette {
  const root = document.documentElement;
  const key = `${root.className}|${root.getAttribute("style") ?? ""}`;
  if (paletteCache?.key === key) return paletteCache.value;
  const value = buildPalette();
  paletteCache = { key, value };
  return value;
}

const linkStyle: Record<TopoLink["kind"], { color: string; dash: number[] | null; width: number }> = {
  lan: { color: "rgba(59,130,246,.75)", dash: null, width: 1.6 },
  routed: { color: "rgba(124,147,179,.8)", dash: [4, 3], width: 1.4 },
  bluetooth: { color: "rgba(168,85,247,.8)", dash: [2, 3], width: 1.4 },
  relay: { color: "rgba(245,158,11,.85)", dash: [5, 4], width: 1.6 },
  mesh: { color: "rgba(245,158,11,.85)", dash: [2, 4], width: 1.4 },
  unknown: { color: "rgba(148,163,184,.55)", dash: [2, 4], width: 1 },
};

function drawNode(node: TopoNode, ctx: CanvasRenderingContext2D, scale: number) {
  const p = palette();
  // force-graph 每次 graphData 更新都会按节点数自动 re-zoom（k = F/∛n，只剩自己时 k≈4）。
  // 节点几何**全部除以 scale**：屏幕上恒为设计尺寸（18/12/11px），不随自动缩放膨胀 ——
  // 否则只有一个节点时 self 会被画成 ~144px 大圆，把空态提示压在身上（2026-11-11 用户实报）。
  const s = Math.max(Number(scale) || 1, 0.1);
  const r = (node.kind === "self" ? 18 : 11) / s;
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  ctx.save();
  {
    if (node.kind === "self") {
      // 本机 = **观察端点**：一圈描边标出「这是我在看」，不再用那团中心光晕
      // （光晕读起来像「中心枢纽」—— 方案 §产品表达原则第 1 条）。
      ctx.strokeStyle = p.primary;
      ctx.lineWidth = 2 / s;
      ctx.setLineDash([3 / s, 3 / s]);
      ctx.beginPath();
      ctx.arc(x, y, r + 5 / s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = node.kind === "friend" ? p.primary : node.kind === "peer" ? p.text2 : p.primary;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p.panel;
    ctx.lineWidth = 2 / s;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${(node.kind === "self" ? 13 : 10) / s}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText((node.label || "?").slice(0, 1).toUpperCase(), x, y + 0.5 / s);
  }
  // 名称与链路徽标：只画两层小字，避免图面被文字淹没。
  const labelY = y + r + 10 / s;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `500 ${10 / scale}px sans-serif`;
  ctx.fillStyle = p.text;
  ctx.fillText(clip(node.label, 10), x, labelY);
  if (node.kind !== "self") {
    ctx.font = `${9 / scale}px sans-serif`;
    ctx.fillStyle = linkStyle[node.pathKind ?? "unknown"].color;
    ctx.fillText(linkText(node.pathKind, node.hop), x, labelY + 12 / scale);
  }
  ctx.restore();
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * 自己做的命中测试（不依赖 force-graph 的 hover 影子画布）。
 *
 * 库的节点点击要等 `hoverObj`，而 hoverObj 来自一块 **800ms 节流** 的影子画布：
 * 数据一变（peer 上线、conv link 回来）颜色索引会重排，影子画布在下一轮重绘前
 * 还拿着上一代颜色 ⇒ `lookup` 认不出节点，点上去是背景（2026-11-10 探针实测
 * 约 50% 复现，且"画布像素有颜色、hover 仍为空"）。这里用 `screen2GraphCoords`
 * 直接按节点当前坐标找最近的圆，拖动（>6px）不算点击。
 *
 * 同时**摘掉了库的 onNodeClick/onBackgroundClick**：那两个仍走 hoverObj，
 * 悬停失效时会异步补一发 `onBackgroundClick`，把我们刚选中的卡片又清掉。
 */
let pointerDownAt: { x: number; y: number } | null = null;

function hitRadius(node: TopoNode, k: number): number {
  return (node.kind === "self" ? 24 : 15) / (k || 1);
}

function nodeAt(ev: PointerEvent): TopoNode | null {
  const el = host.value;
  if (!el || !graph) return null;
  const r = el.getBoundingClientRect();
  const pt = graph.screen2GraphCoords(ev.clientX - r.left, ev.clientY - r.top);
  const k = graph.zoom();
  let best: TopoNode | null = null;
  let bestDist = Infinity;
  for (const n of drawnNodes) {
    const d = Math.hypot((n.x ?? 0) - pt.x, (n.y ?? 0) - pt.y);
    if (d <= hitRadius(n, k) && d < bestDist) {
      best = n;
      bestDist = d;
    }
  }
  return best;
}

function onHostPointerDown(ev: PointerEvent) {
  pointerDownAt = ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null;
}

function onHostPointerMove(ev: PointerEvent) {
  // 按住拖超过 6px = 平移画布 ⇒ 相机从此归用户（数据刷新不再自动归位）。
  if (pointerDownAt && Math.hypot(ev.clientX - pointerDownAt.x, ev.clientY - pointerDownAt.y) > 6) {
    userAdjustedCamera = true;
  }
  if (host.value) host.value.style.cursor = nodeAt(ev) ? "pointer" : "";
}

function onHostWheel() {
  userAdjustedCamera = true;
}

function onHostTouchStart(ev: TouchEvent) {
  if (ev.touches.length > 1) userAdjustedCamera = true;
}

function onHostPointerUp(ev: PointerEvent) {
  const down = pointerDownAt;
  pointerDownAt = null;
  if (!down || ev.button !== 0) return;
  if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 6) return;
  selectedId.value = nodeAt(ev)?.id ?? null;
}

async function refreshLinks() {
  if (linksLoading.value) return;
  linksLoading.value = true;
  try {
    const ids = chat.friends
      .filter((f) => onlinePeerIds.value.has(f.device_id))
      .map((f) => f.device_id);
    const pairs = await Promise.all(
      ids.map(async (id) => {
        try {
          const ls = await api.getConvLink(id);
          return [id, ls] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );
    convLinks.value = Object.fromEntries(pairs.filter(([, v]) => v)) as Record<string, LinkState>;
  } finally {
    linksLoading.value = false;
  }
}

/** 名单读取失败要**说出来**（INV-P36 同族）：把 IO 失败画成"没有发现其他节点"
 *  是假陈述 —— 用户会以为真的没人在线。只在列表为空时升横幅；有旧数据时数据说话。 */
const loadError = ref<string | null>(null);

async function refreshAll() {
  loadError.value = null;
  const [peers, friends] = await Promise.allSettled([chat.refreshPeers(), chat.refreshFriends()]);
  if (peers.status === "rejected") {
    loadError.value = detailText(peers.reason, { log: true });
  } else if (friends.status === "rejected") {
    loadError.value = detailText(friends.reason, { log: true });
  }
  await refreshLinks();
  // 数据时间：**只有成功**才更新（失败时旧视图要标「可能已过期」，不能装作是新的）。
  if (!loadError.value) updatedAt.value = Date.now();
}

function addFriend(peerId: string) {
  if ((cooldown.value[peerId] ?? 0) > Date.now()) return;
  cooldown.value = { ...cooldown.value, [peerId]: Date.now() + 3000 };
  window.clearTimeout(cooldownTimer);
  cooldownTimer = window.setTimeout(() => {
    const next = { ...cooldown.value };
    for (const k of Object.keys(next)) if (next[k] <= Date.now()) delete next[k];
    cooldown.value = next;
  }, 3200);
  // 对方已经先发来申请时，这颗键的文案是「同意申请」—— 动作也必须真的同意，
  // 不能再发一条申请（否则两边互相申请，谁也不成好友）。
  const accepting = reqPending(peerId);
  const action = accepting ? chat.respondRequest(peerId, true) : chat.sendFriendRequest(peerId);
  action
    .then(() => app.toast(t(accepting ? "friend.add.toast.accepted" : "friend.add.toast.sent"), "success"))
    .catch((e) => app.toastError(e, t("msg.sendFailed")));
}

/**
 * 邻域布局：**本机是观察端点**（宽屏在左、窄屏在底），设备节点向另一侧展开成扇形。
 *
 * 坐标由纯函数 `layoutNeighborhood` 算（`src/utils/topologySemantics.ts`）——
 * 那里有判据钉着三件事：本机在锚点上、扇形朝另一侧、新节点加入时老节点不动。
 * 这里只负责把算出来的坐标钉到节点对象上（fx/fy 钉死 ⇒ 没有力模拟动画）。
 */
function applyLayout(nodes: TopoNode[], w: number, h: number) {
  const l = layoutNeighborhood(
    nodes.map((n) => ({ id: n.id, ts: n.ts ?? 0, self: n.kind === "self" })),
    w,
    h,
  );
  for (const n of nodes) {
    const p = l.points.get(n.id);
    if (!p) continue;
    n.fx = p.x;
    n.fy = p.y;
    n.x = p.x;
    n.y = p.y;
  }
}

/** 节点对象按 id **持久化**：graphData 重算时复用同一对象（只改字段），d3 就不会
 *  重新初始化坐标 —— 这是"增量更新、老节点不大动"的根基。 */
const nodeStore = new Map<string, TopoNode>();

/** 图上实际放得下的设备数（超出的只在列表里 —— 方案 §超多节点：有界渲染）。 */
const shownPeerCount = ref(0);

function buildGraphData(): { nodes: TopoNode[]; links: TopoLink[] } {
  const spec = topoSpec.value;
  const w = host.value?.clientWidth ?? 800;
  const h = host.value?.clientHeight ?? 600;
  // 先按**全部**节点算一次布局，只为拿 maxNodes（图上放不下多少个）——
  // 放不下的设备留在列表里，不进画布（否则会被画到屏幕外、点不到）。
  const probe = layoutNeighborhood(
    spec.nodes.map((n) => ({ id: n.id, ts: n.ts ?? 0, self: n.kind === "self" })),
    w,
    h,
  );
  const peerIds = spec.nodes.filter((n) => n.kind !== "self").map((n) => n.id);
  const keep = new Set([SELF_ID, ...peerIds.slice(0, probe.maxNodes)]);
  shownPeerCount.value = Math.min(peerIds.length, probe.maxNodes);
  const nodes = spec.nodes.filter((sp) => keep.has(sp.id)).map((sp) => {
    let n = nodeStore.get(sp.id);
    if (!n) {
      n = sp;
      nodeStore.set(sp.id, n);
    } else {
      Object.assign(n, sp);
    }
    return n;
  });
  for (const id of [...nodeStore.keys()]) {
    if (!keep.has(id)) nodeStore.delete(id);
  }
  const links = spec.links.filter((l) => keep.has(l.source) && keep.has(l.target)).map((l) => ({ ...l }));
  applyLayout(nodes, w, h);
  return { nodes, links };
}

function topoSig(): string {
  const d = topoSpec.value;
  return d.nodes.map((n) => `${n.id}:${n.kind}:${n.label}`).join(",")
    + "|"
    + d.links.map((l) => `${l.source}>${l.target}:${l.kind}:${l.hop ?? ""}`).join(",");
}

/** 用户一旦自己缩放/平移过，相机就**永远归用户** —— 数据刷新不再自动归位
 *  （2026-11-11 用户："正在放大缩小的时候一刷新又回到原点"）。 */
let userAdjustedCamera = false;

function buildGraph() {
  if (!host.value || graph) return;
  const data = buildGraphData();
  drawnNodes = data.nodes;
  graph = new ForceGraph<TopoNode, TopoLink>(host.value)
    .backgroundColor("rgba(0,0,0,0)")
    .nodeId("id")
    .nodeCanvasObject(drawNode)
    .linkColor((l) => linkStyle[l.kind]?.color ?? linkStyle.unknown.color)
    .linkWidth((l) => linkStyle[l.kind]?.width ?? 1)
    .linkLineDash((l) => linkStyle[l.kind]?.dash ?? null)
    .linkDirectionalParticles((l) => (l.kind === "lan" || l.kind === "bluetooth" ? 2 : 0))
    .linkDirectionalParticleWidth(1.4)
    .linkDirectionalParticleSpeed(0.004)
    // 节点全部钉死（fx/fy）⇒ 引擎无事可做：不预热、不冷却，更新落点即终态。
    .cooldownTicks(0)
    .warmupTicks(0)
    .graphData(data);
  guardCamera();
  lastSig = topoSig();
}

/** 抵消库的"按节点数自动 re-zoom"（k=4/∛n，onFinishUpdate 里触发）：
 *  用户没动过相机时把 k 钉回 1 —— 布局本来就是按屏幕像素给的。
 *  用户动过就不碰（数据更新也不夺走用户的缩放/平移）。 */
function guardCamera() {
  if (!graph || userAdjustedCamera) return;
  graph.zoom(1, 0);
}

function syncGraph(force = false) {
  if (!graph) return;
  // 15s 轮询会把 convLinks 整个换新；内容没变还重灌 graphData 会让引擎空转。
  // 按拓扑签名去重，只在真变了才重灌（对象持久化 ⇒ 老节点坐标不动，新节点就地出现）。
  // force=true 用于 resize：尺寸变了布局半径就得重算，签名没变也要重排。
  const sig = topoSig();
  if (!force && sig === lastSig) return;
  lastSig = sig;
  const data = buildGraphData();
  drawnNodes = data.nodes;
  graph.graphData(data);
  guardCamera();
}

watch(
  () => [chat.peers.map((p) => `${p.device_id}:${p.link ?? ""}`).join("|"), chat.friends.length],
  () => {
    syncGraph();
    void refreshLinks();
  },
);
watch(convLinks, () => syncGraph());
// 切回「图」时画布尺寸才恢复（列表视图下它是隐藏的）⇒ 必须重排一次，
// 否则节点坐标还是列表期间那个尺寸算出来的。
watch(view, async (v) => {
  if (v !== "graph") return;
  await nextTick();
  sizeGraphToHost();
  syncGraph(true);
});

function sizeGraphToHost() {
  const el = host.value;
  if (!el || !graph) return;
  const w = el.clientWidth;
  const h = el.clientHeight;
  // 构造时容器可能还没拿到 flex 后的高度，force-graph 会退回 window 尺寸
  // —— 那样画布比图区高出一个页头，底部节点被视口裁掉。这里按真实图区再钉一次。
  if (w > 0 && h > 0) graph.width(w).height(h);
  // 布局是按**当前图区尺寸**现算的像素坐标，缩放恒为 1；尺寸变化由下一次
  // buildGraphData（任一数据签名变化）或 resize 事件里的重排消化，不再 zoomToFit。
}

onMounted(() => {
  buildGraph();
  sizeGraphToHost();
  boundHost = host.value;
  boundHost?.addEventListener("pointerdown", onHostPointerDown);
  boundHost?.addEventListener("pointermove", onHostPointerMove);
  boundHost?.addEventListener("pointerup", onHostPointerUp);
  boundHost?.addEventListener("wheel", onHostWheel, { passive: true });
  boundHost?.addEventListener("touchstart", onHostTouchStart, { passive: true });
  if (typeof ResizeObserver !== "undefined" && host.value) {
    resizeObs = new ResizeObserver(() => {
      sizeGraphToHost();
      syncGraph(true);
    });
    resizeObs.observe(host.value);
  }
  void refreshAll();
  refreshTimer = window.setInterval(() => void refreshAll(), 15_000);
});
onBeforeUnmount(() => {
  boundHost?.removeEventListener("pointerdown", onHostPointerDown);
  boundHost?.removeEventListener("pointermove", onHostPointerMove);
  boundHost?.removeEventListener("pointerup", onHostPointerUp);
  boundHost?.removeEventListener("wheel", onHostWheel);
  boundHost?.removeEventListener("touchstart", onHostTouchStart);
  boundHost = null;
  resizeObs?.disconnect();
  resizeObs = null;
  window.clearInterval(refreshTimer);
  window.clearTimeout(cooldownTimer);
  graph?._destructor?.();
  graph = null;
});

const cooling = (id: string) => (cooldown.value[id] ?? 0) > Date.now();
const reqPending = (id: string) => pendingFrom.value.has(id);
const reqSent = (id: string) => outgoingByPeer.value.has(id);

const selectedRole = computed(() => {
  const n = selectedNode.value;
  if (!n) return "";
  if (n.kind === "self") return t("topology.role.self");
  return n.kind === "friend" ? t("topology.role.friend") : t("topology.role.peer");
});
</script>

<template>
  <div class="fixed inset-x-0 bottom-0 top-[var(--gosslan-window-safe-top)] z-[70] flex flex-col bg-[var(--gosslan-chat)]">
    <!-- 顶栏：返回 / 标题 / 刷新。让顶只让**刘海那一段**（--gosslan-inset-top）：
         桌面的自绘 caption 已经由外壳的 top-[window-safe-top] 让过了，这里再读
         --gosslan-safe-top（= max(caption, 刘海)）会把 caption 高度算第二遍，
         桌面上返回键上方多出一条死间距（2026-11-11 用户实报）。 -->
    <header
      class="flex shrink-0 items-center gap-3 border-b border-[var(--gosslan-divider)] px-3"
      :style="{ paddingTop: 'var(--gosslan-inset-top)', minHeight: 'calc(var(--gosslan-header-h) + var(--gosslan-inset-top))' }"
    >
      <button
        class="tap-safe -ml-1 flex h-9 w-9 items-center justify-center rounded-[var(--gosslan-radius-md)] transition hover:bg-[var(--gosslan-hover)]"
        :aria-label="t('topology.back')"
        @click="emit('close')"
      >
        <Icon name="arrow-left" class="h-5 w-5" />
      </button>
      <div class="min-w-0 flex-1">
        <div class="truncate text-title font-medium" :title="t('topology.title')">{{ t("topology.title") }}</div>
        <div class="truncate text-caption text-[var(--gosslan-text-2)]" data-topo-subtitle :title="t('topology.subtitle')">{{ t("topology.subtitle") }}</div>
        <div
          class="truncate text-caption text-[var(--gosslan-text-2)]"
          data-topo-stats
          :class="stale ? 'text-[var(--gosslan-warning-ink)]' : ''"
          :title="`${t('topology.online', { n: stats.online })} · ${t('topology.friends', { n: stats.friends })}`"
        >
          {{ t("topology.online", { n: stats.online }) }} ·
          {{ t("topology.friends", { n: stats.friends }) }} ·
          <span>{{ stale ? t("topology.stale") : updatedAtText() }}</span>
        </div>
      </div>
      <!-- 图 / 列表：等价入口（方案 §交互：小屏、键盘与读屏用户走列表）。 -->
      <div
        class="flex shrink-0 items-center gap-0.5 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] p-0.5"
        role="tablist"
        :aria-label="t('topology.view.label')"
      >
        <button
          v-for="v in VIEWS"
          :key="v"
          type="button"
          role="tab"
          class="tap-safe rounded-[var(--gosslan-radius-sm)] px-2 py-1 text-caption transition"
          :class="view === v
            ? 'bg-[var(--gosslan-primary-soft)] text-[var(--gosslan-primary)]'
            : 'text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]'"
          :aria-selected="view === v"
          @click="view = v"
        >
          {{ t(v === "graph" ? "topology.view.graph" : "topology.view.list") }}
        </button>
      </div>
      <button
        class="tap-safe flex h-9 w-9 items-center justify-center rounded-[var(--gosslan-radius-md)] transition hover:bg-[var(--gosslan-hover)]"
        :aria-label="t('topology.refresh')"
        @click="refreshAll"
      >
        <Spinner v-if="linksLoading" size-class="h-4 w-4" decorative />
        <Icon v-else name="refresh-cw" class="h-4 w-4" />
      </button>
    </header>

    <div class="relative min-h-0 flex-1">
      <!-- 图区（切到列表时用 v-show 保留画布，尺寸变化由 watcher 重排）。 -->
      <div v-show="view === 'graph'" ref="host" class="absolute inset-0"></div>

      <!-- 列表视图：与图**同源**（同一份语义数据），加筛选与可执行动作。 -->
      <div v-if="view === 'list'" class="absolute inset-0 overflow-y-auto p-3" data-topo-list>
        <div class="mb-2 flex flex-wrap items-center gap-1.5">
          <button
            v-for="f in (['all', 'friends', 'offline'] as const)"
            :key="f"
            type="button"
            class="tap-safe rounded-[var(--gosslan-radius-md)] border px-2 py-1 text-caption transition"
            :class="listFilter === f
              ? 'border-[var(--gosslan-primary)] text-[var(--gosslan-primary)]'
              : 'border-[var(--gosslan-border)] text-[var(--gosslan-text-2)]'"
            :aria-pressed="listFilter === f"
            @click="listFilter = f"
          >
            {{ t(f === "all" ? "topology.filter.all" : f === "friends" ? "topology.filter.friends" : "topology.filter.offline") }}
          </button>
        </div>
        <ul class="flex flex-col gap-1">
          <li
            v-for="item in listItems"
            :key="item.id"
            class="flex items-center gap-3 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[var(--gosslan-panel)] px-3 py-2"
          >
            <AvatarBox class="h-9 w-9 shrink-0" :id="item.id" :src="item.avatar" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-body" :title="item.label">{{ item.label }}</div>
              <div
                class="truncate text-caption text-[var(--gosslan-text-2)]"
                :title="`${item.isFriend ? t('topology.role.friend') : t('topology.role.peer')} · ${item.offline ? t('topology.offlineState') : linkText(item.pathKind, item.hop)}`"
              >
                {{ item.isFriend ? t("topology.role.friend") : t("topology.role.peer") }} ·
                <span :class="item.offline ? 'opacity-70' : ''">
                  {{ item.offline ? t("topology.offlineState") : linkText(item.pathKind, item.hop) }}
                </span>
              </div>
            </div>
            <PrimaryBtn v-if="item.isFriend && !item.offline" size="dense" @click="emit('open-chat', item.id)">
              {{ t("topology.action.chat") }}
            </PrimaryBtn>
            <SecondaryBtn
              v-else-if="!item.isFriend && !item.offline"
              size="dense"
              :disabled="reqSent(item.id) || cooling(item.id)"
              @click="addFriend(item.id)"
            >
              {{ reqPending(item.id)
                ? t("topology.action.accept")
                : reqSent(item.id)
                  ? t("topology.action.requested")
                  : t("topology.action.add") }}
            </SecondaryBtn>
          </li>
        </ul>
        <p v-if="listItems.length === 0" class="mt-6 text-center text-caption text-[var(--gosslan-text-2)]">
          {{ t("topology.list.empty") }}
        </p>
      </div>

      <!-- 路径摘要（**图外**）：公网中转 / Mesh 是**路径类型**，不是设备清单；
           展开后说明「中间节点当前不可见」与「这不是本机控制中心」。 -->
      <div
        v-if="view === 'graph'"
        class="absolute left-3 top-3 max-w-[260px] rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[color-mix(in_srgb,var(--gosslan-panel)_88%,transparent)] px-2.5 py-2 text-caption text-[var(--gosslan-text-2)] backdrop-blur-sm"
        data-topo-summary
      >
        <button type="button" class="flex w-full items-center gap-1.5 text-left" :aria-expanded="summaryOpen" @click="summaryOpen = !summaryOpen">
          <Icon :name="summaryOpen ? 'chevron-down' : 'chevron-right'" class="h-3 w-3 shrink-0" />
          <span>{{ t("topology.summary.title") }}</span>
        </button>
        <div class="mt-1 flex flex-col gap-0.5">
          <span v-if="stats.relay">{{ t("topology.summary.relay", { n: stats.relay }) }}</span>
          <span v-if="stats.mesh">{{ t("topology.summary.mesh", { n: stats.mesh }) }}</span>
          <span v-if="!stats.relay && !stats.mesh">{{ t("topology.summary.none") }}</span>
        </div>
        <p v-if="summaryOpen" class="mt-1.5 leading-relaxed">
          {{ t("topology.summary.explain") }}
        </p>
        <!-- 图上放不下的设备（超多节点）：说清楚它们在哪，不假装不存在。 -->
        <p v-if="stats.online > shownPeerCount" class="mt-1 leading-relaxed" data-topo-overflow>
          {{ t("topology.summary.moreInList", { n: stats.online - shownPeerCount }) }}
          <button type="button" class="ml-1 underline" @click="view = 'list'">{{ t("topology.view.list") }}</button>
        </p>
      </div>

      <!-- 图例：节点种类 + 路径类型（**没有「中转节点」这一项** —— 中转不是设备）。
           线型与文案都在，颜色只是辅助（不靠颜色当唯一信号）。 -->
      <div
        v-if="view === 'graph'"
        data-topo-legend
        class="pointer-events-none absolute bottom-3 left-3 grid grid-cols-2 gap-x-3 gap-y-1 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[color-mix(in_srgb,var(--gosslan-panel)_88%,transparent)] px-2.5 py-2 text-caption text-[var(--gosslan-text-2)] backdrop-blur-sm"
      >
        <span class="flex items-center gap-1.5"><i class="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-[var(--gosslan-primary)]"></i>{{ t("topology.legend.self") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-2.5 w-2.5 rounded-full bg-[var(--gosslan-primary)]"></i>{{ t("topology.legend.friend") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-2.5 w-2.5 rounded-full bg-[var(--gosslan-text-2)]"></i>{{ t("topology.legend.peer") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-0.5 w-4 bg-[var(--gosslan-primary)]"></i>{{ t("topology.link.lan") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-0.5 w-4 border-t border-dashed border-[var(--gosslan-text-2)]"></i>{{ t("topology.link.routed") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-0.5 w-4 border-t border-dotted border-[var(--gosslan-warning)]"></i>{{ t("topology.link.bluetooth") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-0.5 w-4 border-t border-dashed border-[var(--gosslan-warning)]"></i>{{ t("topology.link.relay") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-0.5 w-4 border-t border-dashed border-[var(--gosslan-text-2)]"></i>{{ t("topology.link.hop", { n: 2 }) }}</span>
      </div>

      <!-- 空态/失败态：失败优先 —— 名单读不到时说"读不到 + 重试"（INV-P36 同族），
           把 IO 失败画成"没有发现其他节点"是假陈述；真·空场才给空态提示。
           两者都放在**自己节点下方**（center + 64px），别盖住居中的 self 节点
           （2026-11-11 用户：只有一个节点时文字压住了自己）。外层不吃指针，
           StateBlock / 刷新按钮自己恢复可点。 -->
      <div
        v-if="chat.peers.length === 0 && loadError"
        class="pointer-events-none absolute inset-x-0 top-[calc(50%+64px)] flex justify-center px-6"
      >
        <StateBlock
          kind="error"
          compact
          class="pointer-events-auto max-w-[340px]"
          :title="loadError"
          :detail="t('topology.loadFailedHint')"
          :retry-label="t('common.retry')"
          @retry="refreshAll"
        />
      </div>
      <div
        v-else-if="chat.peers.length === 0"
        class="pointer-events-none absolute inset-x-0 top-[calc(50%+64px)] flex justify-center"
      >
        <div class="max-w-[280px] text-center text-caption leading-relaxed text-[var(--gosslan-text-2)]">
          {{ t("topology.empty") }}
          <button class="pointer-events-auto mt-2 block w-full text-[var(--gosslan-primary)]" @click="refreshAll">{{ t("topology.refresh") }}</button>
        </div>
      </div>

      <div v-if="offlineFriendCount > 0" class="pointer-events-none absolute bottom-3 right-3 text-caption text-[var(--gosslan-text-2)] opacity-70">
        {{ t("topology.offline", { n: offlineFriendCount }) }}
      </div>

      <!-- 节点详情：桌面右栏 / 移动端底部卡 -->
      <transition :name="panelTransition">
        <aside
          v-if="selectedNode"
          class="absolute inset-x-0 bottom-0 z-10 border-t border-[var(--gosslan-divider)] bg-[var(--gosslan-panel)] pb-[var(--gosslan-inset-bottom)] md:inset-y-0 md:left-auto md:right-0 md:w-[300px] md:border-l md:border-t-0"
        >
          <div class="p-4">
            <div class="flex items-start gap-3">
              <AvatarBox class="h-12 w-12" :id="selectedNode.id" :src="selectedNode.avatar" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-body font-medium" :title="selectedNode.label">{{ selectedNode.label }}</div>
                <div class="text-caption text-[var(--gosslan-text-2)]" data-topo-role>{{ selectedRole }}</div>
              </div>
              <button
                class="tap-safe -mr-1 flex h-8 w-8 items-center justify-center rounded-[var(--gosslan-radius-md)] text-[var(--gosslan-text-2)] hover:bg-[var(--gosslan-hover)]"
                :aria-label="t('common.close')"
                @click="selectedId = null"
              >
                <Icon name="x" class="h-4 w-4" />
              </button>
            </div>

            <dl v-if="selectedNode.kind === 'friend' && selectedFriend" class="mt-3 space-y-1.5 text-caption">
              <div class="flex justify-between gap-3"><dt class="text-[var(--gosslan-text-2)]">{{ t("topology.field.link") }}</dt><dd>{{ linkText(selectedNode.pathKind, selectedNode.hop) }}</dd></div>
              <div v-if="selectedPeer?.rtt_ms != null" class="flex justify-between gap-3"><dt class="text-[var(--gosslan-text-2)]">{{ t("topology.field.rtt") }}</dt><dd>{{ selectedPeer.rtt_ms }} ms</dd></div>
              <div class="flex justify-between gap-3"><dt class="text-[var(--gosslan-text-2)]">{{ t("topology.field.device") }}</dt><dd class="truncate" :title="selectedFriend.device_type || selectedNode.deviceType || '—'">{{ selectedFriend.device_type || selectedNode.deviceType || "—" }}</dd></div>
              <div v-if="selectedFriend.peer_app_version" class="flex justify-between gap-3"><dt class="text-[var(--gosslan-text-2)]">{{ t("topology.field.version") }}</dt><dd>{{ selectedFriend.peer_app_version }}</dd></div>
            </dl>

            <!-- 公网中转 / Mesh 多跳：**中间节点身份当前不可见**（后端只给跳数）——
                 说出来，免得「看不见中转」被当成「没有中转」。 -->
            <p
              v-if="selectedNode.kind !== 'self' && needsIntermediateNotice(selectedNode.pathKind ?? 'unknown')"
              class="mt-3 text-caption leading-relaxed text-[var(--gosslan-text-2)]"
              data-topo-intermediate
            >
              {{ selectedNode.pathKind === "relay" ? t("topology.relayHint") : t("topology.meshHint") }}
            </p>
            <div class="mt-3 flex justify-between gap-3 text-caption">
              <dt class="text-[var(--gosslan-text-2)]">{{ t("topology.field.updated") }}</dt>
              <dd :class="stale ? 'text-[var(--gosslan-warning-ink)]' : ''">{{ stale ? t("topology.stale") : updatedAtText() }}</dd>
            </div>

            <div class="mt-4 flex gap-2">
              <PrimaryBtn v-if="selectedNode.kind === 'friend'" class="flex-1" @click="emit('open-chat', selectedNode.id)">
                {{ t("topology.action.chat") }}
              </PrimaryBtn>
              <SecondaryBtn
                v-if="selectedNode.kind === 'peer'"
                class="flex-1"
                :disabled="reqSent(selectedNode.id) || cooling(selectedNode.id)"
                @click="addFriend(selectedNode.id)"
              >
                {{ reqPending(selectedNode.id)
                  ? t("topology.action.accept")
                  : reqSent(selectedNode.id)
                    ? t("topology.action.requested")
                    : t("topology.action.add") }}
              </SecondaryBtn>
            </div>
          </div>
        </aside>
      </transition>
    </div>
  </div>
</template>

<style scoped>
.topo-panel-enter-active,
.topo-panel-leave-active,
.topo-panel-fade-enter-active,
.topo-panel-fade-leave-active {
  transition: transform 180ms var(--gosslan-ease), opacity 180ms var(--gosslan-ease);
}
.topo-panel-enter-from,
.topo-panel-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
.topo-panel-fade-enter-active,
.topo-panel-fade-leave-active {
  transition: opacity 120ms linear;
}
.topo-panel-fade-enter-from,
.topo-panel-fade-leave-to {
  opacity: 0;
}
@media (min-width: 768px) {
  .topo-panel-enter-from,
  .topo-panel-leave-to {
    transform: translateX(12px);
  }
}
</style>
