import {
  randomBytes, createHash, timingSafeEqual, scrypt as scryptCb, createHmac,
} from 'node:crypto';
import { promisify } from 'node:util';
import config from './config.js';

const scrypt = promisify(scryptCb);

/* ---------- passwords ---------- */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 };

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new Error('Password must be at least 10 characters.');
  }
  if (password.length > 512) throw new Error('Password is too long.');
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const n = Number(N), rr = Number(r), pp = Number(p);
  if (!Number.isInteger(n) || !Number.isInteger(rr) || !Number.isInteger(pp)) return false;
  if (n > (1 << 20) || rr > 32 || pp > 16) return false; // refuse absurd work factors from a tampered row
  let salt, expected;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    expected = Buffer.from(keyB64, 'base64url');
  } catch { return false; }
  let actual;
  try {
    actual = await scrypt(password, salt, expected.length, { N: n, r: rr, p: pp, maxmem: 128 * n * rr * 2 });
  } catch { return false; }
  return safeEqual(actual, expected);
}

export function safeEqual(a, b) {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length alone is not a fast path.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/* ---------- opaque tokens ----------
   256 bits of randomness. Only the SHA-256 is stored, so a database copy
   never yields a working link. */

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/* A token is only ever looked up by hash, and the shape is checked first so a
   junk value never even reaches the database. */
export function isTokenShape(token) {
  return typeof token === 'string' && token.length >= 32 && token.length <= 64 && /^[A-Za-z0-9_-]+$/.test(token);
}

export function sign(value) {
  return createHmac('sha256', config.secret).update(String(value)).digest('base64url');
}

/* ---------- cookies ---------- */

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) bits.push(`Expires=${new Date(opts.expires).toUTCString()}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  bits.push(`SameSite=${opts.sameSite || 'Strict'}`);
  return bits.join('; ');
}

/* ---------- request context ---------- */

export function isSecureRequest(req) {
  if (req.socket?.encrypted) return true;
  if (config.trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto === 'https') return true;
  }
  return config.publicBaseUrl.startsWith('https://');
}

export function clientIp(req) {
  if (config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket?.remoteAddress || '';
}

export function securityHeaders(req, { allowUploads = false } = {}) {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data:${allowUploads ? '' : ''}`,
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "manifest-src 'self'",
  ].join('; ');

  const headers = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    /* Geolocation is needed by the owner's own browser while a trip is live. */
    'Permissions-Policy': 'geolocation=(self), camera=(self), microphone=(), payment=(), usb=(), interest-cohort=()',
  };
  if (isSecureRequest(req)) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

/* ---------- same-origin check for state-changing requests ---------- */

export function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!host) return false;
  if (!origin) {
    /* No Origin header at all: only browsers omit it on same-origin GETs and on
       some non-CORS form posts. The CSRF token is the real gate; this is belt and braces. */
    return true;
  }
  if (origin === 'null') return false;
  try {
    const u = new URL(origin);
    return u.host === host;
  } catch { return false; }
}

/* ---------- rate limiting ----------
   Fixed-window counters held in memory. Restarting clears them, which is fine:
   account lockout is persisted separately in the owners table. */

const buckets = new Map();

export function rateLimit(key, { limit, windowMs }) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.reset) {
    b = { count: 0, reset: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return {
    ok: b.count <= limit,
    remaining: Math.max(0, limit - b.count),
    retryAfterSec: Math.max(1, Math.ceil((b.reset - now) / 1000)),
  };
}

export function resetRateLimit(key) { buckets.delete(key); }

export function sweepRateLimits(now = Date.now()) {
  for (const [k, b] of buckets) if (now >= b.reset) buckets.delete(k);
}

/* Exposed for tests so a suite can start from a clean slate. */
export function _clearRateLimits() { buckets.clear(); }
