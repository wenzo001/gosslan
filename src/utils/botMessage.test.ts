/**
 * 机器人消息渲染的判据：外部正文是不可信输入 ⇒ 渲染链路的每一条边界都要钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOT_MESSAGE_ALLOWED_TAGS,
  botMessageToHtml,
  capBotMessageText,
  normalizeBotFormat,
} from "./botMessage.ts";

test("格式归一化：只认 markdown/md，其余按纯文本（不猜）", () => {
  assert.equal(normalizeBotFormat("markdown"), "markdown");
  assert.equal(normalizeBotFormat("MD"), "markdown");
  assert.equal(normalizeBotFormat("text"), "text");
  assert.equal(normalizeBotFormat("html"), "text");
  assert.equal(normalizeBotFormat(""), "text");
  assert.equal(normalizeBotFormat(null), "text");
  assert.equal(normalizeBotFormat(undefined), "text");
});

test("纯文本：尖括号当字面量，不当标签渲染", () => {
  const html = botMessageToHtml("<b>粗</b> <script>alert(1)</script>", "text");
  assert.ok(html.includes("&lt;b&gt;"), "纯文本里的标签必须被转义");
  assert.ok(!html.includes("<script"), "纯文本里不许出现脚本标签");
  assert.ok(!html.includes("<b>"), "纯文本不许被渲染成粗体");
});

test("Markdown：结构化元素真的渲染出来（标题/列表/表格/代码块）", () => {
  const html = botMessageToHtml(
    "# 标题\n\n- 一\n- 二\n\n| 项 | 结果 |\n| --- | --- |\n| 测试 | 通过 |\n\n```\ncode\n```",
    "markdown",
  );
  assert.ok(html.includes("<h1"), "标题要渲染");
  assert.ok(html.includes("<li"), "列表要渲染");
  assert.ok(html.includes("<table"), "表格要渲染");
  assert.ok(html.includes("<code"), "代码块要渲染");
  assert.ok(html.includes("标题"), "正文文字要保留");
});

test("Markdown：外部内容里的脚本/事件属性/远程图片一律不进 DOM", () => {
  const html = botMessageToHtml(
    '<script>alert(1)</script>\n\n<img src="https://evil.example/x.png">\n\n[x](javascript:alert(1))\n\n<span onclick="alert(1)">点</span>',
    "markdown",
  );
  assert.ok(!html.includes("<script"), "脚本必须被消毒");
  assert.ok(!html.includes("onclick"), "事件属性必须被消毒");
  assert.ok(!html.includes("<img"), "远程图片不许自动加载（图片走附件通道）");
  assert.ok(!html.includes("javascript:"), "javascript: 链接必须被挡");
});

test("白名单里没有 img/style（图片与内联样式都不许）", () => {
  assert.ok(!BOT_MESSAGE_ALLOWED_TAGS.includes("img"));
  assert.ok(!BOT_MESSAGE_ALLOWED_TAGS.includes("style"));
  // 表格与代码块要**在**白名单里（全格式的要求）
  assert.ok(BOT_MESSAGE_ALLOWED_TAGS.includes("table"));
  assert.ok(BOT_MESSAGE_ALLOWED_TAGS.includes("pre"));
  assert.ok(BOT_MESSAGE_ALLOWED_TAGS.includes("code"));
});

test("超长正文截断（不留无声吞掉的痕迹）", () => {
  const long = "x".repeat(40_000);
  const out = capBotMessageText(long);
  assert.ok(out.length < long.length);
  assert.ok(out.endsWith("…"), "截断要留下可辨认的省略号");
  assert.equal(capBotMessageText("短"), "短");
});

test("空正文渲染成空串（界面据此不画正文区）", () => {
  assert.equal(botMessageToHtml("", "markdown"), "");
  assert.equal(botMessageToHtml("   ", "markdown"), "");
  assert.equal(botMessageToHtml(null, "markdown"), "");
});

// ---------------- 后台轮询：通知要能自动进来（2026-11-16） ----------------

test("机器人消息能自动进来：后端有轮询 worker，前端订阅它的刷新事件", () => {
  // `src/utils` ⇒ 上两级是仓库根；`src` 是源码根。
  const repoRoot = join(import.meta.dirname, "..", "..");
  const srcRoot = join(repoRoot, "src");
  const read = (p: string) => readFileSync(join(srcRoot, p), "utf8");

  // ① 后端：worker 存在 + 已接线。
  const bots = readFileSync(join(repoRoot, "src-tauri", "src", "commands", "bots.rs"), "utf8");
  assert.ok(
    bots.includes("pub fn spawn_bot_poller("),
    "没有后台轮询 worker ⇒ 外部发的通知不会自动进来（用户得手动点「立即取件」）",
  );
  const lib = readFileSync(join(repoRoot, "src-tauri", "src", "lib.rs"), "utf8");
  assert.ok(
    lib.includes("commands::spawn_bot_poller(&state);"),
    "轮询 worker 没在 setup 里启动",
  );

  // ② 前端：订阅事件 ⇒ 收件箱会刷新。
  const api = read("api/index.ts");
  assert.ok(
    api.includes('listen<{ bot_id?: string; count?: number }>("bot-inbox-updated"'),
    "前端没有订阅 bot-inbox-updated ⇒ 收件箱不会自动刷新",
  );
  const panel = read("components/settings/BotSection.vue");
  assert.ok(
    panel.includes("api.onBotInboxUpdated("),
    "机器人面板没有订阅轮询事件",
  );
  assert.ok(
    panel.includes("createInitScope()"),
    "订阅↔卸载必须走 initScope（不许手工卸载句柄）",
  );

  // ③ 系统通知只给摘要，不放正文（外部内容不可信）。
  const notif = read("stores/chat/notifications.ts");
  assert.ok(
    notif.includes('t("bot.notifyBody", { n: count })'),
    "系统通知必须走「只给条数」的摘要文案",
  );
  assert.ok(
    !notif.includes("entry.text"),
    "系统通知里不许带机器人正文（正文是外部来的不可信内容）",
  );
});
