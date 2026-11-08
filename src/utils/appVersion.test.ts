import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 主界面版本号（用户 2026-11-07）：会话列表页脚右端，纯展示、桌面与移动共用同一落点。
 *
 * 判据（任何一条不满足即红）：
 *   1. 值只能来自 `package.json`：必须有 `import { version } from "…/package.json"`，
 *      并用 `` `v${version}` `` 拼出来 —— 手写第二处 `v5.18.78` 就红。
 *   2. 模板里渲染的是那个变量（`{{ appVersion }}`），不是字面量。
 *   3. 它是 `<span data-app-version>`：带 `pointer-events-none`，标签内没有 `@click` / `href` /
 *      `role="button"` —— 不许变成「关于」的第二个入口。
 *
 * 反例自证在文件末尾两条：写死版本号 / 改成可点按钮 ⇒ 都会红。
 */
export function checkMainVersionBadge(src: string): string[] {
  const issues: string[] = [];
  if (!/import\s*\{\s*version\s*\}\s*from\s*"(\.\.\/)+package\.json"/.test(src)) {
    issues.push('缺少 `import { version } from "../…/package.json"` —— 版本号必须来自唯一数据源。');
  }
  if (!/const\s+appVersion\s*=\s*`v\$\{version\}`/.test(src)) {
    issues.push("缺少 `const appVersion = `v${version}`` —— 前缀可以手写，数字不许。");
  }
  if (!/\{\{\s*appVersion\s*\}\}/.test(src)) {
    issues.push("模板没有渲染 `{{ appVersion }}`（疑似写死了版本号字面量）。");
  }
  // 只要在组件里出现形如 5.18.78 / v5.18.78 的版本字面量 ⇒ 第二处手写，红。
  const literal = src.match(/\bv?\d+\.\d+\.\d+\b/);
  if (literal) issues.push(`源码里出现写死的版本字面量 \`${literal[0]}\` —— 改版本时会漂。`);

  const span = src.match(/<span[^>]*data-app-version[^>]*>/);
  if (!span) {
    issues.push("找不到 `<span data-app-version>`（主界面版本号那一个落点）。");
  } else {
    if (!/pointer-events-none/.test(span[0])) {
      issues.push("版本号必须 `pointer-events-none`（纯展示，不参与点击命中）。");
    }
    if (/@click|href=|role="button"/.test(span[0])) {
      issues.push("版本号不许可点 —— 它不是「关于」的入口。");
    }
  }
  return issues;
}

const COMPONENT = join(import.meta.dirname, "..", "components", "ConversationList.vue");

test("主界面版本号：真实源码通过", () => {
  const issues = checkMainVersionBadge(readFileSync(COMPONENT, "utf8"));
  assert.deepEqual(issues, []);
});

test("反例：把变量换成写死的版本号 ⇒ 红", () => {
  const src = readFileSync(COMPONENT, "utf8").replace(/\{\{\s*appVersion\s*\}\}/, "{{ 'v5.18.78' }}");
  const issues = checkMainVersionBadge(src);
  assert.ok(issues.some((x) => x.includes("appVersion") || x.includes("字面量")), issues.join(" / "));
});

test("反例：把版本号改成可点按钮（当成第二个「关于」入口）⇒ 红", () => {
  const src = readFileSync(COMPONENT, "utf8").replace(
    "<span\n          data-app-version",
    '<button\n          data-app-version\n          @click="router.push(\'/me\')"',
  );
  const issues = checkMainVersionBadge(src);
  assert.ok(issues.some((x) => x.includes("data-app-version")), issues.join(" / "));
});

// ---------------- 页脚排版（用户 2026-11-08） ----------------
//
// 四条契约，任何一条被改回去都要红：
//   1. hover 高亮只属于任务入口，**不许贴到版本文本**：两者是兄弟节点，中间有间距 token；
//   2. 版本号宽度按最长形态（`v100.100.100` = 12ch）预留，`tabular-nums` + `text-right`；
//   3. `shrink-0` + `whitespace-nowrap` —— 任何宽度下都不被压缩、不换行；
//   4. 容器窄到放不下时**先隐藏版本号**，任务入口保留。
export function checkFooterLayout(src: string): string[] {
  const issues: string[] = [];
  const row = src.match(/<div\s+class="conv-footer-row[^"]*"[^>]*>/);
  if (!row) {
    issues.push("找不到 `.conv-footer-row`（页脚那一行）。");
  } else {
    if (!/\bgap-[1-9]/.test(row[0])) {
      issues.push("页脚行缺少间距 token（gap-*）—— hover 高亮会直接贴到版本号上。");
    }
    if (!/\bpr-3\b/.test(row[0])) issues.push("页脚行右侧内边距（pr-3）丢了，版本号会贴着窗口边缘。");
  }

  const span = src.match(/<span[^>]*data-app-version[^>]*>/);
  if (!span) {
    issues.push("找不到 `<span data-app-version>`。");
    return issues;
  }
  const cls = span[0];
  for (const [needle, why] of [
    ["shrink-0", "版本号必须 `shrink-0`，否则会被任务入口压缩"],
    ["whitespace-nowrap", "版本号必须 `whitespace-nowrap`，否则窄宽下会折成两行"],
    ["tabular-nums", "版本号必须 `tabular-nums`，否则数字宽度不一致、预留宽度失效"],
    ["text-right", "版本号右对齐，短版本才不会把空隙留在右边（贴着 hover 区）"],
  ] as const) {
    if (!cls.includes(needle)) issues.push(`${why}（缺 \`${needle}\`）。`);
  }
  if (!/min-w-\[\d+ch\]/.test(cls)) {
    issues.push("版本号没有按 `ch` 预留固定最小宽度 —— 短版本会让右边留白随版本号宽度变化。");
  }
  if (/\bhover:/.test(cls)) issues.push("版本号自己带 hover 样式 —— hover 高亮只能属于任务入口。");

  // 版本号必须是任务入口的**兄弟**（在 </button> 之后）：放进按钮里就等于 hover 背景罩住它。
  const btnEnd = src.indexOf("</button>", src.indexOf("data-task-entry"));
  const spanAt = src.indexOf("data-app-version");
  if (btnEnd < 0 || spanAt < btnEnd) {
    issues.push("版本号落进了任务入口按钮内部 —— hover 高亮会直接压在版本文本上。");
  }

  if (!/@container\s*\(max-width:\s*\d+px\)\s*\{[^}]*data-app-version[^}]*display:\s*none/s.test(src)) {
    issues.push("缺少「极窄容器先隐藏版本号」的容器查询 —— 窄宽下两边会一起挤成不可读。");
  }
  if (!/container-type:\s*inline-size/.test(src)) {
    issues.push("缺少 `container-type: inline-size`，上面那条容器查询不会生效（等于空转）。");
  }
  return issues;
}

test("页脚排版：真实源码通过", () => {
  assert.deepEqual(checkFooterLayout(readFileSync(COMPONENT, "utf8")), []);
});

test("反例：去掉页脚行的间距（hover 贴到版本号）⇒ 红", () => {
  const src = readFileSync(COMPONENT, "utf8").replace('class="conv-footer-row flex items-center gap-2 pr-3"', 'class="conv-footer-row flex items-center pr-3"');
  assert.ok(checkFooterLayout(src).some((x) => x.includes("间距")), "缺 gap-* 必须报红");
});

test("反例：版本号允许换行 / 允许被压缩 ⇒ 红", () => {
  const src = readFileSync(COMPONENT, "utf8");
  assert.ok(
    checkFooterLayout(src.replace("whitespace-nowrap ", "")).some((x) => x.includes("whitespace-nowrap")),
    "去掉 whitespace-nowrap 必须报红",
  );
  assert.ok(
    checkFooterLayout(src.replace("min-w-[12ch] shrink-0", "min-w-[12ch]")).some((x) => x.includes("shrink-0")),
    "去掉 shrink-0 必须报红",
  );
});

test("反例：把版本号塞进任务入口按钮里（hover 罩住它）⇒ 红", () => {
  const src = readFileSync(COMPONENT, "utf8");
  // 把 </button> 挪到版本号之后，模拟「版本号在按钮内部」。
  const broken = src.replace("</button>\n        <!-- 版本号", "<!-- 版本号").replace(
    ">{{ appVersion }}</span>\n      </div>",
    ">{{ appVersion }}</span>\n        </button>\n      </div>",
  );
  assert.notEqual(broken, src, "反例构造失败");
  assert.ok(checkFooterLayout(broken).some((x) => x.includes("按钮内部")), "版本号在按钮内必须报红");
});

test("反例：删掉极窄容器的隐藏规则 ⇒ 红", () => {
  const src = readFileSync(COMPONENT, "utf8").replace(/@container[^}]*\}[^}]*\}/s, "");
  assert.ok(checkFooterLayout(src).some((x) => x.includes("容器查询")), "删掉容器查询必须报红");
});
