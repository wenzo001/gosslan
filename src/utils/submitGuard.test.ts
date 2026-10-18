import assert from "node:assert/strict";
import test from "node:test";
import { useSubmitGuard } from "../composables/useSubmitGuard.ts";

test("并发提交只放行第一次，第二次直接返回 undefined", async () => {
  const { busy, run } = useSubmitGuard();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });

  const first = run(async () => {
    calls += 1;
    await gate;
    return "first";
  });
  const second = run(async () => {
    calls += 1;
    return "second";
  });

  assert.equal(busy.value, true, "在途期间 busy 必须为 true（按钮 disabled 读它）");
  assert.equal(await second, undefined, "第二次提交必须被挡住");
  release();
  assert.equal(await first, "first");
  assert.equal(calls, 1, "被挡住的提交不能执行 fn");
  assert.equal(busy.value, false, "结束后必须复位");
});

test("提交失败也复位，下一次仍可提交", async () => {
  const { busy, run } = useSubmitGuard();
  await assert.rejects(
    run(async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(busy.value, false);
  assert.equal(await run(async () => 1), 1);
});
