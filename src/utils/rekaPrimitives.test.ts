import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * Reka 原语的形态判据（菜单之外的那几件）。
 *
 * 写法与 `contextMenuReka.test.ts` 同一口径：只钉「内核归谁」这类静默退化 ——
 * 把库换回自建实现时，界面通常照样能用，坏掉的是键盘/读屏/焦点这类没人肉眼看的契约。
 */
const srcRoot = join(import.meta.dirname, "..");

function read(rel: string): string {
  return readFileSync(join(srcRoot, rel), "utf8");
}

test("设置开关走 Reka Switch，不再手写 role=switch / aria-checked", () => {
  // 文件头注释解释「role=switch 没有名字读不出来」是审计背景，先剥注释再量模板。
  const src = read("components/settings/SettingsToggle.vue").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(src.includes("SwitchRoot"), "开关没有接 Reka SwitchRoot");
  assert.ok(src.includes("SwitchThumb"), "滑块没有接 Reka SwitchThumb");
  assert.ok(!src.includes('role="switch"'), "仍手写 role=switch（Reka 会自己写）");
  assert.ok(!src.includes(":aria-checked="), "仍手写 aria-checked（Reka 会自己写）");
  // Reka 的 Vue 版 Switch 用的是 modelValue/update:modelValue（不是 Radix 的 checked/update:checked）。
  assert.ok(src.includes(":model-value=\"modelValue\""), "必须用 Reka Vue 的 modelValue 入参");
  assert.ok(src.includes("@update:model-value="), "必须监听 Reka Vue 的 update:modelValue");
  assert.ok(!src.includes(":checked="), "Reka Vue 没有 checked 入参（写了也静默不生效）");
  assert.ok(src.includes(":aria-label=\"label\""), "开关的可访问名必须来自必填 label");
});

test("分段控件走 Reka RadioGroup，方向键与单 Tab 停靠点交给库", () => {
  const src = read("components/ui/SegmentedControl.vue").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(src.includes("RadioGroupRoot"), "分段控件没有接 Reka RadioGroupRoot");
  assert.ok(src.includes("RadioGroupItem"), "分段控件没有接 Reka RadioGroupItem");
  assert.ok(!src.includes('role="radiogroup"'), "仍手写 role=radiogroup（Reka 会自己写）");
  assert.ok(!src.includes('role="radio"'), "仍手写 role=radio（Reka 会自己写）");
  assert.ok(!src.includes(":aria-checked="), "仍手写 aria-checked（Reka 会自己写）");
  assert.ok(src.includes(":model-value=\"modelValue\""), "必须用 RadioGroup 的 modelValue 入参");
  assert.ok(src.includes("@update:model-value="), "必须监听 update:modelValue");
});

test("字号滑块走 Reka Slider，不再自写 pointer/键盘步进", () => {
  const src = read("components/settings/ChatStyleSection.vue").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(src.includes("SliderRoot"), "字号滑块没有接 Reka SliderRoot");
  assert.ok(src.includes("SliderThumb"), "字号滑块没有接 Reka SliderThumb");
  assert.ok(!src.includes('role="slider"'), "仍手写 role=slider（Reka 会自己写）");
  assert.ok(!src.includes("@pointerdown="), "仍自写 pointerdown（应交给 Reka Slider）");
  assert.ok(!src.includes("@pointermove="), "仍自写 pointermove（应交给 Reka Slider）");
  assert.ok(!src.includes("@keydown.left="), "仍自写方向键步进（应交给 Reka Slider）");
  assert.ok(src.includes(":aria-valuetext="), "滑块必须有可读的 aria-valuetext");
});
