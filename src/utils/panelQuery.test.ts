/**
 * 「只读面板的查询策略」这一族的判据（真实 QueryClient，不 mock 缓存层）。
 *
 * 这根轴的形状：面板打开时拉一份、点刷新再拉一份、失败时别把已有读数换成错误页。
 * 旧实现每个面板各写一遍 `loading`/`failed`/`loadError` + try/finally，
 * 现在由 utils/panelQuery 统一（群文件 / 共享目录 / 搜索 / 诊断快照各占一格）。
 *
 * 这里管两件别处管不到的事：
 *  ① **没有主体可分键的面板**（诊断快照）也要走同一个家 —— 键就是 `["diag", ""]`，
 *     行为与按 id 分键那几格一致（每次重拉、失败保留旧读数、并发合并）；
 *  ② 剩下那些**还没交出去**的手写三件套必须逐格登记（见最后一格），
 *     新增同形即红，免得这根轴悄悄长回第七、第八份抄本。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { afterEach } from "node:test";
import { QueryClient } from "@tanstack/vue-query";
import { PANEL_QUERY_POLICY, panelKey, panelQueryOptions } from "./panelQuery.ts";

// 每个 QueryClient 都挂着 gcTime 定时器；不清掉 node:test 会等它自然到期才退出。
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient();
  clients.push(qc);
  return qc;
};
afterEach(() => {
  for (const qc of clients.splice(0)) qc.clear();
});

const DIAG_KEY = panelKey("diag", "");

test("全局单键面板：键就是 [\"diag\",\"\"]，策略按面板档（每次重拉、只补一次）", () => {
  const opts = panelQueryOptions("diag", "", async () => ({ snap: 1 }));
  assert.deepEqual([...opts.queryKey], ["diag", ""]);
  assert.equal(opts.staleTime, PANEL_QUERY_POLICY.staleTime);
  assert.equal(opts.retry, PANEL_QUERY_POLICY.retry);
  assert.equal(opts.retryDelay, PANEL_QUERY_POLICY.retryDelay);
});

test("重开面板真的再打一次命令（staleTime 0），不是吃缓存占位", async () => {
  const qc = client();
  let calls = 0;
  const opts = panelQueryOptions("diag", "", async () => {
    calls += 1;
    return { snap: calls };
  });
  assert.equal((await qc.fetchQuery(opts)).snap, 1);
  assert.equal((await qc.fetchQuery(opts)).snap, 2);
});

test("刷新失败时旧读数仍在、error 同时可见 —— 面板「只在没有读数时才说读失败」靠这两条同时成立", async () => {
  const qc = client();
  let calls = 0;
  let fail = false;
  const opts = panelQueryOptions("diag", "", async () => {
    calls += 1;
    if (fail) throw new Error("ipc down");
    return { snap: "keep" };
  });
  await qc.fetchQuery(opts);
  assert.equal(calls, 1);

  fail = true;
  calls = 0;
  await assert.rejects(qc.fetchQuery(opts));
  // 正控：这次请求确实发了也确实失败（retry 1 ⇒ 两次尝试），不是"根本没跑所以没变"。
  assert.equal(calls, 2, "失败后的 2 次尝试（retry 1）");

  // 数据侧：旧读数原封不动 ⇒ 有快照时模板不会切成错误页。
  assert.deepEqual(qc.getQueryData(DIAG_KEY), { snap: "keep" });
  // 状态侧：error 是真可见的 ⇒ 首屏失败那一格才有东西可说。
  const query = qc.getQueryCache().find({ queryKey: DIAG_KEY });
  assert.equal(query?.state.status, "error");
  // 反控：换个键取不到那份数据，证明它确实存在 ["diag",""] 这一格而不是碰巧全局可读。
  assert.equal(qc.getQueryData(panelKey("diag", "other")), undefined);
});

// ---------------- 诊断快照的接线（存在性 ≠ 接上了，所以逐件钉） ----------------

const srcRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/+$/, "");
function vueFiles(dir = srcRoot): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...vueFiles(p));
    else if (e.name.endsWith(".vue")) out.push(p);
  }
  return out;
}
const rel = (p: string) => p.slice(srcRoot.length + 1);
const diagSource = readFileSync(`${srcRoot}/components/DevDiagPanel.vue`, "utf8");

test("诊断快照交给 Query：没有手写 loading/loadError，也不再 onMounted 自己拉", () => {
  assert.match(diagSource, /from "@tanstack\/vue-query"/);
  assert.match(diagSource, /panelQueryOptions<DiscoveryDiag>\("diag", ""/);
  assert.doesNotMatch(diagSource, /^const (loading|loadError|diag) = ref\(/m);
  assert.doesNotMatch(diagSource, /onMounted/);
  assert.doesNotMatch(diagSource, /finally\s*\{/);
  // 反向钉：刷新按钮仍然走 refetch（不是只剩一个空函数）。
  assert.match(diagSource, /void diagQuery\.refetch\(\)/);
});

test("诊断快照的三态口径没在迁移里改掉：先内容、再加载、最后才说读失败", () => {
  // 错误可见性这条业务口径（有旧快照就不说"读失败"）是从旧实现原样搬过来的。
  assert.match(diagSource, /diagQuery\.error\.value && !diag\.value/);
  const iData = diagSource.indexOf('v-if="diag"');
  const iLoading = diagSource.indexOf('v-else-if="loading"');
  const iError = diagSource.indexOf('v-else-if="loadError"');
  assert.ok(iData > 0 && iLoading > iData && iError > iLoading, "v-if / v-else-if 的顺序就是这三态的优先级");
});

// ---------------- 外部链接的接线（读 + 写共用一个键，§6.98） ----------------

const linksSource = readFileSync(`${srcRoot}/components/LinksList.vue`, "utf8");

test("外部链接读侧交给 Query：键 [\"links\",\"\"]，没有手写 loading/loadError、也不再自己 onMounted 拉", () => {
  assert.match(linksSource, /panelQueryOptions<ExternalLink\[\]>\("links", ""/);
  assert.doesNotMatch(linksSource, /^const (links|loading|loadError|saving) = ref\(/m);
  assert.doesNotMatch(linksSource, /onMounted/);
  // `finally` 不再作为“手写读侧”的代称：JSON 导入/导出也要在取消/失败时收 busy 状态，
  // 真正的读侧判据是上面那条 panelQueryOptions + 没有手写 loading/loadError。
});

test("外部链接写侧：三条写命令共用一枚 mutation，成功时把返回的整份数组写回同一个键", () => {
  assert.match(linksSource, /useMutation\(/);
  // 键必须从 panelQuery 那个家现算，不许在写侧手抄一份 ["links",""]。
  assert.match(linksSource, /setQueryData\(panelKey\("links", ""\), data\)/);
  // 三条命令都得真接线（少一条就是把某条写路径留在旧实现里）。
  for (const fn of ["addExternalLink", "updateExternalLink", "removeExternalLink"]) {
    assert.match(linksSource, new RegExp(`api\\.${fn}\\(`), `${fn} 没接线`);
  }
  // 写失败仍按三条各自的话术报（旧实现的三种失败提示没有被合并成一句）。
  for (const k of ["links.addFail", "links.updateFail", "links.removeFail"]) {
    assert.ok(linksSource.includes(k), `${k} 丢了`);
  }
  // saving 来自库的 isPending，不是第二枚手写布尔。
  assert.match(linksSource, /const saving = computed\(\(\) => writeLink\.isPending\.value\)/);
});

// ---------------- 存量登记册（新增同形即红） ----------------

/** 手写「面板加载三件套」的签名：这三枚名字任一一枚以 ref 形式声明在组件顶层。 */
const HAND_ROLLED = /^const (loading|failed|loadError) = ref\(/m;

/**
 * 逐格判定（判完才允许留在册子里，别当默认豁免读）：
 * · AddFriendModal  —— `loading` 是**提交在飞**（写操作，不是读面板）；
 * · FavoritePanel   —— 数据家是 Pinia `chat.refreshFavorites()`，交给 Query 会造出第二个状态源；
 * · GroupTodosWindow—— 群任务台账是事件驱动的业务状态机（INV-P29 编号规则同源），不是纯读快照；
 * · LogViewer       —— 2s 轮询 + `document.hidden` 闸门 + 「有旧内容不报失败」，
 *                      已由 §6.79 钉过运行时候选，换 Query 要重测那一整族读数（暂缓替换）；
 * · TodoImageThumb  —— 取字节 + 失败向对端拉 + 排期重试，重试语义是业务的（保留自研）。
 *
 * LinksList 已迁走（§6.98）：读侧 `["links",""]` 走 panelQuery，三条写命令共用一个
 * `useMutation`，成功时把后端返回的整份数组 `setQueryData` 回同一个键 ⇒ 不再是手写抄本。
 */
const REGISTERED = [
  "components/AddFriendModal.vue",
  "components/FavoritePanel.vue",
  "components/GroupTodosWindow.vue",
  "components/LogViewer.vue",
  "components/TodoImageThumb.vue",
];

test("手写加载状态只剩这 5 格，且每格都有登记的理由；新增同形即红", () => {
  const files = vueFiles();
  // 分母下限：量具真扫到了整个 components/，不是路径写错扫了个空。
  assert.ok(files.length >= 80, `扫描到的 .vue 只有 ${files.length} 个`);
  const hits = files.filter((f) => HAND_ROLLED.test(readFileSync(f, "utf8"))).map(rel).sort();
  assert.deepEqual(hits, [...REGISTERED].sort(), `多出来的抄本：${hits.filter((h) => !REGISTERED.includes(h))}`);
  // 每一格都得在册子里给得出理由（防止"登记了名字但没人知道为什么"）。
  for (const r of REGISTERED) assert.ok(hits.includes(r), `${r} 已经不在这根轴上了，把它的登记一起删掉`);

  // 正控：迁移前的 DevDiagPanel 就是这个形状，量具抓得住它。
  assert.ok(
    HAND_ROLLED.test('const diag = ref(null);\nconst loading = ref(false);\nconst loadError = ref("");'),
    "签名认不出旧形状 ⇒ 这一格是在测空气",
  );
  // 反控：迁给 Query 之后的写法（computed 派生）不算抄本。
  assert.ok(
    !HAND_ROLLED.test('const loading = computed(() => q.isFetching.value);\nconst loadError = computed(() => "");'),
  );
});
