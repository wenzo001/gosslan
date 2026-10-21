/**
 * localStorage 的**唯一**安全出口。
 *
 * 为什么要有这一家（现读口径）：迁到这一家之前，全仓生产码有 25 个 `localStorage.<op>` 直连点，
 * 其中 17 个连 `try` 都没有，而"存储不可用"这件事已经被四处**各自手写**过一遍
 * （`i18n/index.ts` 读写两处、`useChatStore.ts` 读写两处、`useAppStore.loadLocalChatStyle`）。
 * 这不是洁癖：Safari 隐私模式 / 禁第三方 Cookie / WebView 配额写满时，
 * `getItem`、`setItem` 会抛（`SecurityError`、`QuotaExceededError`），
 * 而**读 `localStorage` 这个属性本身**在某些 WebView 里就会抛 —— 所以 try 必须连取后端一起包住。
 * 一次没兜住的抛，代价分别是：store 创建期崩（`themeColor`/`fontFamily` 那两个 ref）、
 * 用户点一下"切换外观"就整条 `applyAppearance` 中断、拖分栏时拖拽收尾函数中断。
 *
 * 语义就三条，且**绝不 rethrow**：读失败当"没这个键"（null），写/删失败当"没写成"（false）。
 * 调用方原有的校验（键名白名单、JSON 解析、数字夹取）留在调用方 —— 这一家只管"会不会抛"，
 * 不管"值对不对"，免得变成一个什么都往里塞的配置层。
 *
 * `createSafeStorage` 这层工厂不是"为可测而多出来的一层"：本仓已有的
 * `appearance.ts` / `memberNameCache.ts` 就是靠"调用方把 storage 传进来"跑的同一口径，
 * 而 `node --test` 这台环境里**有一个真的 localStorage 且删不掉**，
 * 靠改写全局来测"没有存储的世界"会得到一个假绿。
 */

export type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

export type SafeStorage = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => boolean;
  remove: (key: string) => boolean;
};

/** 把"会不会抛"收进这三个出口；传 null 表示"这台环境没有存储"。 */
export function createSafeStorage(storage: StorageLike | null): SafeStorage {
  return {
    get(key) {
      if (!storage) return null;
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      if (!storage) return false;
      try {
        storage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      if (!storage) return false;
      try {
        storage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 每次调用现取后端：光访问 `localStorage` 这个属性就可能抛，所以那一步也得进 try。 */
function globalSafe(): SafeStorage {
  try {
    return createSafeStorage(typeof localStorage === "undefined" ? null : localStorage);
  } catch {
    return createSafeStorage(null);
  }
}

/**
 * 给「把存储当对象交出去」的那一族用的同一份兜底（appearance.ts 的 ReadonlyStorage、
 * memberNameCache 的 KVStore、emojiUsage、announcementDismiss）：方法名与 localStorage 一致、
 * 但**永不抛** ⇒ 那些 util 的形参形状一个字没动，它们喂假表的单测照旧。
 * ⚠️ 代价要写明：这个面上**写失败读不到成败**（吞成 void）。那几家本来也是吞掉的，
 * 而真正的持久化权威在后端 settings/SQLite，localStorage 只是首帧快路径。
 */
export const safeStorageBackend: StorageLike = {
  getItem: (key) => storageGet(key),
  setItem: (key, value) => { storageSet(key, value); },
  removeItem: (key) => { storageRemove(key); },
};

export function storageGet(key: string): string | null {
  return globalSafe().get(key);
}

export function storageSet(key: string, value: string): boolean {
  return globalSafe().set(key, value);
}

export function storageRemove(key: string): boolean {
  return globalSafe().remove(key);
}
