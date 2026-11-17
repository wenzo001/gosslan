/**
 * 外部分享到会话的**接线判据**：入口 → 分派 → 队列 → 命令 → 门面 → 面板 → 发送。
 *
 * 为什么需要它：这条链路跨 7 个文件，断在任何一段的表现都是「点了分享链接什么也没发生」
 * —— 没有报错、没有日志，只有用户反复点。本仓反复踩过同一形状（"注释里写着跑、底下没跑"），
 * 所以每一段都按**源码形状**钉一次，而不是靠人工读一遍。
 *
 * 判据只读文本，不执行任何代码；每条都配了会在改坏时变红的锚点（见注释里的"拆掉会怎样"）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("后端：命令已注册，且命令层与协议核心各只有一个家", () => {
  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /commands::share_get_pending,/, "命令没注册 ⇒ 前端 invoke 必然 reject");
  assert.match(lib, /commands::share_dismiss,/, "命令没注册 ⇒ 前端 invoke 必然 reject");

  const commands = read("src-tauri/src/commands.rs");
  assert.match(
    commands,
    /include!\("commands\/external_share\.rs"\);/,
    "命令文件没被 include 进 commands 模块 ⇒ 整个文件是死代码",
  );

  // 解析逻辑只许有一个家：命令层再写一份解析 = 两套口径（一边拒一边放）。
  const cmd = read("src-tauri/src/commands/external_share.rs");
  assert.match(cmd, /sh::parse_share_intent\(/, "命令层必须走协议核心的解析，不许自己解析");
  assert.doesNotMatch(cmd, /Url::parse\(/, "命令层出现了第二处 URL 解析 ⇒ 口径会分叉");

  const core = read("src-tauri/src/share.rs");
  assert.match(core, /pub fn admit\(/, "去重/限额必须收在协议核心里");
});

test("后端：三处深链入口全部走 route_deep_link，不许有绕过分派器的直连", () => {
  const lib = read("src-tauri/src/lib.rs");
  const routed = (lib.match(/commands::route_deep_link\(/g) ?? []).length;
  // 三个入口：单实例转发 / on_open_url / 冷启动 argv。
  assert.equal(
    routed,
    3,
    `深链分派点应为 3 处（单实例 / on_open_url / 冷启动），实际 ${routed} 处 —— 少一处就有入口收不到分享`,
  );
  // 拆掉会怎样：把任一处改回直接 `spawn_device_auth_link`，分享链接会被当成授权链接去报错。
  assert.match(lib, /crate::share::share_link_from_args\(/, "argv 侧没有分享识别 ⇒ 冷启动/单实例收不到");
});

test("前端：门面四条入口齐全（两条命令 + 两个事件）", () => {
  const api = read("src/api/index.ts");
  for (const [sig, why] of [
    ['invoke<SharePrompt | null>("share_get_pending")', "冷启动补拉入口缺失 ⇒ 进程起来前的分享永远看不到"],
    ['invoke<boolean>("share_dismiss", { shareId })', "清理入口缺失 ⇒ 队列满之后再也收不到新分享"],
    ['listen<SharePrompt>("share-request"', "事件监听缺失 ⇒ 运行中到达的分享不弹面板"],
    ['listen<string>("share-error"', "失败监听缺失 ⇒ 坏链接静默失败，用户只会反复点"],
  ] as const) {
    assert.ok(api.includes(sig), `${why}（缺 ${sig}）`);
  }
});

test("前端：面板挂在主窗壳上，且发送走既有 send 通道", () => {
  const app = read("src/App.vue");
  assert.match(app, /<SharePanel \/>/, "面板没挂上去 ⇒ 事件到了也没人渲染");

  const panel = read("src/components/SharePanel.vue");
  // 拆掉会怎样：改成 `invoke("send_message")` 就绕过了乐观上屏/台账/失败态那一层。
  assert.match(panel, /chat\.send\(/, "发送必须复用既有统一发送路径");
  assert.doesNotMatch(panel, /\binvoke\(/, "面板里不许裸 invoke：那是第二条发送通道");
  // 关闭 = 什么都不发：关闭路径不得调用发送。
  const closeBlock = panel.slice(panel.indexOf("async function onClose"), panel.indexOf("</script>"));
  assert.doesNotMatch(closeBlock, /chat\.send\(/, "取消必须什么都不发（关闭路径里出现了 send）");
});

test("前端：默认不预选会话，且多选必须逐项勾、部分失败只留失败项", () => {
  const panel = read("src/components/SharePanel.vue");
  // 设计稿验收矩阵要求「多选、逐项可辨认」。预选等于替用户决定发给谁；空数组是唯一的正确初值。
  assert.match(
    panel,
    /const selected = ref<string\[\]>\(\[\]\)/,
    "选中项初值必须是空数组 —— 预选会话等于替用户决定发给谁",
  );
  assert.match(panel, /function toggleTarget\(/, "多选必须有显式切换（点一下勾上、再点取消）");
  assert.match(
    panel,
    /role="checkbox"/,
    "多选行语义应为 checkbox；用 radio 会让读屏暗示只能选一个",
  );
  assert.match(panel, /for \(const id of ids\)/, "发送必须逐个会话投递（一次失败不该挡住后面的）");
  assert.match(
    panel,
    /selected\.value = failed;/,
    "部分失败必须只保留失败目标 —— 重发全部会让已经发出去的那几个重复",
  );
  const reset = panel.match(/selected\.value = \[\]/g) ?? [];
  assert.ok(reset.length >= 1, "换一条分享时必须清空勾选（否则上一条的收件人会带过来）");
});

test("协议核心：限额与 TTL 是一处常量，且有单测钉着", () => {
  const core = read("src-tauri/src/share.rs");
  for (const name of ["MAX_TITLE_CHARS", "MAX_TEXT_CHARS", "MAX_URL_CHARS", "MAX_PENDING", "PENDING_TTL_MS"]) {
    assert.match(core, new RegExp(`pub const ${name}: `), `限额常量 ${name} 消失 ⇒ 前端镜像会默默漂`);
  }
  // 前端那份镜像由 share.test.ts 现读 Rust 源码对账（这里只确认它对账的对象还在）。
  const ts = read("src/utils/share.test.ts");
  assert.match(ts, /readFileSync\(RUST_SRC/, "前端↔后端限额对账判据被拿掉了");
});

/**
 * 粘贴兜底：深链没被系统注册时（开发期构建 / 未签名包 / 未注册的 Linux 桌面）唯一的自测入口。
 *
 * 为什么要单独钉：这条链路断掉的表现和「深链没注册」一模一样 —— 输入框还在、点了没反应，
 * 排障时会被误判成系统没注册协议。而它正是接入文档 §4 自测清单能被执行的前提。
 */
test("兜底：粘贴入口走同一条 begin_share，且两端设置页都挂了它", () => {
  const cmd = read("src-tauri/src/commands/external_share.rs");
  // 拆掉会怎样：自己再写一遍解析/入队 ⇒ 限额与去重出现第二套口径，自测结果不再等价于真实入口。
  assert.match(
    cmd,
    /pub async fn share_handle_link\([\s\S]{0,200}begin_share\(&state\.inner\(\)\.app, &url\)\.await/,
    "粘贴命令必须复用 begin_share（不许另写一条入队路径）",
  );

  const lib = read("src-tauri/src/lib.rs");
  assert.match(lib, /commands::share_handle_link,/, "命令没注册 ⇒ 设置页一点就 reject");

  const api = read("src/api/index.ts");
  assert.match(
    api,
    /shareHandleLink: \(url: string\) => invoke<SharePrompt>\("share_handle_link"/,
    "门面缺 shareHandleLink ⇒ 组件没得调",
  );

  const store = read("src/stores/useShareStore.ts");
  assert.match(store, /async function handleLink\(url: string\)/, "store 缺 handleLink");
  assert.match(store, /api\.shareHandleLink\(url\)/, "store 没调门面");
  assert.match(store, /pending\.value = p;/, "拿到结果后没打开面板 ⇒ 用户点完像没发生");

  // 2026-11-17：粘贴入口随其他第三方设置收进「第三方接入」tab。
  const integrations = read("src/components/settings/IntegrationsSection.vue");
  assert.match(integrations, /<ExternalShareSection \/>/, "第三方接入页没挂粘贴入口");
  for (const surface of ["src/components/SettingsWindow.vue", "src/components/SettingsPanel.vue"]) {
    assert.match(read(surface), /<IntegrationsSection \/>/, `${surface} 没挂第三方接入 tab`);
  }

  const section = read("src/components/settings/ExternalShareSection.vue");
  assert.match(section, /store\.handleLink\(/, "组件必须经 store，不许自己 invoke");
  assert.doesNotMatch(section, /\binvoke\(/, "组件里裸 invoke ⇒ 绕开了错误口径与面板状态");
});
