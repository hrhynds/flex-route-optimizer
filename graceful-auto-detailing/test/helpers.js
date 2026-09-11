import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/* Each suite gets its own throwaway data directory and its own secret, so no
   test can be affected by another's leftovers. */
export function isolate() {
  const dir = mkdtempSync(path.join(tmpdir(), 'gad-test-'));
  process.env.DATA_DIR = dir;
  process.env.APP_SECRET = 'test-secret-that-is-definitely-long-enough-000';
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1';
  process.env.SMS_PROVIDER = 'outbox';
  process.env.NODE_ENV = 'test';
  return {
    dir,
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

export async function startServer() {
  const { createServer } = await import('../server.js');
  const { init } = await import('../src/db.js');
  init();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, port, base: `http://127.0.0.1:${port}` };
}

/* A very small cookie-holding client, so tests exercise the same paths a
   browser would: cookies in, CSRF header out. */
export function makeClient(base) {
  const jar = new Map();
  const client = {
    base,
    cookies: jar,
    csrf() { return jar.get('gad_csrf') ?? null; },
    async raw(method, pathname, { body, headers = {}, csrf = true, origin = base, json = true } = {}) {
      const h = { ...headers };
      if (jar.size) h.Cookie = [...jar].map(([k, val]) => `${k}=${val}`).join('; ');
      if (origin !== null) h.Origin = origin;
      if (csrf && client.csrf() && method !== 'GET' && method !== 'HEAD') h['X-CSRF-Token'] = client.csrf();
      let payload;
      if (body instanceof Uint8Array) { payload = body; }
      else if (body !== undefined) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; }

      const resp = await fetch(`${base}${pathname}`, { method, headers: h, body: payload, redirect: 'manual' });
      for (const raw of resp.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = decodeURIComponent(pair.slice(eq + 1).trim());
        if (value === '') jar.delete(name); else jar.set(name, value);
      }
      const contentType = resp.headers.get('content-type') || '';
      const data = json && contentType.includes('application/json') ? await resp.json() : await resp.arrayBuffer();
      return { status: resp.status, headers: resp.headers, data };
    },
    get: (p, o) => client.raw('GET', p, o),
    post: (p, body, o) => client.raw('POST', p, { body, ...o }),
    patch: (p, body, o) => client.raw('PATCH', p, { body, ...o }),
    del: (p, o) => client.raw('DELETE', p, o),
  };
  return client;
}

export const OWNER = { email: 'owner@gracefulauto.test', password: 'a-long-owner-passphrase-72' };
