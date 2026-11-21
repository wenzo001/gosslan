/**
 * 「提醒强度分端」这条链的形状判据（用户 2026-09-29 需求汇总五）。
 *
 * 判的是**接线**，不是算法（算法在 `notifyUrgency.test.ts` 里逐条判）：
 * 前端算出的那个 bool 要真的走到 IPC、真的被后端两条命令签名接住、真的只在 macOS
 * 那一支改变行为 —— 少一环就是"看着改了，实际什么都没变"。
 *
 * 为什么用静态读文件而不是跑起来：`request_user_attention` 是**系统级视觉副作用**，
 * node 侧没有可判的对象；而"参数漏接"在 Tauri 里是运行时 `invalid args`（用户点了没反应），
 * 编译期反而不报 —— 正是静态判据最划算的那一类。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readChatStoreSrc } from "../../scripts/chatStoreSrc.ts";

const read = (rel: string) =>
  rel === "../stores/useChatStore.ts"
    ? readChatStoreSrc(fileURLToPath(new URL(rel, import.meta.url)))
    : readFileSync(new URL(rel, import.meta.url), "utf8");
const store = read("../stores/useChatStore.ts");
const api = read("../api/index.ts");
const networkRs = read("../../src-tauri/src/commands/network.rs");
const trayRs = read("../../src-tauri/src/tray.rs");

test("紧急程度按『这批真正发出的通知』算，并原样传给后端", () => {
  // 入参必须是 `entries`（去抖合并后的那批），不是未读列表 / 不是整个会话历史：
  // 用后者会让一条很旧的紧急任务把每次新消息都点亮 Dock 弹跳。
  assert.match(
    store,
    /const urgent = batchIsUrgent\(entries\.map\(\(e\) => e\.last\)\);/,
    "urgent 必须由这批通知的最后一条算出",
  );
  assert.doesNotMatch(
    store,
    /batchIsUrgent\((messages|allMessages|conversations)/,
    "不许把整条消息列表喂给 batchIsUrgent（那样紧急标记永远清不掉）",
  );
});

test("IPC 两端参数名对齐：前端传的 key 就是后端形参名", () => {
  // Tauri 按**参数名**做序列化匹配：前端写 `{ urgency }` 而后端形参叫 `urgent`
  // 不会编译失败，只会在运行时 `invalid args` ⇒ 必须两头都钉住。
  assert.match(api, /requestAttention: \(urgent: boolean\) => invoke<void>\("request_attention", \{ urgent \}\)/);
  assert.ok(
    networkRs.includes("pub fn request_attention(app: tauri::AppHandle, urgent: bool)"),
    "桌面端命令必须收 urgent: bool",
  );
  assert.ok(
    networkRs.includes("pub fn request_attention(_app: tauri::AppHandle, _urgent: bool)"),
    "移动端命令也必须收这个参数（Android 少收一个参数 = 每次调用 invalid args）",
  );
});

test("分端规则只在后端一处：macOS 看 urgent，Windows / 其它维持闪烁", () => {
  // macOS 那一支必须真的把 urgent 用上；写成 `Some(Critical)` 就等于这条需求没做。
  assert.match(networkRs, /AttentionPlatform::MacOS => urgent\.then_some/);
  assert.match(networkRs, /AttentionPlatform::Windows \| AttentionPlatform::Other => \{/);
  // 只有一处决定"要不要打断"：前端不许自己判平台（isMac 分支会漂成第二份规则）。
  // 强提醒（handleIncomingRemind）加入后，唯一字面调用点收进 requestAttentionOnce，
  // 普通消息批与强提醒两条路径都经它 —— 直接写第二处字面调用就是第二个家。
  assert.equal(
    (store.match(/api\.requestAttention\(/g) ?? []).length,
    1,
    "字面调用点只许一处（收在 requestAttentionOnce 里）",
  );
  assert.match(
    store,
    /function requestAttentionOnce\(urgent: boolean\)/,
    "必须有 requestAttentionOnce 这个唯一收口",
  );
  assert.match(
    store,
    /if \(anyReminded && !app\.isMobile\) \{[\s\S]*?requestAttentionOnce\(urgent\);/,
    "普通消息批：去抖合并后经收口请求注意",
  );
  assert.match(
    store,
    /if \(sent\) requestAttentionOnce\(true\);/,
    "强提醒：通知确实发出后经收口请求紧急注意",
  );
  assert.equal(
    (networkRs.match(/fn request_attention\(/g) ?? []).length,
    2,
    "桌面 + 移动各一条；第三份就是第二个家",
  );
});

test("macOS 菜单栏数字由未读总数驱动，0 条时清空", () => {
  assert.ok(
    trayRs.includes("tray.set_title(tray_title(unread).as_deref())"),
    "set_unread_badge 里必须真的改标题（只写 tooltip = 菜单栏上没有数字）",
  );
  assert.ok(
    trayRs.includes("tray.set_tooltip(Some(tray_tooltip(zh, unread)))"),
    "tooltip 那条不能因为新增数字而被删掉（Windows 侧靠它报条数）",
  );
  // 纯函数那一半：0 → None（清空），不是 Some("0")
  assert.match(trayRs, /0 => None,/);
});

/**
 * 托盘闪烁（用户 2026-11-21：「来消息时右下角图标要闪」）。
 *
 * 这条需求的**坑不在实现，在接线**：任务栏那边早就闪（`request_attention` → Windows
 * `Critical`），但关窗口是"隐藏到托盘"（`prevent_close` + `hide`）—— 窗口一隐藏，
 * 任务栏上根本没有按钮可闪，那条链在这个场景里是空的。真正的可见面只有托盘图标。
 *
 * 所以判三件事，缺一条就退回"用户看不见任何反应"：
 *  ① 后端真的实现了闪烁，并且有一条**纯函数**计划（可测）；
 *  ② 触发点在 `request_attention` 里，且只在**窗口不可见/未聚焦**时补闪
 *    （可见时闪托盘是噪音：用户正看着界面）；
 *  ③ 用户回来时必须收手，并按**真实未读数**落位（不能停在熄灭那一帧）。
 */
test("托盘闪烁：实现了、接在提醒出口、用户回来收手", () => {
  // ① 实现 + 可测的计划
  assert.ok(trayRs.includes("pub fn flash_unread"), "托盘侧没有闪烁实现");
  assert.match(
    trayRs,
    /fn flash_plan\(rounds: usize\) -> Vec<bool>/,
    "闪烁节奏必须是纯函数（真跑要托盘运行时，那一层测不到）",
  );
  assert.match(trayRs, /for with_dot in flash_plan\(FLASH_ROUNDS\)/, "线程没用那份计划 ⇒ 计划是摆设");
  // 收尾必须落回"有未读"的真实状态：停在熄灭帧 = 托盘上留下没有红点的图标
  assert.match(
    trayRs,
    /if FLASH_GEN\.load\(std::sync::atomic::Ordering::SeqCst\) == gen \{[\s\S]{0,200}?set_icon/,
    "闪完没有按真实未读落位（最后一帧会留在熄灭状态）",
  );

  // ② 触发点：只此一处，且在"看不见窗口"的分支里
  assert.match(
    networkRs,
    /let seen = win\.is_visible\(\)[\s\S]{0,120}?if !seen \{\s*crate::tray::flash_unread\(&app\);/,
    "request_attention 没有在『窗口不可见/未聚焦』时补闪托盘（任务栏隐藏时这条链是空的）",
  );
  assert.equal(
    (networkRs.match(/crate::tray::flash_unread\(/g) ?? []).length,
    1,
    "闪烁的触发点只许一处（第二处 = 第二个家，强度会漂）",
  );

  // ③ 收手：用户点托盘/菜单显示窗口时必须停，且按真实未读落位
  assert.match(
    trayRs,
    /pub fn show_main_window[\s\S]{0,400}?stop_flash\(app\);/,
    "show_main_window 没停闪烁 —— 用户回来了还闪，等于提醒失效",
  );
  assert.match(
    trayRs,
    /if unread == 0 \{\s*FLASH_GEN\.fetch_add\(1,/,
    "未读清零时没打断闪烁（会和 set_unread_badge 的图标落位抢同一张图）",
  );
});

/**
 * 桌面端点通知的**近似**定位（用户 2026-11-21 拍板）。
 *
 * 先钉住一个事实：`tauri-plugin-notification` 2.4.0 的 Rust `generate_handler!` 只有
 * notify / request_permission / is_permission_granted —— 前端 `onAction` 调的
 * `plugin:notification|registerListener` **不存在**。所以桌面端注册必然失败，且永远
 * 收不到点击。这条需求只能在"窗口被激活"这个信号上近似实现。
 */
test("桌面点通知：不再注册不存在的命令，改走窗口激活 + 20s 窗口", () => {
  // ① onAction 必须收进 `app.isMobile`：桌面端注册 = 每次启动一条红字 + 永远收不到回调
  assert.match(
    store,
    /if \(app\.isMobile\) \{\s*onAction\(/,
    "桌面端又去注册 onAction 了 —— 那个命令在插件里不存在（控制台红字就是它）",
  );
  // ② 桌面分支：有且只有一个焦点监听，且挂 scope（init 重入会叠加监听器）
  assert.match(
    store,
    /const onWindowFocus = \(\) => \{\s*const hit = consumeDesktopNoticeClick\(\);/,
    "桌面分支没有消费『刚弹过的通知』",
  );
  assert.match(
    store,
    /routeNotificationClick\("chat", hit\.convId, hit\.msgId\)/,
    "消费了却没路由过去 —— 用户还是看不到那条消息",
  );
  assert.equal(
    (store.match(/window\.addEventListener\("focus", onWindowFocus\)/g) ?? []).length,
    1,
    "焦点监听只许一处",
  );
  assert.match(
    store,
    /scope\.onDispose\(\(\) => window\.removeEventListener\("focus", onWindowFocus\)\)/,
    "焦点监听没挂 scope ⇒ init 重入后每轮叠一个，会跳好几次",
  );
  // ③ 候选必须由**两条**桌面通知路径各自记下（普通消息批 + 强提醒带 msg_id）
  assert.equal(
    (store.match(/noteDesktopNotice\(/g) ?? []).length,
    3,
    "应当是『一处定义 + 两处调用』；少一处就有一条通知点了不跳",
  );
  assert.match(store, /noteDesktopNotice\(rec\.conv_id, payload\.target\)/, "强提醒没带 msg_id ⇒ 点了只到会话、落不到原消息");
  // ④ 近似的时间窗必须有限（不做窗口就是"随便切个窗口都跳"）
  assert.match(store, /DESKTOP_NOTICE_CLICK_WINDOW_MS = 20_000/);
  // 间隔规则必须走 `utils/defer` 那一个家（手写 `now - at` 会被 defer.test.ts 判红）
  assert.match(
    store,
    /!shouldRunThrottled\(Date\.now\(\), hit\.at, DESKTOP_NOTICE_CLICK_WINDOW_MS\)/,
    "窗口没被真的用上（而且间隔规则要走 shouldRunThrottled，不能手写时间差）",
  );
});
