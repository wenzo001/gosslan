/**
 * 群：创建/改名/成员/转让/退群/被移出，以及群公告的发布与生效标记。
 *
 * 职责边界：群**元数据**与公告标记；会话行刷新交给 `conversations`，消息入账交给 `messaging`。
 */
import { ref } from "vue";
import { api } from "@/api";
import type { ChatContext } from "./runtime";
import type { Group } from "@/types";
import { createGeneration, optimisticMutate } from "@/utils/optimisticMutate";

export function createGroupsModule(ctx: ChatContext) {
  const {
    conversations,
    groups,
    activeConv,
    messages,
    groupDeliveries,
    groupDeliveryErrors,
  } = ctx.state;
  const { refreshGroups, refreshConversations, enqueueMessage, clearUnreadJump } = ctx.api;

  // 并发安全回滚（2026-11-13 功能闭环审计 P2）：权威刷新递增 generation；乐观回滚只对本次
  // 改动施加逆操作于**当前态**（不整份恢复快照），晚到失败若已被权威刷新超越则跳过逆操作
  // （后端状态优先）。机制见 utils/optimisticMutate，判据见 optimisticMutate.test.ts。
  const groupsGen = createGeneration();
  async function refreshGroupsAuthoritative() {
    await refreshGroups();
    groupsGen.bump();
  }

  /** 发布群公告（仅群主）。正常入时间线（计未读、可通知），只是不随清空历史消失。 */
  async function publishAnnouncement(groupId: string, text: string) {
    const rec = await api.sendGroupAnnouncement(groupId, text);
    enqueueMessage(rec);
    await refreshAnnouncements();
  }

  // ---------------- 群公告（会话列表 📢 标记的数据源） ----------------
  // 为什么走一条专门的查询：会话列表要覆盖**全部**群，而 `chat.messages` 是 ~4 个会话的
  // LRU 缓存 —— 从它折叠公告覆盖不了大多数群。后端 `list_active_group_announcements`
  // 一条 SQL 全量折叠（公告 + 墓碑），前端缓存成 map。

  /** 当前生效的群公告：key = group_id。 */
  const activeAnnouncements = ref(new Map<string, { text: string; msgId: string }>());

  /** 全量刷新（一条 SQL，代价低）。 */
  async function refreshAnnouncements() {
    try {
      const list = await api.listActiveGroupAnnouncements();
      const next = new Map<string, { text: string; msgId: string }>();
      for (const a of list) next.set(a.groupId, { text: a.text, msgId: a.msgId });
      activeAnnouncements.value = next;
    } catch {
      /* 拉取失败保持旧值（下一条公告事件会再触发刷新） */
    }
  }

  /** 删除群公告（仅群主）：发墓碑 → 入 store（本端横幅即刻消失）→ 刷新标记。 */
  async function deleteAnnouncement(groupId: string, annId: string) {
    const rec = await api.deleteGroupAnnouncement(groupId, annId);
    enqueueMessage(rec);
    await refreshAnnouncements();
  }

  async function createGroup(name: string, members: string[]) {
    const g = await api.createGroup(name, members);
    await api.distributeGroupKey(g.id);
    await refreshGroupsAuthoritative();
    await refreshConversations();
    return g;
  }

  /** 重命名群（仅群主）。乐观更新会话标题，失败按项还原旧名（不整份覆盖会话表）。 */
  async function renameGroup(groupId: string, name: string) {
    const convId = `group:${groupId}`;
    let oldName = "";
    await optimisticMutate(
      conversations,
      (cur) =>
        cur.map((c) => {
          if (c.id !== convId) return c;
          oldName = c.name;
          return { ...c, name };
        }),
      (cur) => cur.map((c) => (c.id === convId ? { ...c, name: oldName } : c)),
      () => api.renameGroup(groupId, name),
    );
    await refreshGroupsAuthoritative();
    await refreshConversations();
  }

  /**
   * 群操作的**乐观更新**骨架（用户 2026-09-12 要求「所有异步操作尽量乐观更新」）。
   *
   * 原先四个群操作都是「await 后端 → await refreshGroups → await refreshConversations」：
   * 点一下要等 **3 个 IPC 往返**才看到变化（成员列表、群主标识都不动），
   * 与「不阻断渲染」的要求相反。这里统一成与 `renameGroup` 相同的范式：
   * **先本地改（可感知即时）→ 调后端 → 失败回滚 + 抛错**（调用方负责 toast）。
   * 后端仍是权威：成功后会 refresh 一次收敛（成员/会话行以后端为准）。
   *
   * 回滚是**按项逆操作**（审计 P2）：`inverse` 对当前态撤销本次改动，不整份恢复快照——
   * 同一集合上另一操作先成功的变更不会被盖掉；`groupsGen` 守卫让晚到失败不覆盖权威刷新。
   */
  function withGroupRollback<T>(
    apply: (cur: Group[]) => Group[],
    inverse: (cur: Group[]) => Group[],
    call: () => Promise<T>,
  ): Promise<T> {
    return optimisticMutate(groups, apply, inverse, call, groupsGen);
  }

  /** 加人入群（群主）。 */
  async function addGroupMember(groupId: string, deviceId: string) {
    await withGroupRollback(
      (cur) =>
        cur.map((g) =>
          g.id === groupId && !g.members.includes(deviceId)
            ? { ...g, members: [...g.members, deviceId] }
            : g,
        ),
      (cur) =>
        cur.map((g) =>
          g.id === groupId ? { ...g, members: g.members.filter((m) => m !== deviceId) } : g,
        ),
      () => api.groupAddMember(groupId, deviceId),
    );
    await refreshGroupsAuthoritative();
    await refreshConversations();
  }

  /** 移除成员（群主）。 */
  async function removeGroupMember(groupId: string, deviceId: string) {
    await withGroupRollback(
      (cur) =>
        cur.map((g) =>
          g.id === groupId ? { ...g, members: g.members.filter((m) => m !== deviceId) } : g,
        ),
      (cur) =>
        cur.map((g) =>
          g.id === groupId && !g.members.includes(deviceId)
            ? { ...g, members: [...g.members, deviceId] }
            : g,
        ),
      () => api.groupRemoveMember(groupId, deviceId),
    );
    await refreshGroupsAuthoritative();
    await refreshConversations();
  }

  /** 任命管理员（仅群主）。乐观把目标加进 admins，失败按项撤销。 */
  async function appointAdmin(groupId: string, deviceId: string) {
    await withGroupRollback(
      (cur) =>
        cur.map((g) =>
          g.id === groupId && !g.admins.includes(deviceId)
            ? { ...g, admins: [...g.admins, deviceId] }
            : g,
        ),
      (cur) =>
        cur.map((g) =>
          g.id === groupId ? { ...g, admins: g.admins.filter((a) => a !== deviceId) } : g,
        ),
      () => api.groupAppointAdmin(groupId, deviceId),
    );
    await refreshGroupsAuthoritative();
  }

  /** 撤销管理员（仅群主）。乐观把目标移出 admins，失败按项加回。 */
  async function removeAdmin(groupId: string, deviceId: string) {
    await withGroupRollback(
      (cur) =>
        cur.map((g) =>
          g.id === groupId ? { ...g, admins: g.admins.filter((a) => a !== deviceId) } : g,
        ),
      (cur) =>
        cur.map((g) =>
          g.id === groupId && !g.admins.includes(deviceId)
            ? { ...g, admins: [...g.admins, deviceId] }
            : g,
        ),
      () => api.groupRemoveAdmin(groupId, deviceId),
    );
    await refreshGroupsAuthoritative();
  }

  /** 转让群主（仅当前群主）。后端会向全体成员广播新群主。失败还原旧群主（按项）。 */
  async function transferGroupCreator(groupId: string, newCreator: string) {
    let oldCreator = "";
    await withGroupRollback(
      (cur) =>
        cur.map((g) => {
          if (g.id !== groupId) return g;
          oldCreator = g.creator;
          return { ...g, creator: newCreator };
        }),
      (cur) => cur.map((g) => (g.id === groupId ? { ...g, creator: oldCreator } : g)),
      () => api.transferGroupCreator(groupId, newCreator),
    );
    await refreshGroupsAuthoritative();
  }

  /** 退出群聊（群主须先转让）。退出后复用「被移出群」的本地清理路径。 */
  async function leaveGroup(groupId: string) {
    const convId = `group:${groupId}`;
    // 捕获被移除的**那一条**群/会话（不是整份快照），失败时按项加回当前态。
    const removedGroup = groups.value.find((g) => g.id === groupId);
    const removedConv = conversations.value.find((c) => c.id === convId);
    const prevActive = activeConv.value;
    const prevMessages = messages.value[convId];
    // 乐观：立刻把群从本地移除并关掉会话（用户点了"退出"就该马上看到结果）
    groups.value = groups.value.filter((g) => g.id !== groupId);
    conversations.value = conversations.value.filter((c) => c.id !== convId);
    if (activeConv.value === convId) {
      activeConv.value = null;
      clearUnreadJump();
    }
    try {
      await api.leaveGroup(groupId);
    } catch (e) {
      // 按项逆操作（审计 P2）：把移除的群/会话加回**当前态**，不整份覆盖——
      // 并发期间别的群/会话的新事实得以保留。活动会话与消息是本地 UI 态，原样还原。
      if (removedGroup && !groups.value.some((g) => g.id === groupId)) {
        groups.value = [...groups.value, removedGroup];
      }
      if (removedConv && !conversations.value.some((c) => c.id === convId)) {
        conversations.value = [...conversations.value, removedConv];
      }
      activeConv.value = prevActive;
      if (prevMessages !== undefined) messages.value = { ...messages.value, [convId]: prevMessages };
      throw e;
    }
    await handleSelfRemovedFromGroup(groupId);
  }

  /** 自己被移出群：关闭该会话并刷新。 */
  async function handleSelfRemovedFromGroup(groupId: string) {
    const convId = `group:${groupId}`;
    if (activeConv.value === convId) {
      activeConv.value = null;
      clearUnreadJump();
    }
    delete messages.value[convId];
    // 同一次收尾里把台账摘要也放掉：群已经不在了，留着只会在重建同名会话时先显示旧计数。
    delete groupDeliveries.value[convId];
    // 摘要的读失败登记与摘要同生共死：留着它，重建的同名会话会先挂一条过期的错误档。
    delete groupDeliveryErrors.value[convId];
    await refreshGroupsAuthoritative();
    await refreshConversations();
  }

  return {
    activeAnnouncements,
    publishAnnouncement,
    refreshAnnouncements,
    deleteAnnouncement,
    createGroup,
    renameGroup,
    withGroupRollback,
    addGroupMember,
    removeGroupMember,
    appointAdmin,
    removeAdmin,
    transferGroupCreator,
    leaveGroup,
    handleSelfRemovedFromGroup,
  };
}
