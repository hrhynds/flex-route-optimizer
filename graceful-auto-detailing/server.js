import http from 'node:http';
import path from 'node:path';
import config from './src/config.js';
import { init as initDb, close as closeDb } from './src/db.js';
import { Router, sendError, send, serveFile, notFound, HttpError } from './src/http.js';
import { sweepRateLimits, isTokenShape } from './src/security.js';
import { ensureSetupCode, ownerCount, sweepSessions } from './src/auth.js';
import { sweepTrips, sweepPortalLinks } from './src/links.js';
import adminRoutes from './src/routes/admin.js';
import portalRoutes from './src/routes/portal.js';
import trackRoutes from './src/routes/track.js';

/* --------------------------------------------------------------------------
   Page routes

   Three separate front ends, each its own document, so nothing from the admin
   bundle is ever delivered to a customer's browser in the first place.
   -------------------------------------------------------------------------- */

const PAGES = {
  landing: path.join(config.publicDir, 'index.html'),
  admin: path.join(config.publicDir, 'admin', 'index.html'),
  portal: path.join(config.publicDir, 'portal', 'index.html'),
  track: path.join(config.publicDir, 'track', 'index.html'),
};

const pageRouter = new Router();

pageRouter.get('/', async (req, res) => servePage(req, res, PAGES.landing));
/* Only the bare path serves the dashboard shell. Everything else under
   /admin/ is a real file — the app routes itself with the hash, so a deeper
   path is never a page. */
pageRouter.get('/admin', async (req, res) => servePage(req, res, PAGES.admin));
pageRouter.get('/p/:token', async (req, res, params) => {
  if (!isTokenShape(params.token)) throw notFound();
  servePage(req, res, PAGES.portal);
});
pageRouter.get('/t/:token', async (req, res, params) => {
  if (!isTokenShape(params.token)) throw notFound();
  servePage(req, res, PAGES.track);
});
/* The same map, reached from a customer's own appointment page rather than
   from the tracking text, so there is no second link to pass around. */
pageRouter.get('/m/:token', async (req, res, params) => {
  if (!isTokenShape(params.token)) throw notFound();
  servePage(req, res, PAGES.track);
});
pageRouter.get('/healthz', async (req, res) => {
  send(req, res, 200, JSON.stringify({ ok: true, owner: ownerCount() > 0 }), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
});

/* A page that carries a token in its URL must never be cached by a proxy or
   left in a shared cache for the next person on the same machine. */
async function servePage(req, res, file) {
  await serveFile(req, res, path.dirname(file), path.basename(file), {
    'Cache-Control': 'no-store, private',
  });
}

const ROUTERS = [adminRoutes, portalRoutes, trackRoutes, pageRouter];

/* --------------------------------------------------------------------------
   Dispatch
   -------------------------------------------------------------------------- */

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    /* No CORS is offered at all: everything here is same-origin by design. */
    send(req, res, 204, '', { Allow: 'GET, HEAD, POST, PATCH, DELETE' });
    return;
  }

  let mismatch = false;
  for (const router of ROUTERS) {
    const found = router.match(req.method, pathname);
    if (!found) continue;
    if (found.methodMismatch) { mismatch = true; continue; }
    await found.handler(req, res, found.params);
    return;
  }

  /* Anything else is a file request. The API namespace never falls through to
     disk, so a stray /api/... path cannot be answered by a lookalike file. */
  if (!pathname.startsWith('/api/')) {
    await serveFile(req, res, config.publicDir, pathname);
    return;
  }

  throw mismatch ? new HttpError(405, 'That method is not allowed here.') : notFound();
}

export function createServer() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      try { sendError(req, res, err); }
      catch (nested) { console.error('[fatal] could not send error', nested); res.destroy(); }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 10_000;
  server.maxRequestsPerSocket = 0;
  return server;
}

/* --------------------------------------------------------------------------
   Housekeeping

   The one-hour limit on location sharing does not depend on anyone pressing
   anything: this timer ends and purges expired trips on its own.
   -------------------------------------------------------------------------- */

export function startSweeper(everyMs = 60_000) {
  const tick = () => {
    try {
      sweepTrips();
      sweepSessions();
      sweepRateLimits();
      sweepPortalLinks();
    } catch (err) {
      console.error('[sweep] failed', err);
    }
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return timer;
}

/* --------------------------------------------------------------------------
   Boot
   -------------------------------------------------------------------------- */

async function main() {
  initDb();

  if (ownerCount() === 0) {
    if (config.ownerEmail && config.ownerPassword) {
      const { createOwner } = await import('./src/auth.js');
      await createOwner({ email: config.ownerEmail, password: config.ownerPassword, name: 'Owner' });
      console.log(`[setup] Owner account created for ${config.ownerEmail}.`);
    } else {
      const code = ensureSetupCode();
      console.log('');
      console.log('  ┌──────────────────────────────────────────────┐');
      console.log('  │  No owner account yet.                       │');
      console.log(`  │  Go to /admin and enter setup code:          │`);
      console.log(`  │      ${code.padEnd(40)}│`);
      console.log('  └──────────────────────────────────────────────┘');
      console.log('');
    }
  }

  startSweeper();

  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`Graceful Auto Detailing running on http://${config.host}:${config.port}`);
    console.log(`  admin    ${config.publicBaseUrl}/admin`);
    console.log(`  customer links are issued per appointment`);
    console.log(`  sms      ${config.sms.provider}`);
    if (config.env !== 'production') console.log('  mode     development');
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} — shutting down.`);
    server.close(() => { closeDb(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => { console.error('Failed to start:', err); process.exit(1); });
}
