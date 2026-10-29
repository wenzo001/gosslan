/**
 * 错误**分类器**的判据。
 *
 * 这里只判"分成哪一类、给哪个键"—— 文案已经搬到 i18n 词典（拼装那一格在
 * `composables/useErrorText.ts`，它 import `@/i18n` 因而不能被 node --test 直接吃）。
 * 于是这一本反而比原来更硬：**分类与文案不再混在一句断言里**，改词典不会红、
 * 改分类必红；而"键在不在词典里"由下面那条现扫生产码的判据兜住。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyError, errorCode, ERROR_CODE_RULES, isTechnicalError, MessageKeyError, rawErrorMessage, stripErrorCode } from "./errors.ts";
import { enUS, zhCN } from "../i18n/locales.ts";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("取错误文本：Error / string / null", () => {
  assert.equal(rawErrorMessage(new Error("boom")), "boom");
  assert.equal(rawErrorMessage("直接字符串"), "直接字符串");
  assert.equal(rawErrorMessage(null), "");
  assert.equal(rawErrorMessage(undefined), "");
});

test("自家抛出的错误带词典键，插值数据一个都不丢", () => {
  const e = new MessageKeyError("errors.image.httpFail", { status: 404 });
  assert.deepEqual(classifyError(e), { kind: "copy", key: "errors.image.httpFail", params: { status: 404 } });
  // 键不是"人话"，也不该被当成技术串写进 console（它是给用户看的句子的身份证号）。
  assert.equal(isTechnicalError(e), false);
});

test("公钥缺失 → 自动补发那一档（不再透出 device_id 那一串）", () => {
  const e = "尚未获取 gosslan-a1b2c3 的公钥：对方可能离线或处于不同子网";
  assert.deepEqual(classifyError(e), { kind: "copy", key: "errors.rule.pubkey" });
});

test("已经是给用户看的中文说明 → 原样透传，不做无用改写", () => {
  assert.deepEqual(classifyError("对方不是好友，请先扫描添加好友之后再继续聊天。"), {
    kind: "human",
    detail: "对方不是好友，请先扫描添加好友之后再继续聊天。",
  });
});

test("英文技术串（OS / 库错误）→ 系统那一档，不外露原文", () => {
  assert.deepEqual(classifyError("No such file or directory (os error 2)"), {
    kind: "copy",
    key: "errors.rule.system",
  });
  assert.deepEqual(classifyError("Connection refused"), { kind: "copy", key: "errors.rule.system" });
});

test("Rust panic 一类：既不透传也不给规则，只剩「请稍后重试」", () => {
  assert.deepEqual(classifyError("called `unwrap()` on a `None` value at src/db.rs:120"), {
    kind: "retry",
  });
  assert.equal(isTechnicalError("called `unwrap()` on a `None` value at src/db.rs:120"), true);
});

test("端口占用给出具体那一档", () => {
  assert.deepEqual(classifyError("TCP 绑定 0.0.0.0:59992 失败：端口被占用"), {
    kind: "copy",
    key: "errors.rule.port",
  });
});

test("空错误 / 无 info → 请稍后重试那一档", () => {
  assert.deepEqual(classifyError(null), { kind: "retry" });
  assert.deepEqual(classifyError(""), { kind: "retry" });
  assert.deepEqual(classifyError(undefined), { kind: "retry" });
  assert.equal(isTechnicalError(null), false, "没有原文就别往 console 里打空行");
});

test("已是人话的错误不打 console 噪音，技术串才留线索", () => {
  assert.equal(isTechnicalError("对方不是好友"), false);
  assert.equal(isTechnicalError("os error 2"), true);
});

/**
 * 抛出去的键必须真存在于中英两册（`t()` 的回落是"把键原样上屏" ⇒ 漏一条就是一句英文
 * 界面里的 `errors.avatar.stillTooLarge`）。i18n 那本调用点判据只扫 `t("...")` 字面量，
 * 扫不到 `new MessageKeyError("...")` ⇒ 这一条补的是它管不着的那半个家。
 */
test("生产码里抛出的 errors.* 键都在中英词典里", () => {
  const thrown = new Set<string>();
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "i18n") continue; // 词典本体不扫
        walk(p);
        continue;
      }
      if (!/\.(ts|vue)$/.test(ent.name) || ent.name.includes(".test.")) continue;
      const src = fs.readFileSync(p, "utf8");
      for (const m of src.matchAll(/new MessageKeyError\(\s*"([^"]+)"/g)) thrown.add(m[1]);
    }
  };
  walk(SRC);
  const rules = ["errors.rule.pubkey", "errors.rule.port", "errors.rule.system"];
  const all = [...thrown, ...rules].sort();
  assert.ok(all.length >= 7, `只扫到 ${all.length} 个键 ⇒ 分母变小，先确认是不是被改掉了`);
  for (const k of all) {
    assert.ok(k in zhCN, `中文词典缺 ${k}`);
    assert.ok(k in enUS, `英文词典缺 ${k}`);
    // 拼装那两把模板也要在（分类器不再自带任何一句话）。
  }
  for (const k of ["errors.joined", "errors.retry"]) {
    assert.ok(k in zhCN && k in enUS, `拼装模板 ${k} 不在词典里`);
  }
});


/**
 * **码优先**（INV-P16 窄口，2026-10-29）。
 *
 * 这一族原来只有一条判据能表达"这话说什么档"：后端那句中文里有没有"公钥"两个字。
 * 于是把"公钥"改成"身份密钥"这种**纯文案改动**会把用户提示从"不用重发，先让对方上线"
 * 悄悄换成"请稍后重试" —— 不报错、不进日志、桌面跑一遍看不出来。
 */
test("码优先：后端换了那句人话的说法，档位不许跟着换（带反向对照）", () => {
  const coded = classifyError("code=E2EE_PUBKEY_MISSING 对端身份密钥暂时拿不到，请先让对方上线");
  assert.deepEqual(coded, { kind: "copy", key: "errors.rule.pubkey" }, "认到码就走那一档，与措辞无关");
  // 反向对照：同样的措辞、**没有码** ⇒ 落到"透传给人看"那一档。
  // 少了这一格，上一条可能只是"任何中文串都返回 pubkey 那一档"的假绿。
  const noCode = classifyError("对端身份密钥暂时拿不到，请先让对方上线");
  assert.equal(noCode.kind, "human", "没码时不该凭空认出 pubkey 那一档（否则码优先那条是空转）");
  const portCoded = classifyError("code=PORT_IN_USE 59992 这个监听口已被别的过程占着");
  assert.deepEqual(portCoded, { kind: "copy", key: "errors.rule.port" }, "端口那一档同样按码认");
});

test("码只给我们看：任何一档都不许把 code=… 带上屏", () => {
  const v = classifyError("code=NOT_IMPLEMENTED_YET 磁盘已满，请清理后再试");
  assert.equal(v.kind, "human", "不认识的码仍然要能给人看那句话");
  assert.equal(v.kind === "human" && v.detail.includes("code="), false, `码泄漏到界面上了：${JSON.stringify(v)}`);
  assert.equal(stripErrorCode("code=PORT_IN_USE 端口被占用"), "端口被占用");
  assert.equal(errorCode("端口被占用"), null, "没有码时必须返回 null，不能把整串当码");
});

/**
 * **跨语言对账**：前端读的码必须都由后端产出，后端产出的码必须都有人用。
 *
 * 分母从 `error_codes.rs` 现读（不手抄清单 —— 手抄的那份一定会漂），
 * 并用"一个不存在的码必须数到 0 次引用"当阳性对照，证明引用计数器真的会说"没有"。
 */
test("跨语言契约：错误码两侧同源（前端读的码 ⊆ 后端产出的码，且后端每个码都被用到）", () => {
  const rustDir = path.join(SRC, "..", "src-tauri", "src");
  const defs = path.join(rustDir, "error_codes.rs");
  const src = fs.readFileSync(defs, "utf8");
  const defined = [...src.matchAll(/^pub const ([A-Z0-9_]+): &str = /gm)].map((m) => m[1]);
  assert.ok(defined.length >= 2, `后端错误码只解析到 ${defined.length} 个 ⇒ 提取器坏了（形状变了？）`);

  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".rs")) files.push(p);
    }
  };
  walk(rustDir);
  const usesOf = (code: string) =>
    files.reduce(
      (n, f) => n + (f.endsWith("error_codes.rs") ? 0
        : (fs.readFileSync(f, "utf8").match(new RegExp(`error_codes::${code}\\b`, "g")) ?? []).length),
      0,
    );
  assert.equal(usesOf("E2EE_PUBKEY_MISSING") > 0, true, "阳性对照：真有引用的码要数得到");
  assert.equal(usesOf("THIS_CODE_IS_NOT_USED_ANYWHERE"), 0, "计数器必须会说『0 处』（否则下面那条恒绿）");

  const dead = defined.filter((c) => usesOf(c) === 0);
  assert.deepEqual(dead, [], `后端定义了但没人用的码（那是一条已经失效的契约）：${dead.join(", ")}`);

  const orphans = Object.keys(ERROR_CODE_RULES).filter((c) => !defined.includes(c));
  assert.deepEqual(orphans, [], `前端读了后端不产出的码：${orphans.join(", ")}`);
});
