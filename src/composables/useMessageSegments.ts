/**
 * 消息正文的两级切段：先按表情 token（`[名字]`）切，文本段再交给 `linkify` 切链接 / @提及。
 *
 * ## 为什么要有这一个家（DUP-06，5.15.28）
 * 这段循环原先在三个渲染件里各抄一遍（`MentionText.vue` / `MessageTextBubble.vue` /
 * `MessageContentModal.vue`），三处的**语义**逐字相同，只有"正文从哪来"不同
 * （`props.text` / `parsed.value.body` / `props.content`）。切段本身早就单源在
 * `utils/emoji` + `utils/linkify`，会漂的是**把它们拼起来那几行** —— 例如表情段要不要带 `name`，
 * 三份拷贝里就有一份没带（`MentionText`），下次有人按那份写就会少一个字段。
 *
 * ## 语义仍然不在这里
 * 段怎么切、@ 到谁算"@到我"、显示成什么文案，全部还是 `utils/linkify` 与 `utils/emoji` 的事。
 * 本件只做一件事：**给定正文 + 提及输入 ⇒ 一组段**。颜色、字号、对比度、点链接的副作用都留在调用方
 * （气泡按当前底色现算 @ 的文字色，任务详情用固定底色那两条全局 class —— 那是渲染件的事，
 * 收进这里就会把两种做法强行统一成一种）。
 */
import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from "vue";
import { linkify, type LinkSegment } from "@/utils/linkify";
import { splitEmoji } from "@/utils/emoji";

/** 渲染段的完整形状：`linkify` 的四类 + 表情段。 */
export type MessageSegment = LinkSegment | { kind: "emoji"; value: string; name: string; url: string };

/** 提及判定需要的三份输入；不传（或传 null）就是"这条正文不做 @ 高亮"。 */
export interface MentionInputs {
  mentionNames?: string[] | null;
  selfMention?: { name: string; label: string; id?: string } | null;
  mentionTargets?: { id: string; name: string; n: number }[] | null;
}

/**
 * 纯函数那一半（仓里的 `*Core` 口径）：给定正文与提及输入 ⇒ 一组段。
 *
 * 单独出口的原因是**可测**：本仓的 Node 判据没有一处真的 import `vue`
 * （`designGuards.test.ts` 里那句 `from "vue"` 是被扫描的字符串，不是导入），
 * 只露 `computed` 出来的话这段语义就只能靠渲染探针证。reactive 那一半只有三行包装。
 */
export function buildMessageSegments(
  source: string | null | undefined,
  mentions: MentionInputs,
): MessageSegment[] {
  const out: MessageSegment[] = [];
  for (const s of splitEmoji(source ?? "")) {
    if (s.kind === "emoji") out.push({ kind: "emoji", value: s.value, name: s.name, url: s.url });
    else
      out.push(
        ...linkify(
          s.value,
          mentions.mentionNames ?? [],
          mentions.selfMention ?? undefined,
          mentions.mentionTargets ?? null,
        ),
      );
  }
  return out;
}

export function useMessageSegments(
  source: MaybeRefOrGetter<string | null | undefined>,
  mentions: MaybeRefOrGetter<MentionInputs>,
): ComputedRef<MessageSegment[]> {
  // 两个 `toValue` 都在 `computed` 的求值函数**里面** ⇒ 依赖照常追踪；
  // 挪到外面取一次就会退化成"只算一次"（这类退化在收家时最常见）。
  return computed(() => buildMessageSegments(toValue(source), toValue(mentions)));
}
