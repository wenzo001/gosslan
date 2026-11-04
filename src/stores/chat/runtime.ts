/**
 * chat store 拆分后的运行时外壳。
 *
 * 为什么需要这一层：拆分前所有状态与动作都活在 `useChatStore` 的同一个闭包里，
 * 动作互相调用靠"同名局部函数"解析。拆成模块后必须保持**同一份状态、同一份闭包**：
 *   - `ChatState` 是唯一一份状态（仍由 `useChatStore` 创建，模块只读/写同一批 ref）；
 *   - `ChatApi` 是**晚绑定**的动作注册表 —— 模块创建时拿到的是转发函数，
 *     真正调用发生在 init 之后，因此模块之间的循环依赖不会被拆成两份实现。
 *
 * ⚠️ 不要在这里加任何状态或业务逻辑：这里只描述形状。
 */
import type { ComputedRef, Ref } from "vue";
import type { StaleGuard } from "@/utils/staleGuard";
import type { MemberNameCache } from "@/utils/memberNameCache";
import type { OperationRow } from "@/utils/taskCenter";
import type { TodoRowsByConv } from "@/utils/todos";
import type {
  ContentTransfer,
  Conversation,
  Friend,
  FriendKeyRotation,
  Group,
  GroupDeliverySummary,
  GroupHistoryProgress,
  MessageRecord,
  OutgoingFriendRequest,
  PendingMessageOp,
  PendingRequest,
  Peer,
  TransferInfo,
  UpdaterStatus,
} from "@/types";
import type { useAppStore } from "@/stores/useAppStore";

/** store 内**唯一一份**状态与只读派生值。模块通过 `ctx.state` 共享它们。 */
export interface ChatState {
  app: ReturnType<typeof useAppStore>;
  refreshGuard: StaleGuard;
  myDeviceId: ComputedRef<string>;
  nicknameOf: (id: string) => string;
  rememberSeenNames: (list: readonly { device_id: string; nickname?: string | null }[]) => void;
  asReadError: (e: unknown) => string;

  peers: Ref<Peer[]>;
  friends: Ref<Friend[]>;
  initialized: Ref<boolean>;
  friendsLoaded: Ref<boolean>;
  friendsError: Ref<string | null>;
  conversationsLoaded: Ref<boolean>;
  groupsLoaded: Ref<boolean>;
  memberNames: Ref<MemberNameCache>;
  rawPendingRequests: Ref<PendingRequest[]>;
  keyRotations: Ref<Record<string, FriendKeyRotation>>;
  pendingRequests: ComputedRef<PendingRequest[]>;
  rawOutgoingRequests: Ref<OutgoingFriendRequest[]>;
  outgoingRequests: ComputedRef<OutgoingFriendRequest[]>;

  conversations: Ref<Conversation[]>;
  groups: Ref<Group[]>;
  transfers: Ref<TransferInfo[]>;
  contentTransfers: Ref<ContentTransfer[]>;
  messageOps: Ref<PendingMessageOp[]>;
  transfersError: Ref<string | null>;
  contentTransfersError: Ref<string | null>;
  messageOpsError: Ref<string | null>;
  groupReadsErrors: Ref<Record<string, string>>;
  updaterStatus: Ref<UpdaterStatus | null>;

  messages: Ref<Record<string, MessageRecord[]>>;
  groupDeliveries: Ref<Record<string, Record<string, GroupDeliverySummary>>>;
  messageLoadErrors: Ref<Record<string, string>>;
  groupReads: Ref<Record<string, Record<string, number>>>;
  groupHistorySync: Ref<Record<string, GroupHistoryProgress>>;
  activeConv: Ref<string | null>;
  mentionedConvs: Ref<Set<string>>;
  activeConversation: ComputedRef<Conversation | null>;
  totalUnread: ComputedRef<number>;

  operations: ComputedRef<OperationRow[]>;
  liveOperationCount: ComputedRef<number>;
  resendingIds: Ref<Set<string>>;
  groupTodoRows: Ref<TodoRowsByConv>;
  eventBridgeOk: Ref<boolean>;
}

/** 上次打开的会话（重启后恢复；只作 UI 状态）。 */
export const LAST_CONV_KEY = "gosslan.lastConv";

/**
 * 动作注册表。
 *
 * 刻意用下标签名：这里的键是**跨模块动作名**，每个模块只声明自己导出的具体函数，
 * 由 `useChatStore` 统一登记。跨模块调用在模块创建时拿到的是转发器，因此 `undefined`
 * 只会在真的漏登记时出现（单测 `storeContract` 会拦公开 API，漏登记会在运行期报错）。
 */
export type ChatApi = Record<string, any>;

export interface ChatContext {
  state: ChatState;
  api: ChatApi;
}

/** 建立一个转发到 `registry` 的 API 视图；函数按名晚绑定，非函数原样返回。 */
export function createChatApi(registry: Record<string, unknown>): ChatApi {
  return new Proxy(registry, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const key = prop;
      return (...args: unknown[]) => {
        const fn = target[key];
        if (typeof fn !== "function") {
          throw new Error(`chat api "${key}" is not registered yet`);
        }
        return fn(...args);
      };
    },
  }) as ChatApi;
}
