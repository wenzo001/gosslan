import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { useQuery } from "@tanstack/vue-query";
import { api } from "@/api";
import { botsQueryOptions } from "@/utils/botsQuery";

/** 组件侧统一入口；enabled 可跟随面板开关，同窗仍共用 ["bots"]。 */
export function useBotsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery(computed(() => botsQueryOptions(api.botList, toValue(enabled))));
}
