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
import ForceGraph from "force-graph";
import Icon from "@/components/ui/Icon.vue";
import AvatarBox from "@/components/ui/AvatarBox.vue";
import PrimaryBtn from "@/components/ui/PrimaryBtn.vue";
import SecondaryBtn from "@/components/ui/SecondaryBtn.vue";
import Spinner from "@/components/ui/Spinner.vue";
import { t } from "@/i18n";
import { prefersReducedMotion } from "@/utils/platform";
import { api } from "@/api";
import { useAppStore } from "@/stores/useAppStore";
import { useChatStore } from "@/stores/useChatStore";
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

/** reduce 档只淡入淡出：滑动位移交还给系统偏好（判据见 design-guidelines §11.3.7）。 */
const panelTransition = prefersReducedMotion() ? "topo-panel-fade" : "topo-panel";

interface TopoNode {
  id: string;
  kind: "self" | "friend" | "peer" | "hub";
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

/** 纯数据拼装：以 self 为中心；relay 与 hop>0 各挂一个合成中枢。 */
const graphData = computed<{ nodes: TopoNode[]; links: TopoLink[] }>(() => {
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
  relay: graphData.value.links.filter((l) => l.kind === "relay" && l.target !== HUB_RELAY).length,
  mesh: graphData.value.links.filter((l) => l.kind === "mesh" && l.target !== HUB_MESH).length,
}));

const selectedNode = computed(() => {
  if (!selectedId.value) return null;
  return graphData.value.nodes.find((n) => n.id === selectedId.value) ?? null;
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

function palette() {
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
  for (const n of graphData.value.nodes) {
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
  if (host.value) host.value.style.cursor = nodeAt(ev) ? "pointer" : "";
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

function refreshAll() {
  void chat.refreshPeers();
  void chat.refreshFriends();
  void refreshLinks();
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

function buildGraph() {
  if (!host.value || graph) return;
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
    .cooldownTicks(90)
    .d3AlphaDecay(0.035)
    .d3VelocityDecay(0.35)
    // 库的自动 re-zoom 只看节点数（k=4/∛n），不看实际包围盒 —— 节点会被推出视口
    // （实测 7 节点时"陌生节点"飞出画布顶）。引擎每次停下都按包围盒装进图区（留 60px 边距）。
    .onEngineStop(() => graph?.zoomToFit(400, 60))
    .graphData(graphData.value);
  // 默认斥力太挤：节点名 + 链路徽标是两行小字，彼此压住就看不清"谁是谁"。
  graph.d3Force("charge")?.strength(-110);
  graph.d3Force("link")?.distance(90);
  lastSig = topoSig();
}

function topoSig(): string {
  const d = graphData.value;
  return d.nodes.map((n) => `${n.id}:${n.kind}:${n.label}`).join(",")
    + "|"
    + d.links.map((l) => `${l.source}>${l.target}:${l.kind}:${l.hop ?? ""}`).join(",");
}

function syncGraph() {
  if (!graph) return;
  // 15s 轮询会把 convLinks 整个换新；内容没变还重灌 graphData 会让力导向每 15s
  // 重排一次（节点抖一下、命中区也跟着漂）。按拓扑签名去重，只在真变了才重开模拟。
  const sig = topoSig();
  if (sig === lastSig) return;
  lastSig = sig;
  graph.graphData(graphData.value);
}

watch(
  () => [chat.peers.map((p) => `${p.device_id}:${p.link ?? ""}`).join("|"), chat.friends.length],
  () => {
    syncGraph();
    void refreshLinks();
  },
);
watch(convLinks, syncGraph);

function sizeGraphToHost() {
  const el = host.value;
  if (!el || !graph) return;
  const w = el.clientWidth;
  const h = el.clientHeight;
  // 构造时容器可能还没拿到 flex 后的高度，force-graph 会退回 window 尺寸
  // —— 那样画布比图区高出一个页头，底部节点被视口裁掉。这里按真实图区再钉一次。
  if (w > 0 && h > 0) {
    graph.width(w).height(h);
    graph.zoomToFit(0, 60);
  }
}

onMounted(() => {
  buildGraph();
  sizeGraphToHost();
  boundHost = host.value;
  boundHost?.addEventListener("pointerdown", onHostPointerDown);
  boundHost?.addEventListener("pointermove", onHostPointerMove);
  boundHost?.addEventListener("pointerup", onHostPointerUp);
  if (typeof ResizeObserver !== "undefined" && host.value) {
    resizeObs = new ResizeObserver(sizeGraphToHost);
    resizeObs.observe(host.value);
  }
  void refreshLinks();
  refreshTimer = window.setInterval(() => void refreshLinks(), 15_000);
});
onBeforeUnmount(() => {
  boundHost?.removeEventListener("pointerdown", onHostPointerDown);
  boundHost?.removeEventListener("pointermove", onHostPointerMove);
  boundHost?.removeEventListener("pointerup", onHostPointerUp);
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

      <!-- 空态提示：放在**自己节点下方**（center + 64px），别盖住居中的 self 节点
           （2026-11-11 用户：只有一个节点时文字压住了自己）。外层不吃指针，
           刷新按钮自己恢复可点。 -->
      <div
        v-if="chat.peers.length === 0"
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
