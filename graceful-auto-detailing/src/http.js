import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import config from './config.js';
import { securityHeaders } from './security.js';

export class HttpError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

export const bad = (msg, code) => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Sign in to continue.') => new HttpError(401, msg);
export const forbidden = (msg = 'Not allowed.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg) => new HttpError(409, msg);
export const tooMany = (msg = 'Too many attempts. Try again shortly.') => new HttpError(429, msg);

/* ---------- responses ---------- */

export function send(req, res, status, body, headers = {}) {
  if (res.writableEnded) return;
  const base = securityHeaders(req);
  const all = { ...base, ...headers };
  const payload = body === null || body === undefined ? '' : body;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  all['Content-Length'] = String(buf.length);
  res.writeHead(status, all);
  if (req.method === 'HEAD') res.end();
  else res.end(buf);
}

export function sendJson(req, res, status, data, headers = {}) {
  send(req, res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

export function sendError(req, res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError && err.expose ? err.message : 'Something went wrong.';
  if (status >= 500) console.error('[error]', req.method, req.url, err);
  const body = { error: message };
  if (err instanceof HttpError && err.code) body.code = err.code;
  const headers = {};
  if (status === 429 && err.retryAfterSec) headers['Retry-After'] = String(err.retryAfterSec);
  if (status === 401) headers['WWW-Authenticate'] = 'Session';
  sendJson(req, res, status, body, headers);
}

export function redirect(req, res, location, status = 302) {
  send(req, res, status, '', { Location: location, 'Cache-Control': 'no-store' });
}

/* ---------- request bodies ---------- */

export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; req.destroy(); reject(err); } };
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) { fail(new HttpError(413, 'That is too large.')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', () => fail(new HttpError(400, 'Could not read the request.')));
    req.on('aborted', () => fail(new HttpError(400, 'Request aborted.')));
  });
}

export async function readJson(req, maxBytes = config.jsonBodyMaxBytes) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/json') throw bad('Send JSON.');
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  let parsed;
  try { parsed = JSON.parse(buf.toString('utf8')); }
  catch { throw bad('That is not valid JSON.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw bad('Expected a JSON object.');
  }
  /* Prototype pollution guard: a body may not carry these keys at all. */
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) throw bad('Unexpected field.');
  }
  return parsed;
}

/* ---------- router ---------- */

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    const names = [];
    const regexSrc = pattern
      .split('/')
      .map((seg) => {
        if (!seg) return '';
        if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${regexSrc}/?$`), names, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathExists = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathExists = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = Object.create(null);
      route.names.forEach((name, i) => {
        try { params[name] = decodeURIComponent(m[i + 1]); }
        catch { params[name] = m[i + 1]; }
      });
      return { handler: route.handler, params };
    }
    return pathExists ? { methodMismatch: true } : null;
  }
}

/* ---------- static files ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* Only these extensions are ever served from disk. */
const SERVABLE = new Set(Object.keys(MIME));

export async function serveFile(req, res, rootDir, relPath, extraHeaders = {}) {
  const root = path.resolve(rootDir);
  /* Normalise, then prove the result is still inside the root. Both checks matter:
     normalisation kills `..` segments, the prefix test kills symlink-ish surprises. */
  const decoded = (() => { try { return decodeURIComponent(relPath); } catch { return relPath; } })();
  if (decoded.includes('\0')) throw notFound();
  const target = path.resolve(root, '.' + path.posix.resolve('/', decoded.replace(/\\/g, '/')));
  if (target !== root && !target.startsWith(root + path.sep)) throw notFound();

  const ext = path.extname(target).toLowerCase();
  if (!SERVABLE.has(ext)) throw notFound();

  let info;
  try { info = await stat(target); }
  catch { throw notFound(); }
  if (!info.isFile()) throw notFound();

  const etag = `W/"${createHash('sha1').update(`${info.size}-${info.mtimeMs}`).digest('base64url')}"`;
  const headers = {
    ...securityHeaders(req),
    'Content-Type': MIME[ext],
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
    ...extraHeaders,
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['Content-Length'] = String(info.size);
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}
