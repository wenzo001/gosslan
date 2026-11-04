// 安卓升级状态机的行为真值表：每个转移、重复安装、取消、失败重试、权限回推。
// 跑法：node --test src/updater/androidService.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  createAndroidUpdaterService,
  installerTookOver,
  isInstallBusy,
  type AndroidUpdateAdapter,
} from "./androidService.ts";
import type { AndroidUpdateInfo, AndroidUpdateStatus } from "../types.ts";

const INFO: AndroidUpdateInfo = {
  currentVersion: "1.0.0",
  version: "1.1.0",
  notes: "notes",
  size: 1024,
  sha256: "a".repeat(64),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 让出若干轮微任务/宏任务，用于观察「Promise 已 resolve 但后续 await 还没跑完」的中间态。 */
async function flush(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

function status(patch: Partial<AndroidUpdateStatus>): AndroidUpdateStatus {
  return {
    phase: "idle",
    downloaded: 0,
    total: null,
    version: null,
    size: null,
    sha256: null,
    error: null,
    errorCode: null,
    installStep: null,
    ...patch,
  };
}

type Handlers = {
  check?: () => Promise<AndroidUpdateInfo | null>;
  download?: (onEvent: (e: unknown) => void) => Promise<void>;
  verify?: () => Promise<void>;
  install?: () => Promise<void>;
  cancel?: () => Promise<void>;
  close?: () => Promise<void>;
  openPermissionSettings?: () => Promise<void>;
  status?: () => Promise<AndroidUpdateStatus>;
};

function harness(handlers: Handlers = {}) {
  const calls = {
    check: 0,
    download: 0,
    verify: 0,
    install: 0,
    cancel: 0,
    close: 0,
    permission: 0,
    subscribe: 0,
    status: 0,
  };
  const cbs: ((s: AndroidUpdateStatus) => void)[] = [];
  const adapter: AndroidUpdateAdapter = {
    check: async () => {
      calls.check += 1;
      return handlers.check ? handlers.check() : INFO;
    },
    download: (onEvent) => {
      calls.download += 1;
      return handlers.download
        ? (handlers.download as (e: (x: unknown) => void) => Promise<void>)(onEvent)
        : Promise.resolve();
    },
    verify: async () => {
      calls.verify += 1;
      if (handlers.verify) await handlers.verify();
    },
    install: async () => {
      calls.install += 1;
      if (handlers.install) await handlers.install();
    },
    cancel: async () => {
      calls.cancel += 1;
      if (handlers.cancel) await handlers.cancel();
    },
    close: async () => {
      calls.close += 1;
      if (handlers.close) await handlers.close();
    },
    openPermissionSettings: async () => {
      calls.permission += 1;
      if (handlers.openPermissionSettings) await handlers.openPermissionSettings();
    },
    onStatus: async (cb) => {
      calls.subscribe += 1;
      cbs.push(cb);
      return () => {
        const i = cbs.indexOf(cb);
        if (i >= 0) cbs.splice(i, 1);
      };
    },
    status: async () => {
      calls.status += 1;
      return handlers.status ? handlers.status() : status({});
    },
  };
  const svc = createAndroidUpdaterService(adapter, { currentVersion: "1.0.0" });
  // 自动订阅后端事件：`onStatus` 的函数体同步登记回调，所以 emitStatus 立即可用。
  void svc.subscribe();
  return {
    svc,
    calls,
    adapter,
    emitStatus: (patch: Partial<AndroidUpdateStatus>) => {
      const s = status(patch);
      for (const cb of [...cbs]) cb(s);
    },
  };
}

/** 走到 ready（下载 + 校验都用立即 resolve 的假实现）。 */
async function toReady(handlers: Handlers = {}) {
  const h = harness(handlers);
  await h.svc.check();
  await h.svc.download();
  assert.equal(h.svc.state.phase, "ready", "前置：应到达 ready");
  return h;
}

test("检查更新：idle→checking→available；没有新版本时 upToDate", async () => {
  const d = deferred<AndroidUpdateInfo | null>();
  const { svc } = harness({ check: () => d.promise });
  assert.equal(svc.state.phase, "idle");
  const p = svc.check();
  assert.equal(svc.state.phase, "checking");
  d.resolve(INFO);
  await p;
  assert.equal(svc.state.phase, "available");
  assert.equal(svc.state.info?.version, "1.1.0");
  assert.equal(svc.state.total, INFO.size, "下载前就应该知道安装包大小");
  assert.equal(svc.state.upToDate, false);

  // 已是最新
  const h2 = harness({ check: async () => null });
  await h2.svc.check();
  assert.equal(h2.svc.state.phase, "idle");
  assert.equal(h2.svc.state.upToDate, true);
});

test("全链转移：available→downloading→verifying→ready→installing(preparing/launching/waiting-user)→installed", async () => {
  const dDownload = deferred<void>();
  const dVerify = deferred<void>();
  const dInstall = deferred<void>();
  const h = harness({
    download: () => dDownload.promise,
    verify: () => dVerify.promise,
    install: () => dInstall.promise,
  });
  const { svc, emitStatus } = h;

  await svc.check();
  assert.equal(svc.state.phase, "available");

  const dp = svc.download();
  assert.equal(svc.state.phase, "downloading");

  dDownload.resolve();
  await flush();
  assert.equal(svc.state.phase, "verifying", "下载完成不等于能装：必须先进校验态");

  dVerify.resolve();
  await dp;
  assert.equal(svc.state.phase, "ready");

  const ip = svc.install();
  assert.equal(svc.state.phase, "installing");
  assert.equal(svc.state.installStep, "preparing");
  // ★ 核心断言：静默期（Kotlin 还在写安装会话）里弹窗必须是 busy，而不是空白。
  assert.equal(isInstallBusy(svc.state), true, "preparing 阶段必须 busy");
  assert.equal(installerTookOver(svc.state), false, "系统安装器还没接管，弹窗不能关");

  dInstall.resolve();
  await ip;
  assert.equal(svc.state.installStep, "launching", "会话提交后进入唤起安装器阶段");
  assert.equal(isInstallBusy(svc.state), true, "launching 阶段仍然 busy");

  emitStatus({ phase: "installing", installStep: "waiting-user", version: "1.1.0" });
  assert.equal(svc.state.installStep, "waiting-user");
  assert.equal(installerTookOver(svc.state), true, "系统确认框已出现，此时才允许关弹窗");
  assert.equal(isInstallBusy(svc.state), false);

  emitStatus({ phase: "installed", version: "1.1.0" });
  assert.equal(svc.state.phase, "installed");
  assert.equal(svc.state.installStep, null);
  assert.equal(svc.state.currentVersion, "1.1.0");
});

test("确认后重复点安装：适配层只被调用一次", async () => {
  const dInstall = deferred<void>();
  const h = await toReady({ install: () => dInstall.promise });
  const { svc, calls, emitStatus } = h;

  const first = svc.install();
  const second = svc.install();
  const third = svc.install();
  assert.equal(calls.install, 1, "两次重复点击不许再发 install 命令");
  assert.equal(svc.state.installStep, "preparing");

  dInstall.resolve();
  await Promise.all([first, second, third]);
  assert.equal(calls.install, 1);

  // 系统安装器已经接管（waiting-user）后再点：依旧不许发命令。
  emitStatus({ phase: "installing", installStep: "waiting-user" });
  await svc.install();
  assert.equal(calls.install, 1);
  // 走到 installed 后再点：也不许。
  emitStatus({ phase: "installed" });
  await svc.install();
  assert.equal(calls.install, 1);
});

test("取消下载：回到可重试的 available，读数清零（后端已删半包）", async () => {
  const dDownload = deferred<void>();
  const h = harness({ download: () => dDownload.promise });
  const { svc, calls } = h;
  await svc.check();
  const dp = svc.download();
  assert.equal(svc.state.phase, "downloading");

  await svc.cancelDownload();
  assert.equal(calls.cancel, 1);
  assert.equal(svc.state.phase, "available");
  assert.equal(svc.state.downloaded, 0);
  assert.equal(svc.state.retry, null);

  // 后端随后把下载 Promise 拒掉（ANDROID_UPDATE_CANCELLED）：不许变成 failed。
  dDownload.reject(new Error("code=ANDROID_UPDATE_CANCELLED：下载已取消"));
  await dp;
  assert.equal(svc.state.phase, "available");
  assert.equal(svc.state.downloaded, 0);
  assert.equal(svc.state.error, null);
});

test("下载失败：落到 failed(network)，retry 重新下载而不是重新检查", async () => {
  let attempt = 0;
  const dFirst = deferred<void>();
  const h = harness({
    download: () => {
      attempt += 1;
      return attempt === 1 ? dFirst.promise : Promise.resolve();
    },
  });
  const { svc, calls } = h;
  await svc.check();
  const dp = svc.download();
  dFirst.reject(new Error("code=ANDROID_UPDATE_NETWORK：连接失败"));
  await dp;
  assert.equal(svc.state.phase, "failed");
  assert.equal(svc.state.errorCode, "network");
  assert.equal(svc.state.retry, "download");
  assert.equal(svc.state.downloaded, 0, "失败的下载不保留半包读数");

  const checksBefore = calls.check;
  await svc.retry();
  assert.equal(calls.check, checksBefore, "重试应重下而不是重新检查");
  assert.equal(calls.download, 2);
  assert.equal(svc.state.phase, "ready");
});

test("校验失败：落到 failed(checksum)，回到可重试（需重新下载）", async () => {
  let verifyAttempt = 0;
  const h = harness({
    verify: async () => {
      verifyAttempt += 1;
      if (verifyAttempt === 1) throw new Error("code=ANDROID_UPDATE_CHECKSUM：sha256 不符");
    },
  });
  const { svc, calls } = h;
  await svc.check();
  // 第一次下载会因校验失败落到 failed；第二次应成功。
  await svc.download();
  assert.equal(svc.state.phase, "failed");
  assert.equal(svc.state.errorCode, "checksum");
  assert.equal(svc.state.retry, "download");
  assert.equal(svc.state.downloaded, 0);

  await svc.retry();
  assert.equal(calls.download, 2);
  assert.equal(svc.state.phase, "ready");
});

test("安装失败：落到 failed(install-failed)，retry 允许再次安装", async () => {
  let installAttempt = 0;
  const h = await toReady({
    install: async () => {
      installAttempt += 1;
      if (installAttempt === 1) throw new Error("code=ANDROID_UPDATE_INSTALL_FAILED：会话创建失败");
    },
  });
  const { svc, calls } = h;
  await svc.install();
  assert.equal(svc.state.phase, "failed");
  assert.equal(svc.state.errorCode, "install-failed");
  assert.equal(svc.state.retry, "install");
  assert.equal(svc.state.installStep, null);
  assert.equal(svc.state.installInFlight, false);

  await svc.retry();
  assert.equal(calls.install, 2);
  assert.equal(svc.state.phase, "installing");
});

test("无权限：failed(permission) → 打开设置 → 后端回推 ready 后可直接重试", async () => {
  const h = await toReady({
    install: async () => {
      throw new Error("code=ANDROID_UPDATE_PERMISSION：需要允许安装未知来源应用");
    },
  });
  const { svc, calls, emitStatus } = h;
  await svc.install();
  assert.equal(svc.state.phase, "failed");
  assert.equal(svc.state.errorCode, "permission");
  assert.equal(svc.state.retry, "install");

  await svc.openPermissionSettings();
  assert.equal(calls.permission, 1);

  // 用户在系统设置里授权后返回：Kotlin 的 onActivityResult → 后端推 ready。
  emitStatus({ phase: "ready", total: INFO.size });
  assert.equal(svc.state.phase, "ready");
  assert.equal(svc.state.error, null);
  assert.equal(svc.state.errorCode, null);

  await svc.install();
  assert.equal(calls.install, 2);
});

test("用户在系统安装界面取消：failed(install-cancelled)，可重试且不卡住", async () => {
  const h = await toReady({ install: async () => {} });
  const { svc, emitStatus } = h;
  await svc.install();
  emitStatus({ phase: "installing", installStep: "waiting-user" });
  emitStatus({
    phase: "failed",
    error: "code=ANDROID_UPDATE_INSTALL_CANCELLED：安装已取消",
    errorCode: "ANDROID_UPDATE_INSTALL_CANCELLED",
  });
  assert.equal(svc.state.phase, "failed");
  assert.equal(svc.state.errorCode, "install-cancelled");
  assert.equal(svc.state.retry, "install");
  assert.equal(svc.state.installStep, null);
  assert.equal(isInstallBusy(svc.state), false);
});

test("重复检查/下载进行中再检查：适配层各只调用一次", async () => {
  const dCheck = deferred<AndroidUpdateInfo | null>();
  const h = harness({ check: () => dCheck.promise });
  const { svc, calls } = h;
  const a = svc.check();
  const b = svc.check();
  assert.equal(calls.check, 1);
  dCheck.resolve(INFO);
  await Promise.all([a, b]);
  assert.equal(svc.state.phase, "available");

  await svc.download();
  assert.equal(svc.state.phase, "ready");
  await svc.check();
  assert.equal(calls.check, 1, "ready 之后也不允许自动重查覆盖已下载的包");
});

test("订阅后端状态：preparing/launching 事件不会把本地 ready 覆盖回去", async () => {
  const h = await toReady();
  const { svc, emitStatus } = h;
  await svc.subscribe();
  emitStatus({ phase: "available", version: "1.1.0" });
  assert.equal(svc.state.phase, "ready");
});
