import config from './config.js';
import { q, audit } from './db.js';
import {
  hashPassword, verifyPassword, newToken, hashToken, safeEqual,
  parseCookies, serializeCookie, isSecureRequest, clientIp, sameOrigin,
  rateLimit, resetRateLimit,
} from './security.js';
import { unauthorized, forbidden, tooMany, bad, conflict, HttpError } from './http.js';

const MINUTE = 60 * 1000;
const LOGIN_LIMIT = { limit: 10, windowMs: 15 * MINUTE };
const LOCKOUT_AFTER = 8;
const LOCKOUT_MINUTES = 15;

/* ---------- owner account ---------- */

export function ownerCount() {
  return q.pluck('SELECT COUNT(*) AS n FROM owners');
}

export function getOwner(id) {
  return q.get('SELECT id, email, name, created_at, last_login_at FROM owners WHERE id = ?', id);
}

export async function createOwner({ email, password, name = 'Owner' }) {
  const normalised = String(email || '').trim().toLowerCase();
  if (!normalised || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normalised)) {
    throw bad('Enter a valid email address.');
  }
  assertPasswordStrength(password);
  const hash = await hashPassword(password);
  const now = Date.now();
  try {
    const res = q.run(
      'INSERT INTO owners(email, name, pass_hash, created_at) VALUES(?,?,?,?)',
      normalised, String(name || 'Owner').slice(0, 120), hash, now
    );
    audit('system', 'owner.create', 'owner', res.id, { email: normalised });
    return res.id;
  } catch (err) {
    if (String(err?.message || '').includes('UNIQUE')) throw conflict('An account with that email already exists.');
    throw err;
  }
}

export function assertPasswordStrength(password) {
  const p = String(password ?? '');
  if (p.length < 12) throw bad('Use a password of at least 12 characters.');
  if (p.length > 512) throw bad('That password is too long.');
  const weak = ['password', '123456', 'qwerty', 'letmein', 'detailing', 'graceful'];
  const lower = p.toLowerCase();
  if (weak.some((w) => lower.includes(w) && p.length < 20)) {
    throw bad('That password contains an obvious word. Pick something harder to guess.');
  }
  if (new Set(p).size < 6) throw bad('That password repeats too few characters.');
  return true;
}

export async function changePassword(ownerId, currentPassword, nextPassword) {
  const row = q.get('SELECT id, pass_hash FROM owners WHERE id = ?', ownerId);
  if (!row) throw unauthorized();
  if (!(await verifyPassword(currentPassword, row.pass_hash))) {
    throw forbidden('That current password is not right.');
  }
  assertPasswordStrength(nextPassword);
  const hash = await hashPassword(nextPassword);
  q.run('UPDATE owners SET pass_hash = ? WHERE id = ?', hash, ownerId);
  /* Every other session is invalidated: a password change should end any
     session someone else might be holding. */
  q.run('DELETE FROM sessions WHERE owner_id = ?', ownerId);
  audit(`owner:${ownerId}`, 'owner.password_change', 'owner', ownerId);
}

/* ---------- one-time setup code ----------
   Printed to the server console when the database has no owner yet, so the
   very first account cannot be claimed by whoever finds the URL first. */

let setupCode = null;

export function ensureSetupCode() {
  if (ownerCount() > 0) { setupCode = null; return null; }
  if (!setupCode) setupCode = newToken().slice(0, 12).toUpperCase();
  return setupCode;
}

export function clearSetupCode() { setupCode = null; }

export function checkSetupCode(given) {
  if (!setupCode) throw forbidden('Setup is already complete.');
  if (!safeEqual(String(given || '').trim().toUpperCase(), setupCode)) {
    throw forbidden('That setup code is not right. It is printed in the server log.');
  }
  return true;
}

/* ---------- sessions ---------- */

function sessionCookieOpts(req, maxAgeSec) {
  return {
    path: '/',
    maxAge: maxAgeSec,
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'Strict',
  };
}

export async function login(req, res, { email, password }) {
  const ip = clientIp(req);
  const normalised = String(email || '').trim().toLowerCase();

  /* Two limiters: one per source address, one per account, so neither a single
     noisy IP nor a distributed guess at one account gets unlimited tries. */
  const byIp = rateLimit(`login:ip:${ip}`, LOGIN_LIMIT);
  const byAccount = rateLimit(`login:acct:${normalised}`, LOGIN_LIMIT);
  if (!byIp.ok || !byAccount.ok) {
    const err = tooMany('Too many sign-in attempts. Wait a few minutes and try again.');
    err.retryAfterSec = Math.max(byIp.retryAfterSec, byAccount.retryAfterSec);
    audit('anon', 'login.rate_limited', 'owner', '', { email: normalised }, ip);
    throw err;
  }

  const row = q.get('SELECT id, email, name, pass_hash, failed_count, locked_until FROM owners WHERE email = ?', normalised);
  const now = Date.now();

  if (row?.locked_until && row.locked_until > now) {
    const err = tooMany('This account is locked for a few minutes after too many wrong passwords.');
    err.retryAfterSec = Math.ceil((row.locked_until - now) / 1000);
    throw err;
  }

  /* Always run a verification, even with no such account, so the response time
     does not reveal whether the email exists. */
  const stored = row?.pass_hash || DUMMY_HASH;
  const ok = await verifyPassword(password, stored);

  if (!row || !ok) {
    if (row) {
      const failed = row.failed_count + 1;
      const lockUntil = failed >= LOCKOUT_AFTER ? now + LOCKOUT_MINUTES * MINUTE : null;
      q.run('UPDATE owners SET failed_count = ?, locked_until = ? WHERE id = ?', failed, lockUntil, row.id);
    }
    audit('anon', 'login.failed', 'owner', row?.id ?? '', { email: normalised }, ip);
    throw unauthorized('That email or password is not right.');
  }

  q.run('UPDATE owners SET failed_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now, row.id);
  resetRateLimit(`login:acct:${normalised}`);
  resetRateLimit(`login:ip:${ip}`);

  const session = issueSession(req, res, row.id);
  audit(`owner:${row.id}`, 'login.success', 'owner', row.id, '', ip);
  return { owner: { id: row.id, email: row.email, name: row.name }, csrf: session.csrf };
}

/* A fixed hash of a random string, used only to keep the failure path as slow
   as the success path. */
const DUMMY_HASH = 'scrypt$32768$8$1$Q2h2M0hnR0FEc2FsdDAx$Zm9yLXRpbWluZy1vbmx5LW5vdC1hLXJlYWwta2V5';

export function issueSession(req, res, ownerId) {
  const token = newToken();
  const csrf = newToken();
  const now = Date.now();
  const idleMs = config.session.idleMinutes * MINUTE;
  const absoluteMs = config.session.absoluteDays * 24 * 60 * MINUTE;

  q.run(
    `INSERT INTO sessions(id, owner_id, csrf_hash, created_at, last_seen_at, expires_at, absolute_expires_at, ip, user_agent)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    hashToken(token), ownerId, hashToken(csrf), now, now,
    now + idleMs, now + absoluteMs,
    clientIp(req), String(req.headers['user-agent'] || '').slice(0, 300)
  );

  const maxAge = Math.floor(absoluteMs / 1000);
  res.setHeader('Set-Cookie', [
    serializeCookie(config.session.cookie, token, sessionCookieOpts(req, maxAge)),
    /* Readable by the admin page's own script so it can echo the value back in
       a header. Being readable is the point; it is useless without the
       HttpOnly session cookie travelling alongside it. */
    serializeCookie(config.session.csrfCookie, csrf, { ...sessionCookieOpts(req, maxAge), httpOnly: false }),
  ]);

  return { token, csrf };
}

export function currentSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[config.session.cookie];
  if (!token || token.length > 128) return null;

  const row = q.get('SELECT * FROM sessions WHERE id = ?', hashToken(token));
  if (!row) return null;

  const now = Date.now();
  if (now > row.expires_at || now > row.absolute_expires_at) {
    q.run('DELETE FROM sessions WHERE id = ?', row.id);
    return null;
  }

  /* Slide the idle window, but never past the absolute cap, and only write
     once a minute so a busy dashboard is not hammering the row. */
  const nextExpiry = Math.min(now + config.session.idleMinutes * MINUTE, row.absolute_expires_at);
  if (now - row.last_seen_at > MINUTE) {
    q.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now, nextExpiry, row.id);
  }

  const owner = getOwner(row.owner_id);
  if (!owner) { q.run('DELETE FROM sessions WHERE id = ?', row.id); return null; }
  return { session: row, owner, cookies };
}

export function requireOwner(req) {
  const ctx = currentSession(req);
  if (!ctx) throw unauthorized();
  return ctx;
}

/* Double-submit CSRF: the header value must hash to what the session row
   holds, and the request must come from our own origin. */
export function requireCsrf(req, ctx) {
  if (!sameOrigin(req)) throw forbidden('Request blocked: unexpected origin.');
  const header = req.headers['x-csrf-token'];
  if (!header || typeof header !== 'string' || header.length > 128) {
    throw forbidden('Missing security token. Reload the page and try again.');
  }
  if (!safeEqual(hashToken(header), ctx.session.csrf_hash)) {
    throw forbidden('Security token did not match. Reload the page and try again.');
  }
  return true;
}

export function logout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[config.session.cookie];
  if (token) q.run('DELETE FROM sessions WHERE id = ?', hashToken(token));
  const expire = { path: '/', maxAge: 0, secure: isSecureRequest(req), sameSite: 'Strict' };
  res.setHeader('Set-Cookie', [
    serializeCookie(config.session.cookie, '', expire),
    serializeCookie(config.session.csrfCookie, '', { ...expire, httpOnly: false }),
  ]);
}

export function sweepSessions(now = Date.now()) {
  const r = q.run('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?', now, now);
  return r.changes;
}

export { HttpError };
