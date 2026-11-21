import { ref, watch, type Ref } from "vue";
import { api } from "@/api";

/**
 * 面板列表行的**文件可用性探测**（J3-5，旅程走查 2026-11-20）。
 *
 * 背景：消息气泡有 mediaPresent 探测（msg_id 粒度），但群文件面板 / 收藏面板的行
 * 没有这条链路 —— 收藏副本是独立路径，群文件行自带 local_path。文件被「存储清理」
 * 删掉后，行仍显示「本机可打开」，点击才报系统错误。
 *
 * 这里按**路径**批量探测（后端 `files_present`，一次 IPC 拿全部行），返回
 * 「已不在本机」的路径集合。口径与 `media_present` 的极性一致：**只有明确 false
 * 才算 missing** —— 探测失败（IPC 错误）按「可能还在」处理，不说不可逆的假话。
 *
 * 列表变化时整批重探（token 防竞态：await 期间列表又变了 ⇒ 丢弃这批结果）。
 */
export function usePathPresence(paths: Ref<string[]>) {
  const missing = ref<Set<string>>(new Set());
  let token = 0;
  watch(
    paths,
    async (list) => {
      const mine = ++token;
      const targets = [...new Set(list.filter(Boolean))];
      if (!targets.length) {
        missing.value = new Set();
        return;
      }
      try {
        const flags = await api.filesPresent(targets);
        if (mine !== token) return;
        const next = new Set<string>();
        targets.forEach((p, i) => {
          if (flags[i] === false) next.add(p);
        });
        missing.value = next;
      } catch {
        // 探测失败 ≠ 文件不在：保持旧状态（或全按存在），宁可让用户点开时遇到
        // 一次明确报错，也不要把「这次没查到」画成不可逆的假事实。
      }
    },
    { immediate: true },
  );
  return { missing };
}
