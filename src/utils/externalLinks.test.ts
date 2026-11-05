import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_LINK_NAME_CHARS,
  classifyRefreshFailure,
  createSingleFlight,
  describeLinkSource,
  isValidExternalUrl,
  summarizeImportPreview,
  validateLinkInput,
} from "./externalLinks.ts";

test("isValidExternalUrl：只接受 http/https 且主机名非空", () => {
  for (const ok of ["http://example.com", "https://example.com/a?b=c", "  https://a.b.c  "]) {
    assert.equal(isValidExternalUrl(ok), true, `应当放行：${ok}`);
  }
  for (const bad of [
    "",
    "   ",
    "example.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "tauri://localhost",
    "https://",
  ]) {
    assert.equal(isValidExternalUrl(bad), false, `必须拒绝：${bad}`);
  }
});

test("validateLinkInput：名称空 / 超长 / 网址非法 / 重复", () => {
  const existing = [{ id: "a", url: "https://a.com" }];
  assert.equal(validateLinkInput({ name: "", url: "https://x.com" }, [], undefined), "name");
  assert.equal(validateLinkInput({ name: "   ", url: "https://x.com" }, [], undefined), "name");
  assert.equal(
    validateLinkInput({ name: "x".repeat(MAX_LINK_NAME_CHARS + 1), url: "https://x.com" }),
    "nameTooLong",
  );
  assert.equal(validateLinkInput({ name: "ok", url: "javascript:alert(1)" }), "url");
  assert.equal(validateLinkInput({ name: "ok", url: "https://a.com" }, existing), "duplicate");
  // 编辑自己那条（exceptId 命中）不算重复
  assert.equal(validateLinkInput({ name: "ok", url: "https://a.com" }, existing, "a"), null);
  assert.equal(validateLinkInput({ name: "ok", url: "https://new.com" }, existing), null);
});

test("createSingleFlight：并发刷新共用同一次请求（去重），结束后可再次发起", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const refresh = createSingleFlight(async () => {
    calls += 1;
    await gate;
    return "ok";
  });
  const p1 = refresh();
  const p2 = refresh();
  const p3 = refresh();
  assert.equal(calls, 1, "连点三下只许发一次请求");
  assert.equal(p1, p2, "并发调用拿到的必须是同一个 promise");
  assert.equal(p2, p3);
  release();
  assert.deepEqual(await Promise.all([p1, p2, p3]), ["ok", "ok", "ok"]);
  await refresh();
  assert.equal(calls, 2, "上一次结束后新一轮要能真的再发");
});

test("classifyRefreshFailure：链接失效 / 网络不可达 / 格式变化分别给具体话术", () => {
  const http = classifyRefreshFailure(
    new Error("code=LINK_DOWNLOAD_HTTP_FAILED 下载失败：HTTP 404"),
  );
  assert.equal(http.key, "links.refreshFail.http");
  assert.equal(http.params?.status, "404");

  for (const code of ["LINK_URL_EMPTY", "LINK_URL_INVALID", "LINK_URL_SCHEME", "LINK_URL_NO_HOST"]) {
    assert.equal(
      classifyRefreshFailure(new Error(`code=${code} 网址不可用`)).key,
      "links.refreshFail.sourceInvalid",
      `${code} 应归到"链接失效"`,
    );
  }

  for (const code of ["LINK_IMPORT_READ_FAILED", "LINK_NETWORK_INIT_FAILED"]) {
    assert.equal(
      classifyRefreshFailure(new Error(`code=${code} 下载失败`)).key,
      "links.refreshFail.network",
      `${code} 应归到"网络不可达"`,
    );
  }

  for (const code of [
    "LINK_IMPORT_JSON_INVALID",
    "LINK_IMPORT_NOT_UTF8",
    "LINK_IMPORT_TOO_LARGE",
  ]) {
    assert.equal(
      classifyRefreshFailure(new Error(`code=${code} 内容不对`)).key,
      "links.refreshFail.format",
      `${code} 应归到"格式变化"`,
    );
  }

  // 未识别的失败也要有可行动作，不能回落成「操作失败」。
  const unknown = classifyRefreshFailure(new Error("ipc boom"));
  assert.equal(unknown.key, "links.refreshFail.unknown");
  assert.ok(unknown.key !== "errors.rule.system");
});

test("describeLinkSource：用户 / 远程 / 文件 / 旧来源四档，未知来源按 user 保护", () => {
  const current = "https://a.example/links.json";
  assert.deepEqual(describeLinkSource("", current), { kind: "user", address: "", stale: false });
  assert.deepEqual(describeLinkSource("user", current), {
    kind: "user",
    address: "",
    stale: false,
  });
  assert.deepEqual(describeLinkSource(`url:${current}`, current), {
    kind: "url",
    address: current,
    stale: false,
  });
  assert.deepEqual(describeLinkSource("url:https://old.example/links.json", current), {
    kind: "url",
    address: "https://old.example/links.json",
    stale: true,
  });
  assert.deepEqual(describeLinkSource("json:backup.json", current), {
    kind: "json",
    address: "backup.json",
    stale: false,
  });
  // 后端未知来源也按 user 保守处理（与 `is_protected_source` 同口径）。
  assert.deepEqual(describeLinkSource("weird:whatever", current), {
    kind: "user",
    address: "",
    stale: false,
  });
});

test("summarizeImportPreview：确认按钮只在三类变更都为空时不可用", () => {
  const empty = summarizeImportPreview({ added: [], updated: [], removed: [] });
  assert.deepEqual(empty, { added: 0, updated: 0, removed: 0, hasChanges: false });
  const counts = summarizeImportPreview({
    added: [{}, {}],
    updated: [{}],
    removed: [{}],
  });
  assert.deepEqual(counts, { added: 2, updated: 1, removed: 1, hasChanges: true });
  assert.equal(
    summarizeImportPreview({ added: [], updated: [], removed: [{}] }).hasChanges,
    true,
    "只有删除也算变更，必须让用户确认",
  );
});

test("LinksList 接线：JSON 导入先预览、确认后才写库；刷新只走 URL 同步", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../components/LinksList.vue"), "utf8");
  const importFn = src.slice(
    src.indexOf("async function importFile"),
    src.indexOf("function closePreview"),
  );
  assert.match(importFn, /previewExternalLinksFile/, "选择文件后必须先取预览");
  assert.doesNotMatch(importFn, /importExternalLinksFile/, "选文件阶段不许直接写库");
  assert.match(importFn, /previewOpen\.value = true/, "预览要交给用户确认");

  const confirmFn = src.slice(
    src.indexOf("async function confirmImportFile"),
    src.indexOf("async function importFromUrl"),
  );
  assert.match(confirmFn, /importExternalLinksFile/, "只有确认函数才允许 apply");
  assert.match(src, /data-probe="links-preview-confirm"/, "确认按钮必须真实存在");
  assert.match(src, /:disabled="!previewCounts\.hasChanges/, "没有变更时不许写库");
  assert.match(src, /links\.previewSummary/, "预览必须写清新增 / 更新 / 删除计数");

  // 刷新块只调 URL 同步，不许夹带文件导入（刷新语义保持「只增改」）。
  const refreshBlock = src.slice(
    src.indexOf("const refreshSource = createSingleFlight"),
    src.indexOf("/** 来源链接可复制"),
  );
  assert.match(refreshBlock, /importExternalLinksFromUrl/);
  assert.doesNotMatch(refreshBlock, /importExternalLinksFile/);
});
