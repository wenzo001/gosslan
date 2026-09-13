/**
 * **一条链路的"连接信息"该怎么展示**（单一事实来源）。
 *
 * ## 为什么需要它（用户 2026-09-13 提出）
 *
 * 界面上原来是"有 IP 就显示 IP、没有就显示 —"，于是**蓝牙链路**也会显示一行
 * `IP 地址：—`，而 `设备类型` 直接显示后端的 `desktop` / `mobile` 英文原值。用户的要求是：
 * **不同链路进来的设备，标注的信息应当不一样** —— 蓝牙根本没有 IP，不该拿一个空行敷衍。
 *
 * ## 约定（三种链路各说各的事实）
 *
 * | 链路 | 连接方式 | 地址行 | 例子 |
 * |---|---|---|---|
 * | 蓝牙直连 | 蓝牙直连（近距离） | **不显示** —— 蓝牙链路上没有 IP 这个概念 | — |
 * | 同一局域网 | 同一局域网 | `ip:port` | `192.168.31.32:59992` |
 * | 跨网段/中继 | 跨网段 / VPN（或"经 N 跳中继"） | `ip:port`；中继时**不显示**直连地址 | `100.101.221.60:59992` |
 * | 已发现未建链 | 已发现（未建链） | 不显示 | — |
 *
 * 判据全部是纯函数 ⇒ 可单测、可护栏（这类"显示错了"的退化不会报错，只会误导用户）。
 */

/** 与后端 `PathKind::as_str()` 对齐（`lan` / `routed` / `bluetooth`）。 */
export type PeerLink = "bluetooth" | "lan" | "routed" | string | null | undefined;

export interface PeerInfoInput {
  /** 后端填的**真实链路类型**（`Peer.link`）；null/缺失 = 只有发现、没有链路 */
  link?: PeerLink;
  ip?: string | null;
  tcp_port?: number | null;
  /** 中继跳数（0 = 直连；>0 = 经中继）。缺失按 0 处理。 */
  hop?: number | null;
  online?: boolean;
  /** 后端 `device_type`：`desktop` / `mobile` / 空串（旧端或未知） */
  device_type?: string | null;
}

/** 连接方式那一行的 i18n key（用 `t()` 渲染）。 */
export function linkLabelKey(info: PeerInfoInput): string {
  const hop = info.hop ?? 0;
  if (info.link === "bluetooth") return "peer.link.bluetooth";
  if (hop > 0) return "peer.link.relay";
  if (info.link === "routed") return "peer.link.routed";
  if (info.link === "lan") return "peer.link.lan";
  if (info.online) return "peer.link.lan";
  // 有节点、没链路：**必须说清"还没连上"**，否则用户会以为已经可用（真机踩过）
  return "peer.link.discovered";
}

/** 连接方式的展示参数（中继跳数要填进模板）。 */
export function linkLabelParams(info: PeerInfoInput): Record<string, string | number> {
  return { n: info.hop ?? 0 };
}

/**
 * 该不该显示"地址"这一行。
 *
 * **蓝牙链路一律不显示**：蓝牙上没有 IP，显示 `IP 地址：—` 只会让人以为"信息缺失"。
 * 中继链路也不显示直连地址（我们只有跳数，没有中继节点地址，写了就是编）。
 */
export function shouldShowAddress(info: PeerInfoInput): boolean {
  if (info.link === "bluetooth") return false;
  if ((info.hop ?? 0) > 0) return false;
  return !!info.ip;
}

/** 地址文本（`ip:port`），没有地址返回 null。 */
export function addressText(info: PeerInfoInput): string | null {
  if (!shouldShowAddress(info)) return null;
  const ip = info.ip as string;
  return info.tcp_port ? `${ip}:${info.tcp_port}` : ip;
}

/** 设备类型的 i18n key：后端只给 `desktop` / `mobile`，其余一律"未知设备"。 */
export function deviceTypeKey(deviceType: string | null | undefined): string {
  const v = (deviceType ?? "").trim().toLowerCase();
  if (v === "desktop") return "peer.device.desktop";
  if (v === "mobile") return "peer.device.mobile";
  return "peer.device.unknown";
}
