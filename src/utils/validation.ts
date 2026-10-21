/**
 * 表单与 IPC 边界的运行时校验（Zod）。
 *
 * 为什么需要（5.x 指令）：前端类型是**手写**的 `src/types.ts`，Rust 侧改字段时 TS 不会编译失败；
 * 只靠 `invoke<T>` 断言等于把跨进程数据当成可信。这里用成熟 schema 库在边界上真校验，
 * 表单侧也复用同一套长度口径，避免"输入框 maxlength / 前端 trim / 后端 chars() 三份规则"。
 *
 * 字符数口径：后端用 `chars().count()`（Unicode 码点），JS 的 `.length` 数的是 UTF-16 单元，
 * 所以长度判据统一走 `[...s].length`，emoji 不会被算成两个字符。
 */
// `zod/mini` 是同一套 schema 的摇树版：API 用 `.check(...)` 组合，打包体积只有完整版的一小部分。
import * as z from "zod/mini";

export const MAX_GROUP_NAME_CHARS = 40;
export const MAX_NICKNAME_CHARS = 40;

/**
 * 其余几格的长度上限。每一个都对应 Rust 侧的一个 `const`，数值由
 * `textLimits.test.ts` 现读两边对账（改任何一侧而没改另一侧 ⇒ 测试红）。
 *
 * ⚠️ 口径不同源这件事是真的，但方向安全：`maxlength` 数 UTF-16 单元、后端数码点，
 * 含 emoji 时前端**更严**（同一串里前端先卡住），不会出现"前端放过、后端偷偷截"。
 */
/** 群公告（Rust `group_announcements.rs::MAX_ANNOUNCEMENT_LEN`）。 */
export const MAX_ANNOUNCEMENT_CHARS = 500;
/** 搜索关键词（Rust `commands.rs::MAX_SEARCH_LEN`；超了后端 `chars().take()` 静默截）。 */
export const MAX_SEARCH_KEYWORD_CHARS = 100;
/** 列表内本地过滤的关键词（转发弹窗 / 收藏面板；后端无对应规则，纯输入护栏）。 */
export const MAX_LIST_FILTER_KEYWORD_CHARS = 50;

/**
 * 长度口径的唯一实现：**Unicode 码点**（与 Rust 侧 `chars().count()` 同尺）。
 *
 * ⚠️ 不许在别处改写这一维：`.length` 数的是 UTF-16 单元，一个 emoji 算 2 ⇒
 * 与后端不同尺（同一串两边各数一次，报错的永远是"看起来更短"的那个）。
 * 输入框的计数器、schema 的判长、提示里的数字必须都走这里 —— 否则"上限 40"
 * 在三处分别是 40 / 20 / 40，而用户只看得见一个数字。
 */
export function charCount(s: string): number {
  return [...s].length;
}

/**
 * 长度规则的唯一家：`max` 是判据，两个 `*Key` 是**词典键**（不是文案）。
 *
 * ⚠️ 为什么不在这里写人话：schema 是模块级常量，在 import 那一刻就求值完毕。
 * 若把 `t()` 或中文塞进 message，换语言时它不会跟着换（dayjs 全局 locale 那个坑的同形），
 * 而且中文 message 看起来像 UI 文案、实则没人显示它 —— 两处调用点本来就自己 t()。
 * ⇒ 这里只出**键**，上屏的地方 `t(issue.message, { max })`；`max` 由调用方用同一个常量传，
 * 所以输入框的 `:maxlength`、schema 的判据、提示里的数字是同一个数（本仓最怕的"三份规则"）。
 */
const trimmedNonEmpty = (max: number, emptyKey: string, tooLongKey: string) =>
  z.string().check(
    z.trim(),
    z.minLength(1, emptyKey),
    z.refine((s) => charCount(s) <= max, tooLongKey),
  );

export const groupNameSchema = trimmedNonEmpty(
  MAX_GROUP_NAME_CHARS,
  "group.toast.nameEmpty",
  "group.toast.nameTooLong",
);
export const nicknameSchema = trimmedNonEmpty(
  MAX_NICKNAME_CHARS,
  "settings.profile.toast.nicknameEmpty",
  "settings.profile.toast.nicknameTooLong",
);

/** 群文件列表行（`list_group_files`）。字段与 `GroupFileEntry` 对齐。 */
export const groupFileEntrySchema = z.object({
  transfer_id: z.string(),
  name: z.string(),
  size: z.int().check(z.nonnegative()),
  sender_id: z.string(),
  created_at: z.number(),
  local_state: z.enum(["local", "receiving", "remote", "failed"]),
  local_path: z.nullable(z.string()),
  delivered: z.int().check(z.nonnegative()),
  total: z.int().check(z.nonnegative()),
});

/** 共享目录行（`request_share_tree`）。 */
export const shareEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  is_dir: z.boolean(),
  size: z.int().check(z.nonnegative()),
});

/**
 * 「搜索聊天记录」的一条命中（`search_chat_history` 的嵌套行）。
 * `kind` 刻意收任意字符串：对端可能比本机新，未知 kind 由 `UnsupportedKindBubble`
 * 渲染成占位 —— 校验若把"不认识的 kind"判成坏行，前向兼容会先碎在校验层。
 */
export const chatSearchMessageSchema = z.object({
  msg_id: z.string(),
  sender_id: z.string(),
  sender_name: z.string(),
  kind: z.string(),
  content: z.string(),
  ts: z.number(),
});

/** 按会话分组的搜索结果（左栏一行 = 一个会话 + 它的命中消息）。 */
export const chatSearchGroupSchema = z.object({
  conv_id: z.string(),
  name: z.string(),
  kind: z.string(),
  avatar: z.nullable(z.string()),
  total: z.int().check(z.nonnegative()),
  latest_ts: z.number(),
  messages: z.array(chatSearchMessageSchema),
});

/**
 * 校验一条 IPC 返回的数组；形状不符就抛错（让查询进入 error 态并显示可读原因），
 * 不把坏数据塞进界面后等某个字段 `.map` 时才炸。
 */
export function parseIpcList<T>(
  schema: z.ZodMiniType<T>,
  value: unknown,
  label: string,
): T[] {
  const parsed = z.array(schema).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length ? ` @ ${issue.path.join(".")}` : "";
    throw new Error(`${label} 返回了非法数据${where}：${issue?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}
