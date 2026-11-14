#!/usr/bin/env node
/**
 * 外部应用设备认证的 **RP 契约 mock**（Phase 2 参考实现，非 Gosslan 运营服务）。
 *
 * 用途：在本机起一个最小 RP 后端，驱动 Gosslan 客户端走完「绑定/登录」全流程，
 * 并作为集成方接口契约的可运行示例。设计依据：
 * docs/notes/external-app-device-auth-design-2026-11-13.md §4。
 *
 * 跑法：
 *   node scripts/device-auth-rp-mock.mjs            # 默认 https://localhost:8443
 *   PORT=9443 ORIGIN=https://localhost:9443 node scripts/device-auth-rp-mock.mjs
 *
 * 首次运行用 openssl 生成自签证书（mock-cert.pem/mock-key.pem）。Gosslan 客户端的
 * reqwest 走系统信任根 ⇒ 需把 mock-cert.pem 加入系统/钥匙串信任后才能联调（真机信任
 * 配置 NOT RUN）。本 mock 只验证契约形状与签名，不代表生产 RP 的安全实现。
 *
 * 限制（这不是生产后端，不能作为生产接入依据）：
 *   · 事务、绑定、已消费 jti、限流窗口全部存在进程内 Map/Set，进程重启即丢失，
 *     没有持久化、没有数据库、没有跨进程一致性。
 *   · 自签 localhost 证书，需手动加入系统信任；真机信任配置 NOT RUN。
 *   · 创建事务免 RP 登录会话、免 CSRF 检查；下面只做最小来源校验与窗口限流占位，
 *     不校验账号身份，也没有真实账号体系。生产 RP 必须换成会话绑定、CSRF token、
 *     幂等键、持久化事务与公钥登记、并发控制与分布式限流，不能照抄这里。
 *   · 限流是按进程内存计数的最小占位，不防分布式滥用。
 *   · account_hint 硬编码为固定掩码串，不来自真实 RP 账号。
 *   · 无分享端点，metadata 不含分享字段。
 *
 * 端点：
 *   GET    /.well-known/gosslan-device-auth            元数据
 *   POST   /api/device-auth/requests                   创建事务（mock 免 session/CSRF）
 *   GET    /api/device-auth/requests/:id               取待确认请求
 *   POST   /api/device-auth/requests/:id/decision      批准/拒绝（验签 + 登记公钥）
 *   GET    /api/device-auth/requests/:id/status        浏览器轮询状态
 *   DELETE /api/device-auth/bindings/:kid              RP 侧撤销设备凭证（按 key_id）
 *   POST   /api/device-auth/revoke                     RP 侧撤销设备凭证（按 key_id 或 subject）
 *
 * 事务状态机：pending → expired | consumed。决策落地后置 consumed 终态，已消费事务
 * 不可再次决策，冲突码 DEVICE_AUTH_ALREADY_CONSUMED 保持不变。对外结果由 decision
 * 字段承载（approved / denied），/status 仍返回原有取值，端点契约不变。
 * 断言一次性消费：verifyAssertion 校验 jti 存在，已消费 jti 在 consumedJtis 全局去重，
 * 同一 jti 第二次出现一律 409 DEVICE_AUTH_JTI_REPLAY。jti 只在验签通过后才入集，
 * 未验签的断言不能污染去重集合。
 */
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8443);
const ORIGIN = process.env.ORIGIN || `https://localhost:${PORT}`;
const CLIENT_ID = "com.example.gosslan-mock";
const DISPLAY_NAME = "Gosslan 契约 Mock";
const TTL_MS = 2 * 60 * 1000;
// 创建事务的最小限流占位：按来源在内存里开一个窗口计数，不引入依赖也不跨进程。
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 30;

// ---- 自签证书（仅 mock；生产 RP 用受信 CA 证书）----
const certPath = path.join(HERE, "mock-cert.pem");
const keyPath = path.join(HERE, "mock-key.pem");
if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "365",
    "-subj", "/CN=localhost",
  ], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("需要 openssl 生成自签证书；请先安装 openssl。");
    process.exit(1);
  }
}

// ---- 内存态：事务 + 已登记公钥 + 已消费 jti + 创建事务窗口计数 ----
// 进程重启即全部丢失，这是 mock 的显式限制（见文件头），不是遗漏。
const transactions = new Map(); // request_id -> {action, claims, challenge, state, decision, expires, subject?, kid?, publicKey?, jti?}
const bindings = new Map();     // `${subject}` -> {kid, publicKey, subject, revoked}
const consumedJtis = new Set(); // 已消费断言的 jti；重放判据与事务状态无关
const requestWindows = new Map(); // 来源 -> {start, count}；创建事务限流占位

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);

function metadata() {
  return {
    protocol_version: "1",
    client_id: CLIENT_ID,
    display_name: DISPLAY_NAME,
    issuer: ORIGIN,
    request_endpoint: `${ORIGIN}/api/device-auth/requests/{request_id}`,
    decision_endpoint: `${ORIGIN}/api/device-auth/requests/{request_id}/decision`,
    poll_endpoint: `${ORIGIN}/api/device-auth/requests/{request_id}/status`,
    supported_actions: ["link", "authenticate"],
    supported_claims: ["device_subject", "device_public_key", "nickname"],
  };
}

/** 验 JWS EdDSA 断言：header.payload 签名 + 字段一致性 + 时效 + jti 存在。 */
function verifyAssertion(assertion, tx, publicKeyB64url) {
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new Error("assertion 不是三段 JWS");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
  if (header.alg !== "EdDSA" || header.typ !== "gosslan-device-auth+jwt") throw new Error("alg/typ 不符");
  const pubRaw = Buffer.from(publicKeyB64url, "base64url");
  const keyObj = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubRaw]), format: "der", type: "spki" });
  const ok = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), keyObj, Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("签名校验失败");
  if (payload.transaction_id !== tx.id) throw new Error("transaction_id 不符");
  if (payload.challenge !== tx.challenge) throw new Error("challenge 不符");
  if (payload.action !== tx.action) throw new Error("action 不符");
  if (payload.client_id !== CLIENT_ID) throw new Error("client_id 不符");
  if (payload.aud !== `${ORIGIN}/api/device-auth`) throw new Error("aud 不符");
  if (typeof payload.exp !== "number" || payload.exp < nowSec()) throw new Error("断言过期");
  if (typeof payload.iat !== "number" || payload.exp - payload.iat > 60) throw new Error("断言有效期超过 60s");
  // jti 是断言的一次性标识。RP 必须在验签通过后才信任它，并另行做全局去重
  // （见 decision 里的 consumedJtis）；这里只保证它存在，缺 jti 一律拒，
  // 否则旧签名可以无限重放而 RP 无从区分两次请求。
  if (typeof payload.jti !== "string" || payload.jti.length === 0) throw new Error("断言缺 jti");
  return payload;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

/**
 * 创建事务的最小来源校验与限流占位，不引入任何依赖。
 * 为什么只是占位：mock 免 session/CSRF，没有登录态可绑定，只能用 Origin（若带）
 * 做同源形状校验，再按来源做一个内存窗口计数，挡住最粗的滥用；它既不校验账号
 * 身份也不防分布式滥用，生产 RP 必须用会话绑定、CSRF token、幂等键与分布式限流替掉。
 * 返回 null 表示放行，否则返回 {status, code, message}。
 */
function checkCreateSource(req) {
  const origin = req.headers.origin;
  if (origin && origin !== ORIGIN) {
    return { status: 400, code: "DEVICE_AUTH_INVALID_REQUEST", message: "Origin 与 RP 不同源" };
  }
  const key = origin || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const w = requestWindows.get(key);
  if (!w || now - w.start > RATE_WINDOW_MS) {
    requestWindows.set(key, { start: now, count: 1 });
  } else {
    w.count += 1;
    if (w.count > RATE_MAX_PER_WINDOW) {
      return { status: 429, code: "DEVICE_AUTH_RATE_LIMITED", message: "创建事务过于频繁" };
    }
  }
  return null;
}

/**
 * RP 侧撤销设备凭证：按 key_id 或 subject 找到绑定并置 revoked。
 * 为什么保留记录而不是直接 delete：authenticate 需要能区分「从未绑定」与
 * 「绑定已撤销」，分别给 UNAUTHORIZED 与 BINDING_REVOKED，撤销语义才可观察；
 * 同时允许同一 subject 在撤销后重新 link（见 decision 里的重复绑定判断）。
 * 这是 mock 的单边撤销，不代表生产 RP 的撤销持久化与最终一致性实现。
 */
function revokeBinding({ kid, subject }) {
  for (const b of bindings.values()) {
    if ((kid && b.kid === kid) || (subject && b.subject === subject)) {
      b.revoked = true;
      return { kid: b.kid, subject: b.subject };
    }
  }
  return null;
}

const server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    if (req.method === "GET" && url.pathname === "/.well-known/gosslan-device-auth") {
      return send(res, 200, metadata());
    }
    if (req.method === "POST" && url.pathname === "/api/device-auth/requests") {
      // 创建事务先过最小来源校验/限流占位，再读请求体；被拒的请求不必消费 body。
      const denied = checkCreateSource(req);
      if (denied) return send(res, denied.status, { code: denied.code, message: denied.message });
      const body = await readBody(req);
      const action = body.action === "authenticate" ? "authenticate" : "link";
      const id = b64url(crypto.randomBytes(32));
      const tx = {
        id, action,
        claims: Array.isArray(body.requested_claims) ? body.requested_claims : ["device_subject", "device_public_key"],
        challenge: b64url(crypto.randomBytes(32)),
        state: "pending", decision: null, expires: Date.now() + TTL_MS,
      };
      transactions.set(id, tx);
      return send(res, 201, {
        request_id: id,
        app_link: `gosslan://authorize/${id}?origin=${encodeURIComponent(ORIGIN)}`,
        expires_at: new Date(tx.expires).toISOString(),
        poll_after_ms: 1500,
      });
    }
    // RP 侧撤销：把已登记设备凭证标为撤销，之后 authenticate 一律拒绝。
    // 两种形状都放行（REST 路径与表单式 POST），共用同一个 revokeBinding，
    // 避免两处各写一份撤销语义而漂移。
    const revokeByKid = url.pathname.match(/^\/api\/device-auth\/bindings\/([^/]+)$/);
    if (req.method === "DELETE" && revokeByKid) {
      const hit = revokeBinding({ kid: decodeURIComponent(revokeByKid[1]) });
      if (!hit) return send(res, 404, { code: "DEVICE_AUTH_BINDING_NOT_FOUND" });
      return send(res, 200, { status: "revoked", key_id: hit.kid });
    }
    if (req.method === "POST" && url.pathname === "/api/device-auth/revoke") {
      const body = await readBody(req);
      const hit = revokeBinding({ kid: body.key_id, subject: body.subject });
      if (!hit) return send(res, 404, { code: "DEVICE_AUTH_BINDING_NOT_FOUND" });
      return send(res, 200, { status: "revoked", key_id: hit.kid });
    }
    const m = url.pathname.match(/^\/api\/device-auth\/requests\/([^/]+)(\/decision|\/status)?$/);
    if (!m) return send(res, 404, { code: "DEVICE_AUTH_REQUEST_NOT_FOUND" });
    const tx = transactions.get(m[1]);
    if (!tx) return send(res, 404, { code: "DEVICE_AUTH_REQUEST_NOT_FOUND" });
    if (Date.now() > tx.expires && tx.state === "pending") tx.state = "expired";

    if (req.method === "GET" && !m[2]) {
      return send(res, 200, {
        protocol_version: "1", request_id: tx.id, client_id: CLIENT_ID, issuer: ORIGIN,
        display_name: DISPLAY_NAME, action: tx.action, account_hint: "mo***@example.com",
        requested_claims: tx.claims, challenge: tx.challenge, expires_at: new Date(tx.expires).toISOString(),
      });
    }
    if (req.method === "GET" && m[2] === "/status") {
      // 对外仍返回原有取值（pending / approved / denied / expired）。consumed 是
      // 内部终态，由 decision 字段承载结果，避免把新状态字符串暴露给轮询方。
      return send(res, 200, { status: tx.decision ?? tx.state });
    }
    if (req.method === "POST" && m[2] === "/decision") {
      const body = await readBody(req);
      // 拒绝不带断言，也就没有 jti 可消费；先判终态，沿用原有冲突码。
      if (body.decision === "deny") {
        if (tx.state !== "pending") return send(res, 409, { code: "DEVICE_AUTH_ALREADY_CONSUMED" });
        tx.decision = "denied";
        tx.state = "consumed";
        return send(res, 202, { status: "denied" });
      }
      if (body.decision !== "approve") return send(res, 400, { code: "DEVICE_AUTH_INVALID_REQUEST" });
      try {
        let publicKey = body.public_key;
        let known = null;
        if (tx.action === "authenticate") {
          known = [...bindings.values()].find((b) => b.kid === body.key_id);
          // 撤销后旧 key 立即不能登录：区分「绑定已撤销」与「从未绑定」两种拒绝，
          // 让撤销语义在响应里可观察，而不是笼统的未授权。
          if (known?.revoked) return send(res, 401, { code: "DEVICE_AUTH_BINDING_REVOKED" });
          if (!known) return send(res, 401, { code: "DEVICE_AUTH_UNAUTHORIZED" });
          publicKey = known.publicKey;
        }
        const payload = verifyAssertion(body.assertion, tx, publicKey);
        // jti 全局去重放在事务状态判断之前：同一个旧断言重放时给出明确的重放冲突，
        // 而不是被笼统的「事务已消费」盖过去。jti 只在验签通过后才入集，
        // 未验签的断言不能污染去重集合。
        if (consumedJtis.has(payload.jti)) return send(res, 409, { code: "DEVICE_AUTH_JTI_REPLAY" });
        if (tx.state !== "pending") return send(res, 409, { code: "DEVICE_AUTH_ALREADY_CONSUMED" });
        if (tx.action === "link") {
          const existing = bindings.get(payload.iss);
          // 撤销过的绑定允许重新登记，否则撤销后这个 subject 在这个 mock 里
          // 永远无法再绑；未撤销的重复绑定仍按原契约判冲突。
          if (existing && !existing.revoked) return send(res, 409, { code: "DEVICE_AUTH_ALREADY_CONSUMED" });
          bindings.set(payload.iss, { kid: body.key_id, publicKey: body.public_key, subject: payload.iss, revoked: false });
          tx.subject = payload.iss; tx.kid = body.key_id; tx.publicKey = body.public_key;
        } else {
          tx.subject = known.subject;
        }
        consumedJtis.add(payload.jti);
        tx.jti = payload.jti;
        tx.decision = "approved";
        // consumed 是显式终态：已消费事务不可再次决策。对外结果由 decision 承载，
        // /status 仍返回 approved / denied，端点契约不变。
        tx.state = "consumed";
        return send(res, 202, { status: "approved" });
      } catch (e) {
        return send(res, 401, { code: "DEVICE_AUTH_UNAUTHORIZED", message: String(e.message) });
      }
    }
    return send(res, 400, { code: "DEVICE_AUTH_INVALID_REQUEST" });
  } catch (e) {
    return send(res, 500, { code: "DEVICE_AUTH_TEMPORARY_FAILURE", message: String(e.message) });
  }
});

server.listen(PORT, () => {
  console.log(`RP 契约 mock 已启动：${ORIGIN}`);
  console.log(`把 ${certPath} 加入系统信任后，用 Gosslan 打开下方链接联调：`);
  console.log(`  curl -sk -X POST ${ORIGIN}/api/device-auth/requests -H 'Content-Type: application/json' -d '{"action":"link","requested_claims":["device_subject","device_public_key"]}'`);
  console.log("返回的 app_link 即 gosslan://authorize/… 深链。");
  console.log(`撤销设备凭证：curl -sk -X DELETE ${ORIGIN}/api/device-auth/bindings/<key_id>`);
});