/**
 * 启动守卫（**内联**进每个窗口的 HTML，必须早于任何模块脚本）。
 *
 * 为什么不能放进 TS：`main.ts` 的静态 import 图会在它自己的代码之前求值；
 * 等到 `main.ts` 里注册 error 监听就晚了 —— 模块求值期的异常会留下一个
 * 永远不撤的骨架（用户看到的就是"打开后一直正在启动…"）。
 *
 * 这一层只用原生 DOM 与内联样式，不依赖 i18n / CSS / Vue：它是最后一道兜底。
 * `boot.ts` 能加载时，会用更好看、带 i18n 的错误卡覆盖它，并置 `__gosslan_app_ready`。
 */
(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }
  function capture(kind, detail) {
    if (!window.__gosslan_boot_error) {
      window.__gosslan_boot_error = { kind: kind, detail: String(detail || ""), at: Date.now() };
    }
  }
  window.addEventListener("error", function (e) {
    var where = e && e.filename ? e.filename + ":" + e.lineno + ":" + e.colno : "(unknown)";
    capture("error", (e && e.message ? e.message : "error") + " @ " + where);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    var text = r && r.stack ? String(r.message) + "\n" + r.stack : String(r);
    capture("rejection", text);
  });

  window.__gosslan_fail_boot = function (kind, detail) {
    if (window.__gosslan_boot_failed) return;
    window.__gosslan_boot_failed = true;
    var el = document.querySelector(".boot-skeleton");
    if (!el) return;
    el.classList.remove("boot-hide");
    el.setAttribute("aria-hidden", "false");
    el.innerHTML =
      '<div style="max-width:560px;margin:12vh auto 0;padding:20px 22px;border:1px solid #d64545;border-radius:14px;background:#fff;color:#1b1b1f;font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.18)">' +
      '<div style="font-weight:700;font-size:16px;color:#d64545">界面没有启动起来 · The UI failed to start</div>' +
      '<p style="margin:10px 0 0">启动时发生错误（UI_BOOT_FAILED）。可以先重新加载；如果反复出现，请复制错误信息发给我们。</p>' +
      '<pre style="margin:10px 0 0;padding:8px;background:#f4f4f6;border-radius:8px;white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:180px;overflow:auto">' +
      esc(kind) + ": " + esc(detail) +
      "</pre>" +
      '<div style="display:flex;gap:8px;margin-top:12px">' +
      '<button id="gosslan-boot-reload" style="padding:6px 12px;border:1px solid #ccc;border-radius:8px;background:#f4f4f6;cursor:pointer">重新加载 · Reload</button>' +
      '<button id="gosslan-boot-copy" style="padding:6px 12px;border:1px solid #ccc;border-radius:8px;background:#f4f4f6;cursor:pointer">复制错误 · Copy</button>' +
      "</div></div>";
    var reload = document.getElementById("gosslan-boot-reload");
    if (reload) reload.onclick = function () { location.reload(); };
    var copy = document.getElementById("gosslan-boot-copy");
    if (copy) copy.onclick = function () {
      var text = kind + ": " + detail;
      try { navigator.clipboard.writeText(text); } catch (e) {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e2) {}
        ta.remove();
      }
    };
  };

  // 模块脚本完全没跑起来（或 app 从未挂载）时，10s 后给出可见错误。
  // 5s 那条在 boot.ts 里（更早、带 i18n）；这条只负责"连 boot.ts 都没跑起来"。
  window.setTimeout(function () {
    if (window.__gosslan_app_ready || window.__gosslan_boot_failed) return;
    var app = document.getElementById("app");
    if (app && app.childElementCount > 0) return;
    var err = window.__gosslan_boot_error;
    window.__gosslan_fail_boot(
      "timeout",
      err ? err.kind + ": " + err.detail : "UI_READY_TIMEOUT",
    );
  }, 10000);
})();
