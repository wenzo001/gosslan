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
 * 端点：
 *   GET  /.well-known/gosslan-device-auth        元数据
 *   POST /api/device-auth/requests               创建事务（mock 免 session/CSRF）
 *   GET  /api/device-auth/requests/:id           取待确认请求
 *   POST /api/device-auth/requests/:id/decision  批准/拒绝（验签 + 登记公钥）
 *   GET  /api/device-auth/requests/:id/status    浏览器轮询状态
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

// ---- 内存态：事务 + 已登记公钥 ----
const transactions = new Map(); // request_id -> {action, claims, challenge, state, expires, subject?, kid?, publicKey?}
const bindings = new Map();     // `${subject}` -> {kid, publicKey, subject}

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

/** 验 JWS EdDSA 断言：header.payload 签名 + 字段一致性 + 时效 + 一次性。 */
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

const server = https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    if (req.method === "GET" && url.pathname === "/.well-known/gosslan-device-auth") {
      return send(res, 200, metadata());
    }
    if (req.method === "POST" && url.pathname === "/api/device-auth/requests") {
      const body = await readBody(req);
      const action = body.action === "authenticate" ? "authenticate" : "link";
      const id = b64url(crypto.randomBytes(32));
      const tx = {
        id, action,
        claims: Array.isArray(body.requested_claims) ? body.requested_claims : ["device_subject", "device_public_key"],
        challenge: b64url(crypto.randomBytes(32)),
        state: "pending", expires: Date.now() + TTL_MS,
      };
      transactions.set(id, tx);
      return send(res, 201, {
        request_id: id,
        app_link: `gosslan://authorize/${id}?origin=${encodeURIComponent(ORIGIN)}`,
        expires_at: new Date(tx.expires).toISOString(),
        poll_after_ms: 1500,
      });
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
      return send(res, 200, { status: tx.state });
    }
    if (req.method === "POST" && m[2] === "/decision") {
      const body = await readBody(req);
      if (tx.state !== "pending") return send(res, 409, { code: "DEVICE_AUTH_ALREADY_CONSUMED" });
      if (body.decision === "deny") {
        tx.state = "denied";
        return send(res, 202, { status: "denied" });
      }
      if (body.decision !== "approve") return send(res, 400, { code: "DEVICE_AUTH_INVALID_REQUEST" });
      try {
        if (tx.action === "link") {
          const payload = verifyAssertion(body.assertion, tx, body.public_key);
          if (bindings.has(payload.iss)) return send(res, 409, { code: "DEVICE_AUTH_ALREADY_CONSUMED" });
          bindings.set(payload.iss, { kid: body.key_id, publicKey: body.public_key, subject: payload.iss });
          tx.subject = payload.iss; tx.kid = body.key_id; tx.publicKey = body.public_key;
        } else {
          const known = [...bindings.values()].find((b) => b.kid === body.key_id);
          if (!known) return send(res, 401, { code: "DEVICE_AUTH_UNAUTHORIZED" });
          verifyAssertion(body.assertion, tx, known.publicKey);
          tx.subject = known.subject;
        }
        tx.state = "approved";
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
});