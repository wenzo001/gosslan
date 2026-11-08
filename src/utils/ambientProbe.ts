/**
 * 背景动效差异诊断的取样器。
 *
 * 用户 2026-11-07：「Windows 和 macOS 背景动效观感不一样」——两套 WebView 里真正会分叉的
 * 就是这几个媒体查询、`backdrop-filter` 能力，以及 `utils/ambient.ts` 写到
 * `<html data-ambient>` 的实际档位。这里只负责取样，不判断"应该哪档"；
 * 视图层负责原样展示与复制（规格见 docs/design-language/ambient-motion.md）。
 *
 * 2026-11-07 补：一台 Windows 读数显示 `prefers-reduced-transparency: reduce: on` 而
 * `data-ambient` 是 `drift`，雾却看不见 —— 根因是当时透明降级连带动效整层隐藏。
 * 从那以后这里额外输出：
 *   · 每条 media query **影响什么**（写在 label 的 `(affects: …)` 里），一眼分清
 *     "这条影响玻璃"还是"这条影响动效"；
 *   · `ambient resolved from` / `transparency resolved from`：当前生效值是谁定的
 *     （software / system / default）。
 *
 * 放在 utils 而非组件里：`designGuards` ㉟ 禁止视图层裸写 `matchMedia` / 平台判断，
 * 平台与输入方式只能有一个出口。
 */
import { currentAmbientResolution, readStoredAmbientRaw } from "@/utils/ambient";
import { readAmbientCapability, supportsBackdropFilterBy } from "@/utils/ambientCapability";
import { REDUCED_MOTION_QUERY } from "@/utils/platform";
import {
  readStoredReducedTransparency,
  systemPrefersReducedTransparency,
} from "@/utils/reducedTransparency";

export interface AmbientProbeRow {
  label: string;
  value: string;
}

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "unset";
}

export function readAmbientProbe(): AmbientProbeRow[] {
  const onOff = (q: string) => (window.matchMedia(q).matches ? "on" : "off");
  const ua = navigator.userAgent;
  const platform = ua.includes("Windows")
    ? "Windows"
    : ua.includes("Macintosh")
      ? "macOS"
      : ua.includes("Android")
        ? "Android"
        : navigator.platform || "?";

  const ambient = currentAmbientResolution();
  const capability = readAmbientCapability();
  const transparencyExplicit = readStoredReducedTransparency();
  const transparencySource =
    transparencyExplicit === null
      ? systemPrefersReducedTransparency()
        ? "system"
        : "default"
      : "software";

  return [
    { label: "platform", value: platform },
    // —— 四条媒体查询：后面标的是它**实际影响什么**（2026-11-07 读数事故的教训）——
    {
      label: "prefers-reduced-motion: reduce (affects: ambient motion)",
      value: onOff(REDUCED_MOTION_QUERY),
    },
    {
      label: "prefers-reduced-transparency: reduce (affects: glass blur only)",
      value: onOff("(prefers-reduced-transparency: reduce)"),
    },
    {
      label: "prefers-contrast: more (affects: ambient layer hidden)",
      value: onOff("(prefers-contrast: more)"),
    },
    {
      label: "forced-colors: active (affects: ambient layer hidden)",
      value: onOff("(forced-colors: active)"),
    },
    { label: "pointer: coarse (affects: hit area only)", value: onOff("(pointer: coarse)") },
    // —— 生效结果与来源：出问题时先看这四行 ——
    { label: "html[data-ambient] (final mode)", value: document.documentElement.dataset.ambient ?? "unset" },
    {
      label: "html[data-ambient-motion] (force = software wins over system reduce)",
      value: document.documentElement.dataset.ambientMotion ?? "unset",
    },
    { label: "ambient resolved from", value: ambient.source },
    { label: "software ambient setting", value: readStoredAmbientRaw() ?? "unset" },
    {
      label: "ambient capability (gates the setting, 2026-11-08)",
      value: capability.available ? "available" : `unavailable: ${capability.reason}`,
    },
    { label: "transparency resolved from", value: transparencySource },
    {
      label: "backdrop-filter (backdrop-filter or -webkit-, same as style.css @supports)",
      value: supportsBackdropFilterBy((p, v) => CSS.supports(p, v)) ? "supported" : "unsupported",
    },
    { label: "--ambient-alpha", value: readToken("--ambient-alpha") },
    { label: "--ambient-veil", value: readToken("--ambient-veil") },
    { label: "--ambient-scale", value: readToken("--ambient-scale") },
    { label: "devicePixelRatio", value: String(window.devicePixelRatio) },
    { label: "viewport", value: `${window.innerWidth}×${window.innerHeight}` },
  ];
}

export function ambientProbeText(rows: AmbientProbeRow[]): string {
  return rows.map((row) => `${row.label}: ${row.value}`).join("\n");
}
