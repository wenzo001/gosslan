import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileFailReasonCodes, fileFailReasonText } from "./fileFailReason.ts";
import { tsFnBody } from "./tsSource.ts";
import { zhCN, enUS } from "../i18n/locales.ts";

const ROOT = join(import.meta.dirname, "../..");

/** 假词典：只认一条，用来验证"查表 + 回落"这两条路径。 */
const fakeT = (key: string) => (key === "file.diskFull" ? "磁盘空间不足" : key);

test("已知失败码翻成可行动文案（而不是原始英文 io 消息）", () => {
  const text = fileFailReasonText("DISK_FULL", fakeT);
  assert.equal(text, "磁盘空间不足");
  assert.notEqual(
    text,
    "No space left on device (os error 28)",
    "盘满必须给出可行动文案，而不是把英文 io 错误原样上屏",
  );
});

test("未知 reason 原样返回（绝不空白、绝不 undefined）", () => {
  assert.equal(fileFailReasonText("文件传输未完成", fakeT), "文件传输未完成");
  assert.equal(fileFailReasonText("", fakeT), "");
  // 词典缺这条（后端加了码但前端忘了加文案）⇒ 回落成原始 reason，
  // 而不是把 key 本身印到界面上。
  const t = (k: string) => (k === "file.diskFull" ? "" : k);
  assert.equal(fileFailReasonText("DISK_FULL", t), "DISK_FULL");
});

test("失败码表与中英词典一致（每条都有文案、都不留死文案）", () => {
  const codes = fileFailReasonCodes();
  assert.ok(codes.length > 0, "失败码表空了 ⇒ 量具本身失效");
  for (const code of codes) {
    // 真实词典里必须真有这一条 ⇒ 走一遍真实映射。
    const zh = fileFailReasonText(code, (k) => zhCN[k] ?? k);
    const en = fileFailReasonText(code, (k) => enUS[k] ?? k);
    assert.notEqual(zh, code, `码 ${code} 在中文词典里没有文案`);
    assert.notEqual(en, code, `码 ${code} 在英文词典里没有文案`);
  }
});

/**
 * 消息气泡的原因码（`messages.fail_code`，DB v14→v15）是**另一条通道**上的同一件事：
 * 它不走 `file-failed` 事件，而是落库后随消息读回来 —— 所以两侧都必须有它，
 * 且**多出来的那一侧要能被看见**：
 *  · 后端有、前端表没有 ⇒ 那条失败在界面上只能回落到通用文案（用户看不见已有的原因）；
 *  · 前端有、后端数组没有 ⇒ 那是一行永远不会被命中的死文案（本仓判过"已失效的契约"）。
 *
 * 分母从 `error_codes.rs` 现解析（不手抄清单），并钉住常量名与字面量**逐字相同**：
 * 库里存的就是这个字符串，两侧一旦分叉，读回来就匹配不上。
 */
test("消息失败码两侧同源（后端数组 ⊆ 前端表，前端多出来的也要被看见）", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/error_codes.rs"), "utf8");
  const arr = rust.match(
    /pub const MESSAGE_FAIL_CODES:\s*\[&str;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/,
  );
  assert.ok(arr, "没解析到 MESSAGE_FAIL_CODES ⇒ 提取器失效（形状变了？）");
  const declared = Number(arr[1]);
  const names = arr[2]
    .split(",")
    .map((s) => s.trim().replace(/,.*$/, ""))
    .filter((s) => /^[A-Z0-9_]+$/.test(s));
  assert.equal(names.length, declared, `数组写了 ${declared} 格、实际解析到 ${names.length} 个`);

  // 每个常量的字面量必须与常量名逐字相同（库里存的就是这个串）。
  const values: string[] = [];
  for (const name of names) {
    const def = rust.match(new RegExp(`pub const ${name}: &str = "([^"]+)"`));
    assert.ok(def, `${name} 没有对应的 pub const 字面量 ⇒ 分母读错了一半`);
    assert.equal(def[1], name, `${name} 的名字与字面量分叉：库里存的是 "${def[1]}"`);
    values.push(def[1]);
  }
  assert.ok(values.length >= 4, `只解析到 ${values.length} 个消息失败码 ⇒ 量具空转`);
  // 阳性对照：提取器必须会说"没有"（否则下面两条恒绿）。
  assert.equal(values.includes("SEND_THIS_CODE_DOES_NOT_EXIST"), false);

  const tsCodes = fileFailReasonCodes();
  const missing = values.filter((c) => !tsCodes.includes(c));
  assert.deepEqual(missing, [], `后端会写进库、前端表里没有的码：\n${missing.join("\n")}`);
  // 反向那一格：前端只许认识后端**真会写**的码。
  // ★ 5.15.32 的 review 抓到原来这一腿写成 `startsWith("SEND_")` —— 那是词表还只有四条时的名字约定，
  //   等 `FILE_SEND_*` / `GROUP_FILE_*` 进来后，12 档里 10 档不在它的视野里 ⇒ "死文案"那一半恒绿。
  //   分母因此取**两个家的并集**（落库词表 + 事件载荷族），不再看前缀。
  const loggingCodes = [
    ...readFileSync(join(ROOT, "src-tauri/src/logging.rs"), "utf8").matchAll(
      /pub\(crate\) const FAIL_CODE_[A-Z_]+:\s*&str\s*=\s*"([A-Z_]+)"/g,
    ),
  ].map((m) => m[1]);
  const backend = [...new Set([...values, ...loggingCodes])];
  const orphans = (rustSide: string[]) => tsCodes.filter((c) => !rustSide.includes(c) && backend.includes(c) === false);
  const dead = tsCodes.filter((c) => !backend.includes(c));
  assert.deepEqual(dead, [], "前端表里有、后端任何一家都不写的码（死文案）");
  // 上面那条判据自己也要被证明不是空转：从并集里拿掉一个**真存在**的码，必须被它抓出来。
  const probe = backend.filter((c) => c !== backend[backend.length - 1]);
  assert.deepEqual(
    tsCodes.filter((c) => !probe.includes(c) && backend.includes(c)),
    [backend[backend.length - 1]],
    "反向那格在少一个码时必须报出那一个（否则它就是恒绿的）",
  );
  assert.ok(orphans(backend).length === 0);
});

/**
 * 界面必须**两种状态都说得清**：有码 ⇒ 说原因；没码 ⇒ 只说"发送失败"。
 * 这条钉住那一句"没码不是 bug"的回落，别让它哪天变成把裸码念给用户。
 */
test("没有原因码时回落到通用文案，有码时接在后面", () => {
  const withCode = t2("msg.sendFailedWith", { reason: fileFailReasonText("SEND_PEER_DELETED", t2) });
  assert.ok(withCode.includes("好友"), `有码必须说得出为什么：${withCode}`);
  assert.ok(!withCode.includes("SEND_"), `裸码不许上屏：${withCode}`);
  assert.equal(t2("msg.sendFailed"), "发送失败");
  // 未知码走原始回落（宁可显示后端原文，也不显示空白）：
  assert.equal(fileFailReasonText("SEND_FUTURE_CODE", t2), "SEND_FUTURE_CODE");
});

function t2(key: string, params?: Record<string, string | number>): string {
  const raw = (zhCN as Record<string, string>)[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

/**
 * 消费侧必须真的接上（这一层跑不了 vue，所以按源码钉 —— 与 `designGuards` 那族同一种量具）。
 *
 * 为什么值得钉：`fail_code` 是**落库的一侧**，`fileFailReasonText` 是**查表的一侧**，
 * 中间那根线（failed 分支读这一列）没接上时，上面所有对账全绿而界面一个字都没变 ——
 * 那正是"编译过、门禁绿、功能为零"的假字段形状。
 */
test("失败气泡的 tooltip 真的读 fail_code 并查这张表（正控：撤掉那一支必须报出来）", () => {
  const src = readFileSync(join(ROOT, "src/composables/useMessageDisplay.ts"), "utf8");
  const RE = /case "failed":[\s\S]{0,600}?message\.value\.fail_code[\s\S]{0,200}?fileFailReasonText\([\s\S]{0,120}?\}/;
  assert.ok(RE.test(src), "failed 分支没有「读 fail_code → 查表 → 拼进 msg.sendFailedWith」这一串");
  assert.match(src, /t\("msg\.sendFailed"\)/, "没码时那一格回落（通用文案）不许被顺手删掉");
  // 正控：把原因那一半摘掉（退回本轮之前的写法），同一把尺子必须说"不"。
  const gutted = src.replace(/const code = message\.value\.fail_code;[\s\S]{0,220}?return t\("msg\.sendFailed"\);/, 'return t("msg.sendFailed");');
  assert.notEqual(gutted, src, "变异没落进源码 —— 这条正控不作数（锚点写法变了）");
  assert.equal(RE.test(gutted), false, "摘掉 fail_code 之后仍然匹配 ⇒ 这把尺子在空集上恒绿");
});

/**
 * 两侧对账：后端定义码、前端按码查表 —— 这是一份**跨语言契约**。
 *
 * 手抄清单会漂（后端加码忘了改前端 ⇒ 用户看到裸码 "DISK_FULL" 上屏）。
 * 所以分母从源码现解析：后端 `logging.rs` 里的 `FAIL_CODE_*` 常量 vs 前端表的键。
 * （`file-failed` 事件那一族走这里；落库的 `messages.fail_code` 在上面那条里对账。）
 */
test("前后端失败码逐条对账（后端加码必须同步前端表）", () => {
  const rust = readFileSync(join(ROOT, "src-tauri/src/logging.rs"), "utf8");
  const rustCodes = [...rust.matchAll(/pub\(crate\) const FAIL_CODE_[A-Z_]+:\s*&str\s*=\s*"([A-Z_]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(rustCodes.length > 0, "后端没解析到任何失败码 ⇒ 判据失效（写法变了？）");
  const tsCodes = fileFailReasonCodes();
  const missing = rustCodes.filter((c) => !tsCodes.includes(c));
  assert.deepEqual(
    missing,
    [],
    `后端有、前端表没有的失败码 ⇒ 界面上会显示裸码：\n${missing.join("\n")}`,
  );
});

/**
 * `file-failed` 的 `reason` **不许是硬编码文案**。
 *
 * 为什么单独钉这一条：前端对未知 reason 的处理是**原样上屏**（那是刻意的回落，
 * 宁可显示后端原文也不显示空白）。所以后端塞一句中文，英文界面那格就直接是中文 ——
 * 而这个缺陷不会编译错、不会让上面那条对账红（对账只看码），界面上也只是"另一种语言"，
 * 没有断言。5.15.29 就是把 outbox 过期那一格的硬编码中文换成 `FILE_SEND_EXPIRED` 码，
 * 这条判据守的是"别换回去、也别往别处加新的"。
 *
 * 判据是形状：`FileFailedInfo` 的构造点里 `reason:` 若是**字面量**，必须是稳定码形状
 * （大写/数字/下划线 —— 后端那个同名谓词已在 5.15.32 拆成显式名单，这里只借用它的形状口径）；
 * 变量与 `FAIL_CODE_*` 常量引用不在静态可判范围内，因此不在禁止之列。
 */
function findProseFailReasons(rustSrc: string): string[] {
  const out: string[] = [];
  // 只看点上 FileFailedInfo 的那个构造，避免把日志里的中文当成载荷（日志是给人读的，那里中文是对的）
  for (const m of rustSrc.matchAll(/FileFailedInfo\s*\{[\s\S]{0,220}?\}/g)) {
    const block = m[0];
    const reason = block.match(/reason:\s*"([^"]*)"/);
    if (reason && !/^[A-Z0-9_]+$/.test(reason[1])) out.push(reason[1]);
  }
  return out;
}

test("file-failed 载荷里不许出现硬编码文案（英文界面会原样上屏）", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".rs")) files.push(full);
    }
  };
  walk(join(ROOT, "src-tauri/src"));
  let sites = 0;
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    sites += [...text.matchAll(/FileFailedInfo\s*\{/g)].length;
    for (const bad of findProseFailReasons(text)) {
      offenders.push(`${f.slice(join(ROOT, "src-tauri/src").length + 1)}: "${bad}"`);
    }
  }
  // 下限：构造点必须真被看见（0 个 ⇒ 提取器失效，这条就变成空集恒绿）
  assert.ok(sites >= 3, `只扫到 ${sites} 处 FileFailedInfo 构造 ⇒ 提取器或形状变了，这条判据在空转`);
  assert.deepEqual(offenders, [], "把文案写进了事件载荷：界面按码查表，中文只该活在词典与日志里");
  // 正控：合成一份"中文塞进 reason"的源码，必须被抓到
  const buggy =
    'let _ = app.emit("file-failed", &FileFailedInfo {\n    transfer_id: id,\n    reason: "文件发送超时：超过重发期限仍未送达".to_string(),\n});';
  assert.deepEqual(findProseFailReasons(buggy), ["文件发送超时：超过重发期限仍未送达"]);
  // 反控：发码的写法不许被误判；日志里的中文也不在判据范围内
  const ok =
    'let _ = app.emit("file-failed", &FileFailedInfo {\n    transfer_id: id,\n    reason: crate::logging::FAIL_CODE_FILE_SEND_EXPIRED.to_string(),\n});';
  assert.deepEqual(findProseFailReasons(ok), []);
  assert.deepEqual(
    findProseFailReasons('logger.warn("outbox", "文件发送超时：这条只是日志，中文是对的");'),
    [],
  );
});

/**
 * 接收收尾的四个终态出口必须发**码**，不许发散文、也不许发 `io::Error` 原文（5.15.35）。
 *
 * 为什么单独钉一条：`file-failed` 的 `reason` 与库里那一列的读者都是界面，而前端对未知
 * reason 的处理是**原样上屏**（那条回落是刻意的）⇒ 后端塞一句中文，英文界面那格就是中文；
 * 塞一句 `No space left on device (os error 28)`，用户既读不懂也做不了任何事。
 * 上一判据（「file-failed 载荷里不许出现硬编码文案」）只看 `FileFailedInfo` 的构造点，
 * 而这一族的散文住在**返回值**里（`Err("...")`），中间隔着一层 `reason: e` 透传 ⇒ 看不见。
 *
 * 判据按形状取函数体（不数行、不开固定窗口）：`finish_receiver_into` 与
 * `finish_group_receive_into` 是同一个决定的两家，各自都必须是码。
 */
test("接收收尾的终态出口发码，不发散文与 OS 原文", () => {
  const CJK = /[\u4e00-\u9fff]/;
  const probes = [
    ["1:1", "src-tauri/src/network/file/receive.rs", "fn finish_receiver_into("],
    ["群", "src-tauri/src/network/file/group_receive.rs", "fn finish_group_receive_into("],
  ] as const;
  const codes = [
    "FILE_RECEIVE_INCOMPLETE",
    "FILE_INTEGRITY_FAILED",
    "FILE_RECEIVE_WRITE_FAILED",
    "FILE_RECEIVE_PLACE_FAILED",
  ];
  for (const [name, file, sig] of probes) {
    const body = tsFnBody(readFileSync(join(ROOT, file), "utf8"), sig);
    // 提取自检：拿不到函数体（签名写法变了）时不许变成"零格全过"。
    assert.ok(body.length > 400, `${name} 那一份没取到函数体 ⇒ 锚点写法变了：${sig}`);
    assert.ok(
      body.includes("Ok("),
      `${name} 那一份的函数体像是被截断了（没读到成功出口）⇒ 花括号配对被字符串里的括号带偏了`,
    );
    const prose = [...body.matchAll(/Err\("([^"]*)"\s*\.to_string\(\)/g)]
      .map((m) => m[1])
      .filter((x) => CJK.test(x));
    assert.deepEqual(prose, [], `${name} 接收收尾仍把中文散文当载荷（英文界面会原样上屏）：${prose.join(" / ")}`);
    assert.equal(
      body.includes("return Err(reason)"),
      false,
      `${name} 不许把 io::Error 原文直接当载荷 —— 盘满要归 DISK_FULL，其余归在册的码`,
    );
    assert.ok(
      body.includes("classify_write_failure"),
      `${name} 的写盘失败必须先分诊"盘满"这一类（那是唯一一条用户现在就能动手解决的）`,
    );
  }
  const one = tsFnBody(readFileSync(join(ROOT, "src-tauri/src/network/file/receive.rs"), "utf8"), "fn finish_receiver_into(");
  const grp = tsFnBody(readFileSync(join(ROOT, "src-tauri/src/network/file/group_receive.rs"), "utf8"), "fn finish_group_receive_into(");
  const both = one + grp;
  for (const code of codes) {
    assert.ok(both.includes(code), `四个终态出口里没有一处引用 ${code} ⇒ 那一格还在发散文`);
  }
  // 正控：把一格换回散文，同一把尺子必须报出它（否则上面那条 prose 判据是恒绿的）。
  const gutted = one.replace(
    "return Err(crate::error_codes::FILE_INTEGRITY_FAILED.to_string());",
    'return Err("文件完整性校验失败".to_string());',
  );
  assert.notEqual(gutted, one, "变异没落进源码 ⇒ 这条正控不作数（锚点写法变了）");
  const found = [...gutted.matchAll(/Err\("([^"]*)"\s*\.to_string\(\)/g)]
    .map((m) => m[1])
    .filter((x) => CJK.test(x));
  assert.deepEqual(found, ["文件完整性校验失败"], "散文回潮时必须恰好点名那一句");
});

/**
 * 1:1 接收**上屏**那一族只许发码（5.15.36）。
 *
 * 与上一条的分工：`finish_receiver_into` 那四格是"返回值就是载荷"；这一条管两道闸：
 *  · `write_chunk` 的五个出口（跳号 / 解密失败 / 超出声明 / 写盘 / 序号溢出）—— 它们的返回值
 *    经 `handle_file.rs` 的 `fail_receive(state, .., &e)` 直接进 `file-failed` 载荷；
 *  · **收尾调用的 reason 实参** —— `fail_taken_receive(.., REASON)` 这种字面量实参以前就是中文
 *    （1:1 清扫器那句「接收超时」与断链那句「对端连接已断开」）。
 * 判据按形状写，不抄码名清单：新加一格忘了配码 ⇒ 这里红；把码改回散文 ⇒ 这里也红。
 *
 * ⚠️ 刻意**不管**的两条：`未知传输` 与 `文件传输来源不匹配` —— 它们走 `fail_receive` 的
 * `return false` 分支（不 emit），是内部控制的返回值。给它们配码就是造一条没人写的死契约。
 */
test("1:1 接收上屏的出口与收尾实参都不许是中文散文", () => {
  const CJK = /[\u4e00-\u9fff]/;
  const wc = tsFnBody(
    readFileSync(join(ROOT, "src-tauri/src/network/file/receive.rs"), "utf8"),
    "pub fn write_chunk(",
  );
  assert.ok(wc.length > 400, "write_chunk 的函数体没取到 ⇒ 锚点写法变了");
  // 豁免两条，且**有凭据**：它们走 `fail_receive` 的 `return false` 分支（不 emit），
  // 是内部控制的返回值 ⇒ 那一句永远不会上屏。凭由 Rust 那条
  // `fail_receive_stays_silent_for_unknown_and_mismatched_transfer` 钉住（含 `return false` 的处数），
  // 不是这里说了算。给它们配码反而会造出一条没人写的死契约。
  const INTERNAL_ONLY = ["未知传输", "文件传输来源不匹配"];
  const prose = [...wc.matchAll(/Err\("([^"]*)"\s*\.to_string\(\)/g)]
    .map((m) => m[1])
    .filter((x) => CJK.test(x) && !INTERNAL_ONLY.includes(x));
  assert.deepEqual(prose, [], `write_chunk 仍把中文散文当载荷：${prose.join(" / ")}`);
  // 豁免名单不许变胖：每条豁免都要在 Rust 那条判据里有位置（数 `return false` 的处数）。
  assert.equal(INTERNAL_ONLY.length, 2, "豁免是手写的两条；加了第三条就必须同时改 Rust 凭据");
  // 五格都必须真被引用（漏一格 = 那一格还在发散文）
  for (const code of [
    "FAIL_CODE_FILE_CHUNK_GAP",
    "FAIL_CODE_FILE_CHUNK_DECRYPT_FAILED",
    "FAIL_CODE_FILE_CHUNK_OVERSIZE",
    "FILE_RECEIVE_WRITE_FAILED",
    "FAIL_CODE_FILE_CHUNK_SEQ_OVERFLOW",
  ]) {
    assert.ok(wc.includes(code), `write_chunk 里没有引用 ${code}`);
  }

  // 收尾调用的 reason 实参：整库视图里扫（三家的生产码都在视图内）
  const views = [
    "src-tauri/src/network/file/receive.rs",
    "src-tauri/src/network/transport/handle_file.rs",
    "src-tauri/src/network/transport/group_file.rs",
  ]
    .map((f) => readFileSync(join(ROOT, f), "utf8"))
    .join("\n");
  const ARG = /fail_(?:taken_)?receive\(([^;]*?),\s*"([^"]*)"\s*\)/g;
  const badArgs = [...views.matchAll(ARG)]
    .map((m) => m[2])
    .filter((x) => CJK.test(x));
  assert.deepEqual(badArgs, [], `收尾的 reason 实参是中文散文（会原样上屏）：${badArgs.join(" / ")}`);
  // ★ 实参也可能是**中转常量**（`const REASON = "…中文…"; fail_taken_receive(.., REASON)`）。
  //   只判字面量会漏掉这一整类 —— 10-30 实测：把清扫器那条常量改回中文，本判据仍然全绿。
  //   所以再对一次账：这些文件里所有**值含中文**的 `const X: &str = "…"`，只要被当 reason 传给
  //   `fail_receive` / `fail_taken_receive`，就必须红。
  const CJK_CONST = /const\s+([A-Z][A-Z0-9_]*)\s*:\s*&str\s*=\s*"([^"]*[\u4e00-\u9fff][^"]*)"/g;
  const cjkConsts = new Map<string, string>();
  for (const m of views.matchAll(CJK_CONST)) cjkConsts.set(m[1], m[2]);
  const argNames = [...views.matchAll(/fail_(?:taken_)?receive\([^;]*?,\s*([A-Z][A-Z0-9_]*)\s*\)/g)].map(
    (m) => m[1],
  );
  const leaked = argNames.filter((n) => cjkConsts.has(n));
  assert.deepEqual(
    leaked,
    [],
    `收尾的 reason 实参是中文常量的名字（值会原样上屏）：${leaked.map((n) => `${n}=${cjkConsts.get(n)}`).join(" / ")}`,
  );
  // 下限 + 正控：判据必须看得见这些调用点，且实参回潮时报得出那一句
  const callSites = [...views.matchAll(/fail_(?:taken_)?receive\(/g)].length;
  assert.ok(callSites >= 4, `只找到 ${callSites} 处收尾调用 ⇒ 分母大概读空了`);
  const regressed = views.replace(
    'fail_taken_receive(state, &id, &r, REASON);',
    'fail_taken_receive(state, &id, &r, "接收超时：对端久未继续发送");',
  );
  assert.notEqual(regressed, views, "变异没落进去 ⇒ 正控不作数（锚点写法变了）");
  assert.deepEqual(
    [...regressed.matchAll(ARG)].map((m) => m[2]).filter((x) => CJK.test(x)),
    ["接收超时：对端久未继续发送"],
    "实参回潮时必须恰好点名那一句",
  );
});
