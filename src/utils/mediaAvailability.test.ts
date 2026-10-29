import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PREVIEW_FAILURE_KEYS,
  previewFailureResult,
  shouldProbePresence,
} from "./mediaAvailability.ts";
import { enUS, zhCN } from "../i18n/locales.ts";

const SRC = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

// ---------------- 已被清理 vs 查不到：这组判定决定用户看到「已清理」还是裂开的图片框 ----------------

test("确定文件已删除时才标记 missing", () => {
  const r = previewFailureResult("文件不存在");
  assert.equal(r.missing, true);
  assert.equal(r.failure, "gone");
});

test("「查不到」类失败绝不标记 missing", () => {
  // 乐观消息（尚未落库）会走到"消息不存在"；元数据缺失、路径越权同理。
  // 这些是"未知"，把它们当成"已删除"会把正在发送的图片误标成「已被清理」。
  for (const err of ["消息不存在", "元数据缺少路径", "路径越权", "非普通文件"]) {
    const r = previewFailureResult(err);
    assert.notEqual(r.missing, true, `${err} 不应被判为已清理`);
    assert.equal(r.failure, undefined, `${err} 不应产生失败原因（暂时态不许进缓存）`);
  }
});

test("超大文件仍走「无法预览」，且不等于已清理", () => {
  const r = previewFailureResult("TOO_LARGE");
  assert.equal(r.failure, "tooLarge");
  assert.notEqual(r.missing, true, "文件太大不代表文件被删了");
});

test("未知错误不产生任何提示（保持既有回退行为）", () => {
  assert.deepEqual(previewFailureResult(""), {});
  assert.deepEqual(previewFailureResult("EIO: read failed"), {});
});

test("错误文案被包装时仍能识别（Tauri reject 可能带前缀）", () => {
  // 用 includes 而非全等：后端文案改变包装方式时不该让判定悄悄失效。
  assert.equal(previewFailureResult("internal error: 文件不存在").missing, true);
  assert.equal(previewFailureResult("error: TOO_LARGE").failure, "tooLarge");
});

test("原因只给机器读：文案由词典出，缓存判据不许再比字符串", () => {
  // 真实缺陷形状（2026-10-19 全量盘点）：原先两处缓存判断写的是
  // `r.note === "文件过大，无法预览"` —— 拿**上屏的那句话**当控制流。
  // 那句一接进 i18n，缓存就静默不收了（不报错，只是每次都重读一遍）。
  const keys = Object.values(PREVIEW_FAILURE_KEYS);
  assert.equal(keys.length, 2, "失败原因只有 gone / tooLarge 两档");
  for (const k of keys) {
    assert.ok(zhCN[k], `zh-CN 缺 ${k} ⇒ 界面上会显示裸 key`);
    assert.ok(enUS[k], `en-US 缺 ${k}`);
  }
  for (const f of ["utils/filePreview.ts", "utils/favoritePreview.ts"]) {
    const code = read(f);
    assert.match(code, /if \(r\.failure\) cache\.put\(/, `${f} 的缓存判据没读机器位`);
    assert.ok(!/note\s*===/.test(code), `${f} 又长回「比字符串决定缓存」`);
  }
  const availability = read("utils/mediaAvailability.ts");
  assert.ok(!/note/.test(availability), "mediaAvailability 不该再产出文案字段");
});

// ---------------- 什么时候需要额外探测一次"文件还在不在" ----------------

test("普通文件才需要单独探测", () => {
  assert.equal(shouldProbePresence("file", { subtype: "file", path: "/d/a.pdf" }), true);
});

test("图片附件由预览读取代劳，不重复探测；文件/代码附件都单独探测", () => {
  assert.equal(shouldProbePresence("file", { subtype: "image", path: "/d/a.png" }), false);
  assert.equal(shouldProbePresence("file", { subtype: "code", path: "/d/a.ts" }), true);
  assert.equal(shouldProbePresence("file", { subtype: "file", path: "/d/a.md" }), true);
});

test("路径为空表示还没到本机，探测无意义", () => {
  assert.equal(shouldProbePresence("file", { subtype: "file", path: "" }), false);
});

test("image 消息与缺失元数据不探测", () => {
  assert.equal(shouldProbePresence("image", { subtype: "image", path: "/d/a.png" }), false);
  assert.equal(shouldProbePresence("file", null), false);
  assert.equal(shouldProbePresence("file", undefined), false);
});

// ---------------- 「本机那份字节不在了」其实有三件事，不许被合成一句 ----------------
//
// 2026-10-29 审计 DUP-02 的残留一格写的是「缺失路径的提示文案三套，各落点各写一句 toast」，
// 读起来像在说同一件事被写了三遍。**逐条读实现之后的实况**（这一段就是防复发的判据）：
//
//  · `msg.imageCleaned` / `msg.cleaned` —— **会话里那份**媒体被「存储清理」删了；
//  · `favorite.mediaGone` —— **收藏自己那份**：`commands/favorites.rs` 真的 `std::fs::copy`
//    了一份进收藏目录（`favorite_copy_name`），删收藏删的是那份 ⇒ 它是另一件事；
//  · `chat.toast.fileNotForward` / `imageNotForward` —— 本机**还没同步到**那份字节，
//    不是"曾经有、现在没了"；说成"已清理"就是假话（用户会去翻回收站）。
//  · `favorite.msgGone` —— 收藏指向的**原消息**行已经不在了（与上面三份字节无关）。
//
// 所以正确结论是**不统一**，但这件"看起来该合并"的事会一再诱惑下一个读者（本轮我自己就先按
// `available = media_path.is_file()` 推断成"共享同一份"，读了 `add_favorite` 才纠正）。
// 于是把它钉成判据：每把钥匙必须带着它那个事实的特征词，且各 surface 只许引用自己那一族。

/** 事实 → 该事实的钥匙 + 中英都必须含的特征词（`/i` 只对英文那半有意义）。 */
const GONE_FACTS: Array<{ fact: string; keys: string[]; zh: RegExp; en: RegExp }> = [
  { fact: "会话里那份媒体已被存储清理", keys: ["msg.imageCleaned", "msg.cleaned"], zh: /清理/, en: /clean/i },
  { fact: "收藏目录里那份副本已不在本机", keys: ["favorite.mediaGone"], zh: /副本/, en: /cop(?:y|ies)/i },
  { fact: "本机还没同步到那份字节（不是被清理）", keys: ["chat.toast.fileNotForward", "chat.toast.imageNotForward"], zh: /尚未同步/, en: /not synced/i },
  { fact: "收藏指向的原消息行已不在本机", keys: ["favorite.msgGone"], zh: /原消息/, en: /original message/i },
];

test("四把『不在了』的钥匙各自说清是哪一件事实（中英都得含特征词）", () => {
  for (const { fact, keys, zh, en } of GONE_FACTS) {
    for (const k of keys) {
      const z = (zhCN as Record<string, string>)[k];
      const e = (enUS as Record<string, string>)[k];
      assert.ok(z, `zh-CN 缺 ${k}（${fact}）`);
      assert.ok(e, `en-US 缺 ${k}（${fact}）`);
      assert.match(z, zh, `${k} 的中文没说出这是哪一件事 ⇒ 会被当成通用「已被清理」：${z}`);
      assert.match(e, en, `${k} 的英文没说出这是哪一件事：${e}`);
    }
  }
  // 正控：把"收藏副本"那格写成通用清理句 ⇒ 同一把尺子必须判它不合规。
  assert.equal(/副本/.test("已被清理"), false, "特征词判据认不出合并后的措辞 ⇒ 上面那圈断言是空转的");
  // 正控：把"尚未同步"写成"已清理"（本仓最容易被顺手合并的那一步）。
  assert.equal(/尚未同步/.test("文件已被清理，无法转发"), false);
});

test("收藏那句承诺的『副本』必须由代码兑现（文案与实现是一条契约）", () => {
  const rust = readFileSync(join(SRC, "..", "src-tauri", "src", "commands", "favorites.rs"), "utf8");
  assert.match(rust, /std::fs::copy\(/, "收藏必须真的复制一份；不复制了就得改 favorite.mediaGone 的措辞");
  assert.match(rust, /favorite_copy_name\(/, "副本名字由一个家决定；锚点没命中说明实现搬走了");
  // 反控：这句用假文本走一遍，证明这两条锚点不是"什么都认得出"。
  assert.equal(/std::fs::copy\(/.test("let p = resolve_media_path(s, &msg_id);"), false);
});

test("引用面不许跨界：收藏只说收藏那份，会话气泡只说会话那份", () => {
  const fav = read("components/FavoritePanel.vue");
  const chat = read("components/MessageItem.vue");
  const thumb = read("components/TodoImageThumb.vue");
  const fwd = read("components/ChatWindow.vue");
  // 收藏那一族不许改用通用「已被清理」—— 那会丢掉"是另一份文件"这个关键信息。
  for (const k of ["msg.cleaned", "msg.imageCleaned"]) {
    assert.ok(!fav.includes(`"${k}"`), `FavoritePanel 引用了 ${k} ⇒ 有人把两件事合并成一句了`);
  }
  for (const [name, src] of [["MessageItem", chat], ["TodoImageThumb", thumb]] as const) {
    assert.ok(!src.includes("favorite.mediaGone"), `${name} 引用了收藏那句 ⇒ 跨界（收藏与会话是两份不同的文件）`);
  }
  // 转发那两把必须留在 ChatWindow（"尚未同步"的语义只有它讲），且不许被换成"已清理"。
  assert.match(fwd, /chat\.toast\.fileNotForward/, "转发缺路径的提示不见了（或被并进通用清理句）");
  assert.ok(!/chat\.toast\.fileNotForward[\s\S]{0,80}msg\.cleaned/.test(fwd), "转发那句被换成通用「已被清理」= 撒谎");
});
