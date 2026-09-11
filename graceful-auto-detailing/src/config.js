import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/* A .env file is a convenience for local runs; real deployments use real env vars. */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const int = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

/* The signing secret must survive restarts or every live link dies with the process.
   In production it is required; in dev we fall back to a per-run random value and say so. */
function resolveSecret() {
  const given = process.env.APP_SECRET;
  if (given && given.length >= 32) return given;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_SECRET must be set to at least 32 characters in production.');
  }
  if (given) {
    console.warn('[config] APP_SECRET is shorter than 32 characters — generating an ephemeral one instead.');
  }
  return randomBytes(48).toString('base64url');
}

export const config = {
  port: int('PORT', 8080),
  host: process.env.HOST || '0.0.0.0',
  env: process.env.NODE_ENV || 'development',
  secret: resolveSecret(),

  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'),
  publicDir: path.join(ROOT, 'public'),

  /* Absolute base used when building links that go out by text message. */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${int('PORT', 8080)}`).replace(/\/+$/, ''),

  /* Trust X-Forwarded-* only when explicitly told to — otherwise a client can spoof its own IP. */
  trustProxy: process.env.TRUST_PROXY === '1',

  session: {
    cookie: 'gad_session',
    csrfCookie: 'gad_csrf',
    idleMinutes: int('SESSION_IDLE_MINUTES', 12 * 60),
    absoluteDays: int('SESSION_ABSOLUTE_DAYS', 7),
  },

  tracking: {
    defaultMinutes: int('TRACKING_MINUTES', 60),
    maxMinutes: int('TRACKING_MAX_MINUTES', 180),
    pingSeconds: int('TRACKING_PING_SECONDS', 15),
  },

  portal: {
    /* How long a customer's appointment link stays usable after the appointment starts. */
    daysAfterAppointment: int('PORTAL_DAYS_AFTER', 14),
  },

  uploads: {
    maxBytes: int('UPLOAD_MAX_BYTES', 8 * 1024 * 1024),
    dir: null, // filled in below
  },

  jsonBodyMaxBytes: int('JSON_MAX_BYTES', 512 * 1024),

  sms: {
    provider: process.env.SMS_PROVIDER || (process.env.TWILIO_ACCOUNT_SID ? 'twilio' : 'outbox'),
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      from: process.env.TWILIO_FROM || '',
    },
  },

  /* Owner bootstrap. When no owner exists the server prints a one-time setup code. */
  ownerEmail: process.env.OWNER_EMAIL || '',
  ownerPassword: process.env.OWNER_PASSWORD || '',
};

config.uploads.dir = path.join(config.dataDir, 'uploads');
export default config;
