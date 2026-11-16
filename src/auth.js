"use strict";
// Passwords, sign-in tokens (cookies) and sign-in rate limiting.
const crypto = require("crypto");

// ---- passwords -------------------------------------------------------------
// New hashes use scrypt with a random salt. Hashes created by the old browser-only
// version (sha256 of "cu:" + password) are still accepted and are upgraded to
// scrypt automatically the next time that person signs in.
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };

function scrypt(pw, salt, o = SCRYPT) {
  return new Promise((res, rej) =>
    crypto.scrypt(String(pw), salt, o.len, { N: o.N, r: o.r, p: o.p, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k)))
  );
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);

// Returns { ok, upgrade } – upgrade=true means the stored hash is a legacy format.
async function verifyPassword(pw, stored) {
  stored = String(stored || "");
  pw = String(pw || "");
  if (stored.startsWith("scrypt$")) {
    const [, N, r, p, salt, key] = stored.split("$");
    const want = Buffer.from(key, "base64");
    const got = await scrypt(pw, Buffer.from(salt, "base64"), { N: +N, r: +r, p: +p, len: want.length });
    return { ok: eq(got, want), upgrade: false };
  }
  if (stored.startsWith("plain:")) return { ok: eq(Buffer.from(stored), Buffer.from("plain:" + pw)), upgrade: true };
  if (/^[0-9a-f]{64}$/.test(stored)) {
    const h = crypto.createHash("sha256").update("cu:" + pw, "utf8").digest("hex");
    return { ok: eq(Buffer.from(h), Buffer.from(stored)), upgrade: true };
  }
  return { ok: false, upgrade: false };
}

// ---- signed session tokens --------------------------------------------------
// The token holds the account id, a "token version" (bumped when the password is
// changed or reset, which signs out every other device) and an expiry, signed with
// the server's secret. Nothing is kept in the browser except this cookie.
const b64u = (b) => Buffer.from(b).toString("base64url");

function makeTokens(secret) {
  const sig = (s) => crypto.createHmac("sha256", secret).update(s).digest("base64url");
  return {
    sign(payload) {
      const body = b64u(JSON.stringify(payload));
      return body + "." + sig(body);
    },
    verify(token) {
      if (!token || typeof token !== "string") return null;
      const [body, s] = token.split(".");
      if (!body || !s || !eq(Buffer.from(sig(body)), Buffer.from(s))) return null;
      try {
        const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
        return p.exp && p.exp > Date.now() ? p : null;
      } catch (e) {
        return null;
      }
    },
  };
}

function parseCookies(header) {
  const out = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const i = part.indexOf("=");
      if (i < 0) return;
      const k = part.slice(0, i).trim();
      if (!k) return;
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch (e) {
        out[k] = part.slice(i + 1).trim();
      }
    });
  return out;
}

function cookie(name, value, { maxAgeSec, secure }) {
  const parts = [name + "=" + encodeURIComponent(value), "Path=/", "HttpOnly", "SameSite=Lax"];
  if (maxAgeSec !== undefined) parts.push("Max-Age=" + maxAgeSec);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

// ---- sign-in rate limiting ---------------------------------------------------
function makeLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60 * 1000).unref();
  return {
    blocked(key) {
      const h = hits.get(key);
      return !!h && h.reset > Date.now() && h.count >= max;
    },
    fail(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
      else h.count++;
    },
    clear(key) {
      hits.delete(key);
    },
  };
}

function randomSecret() {
  return crypto.randomBytes(48).toString("base64url");
}

module.exports = { hashPassword, verifyPassword, makeTokens, parseCookies, cookie, makeLimiter, randomSecret };
