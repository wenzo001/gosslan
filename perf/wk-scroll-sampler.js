/**
 * WKWebView 真机滚动采样器（2026-10-27）。
 *
 * 用途：解锁计划里的 A8 —— 在 **macOS 出货渲染器（WKWebView）** 上量"切会话 / 向上翻历史 / 停稳后"
 * 三格的真实读数。WKWebView 没有 CDP，所以脚本是**粘进 Safari Web Inspector 控制台**跑的；
 * 读数走现成的前端日志出口（`log_frontend_error` → Rust 日志），单行 2000 字上限 ⇒ 只发摘要。
 *
 * 使用方法（详见计划文档 §A8 运行手册）：
 *   1. 起 debug 版 Gosslan（`src-tauri/target/debug/gosslan`；debug 构建默认 `isInspectable(true)`）；
 *   2. Safari → 开发 → 本机 → Gosslan 页面 → 控制台，把**整个文件**粘进去；
 *   3. `__wk.start()` → 用触控板做一格操作 → `__wk.stop('switch')`；
 *      每次 stop 会打印摘要并把同一份摘要写进应用日志（`kind = "scroll"`）。
 *   4. 三格都做完后 `__wk.flush()` 汇总成一行再发（可选）。
 *
 * 诚实边界：headless 那套"动画时钟不推帧"的问题在真窗口不存在，所以这里**读 computed opacity**
 * 是有意义的；但 1 帧级别的像素闪现仍然只能人眼看 —— 本器只报几何与可见性时长。
 */
(() => {
  "use strict";

  const RING = [];
  const EL = () => document.querySelector(".vlist-no-anchor");
  const padBottom = () => {
    const el = EL();
    return el ? parseFloat(getComputedStyle(el).paddingBottom) || 0 : 0;
  };
  const coveredLen = (iv) => {
    let total = 0;
    let cur = 0;
    for (const [a, b] of iv) {
      if (b <= cur) continue;
      total += Math.max(0, b - Math.max(a, cur));
      cur = Math.max(cur, b);
    }
    return total;
  };

  let running = false;
  let frames = [];

  const sample = () => {
    const el = EL();
    if (!el) return { list: 0, rows: 0, blank: 0, op: 0, top: 0, hidden: true, aKey: "", aTop: 0 };
    const cr = el.getBoundingClientRect();
    const h = el.clientHeight;
    const rs = [...el.querySelectorAll("[data-vlist-key]")]
      .map((n) => {
        const r = n.getBoundingClientRect();
        return { key: n.getAttribute("data-vlist-key") || "",
          top: Math.max(0, r.top - cr.top), bottom: Math.min(h, r.bottom - cr.top) };
      })
      .filter((r) => r.bottom > r.top)
      .sort((a, b) => a.top - b.top);
    const anchor = rs.find((r) => r.bottom > 1) || rs[0] || null;
    return {
      list: 1,
      rows: rs.length,
      // 容器自带 pb-6 ⇒ 贴底时最后一行下方本来就有 24px，扣掉它才是"真空白"
      blank: Math.max(0, h - padBottom() - coveredLen(rs.map((r) => [r.top, r.bottom]))),
      op: +(parseFloat(getComputedStyle(el).opacity) || 0).toFixed(3),
      hidden: el.classList.contains("opacity-0"),
      skel: document.querySelectorAll(".animate-pulse").length,
      top: +el.scrollTop.toFixed(1),
      aKey: anchor ? anchor.key : "",
      aTop: anchor ? +anchor.top.toFixed(2) : 0,
    };
  };

  const summarise = () => {
    if (!frames.length) return { frames: 0 };
    let visibleBlankMs = 0;
    let blankFrames = 0;
    let maxBlank = 0;
    let jumpFrames = 0;
    let maxJump = 0;
    for (let i = 0; i < frames.length; i += 1) {
      const f = frames[i];
      const dt = i ? frames[i].t - frames[i - 1].t : 0;
      if (f.op < 0.99 || f.blank > 1) visibleBlankMs += dt;
      if (f.blank > 1) {
        blankFrames += 1;
        maxBlank = Math.max(maxBlank, f.blank);
      }
      if (i === 0) continue;
      const p = frames[i - 1];
      // "我正读的那一行在手指底下动了" —— 与 scrollTop 的变化抵消后仍非零才算跳
      if (f.aKey && f.aKey === p.aKey) {
        const jump = (f.aTop - p.aTop) + (f.top - p.top);
        if (Math.abs(jump) > 2) {
          jumpFrames += 1;
          maxJump = Math.max(maxJump, Math.abs(jump));
        }
      }
    }
    const gaps = [];
    for (let i = 1; i < frames.length; i += 1) gaps.push(frames[i].t - frames[i - 1].t);
    gaps.sort((a, b) => a - b);
    const q = (x) => (gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * x))].toFixed(1) : null);
    return {
      frames: frames.length,
      ms: Math.round(frames[frames.length - 1].t - frames[0].t),
      visibleBlankMs: Math.round(visibleBlankMs),
      blankFrames,
      maxBlank: Math.round(maxBlank),
      jumpFrames,
      maxJump: Math.round(maxJump),
      frameP50: q(0.5),
      frameP95: q(0.95),
      frameMax: gaps.length ? +gaps[gaps.length - 1].toFixed(1) : null,
      longFrames: gaps.filter((g) => g > 50).length,
      moved: Math.round(frames[frames.length - 1].top - frames[0].top),
      hiddenFrames: frames.filter((f) => f.hidden).length,
      transparentFrames: frames.filter((f) => f.op < 0.99).length,
      vis: { state: document.visibilityState, focused: document.hasFocus() },
    };
  };

  const emit = (kind, text) => {
    // 单行 2000 字上限（settings.rs:239）⇒ 只发摘要；失败就只在控制台留一份
    const payload = String(text).slice(0, 1800);
    try {
      if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {
        void window.__TAURI_INTERNALS__.invoke("log_frontend_error", { kind, text: payload });
        return true;
      }
    } catch (e) {
      console.warn("[__wk] invoke 失败：", e && e.message);
    }
    return false;
  };

  window.__wk = {
    start() {
      frames = [];
      running = true;
      const loop = (t) => {
        if (!running) return;
        const s = sample();
        s.t = t;
        frames.push(s);
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      return "sampling…";
    },
    stop(label) {
      running = false;
      const out = Object.assign({ label: label || "run" }, summarise());
      RING.push(out);
      const line = JSON.stringify(out);
      console.log("[__wk] " + line);
      const ok = emit("scroll", line);
      console.log("[__wk] 已写入应用日志 = " + ok + (ok ? "" : "（invoke 不可用，请手工复制上面那行）"));
      return out;
    },
    flush() {
      const line = JSON.stringify({ all: RING });
      console.log("[__wk] " + line);
      const ok = emit("scroll-summary", line);
      console.log("[__wk] 汇总已写入应用日志 = " + ok);
      return ok;
    },
    peek() {
      return sample();
    },
    clear() {
      RING.length = 0;
      frames = [];
      return "cleared";
    },
    /** 自检：证明读数不是恒 0（把一条行藏掉，blank 必须涨）。 */
    selfCheck() {
      const el = EL();
      if (!el) return { ok: false, why: "no scroller" };
      const before = sample();
      const row = el.querySelector("[data-vlist-key]");
      if (!row) return { ok: false, why: "no row" };
      const prev = row.style.visibility;
      row.style.visibility = "hidden";
      const hidden = sample();
      row.style.visibility = prev;
      const after = sample();
      return { ok: hidden.blank > before.blank + 1 && after.blank <= before.blank + 1,
        before: Math.round(before.blank), hidden: Math.round(hidden.blank), after: Math.round(after.blank) };
    },
  };

  console.log("[__wk] 装好了。selfCheck() 先自证，再 start()/stop('switch')。");
})();
