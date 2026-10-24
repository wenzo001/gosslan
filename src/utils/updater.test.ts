// 更新状态机的行为真值表：离线/超时/取消/重复点击/下载失败/安装/稍后。
// 跑法：node --test src/utils/updater.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  createUpdaterService,
  UPDATER_CANCELLED,
  type DownloadEvent,
  type UpdateInfo,
  type UpdaterAdapter,
} from "../updater/service.ts";

const INFO: UpdateInfo = {
  currentVersion: "5.4.1",
  version: "5.5.0",
  notes: "notes",
  publishedAt: 1_700_000_000,
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

function fake(overrides: Partial<UpdaterAdapter> = {}) {
  const calls = { check: 0, download: 0, cancel: 0, install: 0, close: 0 };
  const adapter: UpdaterAdapter = {
    check: async () => {
      calls.check += 1;
      return overrides.check ? overrides.check() : null;
    },
    download: (onEvent) => {
      calls.download += 1;
      return overrides.download ? overrides.download(onEvent) : Promise.resolve();
    },
    cancel: async () => {
      calls.cancel += 1;
      if (overrides.cancel) await overrides.cancel();
    },
    install: async () => {
      calls.install += 1;
      if (overrides.install) await overrides.install();
    },
    close: async () => {
      calls.close += 1;
      if (overrides.close) await overrides.close();
    },
  };
  return { adapter, calls };
}

function service(adapter: UpdaterAdapter, checkTimeoutMs = 100) {
  return createUpdaterService(adapter, { currentVersion: "5.4.1", checkTimeoutMs });
}

test("发现新版本：进入 available，并保留版本/说明/时间", async () => {
  const { adapter } = fake({ check: async () => INFO });
  const s = service(adapter);
  await s.check(true);
  assert.equal(s.state.phase, "available");
  assert.deepEqual(s.state.info, INFO);
  assert.equal(s.state.error, null);
});

test("手动检查无更新 → up-to-date；自动检查无更新 → 静默 idle", async () => {
  const { adapter } = fake({ check: async () => null });
  const manual = service(adapter);
  await manual.check(true);
  assert.equal(manual.state.phase, "up-to-date");
  const auto = service(adapter);
  await auto.check(false);
  assert.equal(auto.state.phase, "idle");
  assert.equal(auto.state.error, null);
});

test("离线/网络失败：手动给可读错误，自动检查静默（不弹窗、不写 error）", async () => {
  const { adapter } = fake({
    check: async () => {
      throw new Error("dns error: network unreachable");
    },
  });
  const manual = service(adapter);
  await manual.check(true);
  assert.equal(manual.state.phase, "error");
  assert.equal(manual.state.error, "network");

  const auto = service(adapter);
  await auto.check(false);
  assert.equal(auto.state.phase, "idle");
  assert.equal(auto.state.error, null);
});

test("检查请求超时：在时限内结束，手动显示 timeout，自动静默", async () => {
  const hang = new Promise<UpdateInfo | null>(() => {});
  const { adapter } = fake({ check: () => hang });
  const manual = service(adapter, 10);
  const started = Date.now();
  await manual.check(true);
  assert.ok(Date.now() - started < 1000, "超时必须有限，不能挂住");
  assert.equal(manual.state.phase, "error");
  assert.equal(manual.state.error, "timeout");

  const auto = service(adapter, 10);
  await auto.check(false);
  assert.equal(auto.state.phase, "idle");
  assert.equal(auto.state.error, null);
});

test("重复点击检查：单飞，只发一次请求，两次调用拿到同一个结果", async () => {
  const d = deferred<UpdateInfo | null>();
  const { adapter, calls } = fake({ check: () => d.promise });
  const s = service(adapter);
  const a = s.check(true);
  const b = s.check(true);
  assert.equal(calls.check, 1, "第二次点击不能新建任务");
  d.resolve(INFO);
  await Promise.all([a, b]);
  assert.equal(s.state.phase, "available");
  assert.equal(calls.check, 1);
});

test("下载进度：Started/Progress/Finished 累加，完成后 ready", async () => {
  const { adapter, calls } = fake({
    check: async () => INFO,
    download: async (onEvent: (e: DownloadEvent) => void) => {
      onEvent({ event: "Started", data: { contentLength: 1000 } });
      onEvent({ event: "Progress", data: { chunkLength: 400 } });
      onEvent({ event: "Progress", data: { chunkLength: 600 } });
      onEvent({ event: "Finished" });
    },
  });
  const s = service(adapter);
  await s.check(true);
  await s.download();
  assert.equal(calls.download, 1);
  assert.equal(s.state.phase, "ready");
  assert.equal(s.state.downloaded, 1000);
  assert.equal(s.state.total, 1000);
});

test("重复点击下载：单飞；下载完成后才允许安装", async () => {
  const d = deferred<void>();
  const { adapter, calls } = fake({
    check: async () => INFO,
    download: () => d.promise,
  });
  const s = service(adapter);
  await s.check(true);
  const a = s.download();
  const b = s.download();
  assert.equal(calls.download, 1);
  assert.equal(s.state.phase, "downloading");
  d.resolve();
  await Promise.all([a, b]);
  assert.equal(s.state.phase, "ready");
  await s.install();
  assert.equal(calls.install, 1);
});

test("取消下载：适配器真收到 cancel，下载以 CANCEL 结束，回到可重试状态", async () => {
  const d = deferred<void>();
  const { adapter, calls } = fake({
    check: async () => INFO,
    download: () => d.promise,
    cancel: async () => {
      d.reject(new Error(UPDATER_CANCELLED));
    },
  });
  const s = service(adapter);
  await s.check(true);
  const downloading = s.download();
  await Promise.resolve();
  await s.cancel();
  await downloading;
  assert.equal(calls.cancel, 1);
  assert.equal(s.state.phase, "available");
  assert.equal(s.state.error, null);
  // 取消后还能重新下载。
  const second = fake({
    check: async () => INFO,
    download: async () => {},
  });
  const s2 = service(second.adapter);
  await s2.check(true);
  await s2.download();
  assert.equal(s2.state.phase, "ready");
});

test("下载失败：错误可读，保留更新信息以便重试", async () => {
  const { adapter } = fake({
    check: async () => INFO,
    download: async () => {
      throw new Error("签名校验失败 signature mismatch");
    },
  });
  const s = service(adapter);
  await s.check(true);
  await s.download();
  assert.equal(s.state.phase, "error");
  assert.equal(s.state.error, "signature");
  assert.equal(s.state.info?.version, "5.5.0");
});

test("清单版本不高于当前：拒绝并显示 downgrade（不能落到笼统的 unknown）", async () => {
  const { adapter } = fake({
    check: async () => {
      throw new Error(
        "code=UPDATER_DOWNGRADE_BLOCKED：清单版本 5.4.0 不高于当前 5.4.1，已拒绝（禁止降级）",
      );
    },
  });
  const s = service(adapter);
  await s.check(true);
  assert.equal(s.state.phase, "error");
  assert.equal(s.state.info, null, "被拒的版本不许留在界面上（否则还能点下载）");
  assert.equal(s.state.error, "downgrade");
});

test("稍后：释放后端资源、清掉更新卡片，不留下继续下载的任务", async () => {
  const { adapter, calls } = fake({ check: async () => INFO });
  const s = service(adapter);
  await s.check(true);
  s.dismiss();
  assert.equal(calls.close, 1);
  assert.equal(s.state.info, null);
  assert.equal(s.state.phase, "idle");
  assert.equal(s.state.dismissedVersion, "5.5.0");
});

test("安装：把当前版本推进到新版本；失败则回到 error 且不谎报成功", async () => {
  const { adapter, calls } = fake({
    check: async () => INFO,
    download: async () => {},
  });
  const s = service(adapter);
  await s.check(true);
  await s.download();
  await s.install();
  assert.equal(calls.install, 1);
  assert.equal(s.state.phase, "up-to-date");
  assert.equal(s.state.currentVersion, "5.5.0");

  const bad = fake({
    check: async () => INFO,
    download: async () => {},
    install: async () => {
      throw new Error("install failed");
    },
  });
  const s2 = service(bad.adapter);
  await s2.check(true);
  await s2.download();
  await s2.install();
  assert.equal(s2.state.phase, "error");
  assert.equal(s2.state.error, "unknown");
});

// ---------------- 跨窗口恢复（B5）：重开的窗口按后端快照补齐 ----------------

/**
 * `restore()` 守住的是"设置窗重开不装失忆"这件事的产品行为：
 * 以前每窗口一份 UI 状态、下载在后端全局跑 ⇒ 重开只看到"检查更新"。
 * 四条边界缺一不可：下载中要恢复、下完要恢复、**本窗口更细的进度不许被粗快照盖掉**、
 * 终态/未知相位不该把本窗口拖出 idle。
 */
test("恢复：downloading 快照 ⇒ 相位与已下字节都对上", () => {
  const svc = service(fake().adapter);
  svc.restore({ phase: "downloading", downloaded: 40, total: 100, version: "5.5.0" });
  assert.equal(svc.state.phase, "downloading");
  assert.equal(svc.state.downloaded, 40);
  assert.equal(svc.state.total, 100);
  assert.equal(svc.state.info?.version, "5.5.0", "目标版本要跟着恢复（卡片上显示的就是它）");
});

test("恢复：ready 快照 ⇒ 已下字节补到 total（安装按钮才有意义）", () => {
  const svc = service(fake().adapter);
  svc.restore({ phase: "ready", downloaded: 0, total: 512, version: "5.5.0" });
  assert.equal(svc.state.phase, "ready");
  assert.equal(svc.state.downloaded, 512);
});

test("恢复：本窗口已经在跑（非 idle）时**不许**被粗快照覆盖", async () => {
  // 用"检查到更新"把本窗口推进到非 idle（available）——那之后它的 info 才是权威。
  const svc = service(fake({ check: async () => INFO }).adapter);
  await svc.check(true);
  assert.equal(svc.state.phase, "available");
  svc.restore({ phase: "downloading", downloaded: 0, total: 999, version: "9.9.9" });
  assert.equal(svc.state.phase, "available", "相位不许被粗快照改写");
  assert.equal(svc.state.info?.version, INFO.version, "粗粒度快照不许盖掉本窗口更细的读数");
});

test("恢复：终态/未知相位不把本窗口拖出 idle", () => {
  for (const phase of ["idle", "checking", "failed", "cancelled", "unsupported"]) {
    const svc = service(fake().adapter);
    svc.restore({ phase, downloaded: 10, total: 20, version: "5.5.0" });
    assert.equal(svc.state.phase, "idle", `${phase} 不该被恢复成一个可交互的中间态`);
  }
});
