/**
 * 「我的网络」语义层的判据。
 *
 * 方案（`docs/notes/network-topology-visualization-plan-2026-11-16.md`）里最容易回退的
 * 三件事，这里各钉一条：
 * ① 路径种类不能混淆（Relay / Routed / Mesh Hop 是三种东西）；
 * ② **未知状态显式保留**（没有链路 ≠ 离线 ≠ 零跳）；
 * ③ **不推断关系**（离线好友不进图；图里只有本机观测到的路径）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTopologyList,
  buildTopologyPeers,
  filterTopologyList,
  isDirectPath,
  layoutNeighborhood,
  needsIntermediateNotice,
  pathKindOf,
  pathLabelKey,
  type TopologyInput,
} from "./topologySemantics.ts";

function input(over: Partial<TopologyInput> = {}): TopologyInput {
  return {
    peers: [],
    friends: [],
    convLinks: {},
    ...over,
  };
}

test("路径种类：LAN / 路由 IP / 蓝牙 / 公网中转 / Mesh 多跳 各归各的", () => {
  assert.equal(pathKindOf("lan", 0), "lan");
  assert.equal(pathKindOf("routed", 0), "routed");
  assert.equal(pathKindOf("bluetooth", 0), "bluetooth");
  assert.equal(pathKindOf("relay", 0), "relay");
  // hop > 0 且没有具体链路 ⇒ Mesh 多跳（经别的节点转发）
  assert.equal(pathKindOf(null, 3), "mesh");
  assert.equal(pathKindOf(undefined, 2), "mesh");
  // 认识 link 时以 link 为准（hop 是会话维度的旧值，不覆盖当前选路）
  assert.equal(pathKindOf("lan", 3), "lan");
  // 都不认识 ⇒ 显式的「不知道」
  assert.equal(pathKindOf(null, 0), "unknown");
  assert.equal(pathKindOf("", null), "unknown");
});

test("直连与「中间节点不可见」只对真正的中继生效", () => {
  assert.equal(isDirectPath("lan"), true);
  assert.equal(isDirectPath("routed"), true);
  assert.equal(isDirectPath("bluetooth"), true);
  assert.equal(isDirectPath("relay"), false);
  assert.equal(isDirectPath("mesh"), false);
  assert.equal(isDirectPath("unknown"), false);
  // ⚠️ routed 是「对端真实 IP 可达」，中间没有转发节点 ⇒ 不能提示「中间节点不可见」
  assert.equal(needsIntermediateNotice("routed"), false);
  assert.equal(needsIntermediateNotice("lan"), false);
  assert.equal(needsIntermediateNotice("relay"), true);
  assert.equal(needsIntermediateNotice("mesh"), true);
});

test("路径标签键：多跳用带跳数的那一条，未知有自己的一条", () => {
  assert.equal(pathLabelKey("lan"), "topology.link.lan");
  assert.equal(pathLabelKey("routed"), "topology.link.routed");
  assert.equal(pathLabelKey("bluetooth"), "topology.link.bluetooth");
  assert.equal(pathLabelKey("relay"), "topology.link.relay");
  assert.equal(pathLabelKey("mesh"), "topology.link.hop");
  assert.equal(pathLabelKey("unknown"), "topology.link.unknown");
});

test("「已发现未建链」是 unknown，不是离线也不是零跳", () => {
  const { peers, summary } = buildTopologyPeers(
    input({
      peers: [
        { device_id: "p1", nickname: "甲", avatar: null, device_type: "mac", link: null, first_seen: 7 },
      ],
    }),
  );
  assert.equal(peers.length, 1);
  assert.equal(peers[0].pathKind, "unknown");
  assert.equal(peers[0].hop, 0);
  assert.equal(peers[0].online, true, "它在线（被观测到），只是还没有链路事实");
  assert.equal(summary.observed, 1);
  assert.equal(summary.relayed, 0);
  assert.equal(summary.mesh, 0);
});

test("公网中转与 Mesh 是**路径类型**，统计里数的是路径不是设备", () => {
  const { peers, summary } = buildTopologyPeers(
    input({
      peers: [
        { device_id: "p1", nickname: "甲", avatar: null, device_type: "mac", link: "relay" },
        { device_id: "p2", nickname: "乙", avatar: null, device_type: "mac", link: null },
        { device_id: "p3", nickname: "丙", avatar: null, device_type: "mac", link: "lan" },
      ],
      convLinks: { p2: { path: null, hop: 3 } },
    }),
  );
  assert.equal(summary.relayed, 1);
  assert.equal(summary.mesh, 1);
  assert.equal(summary.observed, 3);
  // ⚠️ 节点仍然是那三个 peer 本身 —— **没有合成中转节点**
  assert.deepEqual(
    peers.map((p) => p.id),
    ["p1", "p2", "p3"],
  );
  assert.equal(peers[1].pathKind, "mesh");
  assert.equal(peers[1].hop, 3);
});

test("离线好友不进图，只进列表（不能画成「仍在线」）", () => {
  const friends = [
    { device_id: "f1", nickname: "好友甲", avatar: null, device_type: "mac" },
    { device_id: "f2", nickname: "好友乙", avatar: null, device_type: "mac" },
  ];
  const peers = [
    { device_id: "f2", nickname: "好友乙", avatar: null, device_type: "mac", link: "lan" },
  ];
  const { peers: nodes, summary } = buildTopologyPeers(
    input({ peers, friends }),
  );
  assert.deepEqual(
    nodes.map((n) => n.id),
    ["f2"],
    "离线好友不得进图",
  );
  assert.equal(summary.offlineFriends, 1);

  const items = buildTopologyList(input({ peers, friends }));
  assert.equal(items.length, 2, "列表里在线与离线都在");
  const offline = items.find((i) => i.id === "f1")!;
  assert.equal(offline.offline, true);
  assert.equal(offline.pathKind, "unknown", "离线好友没有路径事实（也不许说成故障）");
  assert.equal(offline.online, false);
});

test("图与列表同源：同一份在线节点，列表不多不少", () => {
  const peers = [
    { device_id: "p1", nickname: "甲", avatar: null, device_type: "mac", link: "lan" },
    { device_id: "p2", nickname: "乙", avatar: null, device_type: "mac", link: "relay" },
  ];
  const friends = [
    { device_id: "p1", nickname: "甲", avatar: null, device_type: "mac" },
    { device_id: "f9", nickname: "离线丙", avatar: null, device_type: "mac" },
  ];
  const { peers: nodes } = buildTopologyPeers(input({ peers, friends }));
  const items = buildTopologyList(input({ peers, friends }));
  const onlineInList = items.filter((i) => !i.offline).map((i) => i.id);
  assert.deepEqual(onlineInList, nodes.map((n) => n.id), "图与列表的在线节点必须一致");
});

test("筛选只影响呈现，不改数据", () => {
  const items = buildTopologyList(
    input({
      peers: [
        { device_id: "p1", nickname: "甲", avatar: null, device_type: "mac", link: "lan" },
        { device_id: "p2", nickname: "乙", avatar: null, device_type: "mac", link: "lan" },
      ],
      friends: [
        { device_id: "p1", nickname: "甲", avatar: null, device_type: "mac" },
        { device_id: "f9", nickname: "离线丙", avatar: null, device_type: "mac" },
      ],
    }),
  );
  assert.equal(filterTopologyList(items, "all").length, 3);
  assert.deepEqual(
    filterTopologyList(items, "friends").map((i) => i.id),
    ["p1", "f9"],
  );
  assert.deepEqual(
    filterTopologyList(items, "offline").map((i) => i.id),
    ["f9"],
  );
});

test("邻域布局：本机是侧边/底部锚点，设备节点向另一侧展开", () => {
  const nodes = [
    { id: "__self__", ts: 0, self: true },
    { id: "p1", ts: 1 },
    { id: "p2", ts: 2 },
    { id: "p3", ts: 3 },
  ];
  // 宽屏：本机在左侧，设备在它右边
  const wide = layoutNeighborhood(nodes, 1000, 600);
  assert.equal(wide.narrow, false);
  assert.ok(wide.anchor.x < 0, "宽屏时本机应在左侧锚点");
  for (const id of ["p1", "p2", "p3"]) {
    assert.ok(wide.points.get(id)!.x > wide.anchor.x, "设备节点在本机右侧展开");
  }
  // 窄屏：本机在底部，设备在它上面
  const narrow = layoutNeighborhood(nodes, 390, 780);
  assert.equal(narrow.narrow, true);
  assert.ok(narrow.anchor.y > 0, "窄屏时本机应在底部锚点");
  for (const id of ["p1", "p2", "p3"]) {
    assert.ok(narrow.points.get(id)!.y < narrow.anchor.y, "设备节点在本机上方展开");
  }
});

test("邻域布局：同一档内新节点只追加，老节点一个像素都不动；跨档才重排", () => {
  const base = [
    { id: "__self__", ts: 0, self: true },
    { id: "p1", ts: 1 },
    { id: "p2", ts: 2 },
  ];
  const before = layoutNeighborhood(base, 1000, 600);
  const after = layoutNeighborhood(
    [...base, { id: "p3", ts: 3 }, { id: "p4", ts: 4 }],
    1000,
    600,
  );
  assert.equal(before.tier, after.tier, "同一档内档位不许变");
  for (const id of ["__self__", "p1", "p2"]) {
    assert.deepEqual(
      after.points.get(id),
      before.points.get(id),
      `${id} 的位置不能因为新节点加入而改变`,
    );
  }
  // 跨档（数量超过当前档容量）⇒ **允许**重排，但必须换更大的档（格子更小）。
  const many = layoutNeighborhood(
    [
      { id: "__self__", ts: 0, self: true },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, ts: i + 1 })),
    ],
    1000,
    600,
  );
  assert.ok(many.tier > before.tier, "数量涨上去必须换更大的档位（否则装不下）");
  assert.ok(many.maxNodes >= 40, "档位容量必须装得下当前数量");
});

test("邻域布局：同环节点不重叠（最小间距大于节点直径）", () => {
  const nodes = [
    { id: "__self__", ts: 0, self: true },
    ...Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, ts: i + 1 })),
  ];
  const l = layoutNeighborhood(nodes, 1000, 600);
  const ids = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = l.points.get(ids[i])!;
      const b = l.points.get(ids[j])!;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(d >= 26, `${ids[i]} 与 ${ids[j]} 间距只有 ${d.toFixed(1)}px，会叠在一起`);
    }
  }
});

test("邻域布局：节点不许溢出画布，且放不下的要有上限", () => {
  // 2026-11-16 review 实测：旧圆弧布局在 1440×900 上算到 y=488（可见区只到 450）
  // ⇒ 节点被画到屏幕外、点不到。现在改成网格云，并给出 maxNodes 上限。
  for (const [w, h] of [[1000, 600], [1440, 900], [390, 780]] as const) {
    const l = layoutNeighborhood(
      [
        { id: "__self__", ts: 0, self: true },
        ...Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, ts: i + 1 })),
      ],
      w,
      h,
    );
    // 只把**放得下的那些**画出来 ⇒ 每一个都必须落在可见区内。
    const peerIds = [...l.points.keys()].filter((id) => id !== "__self__").slice(0, l.maxNodes);
    for (const id of peerIds) {
      const p = l.points.get(id)!;
      assert.ok(
        p.x >= -w / 2 && p.x <= w / 2 && p.y >= -h / 2 && p.y <= h / 2,
        `${id} 超出画布（${w}x${h}）：(${p.x.toFixed(0)}, ${p.y.toFixed(0)})`,
      );
    }
    assert.ok(l.maxNodes > 0, "maxNodes 必须有值（组件据此把放不下的设备留在列表里）");
  }
});

test("邻域布局：网格云铺满可用区域（不留大块空白）", () => {
  const l = layoutNeighborhood(
    [
      { id: "__self__", ts: 0, self: true },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, ts: i + 1 })),
    ],
    1000,
    600,
  );
  const xs = [...l.points.values()].map((p) => p.x);
  const used = Math.max(...xs) - Math.min(...xs);
  assert.ok(
    used > 600,
    `1000 宽的画布上设备只占了 ${used.toFixed(0)}px ⇒ 大片留白（review 实测的旧毛病）`,
  );
});

test("邻域布局：50~100 是常规量级、500~1000 是极限量级，都要装得下且不出画布", () => {
  // 用户 2026-11-16：节点多的时候（50~100 常规、500~1000 极限）渲染必须扛得住。
  for (const [w, h] of [[1000, 600], [1440, 900], [390, 780]] as const) {
    for (const n of [10, 50, 100, 500, 1000]) {
      const l = layoutNeighborhood(
        [
          { id: "__self__", ts: 0, self: true },
          ...Array.from({ length: n }, (_, i) => ({ id: `p${i}`, ts: i + 1 })),
        ],
        w,
        h,
      );
      assert.ok(l.maxNodes >= n, `${n} 个设备装不下（档位容量只有 ${l.maxNodes}）`);
      for (const id of [...l.points.keys()]) {
        const p = l.points.get(id)!;
        assert.ok(
          p.x >= -w / 2 && p.x <= w / 2 && p.y >= -h / 2 && p.y <= h / 2,
          `${n} 个设备时 ${id} 超出画布（${w}x${h}）：(${p.x.toFixed(0)}, ${p.y.toFixed(0)})`,
        );
      }
      // 格子越小 ⇒ 节点半径要跟着缩（否则密集档位互相压死）。
      assert.ok(l.cell > 0, "格子尺寸必须现算");
    }
  }
});
