// 打印「出厂种子」求解出来的两档 token 块，用来同步 style.css。
//
// 用法：node --experimental-strip-types scripts/dump-theme-tokens.mjs [种子]
//
// 为什么要有这个脚本：style.css 的静态数值是"JS 还没跑时的首帧"，必须与 utils/themePalette.ts
// 的求解器输出逐 token 相同（themePalette.test.ts 里有判据盯着）。手抄 42×2 个 hex 一定会漂，
// 所以在改求解器之后直接生成，不要手改 CSS。

const seed = process.argv[2] ?? "#2f6bff";
const { buildThemeTokens } = await import("../src/utils/themePalette.ts");

for (const mode of ["light", "dark"]) {
  const tokens = buildThemeTokens(seed, mode);
  console.log(`\n/* ---- ${mode}：${seed} ---- */`);
  console.log(`${mode === "light" ? ":root" : ".dark"} {`);
  for (const [k, v] of Object.entries(tokens)) console.log(`  ${k}: ${v};`);
  console.log("}");
}
