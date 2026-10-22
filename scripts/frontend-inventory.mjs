// 前端资产清单生成器：把 `docs/architecture/frontend-inventory.md` 里
// `<!-- BEGIN:generated -->` 与 `<!-- END:generated -->` 之间的那一段重算并写回。
//
// 为什么要脚本化：这份清单的价值全在"数字与文件名是现读的"。手抄一遍索引，
// 三个月后它就变成一份没人核对的假事实源（本仓已有多次这种账）。
//
// 用法：node scripts/frontend-inventory.mjs            # 重新生成
//       node scripts/frontend-inventory.mjs --check    # 只核对，不一致退 1
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DOC = "docs/architecture/frontend-inventory.md";
const BEGIN = "<!-- BEGIN:generated (node scripts/frontend-inventory.mjs) -->";
const END = "<!-- END:generated -->";

const git = (args) =>
  execFileSync("git", args, { encoding: "utf8" }).trim().split("\n").filter(Boolean);

// 生产码 / 测试码分列：测试代码的删除不许算成业务简化（目标第二节明确要求）。
// `git ls-files` 会列出「已删除但尚未提交」的文件；对生成器来说它已经不存在，
// 读它会直接 ENOENT（本轮删 navIconPaths.ts 时踩到）。以工作树为准。
const all = git(["ls-files", "src"])
  .filter((f) => /\.(ts|vue|js)$/.test(f) && !f.startsWith("src/assets/"))
  .filter((f) => existsSync(f));
const isTest = (f) => /\.test\.ts$/.test(f);
const locOf = (f) =>
  Number(execFileSync("wc", ["-l", f], { encoding: "utf8" }).trim().split(/\s+/)[0]);

const CATEGORY = [
  ["E-入口/启动", (f) => /^src\/(entries|boot)\//.test(f)],
  ["E-IPC/事件", (f) => /^src\/api\//.test(f)],
  ["E-平台适配", (f) => /^src\/utils\/(platform|ime|haptics|notifications|notifyUrgency|externalLinks|localFile|saveImage|clipboard|windowLaunch)/.test(f)],
  ["C-状态层", (f) => /^src\/stores\//.test(f)],
  ["B-国际化", (f) => /^src\/i18n\//.test(f)],
  ["A-公共UI", (f) => /^src\/components\/(ui|window)\//.test(f) || /^src\/components\/(BaseModal|TitleBar|MobilePageFrame|ActionSheet|ContextMenu|ToastHud|ToastList)\.vue$/.test(f)],
  ["A-布局", (f) => /^src\/layouts\//.test(f) || f === "src/App.vue" || f === "src/style.css"],
  ["B-composables", (f) => /^src\/composables\//.test(f)],
  ["B-utils", (f) => /^src\/utils\//.test(f)],
  ["D-数据表", (f) => /^src\/(data|types)/.test(f)],
  ["D-业务组件", (f) => /^src\/components\//.test(f)],
];
const categorize = (f) => CATEGORY.find(([, test]) => test(f))?.[0] ?? "其他";

// 第三方依赖：只认 package.json 里真装着的包名，避免"清单里写了一个没装的库"。
const DEPS = Object.keys(
  JSON.parse(readFileSync("package.json", "utf8")).dependencies ?? {},
);
const depsOf = (src) => {
  const hit = new Set();
  for (const d of DEPS) if (new RegExp(`from ["']${d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(src)) hit.add(d);
  return [...hit].sort();
};

const rows = all
  .filter((f) => !isTest(f))
  .map((f) => {
    const src = readFileSync(f, "utf8");
    return { file: f, cat: categorize(f), loc: locOf(f), deps: depsOf(src) };
  });
const testRows = all.filter(isTest).map((f) => ({ file: f, loc: locOf(f) }));

const byCat = {};
for (const r of rows) {
  byCat[r.cat] ??= { files: 0, loc: 0 };
  byCat[r.cat].files += 1;
  byCat[r.cat].loc += r.loc;
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const prodLoc = sum(rows.map((r) => r.loc));
const testLoc = sum(testRows.map((r) => r.loc));

const depUse = {};
for (const r of rows) for (const d of r.deps) (depUse[d] ??= { files: 0, loc: 0 }).files++, (depUse[d].loc += r.loc);

const out = [];
out.push(BEGIN);
out.push("");
out.push(
  `> 复跑：\`node scripts/frontend-inventory.mjs\`（本段与 \`--check\` 对账，手改本段数字没有意义）。`,
);
out.push(`> 现读：\`src/\` 共 ${all.length} 份源码 = 生产 ${rows.length} 份 / ${prodLoc.toLocaleString()} 行 + 测试 ${testRows.length} 份 / ${testLoc.toLocaleString()} 行（不含 \`src/assets/\` 里的 ${git(["ls-files", "src/assets"]).length} 个表情图）。`);
out.push("");
out.push("### 1.1 按职责分类（生产码，机器现算）");
out.push("");
out.push("| 类 | 文件 | 行 |");
out.push("|---|---:|---:|");
for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1].loc - a[1].loc))
  out.push(`| ${k} | ${v.files} | ${v.loc.toLocaleString()} |`);
out.push(`| **合计** | **${rows.length}** | **${prodLoc.toLocaleString()}** |`);
out.push("");
out.push("### 1.2 已装库在生产码里的实际使用面（装了不等于用了）");
out.push("");
out.push("| 依赖 | 生产文件 | 行 |");
out.push("|---|---:|---:|");
for (const [k, v] of Object.entries(depUse).sort((a, b) => b[1].files - a[1].files))
  out.push(`| \`${k}\` | ${v.files} | ${v.loc.toLocaleString()} |`);
for (const d of DEPS)
  if (!depUse[d]) out.push(`| \`${d}\` | **0** | 0 ← 装了但生产码没用到，要么接上要么卸掉 |`);
out.push("");
out.push("### 1.3 全量生产文件索引");
out.push("");
out.push("| 文件 | 类 | 行 | 直接用到的库 |");
out.push("|---|---|---:|---|");
for (const r of rows.sort((a, b) => a.file.localeCompare(b.file)))
  out.push(`| \`${r.file}\` | ${r.cat} | ${r.loc} | ${r.deps.map((d) => `\`${d}\``).join(" ") || "—"} |`);
out.push("");
out.push("### 1.4 测试码（分列，不计进业务成果）");
out.push("");
out.push(`共 ${testRows.length} 份 / ${testLoc.toLocaleString()} 行；由 \`npm test\` 的清单自己打印条数。`);
out.push(END);

const block = out.join("\n");
const doc = readFileSync(DOC, "utf8");
const at = doc.indexOf(BEGIN);
const endAt = doc.indexOf(END);
if (at < 0 || endAt < at) {
  console.error(`✗ ${DOC} 里找不到生成锚点（BEGIN/END），拒绝盲写`);
  process.exit(1);
}
const next = doc.slice(0, at) + block + doc.slice(endAt + END.length);
if (process.argv.includes("--check")) {
  if (next !== doc) {
    console.error(`✗ ${DOC} 的生成段与实际代码不一致 —— 跑 \`node scripts/frontend-inventory.mjs\` 重新生成`);
    process.exit(1);
  }
  console.log(`✓ ${DOC} 生成段与实际代码一致`);
  process.exit(0);
}
writeFileSync(DOC, next);
console.log(
  `✓ 已生成 ${DOC} 的清单段：生产 ${rows.length} 份 / ${prodLoc} 行，测试 ${testRows.length} 份 / ${testLoc} 行`,
);
