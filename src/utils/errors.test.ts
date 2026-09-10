import { test } from "node:test";
import assert from "node:assert/strict";
import { friendlyError, rawErrorMessage, reportError } from "./errors.ts";

test("取错误文本：Error / string / null", () => {
  assert.equal(rawErrorMessage(new Error("boom")), "boom");
  assert.equal(rawErrorMessage("直接字符串"), "直接字符串");
  assert.equal(rawErrorMessage(null), "");
  assert.equal(rawErrorMessage(undefined), "");
});

test("公钥缺失：换成带「自动补发」的可行动说明（不透出 device_id）", () => {
  const e = "尚未获取 gosslan-a1b2c3 的公钥：对方可能离线或处于不同子网";
  const out = friendlyError(e, "发送失败");
  assert.equal(
    out,
    "发送失败：对方尚未上线，暂时无法加密发送。消息已保留，对方上线后会自动补发",
  );
  assert.ok(!out.includes("gosslan-a1b2c3"), "不应把设备指纹透给用户");
});

test("已经是给用户看的中文说明 → 原样保留，不做无用改写", () => {
  assert.equal(
    friendlyError("对方不是好友，请先扫描添加好友之后再继续聊天。", "发送失败"),
    "发送失败：对方不是好友，请先扫描添加好友之后再继续聊天。",
  );
  assert.equal(friendlyError("头像不能超过 2MB", "保存失败"), "保存失败：头像不能超过 2MB");
});

test("英文技术串（OS / 库错误）→ 通用文案，不外露原文", () => {
  const out = friendlyError("No such file or directory (os error 2)", "保存图片失败");
  assert.equal(out, "保存图片失败：系统或网络暂时不可用，请稍后重试");
  assert.ok(!out.includes("os error"));
  assert.equal(
    friendlyError("Connection refused", "转发失败"),
    "转发失败：系统或网络暂时不可用，请稍后重试",
  );
});

test("Rust panic 一类的堆栈线索不外露", () => {
  const out = friendlyError("called `unwrap()` on a `None` value at src/db.rs:120", "加载失败");
  assert.equal(out, "加载失败，请稍后重试");
});

test("端口占用给出具体解释", () => {
  assert.equal(
    friendlyError("TCP 绑定 0.0.0.0:59992 失败：端口被占用", "开启失败"),
    "开启失败：端口被占用，可能已有一个 Gosslan 实例在运行",
  );
});

test("空错误 / 无 info → 前缀 + 请稍后重试", () => {
  assert.equal(friendlyError(null, "操作失败"), "操作失败，请稍后重试");
  assert.equal(friendlyError("", "操作失败"), "操作失败，请稍后重试");
  assert.equal(friendlyError(undefined, "删除失败"), "删除失败，请稍后重试");
});

test("reportError 返回与 friendlyError 相同，且只对技术串写 console", () => {
  const calls: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => calls.push(a);
  try {
    const friendly = reportError("对方不是好友", "发送失败");
    assert.equal(friendly, "发送失败：对方不是好友");
    assert.equal(calls.length, 0, "已是人话的错误不应再打 console 噪音");

    reportError("os error 2", "保存失败");
    assert.equal(calls.length, 1, "技术串必须留下排查线索");
  } finally {
    console.warn = orig;
  }
});
