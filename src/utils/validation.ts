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

const trimmedNonEmpty = (max: number, label: string) =>
  z.string().check(
    z.trim(),
    z.minLength(1, `${label}不能为空`),
    z.refine((s) => [...s].length <= max, `${label}最长 ${max} 个字符`),
  );

export const groupNameSchema = trimmedNonEmpty(MAX_GROUP_NAME_CHARS, "群名称");
export const nicknameSchema = trimmedNonEmpty(MAX_NICKNAME_CHARS, "昵称");

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
