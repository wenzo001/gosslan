// App 内那一格（A8）的页内单元：在**真 WKWebView** 里挂**真 `ChatWindow` + 真 store**，
// 用 `scrollhist` 那套 seed（600 条历史、每页 100 条、`getMessages` 走桩）跑三件事：
//   ③ 连翻三页，每页前插后"正在读的那一行"是否还在原位（同 key 且 |Δoffset| ≤ 2px）；
//   B/C 两个方向的快速滚动有没有空白带。
//
// ⚠️ 这个文件**不能单独注入**：它依赖 `window.__probe`（探针页内夹具 `PAGE_FIXTURE`，约 83KB）。
// `perf/wk-a8app.mjs` 会在运行时从 `scripts/check-ui-runtime.mjs` 里把 `PAGE_FIXTURE` 原样抽出来、
// 与本文件拼成一份再交给宿主 —— 只维护一份事实源，不在这里抄第二份。
(() => {
  const report = new URLSearchParams(location.search).get("report") || "";
  const send = (o) => {
    if (!report) return;
    const img = new Image();
    img.src = report + (report.includes("?") ? "&" : "?") + "r=" + encodeURIComponent(JSON.stringify(o));
  };
  const engine = () => ({
    ua: navigator.userAgent.slice(0, 120),
    vendor: navigator.vendor,
    // WKWebView 的 UA 里没有 `Safari/` 段 ⇒ 这两个标记要分开，混用会把宿主判错。
    safari: /Safari\//.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent),
    wkwebview: /AppleWebKit\//.test(navigator.userAgent) && !/Safari\//.test(navigator.userAgent),
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

  const out = { engine: engine(), stage: "boot" };

  function makeRows(limit, offset) {
    const rows = [];
    for (let i = 0; i < limit; i += 1) {
      const seq = offset + i + 1;
      if (seq < 1 || seq > 600) continue;
      const kind = seq % 7 === 0 ? "todo" : seq % 5 === 0 ? "file" : seq % 9 === 0 ? "code" : "text";
      let content;
      if (kind === "todo") {
        content = JSON.stringify({ todo_id: "h-todo-" + seq, number: seq, title: "任务" + seq,
          assignees: ["dev-me"], status: "todo", creator: "dev-me", deleted: false,
          description: "一行描述", images: [], archived: false, done_at: null });
      } else if (kind === "file") {
        content = JSON.stringify({ name: "h" + seq + ".bin", path: "/tmp/h" + seq + ".bin", size: 1000 });
      } else if (kind === "code") {
        content = "const h" + seq + " = " + seq + ";";
      } else {
        content = ("第" + seq + "条历史，把列表撑长。").repeat(4);
      }
      rows.push({ id: seq, msg_id: "m-hist-" + seq, local_id: "m-hist-" + seq, conv_id: "group:hist",
        sender_id: "dev-me", sender_name: "我", receiver_id: "hist", kind, content,
        status: "sent", seq, ts: 1700000000000 + seq * 1000 });
    }
    return rows;
  }

  (async () => {
    try {
      // Tauri IPC 桩：与 `scripts/check-ui-runtime.mjs` 各段用的那一份同形。
      // 少这一步，`ChatWindow` 一 onMounted 就会在 `getCurrentWindow()` 上抛异常（真机不会，它有真 IPC）。
      window.__TAURI_INTERNALS__ = {
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
        invoke: async () => null,
        transformCallback: (cb) => cb,
        convertFileSrc: (p) => p,
      };
      if (!window.__TAURI_EVENT_PLUGIN_INTERNALS__) {
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      }

      out.stage = "install";
      const mounted = await window.__probe.install("/src/components/ChatWindow.vue", "", '{"hostHeight":"900px"}');
      if (!mounted || mounted.ok !== true) {
        out.error = "install 失败：" + JSON.stringify(mounted).slice(0, 200);
        return send(out);
      }
      window.__probe.seedDevice("dev-me");

      out.stage = "seed";
      const { useChatStore } = await import("/src/stores/useChatStore.ts");
      const api = (await import("/src/api/index.ts")).api;
      const chat = useChatStore();
      const conv = "group:hist";
      api.getMessageCount = async () => 600;
      api.getMessages = async (_c, limit, offset) => makeRows(limit, offset);
      chat.activeConv = conv;
      chat.messages[conv] = makeRows(100, 500);
      await sleep(1000);

      const el = document.querySelector(".vlist-no-anchor");
      if (!el) {
        out.error = "找不到 .vlist-no-anchor（ChatWindow 没挂起来？）";
        return send(out);
      }
      out.seed = { len: (chat.messages[conv] || []).length, scrollH: el.scrollHeight, clientH: el.clientHeight };
      if (!(el.scrollHeight > el.clientHeight + 400)) {
        out.error = "种子没撑出可滚区域";
        return send(out);
      }

      // ---------- ③ 连翻三页：每页前插后，正在读的那一行还在不在原位 ----------
      // 起手**不能贴顶**：scrollTop<60 会让应用自己每帧 emit loadMore。从"离底 1200px"起手。
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 1200);
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
      const settle = async (maxMs = 1500) => {
        const t0 = performance.now();
        let lastTop = -1;
        let stable = 0;
        while (performance.now() - t0 < maxMs) {
          await frame();
          const t = el.scrollTop;
          if (Math.abs(t - lastTop) < 0.5) stable += 1; else stable = 0;
          lastTop = t;
          if (stable >= 5) break;
        }
        return +(performance.now() - t0).toFixed(1);
      };
      await settle(1200);
      const readRows = () => {
        const cr = el.getBoundingClientRect();
        return [...el.querySelectorAll("[data-vlist-key]")].map((n) => {
          const r = n.getBoundingClientRect();
          return { key: n.getAttribute("data-vlist-key"), top: +(r.top - cr.top).toFixed(2),
            bottom: +(r.bottom - cr.top).toFixed(2) };
        }).sort((a, b) => a.top - b.top);
      };
      const readAnchor = (rows) => {
        const hit = rows.find((r) => r.bottom > 0.5) ?? rows[0];
        return hit ? { key: hit.key, offset: hit.top } : null;
      };

      out.stage = "prepend";
      const steps = [];
      for (let k = 0; k < 3; k += 1) {
        const before = readAnchor(readRows());
        const len0 = (chat.messages[conv] || []).length;
        await chat.loadMoreMessages(conv);
        const settleMs = await settle();
        const rows1 = readRows();
        const after = readAnchor(rows1);
        const kept = before ? rows1.find((r) => r.key === before.key) : null;
        steps.push({
          settleMs, len0, len1: (chat.messages[conv] || []).length,
          before, after,
          keptKey: !!kept,
          drift: kept && before ? +(kept.top - before.offset).toFixed(2) : null,
        });
        await sleep(250);
      }
      out.prepend = steps;

      // ---------- B/C 两格扫描：空白带检测（与 perf/wk-check.html 同一口径） ----------
      const covered = (s) => {
        const cr = s.getBoundingClientRect();
        const hgt = s.clientHeight;
        const iv = [...s.querySelectorAll("[data-vlist-key]")]
          .map((r) => { const b = r.getBoundingClientRect(); return [Math.max(0, b.top - cr.top), Math.min(hgt, b.bottom - cr.top)]; })
          .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
        let total = 0; let cur = 0;
        for (const [a, b] of iv) { if (b <= cur) continue; total += Math.max(0, b - Math.max(a, cur)); cur = Math.max(cur, b); }
        // 底部留白（`pb-6`）不算空白：与 wk-check.html 同口径，用滚动容器自身的内边距扣掉。
        return Math.max(0, hgt - 0 - total);
      };
      const sweep = async (dir) => {
        const s = el;
        s.scrollTop = dir > 0
          ? Math.floor((s.scrollHeight - s.clientHeight) * 0.25)
          : Math.floor((s.scrollHeight - s.clientHeight) * 0.75);
        await sleep(400); await frame();
        const gaps = []; let blank = 0; let maxBlank = 0; let last = performance.now();
        for (let i = 0; i < 40; i += 1) {
          s.scrollTop = Math.max(0, s.scrollTop + dir * 250);
          await frame();
          const b = covered(s);
          if (b > 1) { blank += 1; maxBlank = Math.max(maxBlank, b); }
          const now = performance.now(); gaps.push(now - last); last = now;
        }
        gaps.sort((x, y) => x - y);
        return { blankFrames: blank, maxBlank: Math.round(maxBlank),
          p50: +gaps[Math.floor(gaps.length / 2)].toFixed(1), max: +gaps[gaps.length - 1].toFixed(1),
          long50: gaps.filter((g) => g > 50).length };
      };
      out.stage = "sweep-down";
      out.down = await sweep(1);
      out.stage = "sweep-up";
      out.up = await sweep(-1);
      out.stage = "done";
      send(out);
    } catch (e) {
      out.error = String((e && e.stack) || e).slice(0, 400);
      send(out);
    }
  })();
})();
