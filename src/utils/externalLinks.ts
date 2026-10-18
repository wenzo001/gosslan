/**
 * 外部链接的**前端预校验**（镜像后端 `commands::validate_external_url` / `normalize_link_input`）。
 *
 * 为什么两端各有一份：后端是权威（真正的拦截在那），但前端先校验能让用户在输入框旁立刻看到
 * 原因，而不是提交一次 IPC 再收一个 toast。两边口径必须一致 —— 后端有一条 `cargo test` 表驱动
 * 用例，这里有一条同样的表驱动用例（`externalLinks.test.ts`）。
 *
 * ⚠️ 只允许 http/https：这个网址会被独立窗口 `WebviewUrl::External` 直接加载，
 * `javascript:` / `data:` / `file:` 之类会带来本机攻击面。
 */

import * as z from "zod/mini";

/** 数量上限（与后端 `MAX_EXTERNAL_LINKS` 一致）。 */
export const MAX_EXTERNAL_LINKS = 20;
/** 显示名长度上限（字符数，与后端 `MAX_LINK_NAME_CHARS` 一致）。 */
export const MAX_LINK_NAME_CHARS = 32;

/** 网址是否可用（http/https 且主机名非空）。与后端 `validate_external_url` 同口径。 */
export function isValidExternalUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return u.hostname.length > 0;
}

/** 校验失败的原因（对应 i18n key 后缀 `links.err.<reason>`）；`null` = 通过。 */
export type LinkInputError = "name" | "nameTooLong" | "url" | "duplicate" | "tooMany" | null;

/**
 * 字段规则交给 Zod（issue 的 message 直接就是错误码，省掉一层 if/return 映射）；
 * 字符数仍按码点数（后端 `chars().count()`），与输入框/后端同口径。
 */
const linkInputSchema = z.object({
  name: z.string().check(
    z.trim(),
    z.minLength(1, "name"),
    z.refine((s) => [...s].length <= MAX_LINK_NAME_CHARS, "nameTooLong"),
  ),
  url: z.string().check(z.refine(isValidExternalUrl, "url")),
});

/**
 * 校验一条待保存的链接。`existing` 是当前列表，`exceptId` 是编辑时排除自己那条。
 * 顺序与后端一致：名称 → 网址 → 重复 → （数量由调用方在新增前判断）。
 */
export function validateLinkInput(
  input: { name: string; url: string },
  existing: readonly { id: string; url: string }[] = [],
  exceptId?: string,
): LinkInputError {
  const parsed = linkInputSchema.safeParse(input);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message;
    return reason === "nameTooLong" ? "nameTooLong" : reason === "url" ? "url" : "name";
  }
  const url = input.url.trim();
  if (existing.some((l) => l.url === url && l.id !== exceptId)) return "duplicate";
  return null;
}
