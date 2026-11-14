/**
 * 外部应用设备认证（Phase 2）的前端状态：待确认事务 + 已授权应用清单。
 *
 * 职责边界：只持有状态与调 api；确认页的展示/反馈在 DeviceAuthConfirmModal，
 * 清单/撤销 UI 在 settings/AuthorizedAppsSection。私钥永不进前端（后端只回公钥面）。
 *
 * 代际守卫（#8）：pending 与 generation 收在 utils/deviceAuth 的纯逻辑核心里（可单测），
 * 这里用 reactive 包一层获得响应性。异步刷新/批准出发前 capture 代际，回填前对账：
 * 清数据或新事务到达后，旧异步结果一律丢弃，绝不复活已消费/已清的事务。
 * 可重试批准（#1）：批准失败**不清** pending（后端 RP 2xx 后才消费），用户可原地重试。
 */
import { defineStore } from "pinia";
import { computed, reactive, ref } from "vue";
import { api } from "@/api";
import type { DeviceAuthOutcome, DeviceAuthPrompt, RpBindingInfo } from "@/types";
import {
  createPendingGuard,
  deviceAuthDenyNeedsRetry,
  guardClear,
  guardConsume,
  guardRefresh,
  guardSetPending,
} from "@/utils/deviceAuth";

/** 后端 DeviceAuthOutcome 已带 rp_notified（见 types.ts），这里直接用官方类型。 */
type DenyResult = DeviceAuthOutcome;

export const useDeviceAuthStore = defineStore("deviceAuth", () => {
  /** 待确认事务 + 代际（深链到达时由事件注入）；pending 为 null = 无确认页。 */
  const guard = reactive(createPendingGuard());
  const pending = computed(() => guard.pending);
  const busy = ref(false);
  const bindings = ref<RpBindingInfo[]>([]);
  /** 「本机已拒绝、RP 未收到」⇒ 显示重试入口且不清确认页（P1 拒绝可观察 / 失败可重试）。 */
  const denyNeedsRetry = ref(false);

  function setPending(p: DeviceAuthPrompt) {
    denyNeedsRetry.value = false;
    guardSetPending(guard, p);
  }
  function clear() {
    denyNeedsRetry.value = false;
    guardClear(guard);
  }

  /** 手动粘贴授权链接（深链未交接时的兜底入口）：后端校验并 emit 确认页。 */
  async function handleLink(url: string): Promise<void> {
    const p = await api.deviceAuthHandleLink(url);
    setPending(p);
  }

  /** 重新拉取待确认事务（确认页刷新过期/消费态）；不存在/过期则清掉确认页。
   * 复合键定位（#8）；代际对账：清数据/新事务到达后旧刷新结果丢弃。 */
  async function refreshPending(): Promise<void> {
    const cur = guard.pending;
    if (!cur) return;
    const captured = guard.generation;
    try {
      const p = await api.deviceAuthGetPending(cur.rp_origin, cur.client_id, cur.request_id);
      guardRefresh(guard, captured, p);
    } catch {
      if (guard.generation === captured) guardClear(guard);
    }
  }

  /** 批准（昵称仅 allowNickname 时共享）。RP 2xx 后后端才消费事务，这里成功才清确认页；
   * 失败**保留** pending（可重试，#1），抛出由 UI 反馈。代际对账防止清掉新到达的事务。 */
  async function approve(allowNickname: boolean): Promise<DeviceAuthOutcome | null> {
    const cur = guard.pending;
    if (!cur || busy.value) return null;
    const captured = guard.generation;
    busy.value = true;
    try {
      const out = await api.deviceAuthApprove(cur.rp_origin, cur.client_id, cur.request_id, allowNickname);
      guardConsume(guard, captured);
      return out;
    } finally {
      busy.value = false;
    }
  }

  async function deny(): Promise<DeviceAuthOutcome | null> {
    const cur = guard.pending;
    if (!cur || busy.value) return null;
    const captured = guard.generation;
    busy.value = true;
    try {
      const out = (await api.deviceAuthDeny(cur.rp_origin, cur.client_id, cur.request_id)) as DenyResult;
      // RP 未收到拒绝：本机已拒绝但回写失败，保留 pending 并显示重试入口（失败可重试，#1）。
      // 此处绝不 guardConsume —— 消费了就没法用同一事务、同一幂等键重试通知 RP。
      if (deviceAuthDenyNeedsRetry(out?.rp_notified)) {
        denyNeedsRetry.value = true;
        return out;
      }
      denyNeedsRetry.value = false;
      guardConsume(guard, captured);
      return out;
    } finally {
      busy.value = false;
    }
  }

  async function loadBindings(): Promise<void> {
    bindings.value = await api.deviceAuthListBindings();
  }

  async function revoke(rpOrigin: string, clientId: string): Promise<void> {
    await api.deviceAuthRevoke(rpOrigin, clientId);
    await loadBindings();
  }

  return {
    pending, busy, bindings, denyNeedsRetry,
    setPending, clear, handleLink, refreshPending, approve, deny, loadBindings, revoke,
  };
});