// 压测前断言：虚拟化是否真的生效（渲染行数 << 总数、clientHeight 明显小于 scrollHeight）。
// 用法：node perf/probe.mjs 9224
const CDP_PORT = process.argv[2] ?? "9223";
const CDP = `http://127.0.0.1:${CDP_PORT}`;
const list = await (await fetch(`${CDP}/json`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("vlist.html"));
if (!page) throw new Error("找不到 vlist.html 目标页");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) (pending.get(m.id)(m), pending.delete(m.id));
});
await new Promise((r) => ws.addEventListener("open", r));
const evalJs = (expression) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    pending.set(mid, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result?.result?.value)));
  });

for (let i = 0; i < 40; i++) {
  if (await evalJs("!!window.__perf")) break;
  await new Promise((r) => setTimeout(r, 500));
}
const probe = await evalJs(`(() => {
  const el = document.querySelector("#perf-root .overflow-y-auto");
  const rows = el ? el.querySelectorAll("[data-vlist-key]").length : -1;
  return { n: window.__perf?.n, renderedRows: rows, clientHeight: el?.clientHeight, scrollHeight: el?.scrollHeight,
           virtualizationOK: rows > 0 && rows < 200 };
})()`);
console.log(JSON.stringify(probe, null, 2));
ws.close();
