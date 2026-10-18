import { test } from "node:test";
import assert from "node:assert/strict";
import { saveImageWith, type SaveImageDeps } from "./saveImageCore.ts";

function deps(overrides: Partial<SaveImageDeps> = {}): SaveImageDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    defaultName: () => {
      calls.push("name");
      return "image-1.png";
    },
    pickDestination: async (p) => {
      calls.push(`pick:${p}`);
      return "/tmp/a.png";
    },
    toBase64: async (url) => {
      calls.push(`bytes:${url}`);
      return "YmFzZTY0";
    },
    saveDataFile: async (b, dest) => {
      calls.push(`save:${b}:${dest}`);
    },
    ...overrides,
  };
}

test("成功：选目的地 → 取字节 → 落盘，顺序与入参正确", async () => {
  const d = deps();
  assert.equal(await saveImageWith("blob:x", d), "saved");
  assert.deepEqual(d.calls, [
    "name",
    "pick:image-1.png",
    "bytes:blob:x",
    "save:YmFzZTY0:/tmp/a.png",
  ]);
});

test("桌面取消：null ⇒ cancelled，不取字节、不落盘", async () => {
  const d = deps({ pickDestination: async () => null });
  assert.equal(await saveImageWith("blob:x", d), "cancelled");
  assert.deepEqual(d.calls, ["name"]);
});

test("Android 取消：reject cancel ⇒ cancelled，不抛", async () => {
  const d = deps({
    pickDestination: async () => {
      throw new Error("File picker cancelled");
    },
  });
  assert.equal(await saveImageWith("blob:x", d), "cancelled");
  assert.ok(!d.calls.some((c) => c.startsWith("bytes:")));
});

test("Android SAF 对象形状 {file} 也能落盘", async () => {
  const d = deps({ pickDestination: async () => ({ file: "content://x" }) });
  assert.equal(await saveImageWith("blob:x", d), "saved");
  assert.ok(d.calls.includes("save:YmFzZTY0:content://x"));
});

test("空字符串/空对象 ⇒ cancelled", async () => {
  for (const picked of ["", {}, { file: "" }]) {
    const d = deps({ pickDestination: async () => picked });
    assert.equal(await saveImageWith("blob:x", d), "cancelled");
  }
});

test("非取消错误原样抛出，且不取字节", async () => {
  const d = deps({
    pickDestination: async () => {
      throw new Error("permission denied");
    },
  });
  await assert.rejects(() => saveImageWith("blob:x", d), /permission denied/);
  assert.ok(!d.calls.some((c) => c.startsWith("bytes:")));
});
