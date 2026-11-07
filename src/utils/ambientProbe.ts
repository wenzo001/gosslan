/**
 * 背景动效差异诊断的取样器。
 *
 * 用户 2026-11-07：「Windows 和 macOS 背景动效观感不一样」——两套 WebView 里真正会分叉的
 * 就是这几个媒体查询、`backdrop-filter` 能力，以及 `utils/ambient.ts` 写到
 * `<html data-ambient>` 的实际档位。这里只负责取样，不判断"应该哪档"；
 * 视图层负责原样展示与复制（规格见 docs/design-language/ambient-motion.md）。
 *
 * 放在 utils 而非组件里：`designGuards` ㉟ 禁止视图层裸写 `matchMedia` / 平台判断，
 * 平台与输入方式只能有一个出口。
 */
import { REDUCED_MOTION_QUERY } from "@/utils/platform";

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
  return [
    { label: "platform", value: platform },
    { label: "prefers-reduced-motion: reduce", value: onOff(REDUCED_MOTION_QUERY) },
    {
      label: "prefers-reduced-transparency: reduce",
      value: onOff("(prefers-reduced-transparency: reduce)"),
    },
    { label: "prefers-contrast: more", value: onOff("(prefers-contrast: more)") },
    { label: "forced-colors: active", value: onOff("(forced-colors: active)") },
    { label: "pointer: coarse", value: onOff("(pointer: coarse)") },
    {
      label: "html[data-ambient]",
      value: document.documentElement.dataset.ambient ?? "unset",
    },
    {
      label: "backdrop-filter",
      value: CSS.supports("backdrop-filter", "blur(2px)") ? "supported" : "unsupported",
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
