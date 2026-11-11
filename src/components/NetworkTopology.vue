<script setup lang="ts">
/**
 * 网络拓扑（自中心图）：自己居中，直连节点一圈；公网中转 / Mesh 中转的节点挂在
 * 合成中枢下；好友边标注真实 `hop`。
 *
 * 数据口径（2026-11-10 用户拍板）：后端只提供「每个节点到本机的最佳链路类型」
 * （`Peer.link`）与好友会话的 `path/hop`（`get_conv_link`），**不提供其他节点之间的边**。
 * 因此本视图不画虚构的 P2P 连线：中转一律归到中枢节点，路径未知的 hop 只作标注。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
import type { Friend, LinkState, Peer } from "@/types";

const emit = defineEmits<{
  (e: "close"): void;
  (e: "open-chat", peerId: string): void;
}>();

const app = useAppStore();
const chat = useChatStore();

const SELF_ID = "__self__";
const HUB_RELAY = "__hub_relay__";
const HUB_MESH = "__hub_mesh__";

/** reduce 档只淡入淡出：滑动位移交还给系统偏好（判据见 design-guidelines §11.3.7）。
 *  用媒体查询的**响应式**读数 —— 会话中途开/关"减弱动态"也要跟着换档。 */
const prefersReducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
const panelTransition = computed(() => (prefersReducedMotion.value ? "topo-panel-fade" : "topo-panel"));

interface TopoNode {
  id: string;
  kind: "self" | "friend" | "peer" | "hub";
  /** first_seen（缺省 0）：放射布局的**插入序** —— 新节点追加在队尾，老节点不动。 */
  ts?: number;
  label: string;
  avatar?: string | null;
  deviceType?: string;
  link?: string | null;
  hop?: number;
  rtt?: number | null;
  hub?: "relay" | "mesh";
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
  kind: "lan" | "routed" | "bluetooth" | "relay" | "mesh" | "unknown";
  hop?: number;
}

const convLinks = ref<Record<string, LinkState>>({});
const linksLoading = ref(false);
const selectedId = ref<string | null>(null);
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

function linkText(link?: string | null, hop?: number): string {
  if (link === "lan") return t("topology.link.lan");
  if (link === "routed") return t("topology.link.routed");
  if (link === "bluetooth") return t("topology.link.bluetooth");
  if (link === "relay") return t("topology.link.relay");
  if (hop && hop > 0) return t("topology.link.hop", { n: hop });
  return t("topology.link.unknown");
}

/** 纯数据拼装：以 self 为中心；relay 与 hop>0 各挂一个合成中枢。
 *  只产出**规格**（不含坐标）—— 坐标由 buildGraphData 的确定性放射布局给。 */
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
  let relayCount = 0;
  let meshCount = 0;
  for (const peer of chat.peers) {
    const friend = friendById.value.get(peer.device_id);
    const conv = convLinks.value[peer.device_id];
    const hop = conv?.hop ?? 0;
    const link: TopoLink["kind"] =
      peer.link === "lan" || peer.link === "routed" || peer.link === "bluetooth"
        ? peer.link
        : peer.link === "relay"
          ? "relay"
          : hop > 0
            ? "mesh"
            : "unknown";
    const node: TopoNode = {
      id: peer.device_id,
      kind: friend ? "friend" : "peer",
      label: peer.nickname || friend?.nickname || peer.device_id.slice(0, 12),
      avatar: peer.avatar ?? friend?.avatar ?? null,
      deviceType: peer.device_type || friend?.device_type,
      link: peer.link ?? null,
      hop,
      rtt: peer.rtt_ms,
      ts: peer.first_seen ?? peer.last_seen ?? 0,
    };
    nodes.push(node);
    if (link === "relay" || link === "mesh") {
      const hubId = link === "relay" ? HUB_RELAY : HUB_MESH;
      if (!nodes.some((n) => n.id === hubId)) {
        nodes.push({
          id: hubId,
          kind: "hub",
          label: link === "relay" ? t("topology.hub.relay") : t("topology.hub.mesh"),
          hub: link,
        });
        links.push({ source: SELF_ID, target: hubId, kind: link });
      }
      links.push({ source: hubId, target: peer.device_id, kind: link, hop });
      if (link === "relay") relayCount += 1;
      else meshCount += 1;
    } else {
      links.push({ source: SELF_ID, target: peer.device_id, kind: link });
    }
  }
  return { nodes, links };
});
const stats = computed(() => ({
  online: chat.peers.length,
  friends: onlineFriends.value.length,
  relay: topoSpec.value.links.filter((l) => l.kind === "relay" && l.target !== HUB_RELAY).length,
  mesh: topoSpec.value.links.filter((l) => l.kind === "mesh" && l.target !== HUB_MESH).length,
}));

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
  const r = (node.kind === "self" ? 18 : node.kind === "hub" ? 12 : 11) / s;
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  ctx.save();
  if (node.kind === "hub") {
    ctx.fillStyle = "rgba(245,158,11,.16)";
    ctx.strokeStyle = linkStyle[node.hub === "mesh" ? "mesh" : "relay"].color;
    ctx.lineWidth = 1.4 / s;
    ctx.beginPath();
    ctx.arc(x, y, r + 3 / s, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = p.warn;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${10 / s}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(node.hub === "relay" ? "⇄" : "⌁", x, y + 0.5 / s);
  } else {
    if (node.kind === "self") {
      const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 2.2);
      glow.addColorStop(0, "rgba(59,130,246,.35)");
      glow.addColorStop(1, "rgba(59,130,246,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
      ctx.fill();
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
  if (node.kind !== "hub" && node.kind !== "self") {
    ctx.font = `${9 / scale}px sans-serif`;
    ctx.fillStyle = linkStyle[
      (node.link === "lan" || node.link === "routed" || node.link === "bluetooth" || node.link === "relay")
        ? node.link
        : node.hop && node.hop > 0
          ? "mesh"
          : "unknown"
    ].color;
    ctx.fillText(linkText(node.link, node.hop), x, labelY + 12 / scale);
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
  return (node.kind === "self" ? 22 : node.kind === "hub" ? 16 : 15) / (k || 1);
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
 * 确定性**放射布局**（2026-11-11 用户：去中心化网络用力导向画不直观、刷新还大幅重排）。
 * 本图天然是"星的星"（深度 ≤2）：self 居中，直连节点与两个中枢均匀占第一圈，
 * 中枢的孩子在第二圈、以中枢角为中心的扇区内 —— 每条边都是短的放射线。
 * 所有节点 fx/fy 钉死 ⇒ 没有力导向动画；新增节点只在自己的槽位出现，
 * 老节点最多因同组均分角度挪一小步；相机完全归用户，永不自动重置。
 */
function layoutRadial(nodes: TopoNode[], links: TopoLink[], w: number, h: number) {
  const minDim = Math.max(Math.min(w, h), 260);
  let r2 = minDim / 2 - 48;
  let r1 = Math.max(96, Math.min(170, minDim / 3.1));
  r1 = Math.min(r1, r2 - 56);
  r2 = Math.max(r2, r1 + 56);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const self = byId.get(SELF_ID);
  if (self) { self.fx = 0; self.fy = 0; self.x = 0; self.y = 0; }

  // 中枢固定角（公网中转在上、Mesh 在下）；既有孩子的偏移角**不随新增变化** ——
  // 插入稳定是新节点"就地出现、老节点不动"的前提。
  const hubBase: Record<string, number> = { relay: -Math.PI / 2, mesh: Math.PI / 2 };
  const hubs = nodes
    .filter((n) => n.kind === "hub")
    .sort((a, b) => (a.hub === "relay" ? 0 : 1) - (b.hub === "relay" ? 0 : 1));
  const childrenByHub = new Map<string, TopoNode[]>();
  for (const l of links) {
    if (l.kind !== "relay" && l.kind !== "mesh") continue;
    const child = byId.get(l.target);
    if (child) {
      const arr = childrenByHub.get(l.source) ?? [];
      arr.push(child);
      childrenByHub.set(l.source, arr);
    }
  }
  for (const arr of childrenByHub.values()) {
    arr.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.id.localeCompare(b.id));
  }

  const exclusions: { a: number; half: number }[] = [];
  for (const hub of hubs) {
    const a0 = hubBase[hub.hub ?? "relay"] ?? 0;
    hub.fx = Math.cos(a0) * r1;
    hub.fy = Math.sin(a0) * r1;
    hub.x = hub.fx;
    hub.y = hub.fy;
    const kids = childrenByHub.get(hub.id) ?? [];
    const half = Math.min(1.25, 0.3 + kids.length * 0.17);
    exclusions.push({ a: a0, half: half + 0.14 });
    kids.forEach((c, j) => {
      // 0 → 正下；之后左右交替外扩（0, +0.34, −0.34, +0.68, …）：插入只追加新偏移
      const order = j === 0 ? 0 : Math.ceil(j / 2) * (j % 2 === 1 ? 1 : -1);
      const ca = a0 + order * 0.34;
      c.fx = Math.cos(ca) * r2;
      c.fy = Math.sin(ca) * r2;
      c.x = c.fx;
      c.y = c.fy;
    });
  }

  // 直连叶子：固定步距顺时针走，**跳过中枢扇区**。角度只前进不重排 ⇒
  // 新增叶子追加在队尾，既有叶子一像素都不动。
  // ⚠️ 中枢的孩子**不算叶子** —— 否则它们先被摆上 ring1、又被中枢循环摆到 ring2，
  // 谁后写谁生效，结构就乱了。
  const childIds = new Set([...childrenByHub.values()].flat().map((c) => c.id));
  const leaves = nodes
    .filter((n) => (n.kind === "friend" || n.kind === "peer") && !childIds.has(n.id))
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || a.id.localeCompare(b.id));
  const step = (Math.PI * 2) / 12;
  const angDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
  let a = Math.PI / 2 + 0.6;
  leaves.forEach((leaf, i) => {
    let guard = 0;
    while (guard++ < 64 && exclusions.some((e) => Math.abs(angDiff(a, e.a)) < e.half)) a += step;
    // 奇偶双半径：相邻叶子径向错开一档，标签不再横向叠在一起（桌面/移动都松一格）。
    const rr = i % 2 === 1 ? r1 * 0.82 : r1;
    leaf.fx = Math.cos(a) * rr;
    leaf.fy = Math.sin(a) * rr;
    leaf.x = leaf.fx;
    leaf.y = leaf.fy;
    a += step;
  });
}

/** 节点对象按 id **持久化**：graphData 重算时复用同一对象（只改字段），d3 就不会
 *  重新初始化坐标 —— 这是"增量更新、老节点不大动"的根基。 */
const nodeStore = new Map<string, TopoNode>();

function buildGraphData(): { nodes: TopoNode[]; links: TopoLink[] } {
  const spec = topoSpec.value;
  const w = host.value?.clientWidth ?? 800;
  const h = host.value?.clientHeight ?? 600;
  const nodes = spec.nodes.map((sp) => {
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
    if (!spec.nodes.some((sp) => sp.id === id)) nodeStore.delete(id);
  }
  const links = spec.links.map((l) => ({ ...l }));
  layoutRadial(nodes, links, w, h);
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
  if (n.kind === "hub") return t("topology.role.hub");
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
        <div class="truncate text-caption text-[var(--gosslan-text-2)]" data-topo-stats :title="`${t('topology.online', { n: stats.online })} · ${t('topology.friends', { n: stats.friends })}`">
          {{ t("topology.online", { n: stats.online }) }} ·
          {{ t("topology.friends", { n: stats.friends }) }}
          <span v-if="stats.relay"> · {{ t("topology.relayed", { n: stats.relay }) }}</span>
          <span v-if="stats.mesh"> · {{ t("topology.mesh", { n: stats.mesh }) }}</span>
        </div>
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
      <div ref="host" class="absolute inset-0"></div>

      <!-- 图例 -->
      <div data-topo-legend class="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1 rounded-[var(--gosslan-radius-md)] border border-[var(--gosslan-border)] bg-[color-mix(in_srgb,var(--gosslan-panel)_88%,transparent)] px-2.5 py-2 text-caption text-[var(--gosslan-text-2)] backdrop-blur-sm">
        <span class="flex items-center gap-1.5"><i class="inline-block h-2.5 w-2.5 rounded-full bg-[var(--gosslan-primary)]"></i>{{ t("topology.legend.friend") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-2.5 w-2.5 rounded-full bg-[var(--gosslan-text-2)]"></i>{{ t("topology.legend.peer") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-2.5 w-2.5 rounded-full bg-[var(--gosslan-warning)]"></i>{{ t("topology.legend.hub") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-0.5 w-4 bg-[var(--gosslan-primary)]"></i>{{ t("topology.legend.direct") }}</span>
        <span class="flex items-center gap-1.5"><i class="inline-block h-0.5 w-4 border-t border-dashed border-[var(--gosslan-warning)]"></i>{{ t("topology.legend.relay") }}</span>
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
              <AvatarBox
                v-if="selectedNode.kind !== 'hub'"
                class="h-12 w-12"
                :id="selectedNode.id"
                :src="selectedNode.avatar"
              />
              <div v-else class="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--gosslan-warning-soft)] text-[var(--gosslan-warning-ink)]">
                <Icon name="network" class="h-5 w-5" />
              </div>
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
              <div class="flex justify-between gap-3"><dt class="text-[var(--gosslan-text-2)]">{{ t("topology.field.link") }}</dt><dd>{{ linkText(selectedPeer?.link, selectedNode.hop) }}</dd></div>
              <div v-if="selectedPeer?.rtt_ms != null" class="flex justify-between gap-3"><dt class="text-[var(--gosslan-text-2)]">{{ t("topology.field.rtt") }}</dt><dd>{{ selectedPeer.rtt_ms }} ms</dd></div>
              <div class="flex justify-between gap-3"><dt class="text-[var(--gosslan-text-2)]">{{ t("topology.field.device") }}</dt><dd class="truncate" :title="selectedFriend.device_type || selectedNode.deviceType || '—'">{{ selectedFriend.device_type || selectedNode.deviceType || "—" }}</dd></div>
              <div v-if="selectedFriend.peer_app_version" class="flex justify-between gap-3"><dt class="text-[var(--gosslan-text-2)]">{{ t("topology.field.version") }}</dt><dd>{{ selectedFriend.peer_app_version }}</dd></div>
            </dl>

            <p v-if="selectedNode.kind === 'hub'" class="mt-3 text-caption leading-relaxed text-[var(--gosslan-text-2)]">
              {{ selectedNode.hub === "relay" ? t("topology.hub.relayHint") : t("topology.hub.meshHint") }}
            </p>

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
