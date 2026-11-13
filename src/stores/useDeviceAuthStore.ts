/**
 * 外部应用设备认证（Phase 2）的前端状态：待确认事务 + 已授权应用清单。
 *
 * 职责边界：只持有状态与调 api；确认页的展示/反馈在 DeviceAuthConfirmModal，
 * 清单/撤销 UI 在 settings/AuthorizedAppsSection。私钥永不进前端（后端只回公钥面）。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "@/api";
import type { DeviceAuthOutcome, DeviceAuthPrompt, RpBindingInfo } from "@/types";

export const useDeviceAuthStore = defineStore("deviceAuth", () => {
  /** 当前待确认事务（深链到达时由事件注入）；null = 无确认页。 */
  const pending = ref<DeviceAuthPrompt | null>(null);
  const busy = ref(false);
  const bindings = ref<RpBindingInfo[]>([]);

  function setPending(p: DeviceAuthPrompt) {
    pending.value = p;
  }
  function clear() {
    pending.value = null;
  }

  /** 手动粘贴授权链接（深链未交接时的兜底入口）：后端校验并 emit 确认页。 */
  async function handleLink(url: string): Promise<void> {
    const p = await api.deviceAuthHandleLink(url);
    setPending(p);
  }

  /** 重新拉取待确认事务（确认页刷新过期/消费态）；不存在/过期则清掉确认页。 */
  async function refreshPending(requestId: string): Promise<void> {
    try {
      setPending(await api.deviceAuthGetPending(requestId));
    } catch {
      clear();
    }
  }

  /** 批准（昵称仅 allowNickname 时共享）。成功消费事务并清确认页；失败抛出由 UI 反馈。 */
  async function approve(allowNickname: boolean): Promise<DeviceAuthOutcome | null> {
    if (!pending.value || busy.value) return null;
    busy.value = true;
    try {
      const out = await api.deviceAuthApprove(pending.value.request_id, allowNickname);
      pending.value = null;
      return out;
    } finally {
      busy.value = false;
    }
  }

  async function deny(): Promise<DeviceAuthOutcome | null> {
    if (!pending.value || busy.value) return null;
    busy.value = true;
    try {
      const out = await api.deviceAuthDeny(pending.value.request_id);
      pending.value = null;
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

  return { pending, busy, bindings, setPending, clear, handleLink, refreshPending, approve, deny, loadBindings, revoke };
});