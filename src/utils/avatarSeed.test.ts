// 默认头像的种子（#32）：emoji 小动物 × 适配背景色，纯函数、跨端可复算。
// 跑法：node --test src/utils/avatarSeed.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AVATAR_BACKGROUNDS,
  AVATAR_EMOJIS,
  AVATAR_PAIRS,
  avatarPresetDataUrl,
  avatarSeedFor,
  isAvatarSeed,
  parseAvatarPreset,
  randomAvatarPair,
} from "./avatarSeed.ts";

/** 相对亮度（WCAG 的那条），用来判"这个背景色既不至于亮到看不见 emoji、也不至于暗到吃字"。 */
function relLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

test("结果不许读时钟或随机源：把它们换成乱跳的实现，输出必须一模一样", () => {
  const first = avatarSeedFor("gosslan-23fe9c32ee9fc");
  assert.ok(first, "合法 id 不该返回 null");
  const realNow = Date.now;
  const realRandom = Math.random;
  try {
    let n = 0;
    // 只重复调用不算判据：同一毫秒里跑 50 次，混进 Date.now() 的实现照样"通过"（实测过这个空转）。
    Date.now = () => 1_700_000_000_000 + n++ * 86_400_000;
    Math.random = () => (n++ % 7) / 7;
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(avatarSeedFor("gosslan-23fe9c32ee9fc"), first,
        "结果里混进了时钟或随机源 —— 那会让同一个人每次上线换一张脸");
    }
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
});

test("id 缺失时返回 null，让调用方走自己的兜底，不许悄悄给一张默认脸", () => {
  assert.equal(avatarSeedFor(""), null);
  assert.equal(avatarSeedFor(null), null);
  assert.equal(avatarSeedFor(undefined), null);
});

test("组合表至少 100 对（条数现算，不手抄）", () => {
  assert.ok(AVATAR_PAIRS.length >= 100, `实际只有 ${AVATAR_PAIRS.length} 对`);
  const seen = new Set(AVATAR_PAIRS.map((p) => `${p.emoji}|${p.bg}`));
  assert.equal(seen.size, AVATAR_PAIRS.length, "表里有完全相同的两行 —— 那等于少一种头像");
});

test("每一对的背景色都得落在中间调：太亮或太暗都会让 emoji 看不清", () => {
  const bad = AVATAR_PAIRS.filter((p) => {
    const l = relLuminance(p.bg);
    return !(l >= 0.18 && l <= 0.72);
  });
  assert.deepEqual(bad.map((p) => `${p.emoji} ${p.bg}`), [],
    "这些背景色不在中间调（相对亮度 0.18–0.72）");
});

test("每个 bg 都得是 #rrggbb —— 写成 rgb()/命名色会让上面那条判据静默失效", () => {
  const bad = AVATAR_PAIRS.filter((p) => !/^#[0-9a-f]{6}$/.test(p.bg));
  assert.deepEqual(bad.map((p) => p.bg), [], "背景色必须是 6 位十六进制小写");
});

test("相邻 id 不该撞脸：造 200 个 id，去重后至少要有 50 种不同结果", () => {
  const kinds = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const s = avatarSeedFor(`gosslan-device-${i}`);
    assert.ok(s);
    kinds.add(`${s!.emoji}|${s!.bg}`);
  }
  assert.ok(kinds.size >= 50, `200 个 id 只散出 ${kinds.size} 种头像 —— 哈希或取模写错了`);
});

test("结果只能取自表里的行，不能是拼出来的第三种东西", () => {
  for (const id of ["a", "gosslan-1", "dev:Mac-wendon"]) {
    const s = avatarSeedFor(id)!;
    assert.ok(AVATAR_PAIRS.some((p) => p.emoji === s.emoji && p.bg === s.bg),
      `${id} 的结果不在表里`);
  }
});

// ---------------- 默认头像选择器（2026-10-22） ----------------

test("选择器的选项集从组合表现推：手动能选的每个表情/颜色，随机算法也都认识", () => {
  assert.ok(AVATAR_EMOJIS.length >= 30, `表情只有 ${AVATAR_EMOJIS.length} 个`);
  assert.ok(AVATAR_BACKGROUNDS.length >= 20, `背景色只有 ${AVATAR_BACKGROUNDS.length} 个`);
  assert.equal(new Set(AVATAR_EMOJIS).size, AVATAR_EMOJIS.length, "表情清单里有重复项");
  assert.equal(new Set(AVATAR_BACKGROUNDS).size, AVATAR_BACKGROUNDS.length, "颜色清单里有重复项");
  for (const e of AVATAR_EMOJIS) {
    assert.ok(AVATAR_PAIRS.some((p) => p.emoji === e), `${e} 不在随机算法的组合表里`);
  }
  for (const bg of AVATAR_BACKGROUNDS) {
    assert.ok(AVATAR_PAIRS.some((p) => p.bg === bg), `${bg} 不在随机算法的组合表里`);
  }
});

test("随机出来的组合永远落在表内，且不会原地重复（点了「随机」像没反应）", () => {
  const seen = new Set<string>();
  let prev = randomAvatarPair();
  for (let i = 0; i < 300; i++) {
    const next = randomAvatarPair(prev);
    assert.ok(
      AVATAR_PAIRS.some((p) => p.emoji === next.emoji && p.bg === next.bg),
      `随机出了表外的组合 ${next.emoji} ${next.bg}`,
    );
    assert.notDeepEqual(next, prev, "随机结果和上一张完全相同");
    seen.add(`${next.emoji}|${next.bg}`);
    prev = next;
  }
  assert.ok(seen.size >= 20, `300 次只随机出 ${seen.size} 种组合`);
});

test("全部表情×颜色（数量现算）都能编码再原样解回来", () => {
  for (const emoji of AVATAR_EMOJIS) {
    for (const bg of AVATAR_BACKGROUNDS) {
      const url = avatarPresetDataUrl({ emoji, bg });
      assert.deepEqual(parseAvatarPreset(url), { emoji, bg }, `${emoji} ${bg} 往返不一致`);
    }
  }
});

test("预设必须是 base64（后端按 base64 算字节数），且整串仍能进 Hello 的 2KB 闸门", () => {
  // 上限从 Rust 现读：这里手抄一个 2048 的话，哪天闸门收紧/放宽，这条判据会说谎。
  const rust = readFileSync(
    new URL("../../src-tauri/src/network/transport/handshake.rs", import.meta.url),
    "utf8",
  );
  const cap = Number(/pub const HELLO_AVATAR_MAX_BYTES: usize = (\d+);/.exec(rust)?.[1]);
  assert.ok(cap > 0, "解析不到 HELLO_AVATAR_MAX_BYTES —— 判据的前提塌了");
  for (const emoji of AVATAR_EMOJIS) {
    for (const bg of AVATAR_BACKGROUNDS) {
      const url = avatarPresetDataUrl({ emoji, bg });
      assert.match(url, /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/, "不是 base64 data URL");
      assert.ok(url.length <= cap, `${emoji} ${bg} 生成 ${url.length} 字节 > Hello 上限 ${cap}`);
    }
  }
});

test("解析只认本机生成的预设：普通图片、坏 base64、表外组合一律 null", () => {
  const marked = (emoji: string, bg: string) =>
    "data:image/svg+xml;base64," +
    Buffer.from(
      `<svg data-gosslan-avatar-preset="1" data-emoji="${emoji}" data-bg="${bg}"></svg>`,
    ).toString("base64");

  assert.equal(parseAvatarPreset(null), null);
  assert.equal(parseAvatarPreset(undefined), null);
  assert.equal(parseAvatarPreset(""), null);
  assert.equal(parseAvatarPreset("data:image/jpeg;base64,AAAA"), null, "普通上传图片不该被当成预设");
  assert.equal(parseAvatarPreset("data:image/svg+xml;base64,!!!"), null, "坏 base64 不该抛");
  assert.equal(parseAvatarPreset(marked("🧠", "#4284b3")), null, "表外表情必须拒绝");
  assert.equal(parseAvatarPreset(marked("🦊", "red")), null, "非 #rrggbb 必须拒绝");
  assert.equal(
    parseAvatarPreset(
      "data:image/svg+xml;base64," +
        Buffer.from(`<svg data-emoji="🦊" data-bg="#4284b3"></svg>`).toString("base64"),
    ),
    null,
    "没有本机标记的 SVG 不能被当成本机预设",
  );
  assert.deepEqual(parseAvatarPreset(marked("🦊", "#4284b3")), { emoji: "🦊", bg: "#4284b3" });
});

test("编码入口拒绝非法 emoji / 非 hex；自定义 hex 放行", () => {
  assert.throws(() => avatarPresetDataUrl({ emoji: "<script>", bg: "#4284b3" }));
  assert.throws(() => avatarPresetDataUrl({ emoji: "🦊", bg: "red" }));
  assert.throws(() => avatarPresetDataUrl({ emoji: "🦊", bg: "#12345" }));
  assert.match(
    avatarPresetDataUrl({ emoji: "🦊", bg: "#ffffff" }),
    /^data:image\/svg\+xml;base64,/,
  );
});

test("自定义颜色：任意合法 hex 可往返，非 hex 一律拒绝", () => {
  for (const bg of ["#123456", "#ffffff", "#000000", "#7a5a3a", "#5aa0c0"]) {
    assert.equal(isAvatarSeed({ emoji: "🦊", bg }), true, `${bg} 应该被接受`);
    assert.deepEqual(parseAvatarPreset(avatarPresetDataUrl({ emoji: "🦊", bg })), { emoji: "🦊", bg });
  }
  for (const bg of ["red", "#12345", "#GGGGGG", "rgb(1,2,3)"]) {
    assert.equal(isAvatarSeed({ emoji: "🦊", bg }), false, `${bg} 应该被拒绝`);
  }
});
