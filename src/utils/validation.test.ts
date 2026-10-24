/**
 * 表单与 IPC 边界校验的判据。
 *
 * 这里同时钉两件事：schema 本身在边界上的行为（含 emoji 的码点口径），
 * 以及“真实入口确实用了它”——否则库装上了、字段还在手写 if。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  charCount,
  chatSearchGroupSchema,
  groupFileEntrySchema,
  groupNameSchema,
  nicknameSchema,
  parseIpcList,
  parseIpcValue,
  shareEntrySchema,
  shareTreeSchema,
} from "./validation.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("群名/昵称：trim 后非空，长度按 Unicode 码点算（emoji 算 1 个）", () => {
  assert.equal(groupNameSchema.parse("  团队  "), "团队");
  assert.equal(groupNameSchema.safeParse("   ").success, false);
  assert.equal(groupNameSchema.safeParse("字".repeat(40)).success, true);
  assert.equal(groupNameSchema.safeParse("字".repeat(41)).success, false);
  assert.equal(groupNameSchema.safeParse("🐱".repeat(40)).success, true, "40 个 emoji 应算 40 个字符");
  assert.equal(groupNameSchema.safeParse("🐱".repeat(41)).success, false);

  assert.equal(nicknameSchema.parse(" 小布 "), "小布");
  assert.equal(nicknameSchema.safeParse("").success, false);
  assert.equal(nicknameSchema.safeParse("字".repeat(41)).success, false);
});

test("群文件 IPC 行：合法形状通过，未知 local_state / 缺字段 / 负 size 都拒绝", () => {
  const ok = {
    transfer_id: "t1",
    name: "a.bin",
    size: 1,
    sender_id: "p1",
    created_at: 0,
    local_state: "local",
    local_path: null,
    delivered: 0,
    total: 1,
  };
  assert.equal(groupFileEntrySchema.safeParse(ok).success, true);
  assert.equal(groupFileEntrySchema.safeParse({ ...ok, local_state: "done" }).success, false);
  assert.equal(groupFileEntrySchema.safeParse({ ...ok, local_path: undefined }).success, false);
  assert.equal(groupFileEntrySchema.safeParse({ ...ok, size: -1 }).success, false);
});

test("共享目录 IPC 行：is_dir 必须是布尔，size 必须是非负整数", () => {
  assert.equal(shareEntrySchema.safeParse({ name: "a", path: "/a", is_dir: false, size: 1 }).success, true);
  assert.equal(shareEntrySchema.safeParse({ name: "a", path: "/a", is_dir: "no", size: 1 }).success, false);
  assert.equal(shareEntrySchema.safeParse({ name: "a", path: "/a", is_dir: true, size: 1.5 }).success, false);
});

test("搜索命中 IPC 行：嵌套消息也校验；未知 kind 必须放行（对端可能比本机新）", () => {
  const msg = { msg_id: "m1", sender_id: "p1", sender_name: "小布", kind: "text", content: "命中", ts: 1 };
  const group = {
    conv_id: "c1", name: "会话", kind: "group", avatar: null,
    total: 1, latest_ts: 1, messages: [msg],
  };
  assert.equal(chatSearchGroupSchema.safeParse(group).success, true);
  assert.equal(chatSearchGroupSchema.safeParse({ ...group, avatar: "https://x/a.png" }).success, true);
  // 前向兼容：不认识的 kind 是合法数据，不能被校验层判死
  assert.equal(
    chatSearchGroupSchema.safeParse({ ...group, messages: [{ ...msg, kind: "future-kind" }] }).success,
    true,
  );
  assert.equal(chatSearchGroupSchema.safeParse({ ...group, total: -1 }).success, false);
  assert.equal(
    chatSearchGroupSchema.safeParse({ ...group, messages: [{ ...msg, sender_name: undefined }] }).success,
    false,
  );
  assert.throws(
    () => parseIpcList(chatSearchGroupSchema, [{ ...group, messages: [{ ...msg, ts: "1" }] }], "search_chat_history"),
    /search_chat_history 返回了非法数据 @ 0\.messages\.0\.ts/,
  );
});

test("parseIpcList：坏行抛错并带命令名与字段路径，不把坏数据放行", () => {
  assert.deepEqual(parseIpcList(shareEntrySchema, [], "request_share_tree"), []);
  assert.throws(
    () => parseIpcList(shareEntrySchema, [{ name: "a", path: "/a", is_dir: 1, size: 0 }], "request_share_tree"),
    /request_share_tree 返回了非法数据 @ 0\.is_dir/,
  );
  assert.throws(
    () => parseIpcList(shareEntrySchema, { not: "an array" }, "request_share_tree"),
    /request_share_tree 返回了非法数据/,
  );
});

test("parseIpcValue：共享目录树必须是 { entries, truncated }，旧形状直接拒绝", () => {
  assert.deepEqual(
    parseIpcValue(shareTreeSchema, { entries: [], truncated: false }, "request_share_tree"),
    { entries: [], truncated: false },
  );
  // 旧后端只返回裸数组 ⇒ 必须报错（否则界面读到 `undefined` 的截断位，提示永远不出现）
  assert.throws(
    () => parseIpcValue(shareTreeSchema, [], "request_share_tree"),
    /request_share_tree 返回了非法数据/,
  );
  assert.throws(
    () =>
      parseIpcValue(
        shareTreeSchema,
        { entries: [{ name: "a", path: "/a", is_dir: false, size: 1 }] },
        "request_share_tree",
      ),
    /request_share_tree 返回了非法数据 @ truncated/,
  );
});

test("接线判据：四个真实入口必须使用 schema，而不是另写一份手校验", () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  assert.match(read("components/GroupCreateModal.vue"), /groupNameSchema\.safeParse\(/);
  assert.match(read("components/settings/ProfileSection.vue"), /nicknameSchema\.safeParse\(/);
  const api = read("api/index.ts");
  assert.match(api, /parseIpcList\(groupFileEntrySchema, v, "list_group_files"\)/);
  assert.match(api, /parseIpcValue\(shareTreeSchema, v, "request_share_tree"\)/);
  assert.match(api, /parseIpcList\(chatSearchGroupSchema, v, "search_chat_history"\)/);
  assert.match(read("utils/externalLinks.ts"), /linkInputSchema\.safeParse\(/);
});

// —— 以下三条钉的是"校验层只出键、翻译在渲染处"这条口径（§6.36）——
test("校验层的 message 是词典键而不是人话：换语言不许留下中文", () => {
  for (const [schema, value] of [
    [groupNameSchema, "   "],
    [groupNameSchema, "字".repeat(41)],
    [nicknameSchema, ""],
    [nicknameSchema, "字".repeat(41)],
  ] as const) {
    const parsed = schema.safeParse(value);
    assert.equal(parsed.success, false);
    const msg = parsed.error.issues[0].message;
    assert.ok(!/[\u3400-\u9FFF]/u.test(msg), `message 里还有中文 ⇒ 换语言不会跟着换：${msg}`);
    assert.match(msg, /^[a-z][A-Za-z0-9.]*$/, `message 不是词典键的形状：${msg}`);
  }
});

test("schema 引用的键两头齐全：缺一种语言界面就显示裸 key", () => {
  const keys = new Set<string>();
  for (const [schema, value] of [[groupNameSchema, "   "], [nicknameSchema, "字".repeat(41)]] as const) {
    for (const issue of schema.safeParse(value).error!.issues) keys.add(issue.message);
  }
  assert.equal(keys.size, 2, `只认出 ${keys.size} 个键：${[...keys]}`);
  const srcFile = (rel: string) =>
    fs.readFileSync(path.join(fileURLToPath(new URL("..", import.meta.url)), rel), "utf8");
  for (const dict of ["zh-cn", "en-us"]) {
    const d = srcFile(`i18n/locales/${dict}.ts`);
    for (const k of keys) assert.ok(d.includes(`"${k}":`), `${dict} 缺 ${k}`);
  }
});

test("有 schema 常量做后盾的输入框不许再手抄数字：两处 :maxlength 都绑常量", () => {
  // 长度这条规则在本仓有三份可能的落点（输入框 maxlength / 前端 trim+判长 / 后端 chars()）。
  // 前端那两份必须读同一个数，否则会出现"输得进去、提交被拒"或反过来。
  for (const [file, constant] of [
    ["components/GroupCreateModal.vue", "MAX_GROUP_NAME_CHARS"],
    ["components/settings/ProfileSection.vue", "MAX_NICKNAME_CHARS"],
  ] as const) {
    const src = fs.readFileSync(path.join(fileURLToPath(new URL("..", import.meta.url)), file), "utf8");
    assert.ok(src.includes(`:maxlength="${constant}"`), `${file} 的输入框没绑常量`);
    assert.doesNotMatch(src, /maxlength="\d+"/, `${file} 还手抄着写死的长度上限`);
  }
});

test("计数器那把尺与 schema 同一把：charCount 数码点，且全仓只此一处写法", () => {
  // `maxlength` 已经在那里**静默**截断（粘 60 字只剩 40 字，无半句说明）。要把它说给用户，
  // 读数就必须与判据同一把尺 —— 否则「计数器说 40、提交被拒」或反过来（两把尺各数一遍）。
  assert.equal(charCount("团队"), 2);
  assert.equal(charCount("🐱".repeat(40)), 40, "40 个 emoji 就是 40 个字符");
  assert.notEqual(charCount("🐱".repeat(40)), "🐱".repeat(40).length, ".length 会给 80 ⇒ 不许拿它当尺");
  // 码点口径只许住在 charCount 里（别处再手写一遍就是第二个家）。
  // 剥注释再数：这个口径的**说明**本来就该出现在文档里，把它算成"第二处实现"是假红。
  const src = fs
    .readFileSync(path.join(ROOT, "utils/validation.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const handRolled = src.match(/\[\s*\.\.\.\w+\s*\]\s*\.length/g) ?? [];
  assert.equal(handRolled.length, 1, `码点数法有 ${handRolled.length} 处，应只剩 charCount 那一处`);
});

test("绑了长度上限的输入框必须给出可见读数，且读数只有 CharCounter 一个家", () => {
  // `maxlength` 到顶时是**静默**截断的：粘 60 个字的群名只剩 40 个，界面不给半句说明。
  // 判据口径是失败关闭的：凡把上限绑到 `:maxlength` 上的框，除非它的值只做过滤、不回写，
  // 就必须同时有一枚同常量的 CharCounter 读数 ⇒ 新增上限默认要求读数，想豁免要在这里显式登记。
  const ephemeral = new Set([
    "MAX_SEARCH_KEYWORD_CHARS", // 搜索词：只当查询条件用
    "MAX_LIST_FILTER_KEYWORD_CHARS", // 转发弹窗 / 收藏面板的列表内过滤
    "MAX_LOG_FILTER_CHARS", // 运行日志过滤框
  ]);
  const capped: string[] = [];
  const vueFiles = fs
    .readdirSync(path.join(ROOT, "components"), { recursive: true })
    .filter((f): f is string => typeof f === "string" && f.endsWith(".vue"));
  for (const rel of vueFiles) {
    const src = fs.readFileSync(path.join(ROOT, "components", rel), "utf8");
    for (const [, name] of src.matchAll(/:maxlength="([A-Z0-9_]+)"/g)) {
      if (ephemeral.has(name)) continue;
      capped.push(`${rel}:${name}`);
      assert.ok(
        src.includes(`:max="${name}"`) && /<CharCounter\b/.test(src),
        `${rel} 把 ${name} 绑成了上限却没有同常量的可见读数`,
      );
    }
  }
  assert.ok(capped.length >= 8, `只扫到 ${capped.length} 格上限绑定 ⇒ 分母变小，先确认是不是被改掉了`);

  // 第二把尺不许存在：`{{ x.length }}/{{ N }}` 数的是 UTF-16 单元，与 schema/后端数码点不同尺。
  const handRolled = vueFiles.filter((rel) =>
    /\{\{\s*[\w.]+\.length\s*\}\}\/\{\{/.test(
      fs.readFileSync(path.join(ROOT, "components", rel), "utf8"),
    ),
  );
  assert.deepEqual(handRolled, [], "计数器只许住 components/ui/CharCounter.vue");
});
