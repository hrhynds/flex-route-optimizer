import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import config from './config.js';

let db = null;
const stmtCache = new Map();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owners (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL DEFAULT '',
  pass_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  failed_count  INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER
);

-- Session ids are the SHA-256 of the cookie value, never the value itself.
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  owner_id            INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  csrf_hash           TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  ip                  TEXT NOT NULL DEFAULT '',
  user_agent          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);

CREATE TABLE IF NOT EXISTS services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  price_is_from INTEGER NOT NULL DEFAULT 0,
  duration_min INTEGER NOT NULL DEFAULT 60,
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS addons (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0,
  price_is_from INTEGER NOT NULL DEFAULT 0,
  duration_min INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  customer_selectable INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  sms_consent INTEGER NOT NULL DEFAULT 1,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

CREATE TABLE IF NOT EXISTS vehicles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  year        TEXT NOT NULL DEFAULT '',
  make        TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '',
  plate       TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vehicles_customer ON vehicles(customer_id);

-- Service name and price are snapshotted so editing the price list never rewrites history.
CREATE TABLE IF NOT EXISTS appointments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id         INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  vehicle_id          INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  service_id          INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name        TEXT NOT NULL,
  service_price_cents INTEGER NOT NULL DEFAULT 0,
  starts_at           INTEGER NOT NULL,
  duration_min        INTEGER NOT NULL DEFAULT 60,
  address             TEXT NOT NULL DEFAULT '',
  lat                 REAL,
  lng                 REAL,
  status              TEXT NOT NULL DEFAULT 'scheduled',
  notes               TEXT NOT NULL DEFAULT '',
  addons_locked       INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_appt_starts ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_customer ON appointments(customer_id);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);

CREATE TABLE IF NOT EXISTS appointment_addons (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  addon_id       INTEGER REFERENCES addons(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  price_cents    INTEGER NOT NULL DEFAULT 0,
  price_is_from  INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'admin',
  created_at     INTEGER NOT NULL,
  UNIQUE(appointment_id, addon_id)
);
CREATE INDEX IF NOT EXISTS idx_apptaddon_appt ON appointment_addons(appointment_id);

-- Customer portal links. Only the hash of the token is ever stored.
CREATE TABLE IF NOT EXISTS portal_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL UNIQUE,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  last_seen_at   INTEGER,
  view_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_portal_appt ON portal_links(appointment_id);

-- A trip exists only between pressing "I'm on my way" and arriving/expiring.
-- No location is stored anywhere else, and pings are purged the moment it ends.
CREATE TABLE IF NOT EXISTS trips (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id   INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  ended_reason     TEXT,
  dest_lat         REAL,
  dest_lng         REAL,
  dest_label       TEXT NOT NULL DEFAULT '',
  last_lat         REAL,
  last_lng         REAL,
  last_accuracy_m  REAL,
  last_heading     REAL,
  last_speed_mps   REAL,
  last_ping_at     INTEGER,
  eta_at           INTEGER,
  distance_m       REAL,
  view_count       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_trips_appt ON trips(appointment_id);
CREATE INDEX IF NOT EXISTS idx_trips_live ON trips(ended_at, expires_at);

CREATE TABLE IF NOT EXISTS trip_pings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id     INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  accuracy_m  REAL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pings_trip ON trip_pings(trip_id, recorded_at);

CREATE TABLE IF NOT EXISTS sms_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL,
  built_in    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  to_phone       TEXT NOT NULL,
  body           TEXT NOT NULL,
  template_key   TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'queued',
  provider       TEXT NOT NULL DEFAULT '',
  provider_sid   TEXT NOT NULL DEFAULT '',
  error          TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  sent_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_appt ON messages(appointment_id);

CREATE TABLE IF NOT EXISTS photos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'before',
  filename       TEXT NOT NULL,
  mime           TEXT NOT NULL,
  bytes          INTEGER NOT NULL DEFAULT 0,
  caption        TEXT NOT NULL DEFAULT '',
  shared         INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_appt ON photos(appointment_id);

CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  number         TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'draft',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents      INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp    INTEGER NOT NULL DEFAULT 0,
  tip_cents      INTEGER NOT NULL DEFAULT 0,  -- unused; tips are recorded on the payment
  total_cents    INTEGER NOT NULL DEFAULT 0,
  paid_cents     INTEGER NOT NULL DEFAULT 0,
  notes          TEXT NOT NULL DEFAULT '',
  issued_at      INTEGER,
  paid_at        INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  qty         INTEGER NOT NULL DEFAULT 1,
  unit_cents  INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'service',
  sort_order  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_invoice ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  tip_cents   INTEGER NOT NULL DEFAULT 0,
  method      TEXT NOT NULL DEFAULT 'cash',
  reference   TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'admin',
  received_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

CREATE TABLE IF NOT EXISTS reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  rating         INTEGER NOT NULL,
  comment        TEXT NOT NULL DEFAULT '',
  author_name    TEXT NOT NULL DEFAULT '',
  published      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

-- Things the customer did on their own link, so the owner can see them.
CREATE TABLE IF NOT EXISTS portal_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  detail         TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL,
  seen_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_portal_events_created ON portal_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portal_events_appt ON portal_events(appointment_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  meta       TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
`;

export function openDb(file) {
  const target = file || path.join(config.dataDir, 'graceful.sqlite');
  if (target !== ':memory:') mkdirSync(path.dirname(target), { recursive: true });
  const handle = new DatabaseSync(target);
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec('PRAGMA busy_timeout = 5000');
  if (target !== ':memory:') handle.exec('PRAGMA journal_mode = WAL');
  handle.exec(SCHEMA);
  return handle;
}

export function init(file) {
  if (db) return db;
  db = openDb(file);
  stmtCache.clear();
  seedDefaults();
  return db;
}

export function handle() {
  if (!db) init();
  return db;
}

export function close() {
  if (db) { db.close(); db = null; stmtCache.clear(); }
}

/* node:sqlite rejects undefined and booleans; normalise before binding. */
function bind(args) {
  return args.map((a) => {
    if (a === undefined) return null;
    if (typeof a === 'boolean') return a ? 1 : 0;
    return a;
  });
}

function prepared(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) { stmt = handle().prepare(sql); stmtCache.set(sql, stmt); }
  return stmt;
}

export const q = {
  get(sql, ...args) { return prepared(sql).get(...bind(args)) ?? null; },
  all(sql, ...args) { return prepared(sql).all(...bind(args)); },
  run(sql, ...args) {
    const r = prepared(sql).run(...bind(args));
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  },
  pluck(sql, ...args) {
    const row = prepared(sql).get(...bind(args));
    if (!row) return null;
    return row[Object.keys(row)[0]];
  },
};

/* Re-entrant: an inner tx() joins the transaction already in flight rather
   than trying to open a second one, so a helper that needs atomicity of its
   own is still safe to call from inside a larger unit of work. */
let txDepth = 0;

export function tx(fn) {
  const h = handle();
  if (txDepth > 0) {
    txDepth += 1;
    try { return fn(); }
    finally { txDepth -= 1; }
  }
  h.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const out = fn();
    h.exec('COMMIT');
    return out;
  } catch (err) {
    try { h.exec('ROLLBACK'); } catch { /* already unwound */ }
    throw err;
  } finally {
    txDepth = 0;
  }
}

/* ---------- settings ---------- */

export const SETTING_DEFAULTS = {
  business_name: 'Graceful Auto Detailing',
  business_tagline: 'Cleaner car. Greater impression.',
  business_phone: '',
  business_email: '',
  business_city: '',
  timezone: 'America/Detroit',
  currency: 'USD',
  tax_rate_bp: '0',                 // basis points; 625 = 6.25%
  tracking_minutes: String(config.tracking.defaultMinutes),
  payment_instructions: 'Cash, card or Zelle on completion.',
  review_prompt: 'If today went well, a quick word means a lot. Totally optional.',
  invoice_prefix: 'GAD',
  invoice_seq: '1000',
  allow_customer_addons: '1',
};

export function getSetting(key) {
  const v = q.pluck('SELECT value FROM settings WHERE key = ?', key);
  return v === null ? (SETTING_DEFAULTS[key] ?? null) : v;
}

export function setSetting(key, value) {
  q.run(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, String(value)
  );
}

/* The setup code lives in this table but is not a setting anyone should see,
   so it never rides along in a payload. */
const PRIVATE_SETTINGS = new Set(['setup_code']);

export function allSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const row of q.all('SELECT key, value FROM settings')) {
    if (PRIVATE_SETTINGS.has(row.key)) continue;
    out[row.key] = row.value;
  }
  return out;
}

/* ---------- first-run content ---------- */

export const DEFAULT_SERVICES = [
  { name: 'Express Wash & Dry', description: 'Hand wash, wheels, tyres dressed and a full dry. In and out.', price_cents: 4500, duration_min: 60 },
  { name: 'Full Interior Detail', description: 'Vacuum throughout, steam and shampoo, every surface cleaned and protected.', price_cents: 15000, duration_min: 180 },
  { name: 'Full Exterior Detail', description: 'Decontamination wash, clay, machine polish and a protective sealant.', price_cents: 17500, duration_min: 210 },
  { name: 'Complete Inside & Out', description: 'The full interior and exterior details together, in one visit.', price_cents: 30000, duration_min: 360 },
];

export const DEFAULT_ADDONS = [
  { name: 'Trim restoration', price_cents: 2000, description: 'Faded black plastic trim brought back to a deep, even finish instead of chalky grey.' },
  { name: 'Spray wax', price_cents: 1000, description: 'A quick layer of gloss and water beading on top of the wash. Lasts a few weeks.' },
  { name: 'Clay bar with long-lasting wax', price_cents: 6000, description: 'Clay lifts the grit that washing leaves behind, then a durable wax seals it. Paint feels like glass for months.' },
  { name: 'Pet hair removal', price_cents: 4000, description: 'The hair a vacuum will not touch — lifted out of carpet and upholstery by hand.' },
  { name: 'Headlight restoration', price_cents: 8000, price_is_from: 1, description: 'Cloudy yellowed lenses sanded, polished and sealed clear again. Price depends on how far gone they are.' },
];

export const DEFAULT_TEMPLATES = [
  {
    key: 'booking_confirmation',
    name: 'Booking confirmation',
    description: 'Sent when an appointment is booked. Carries the customer\'s private link.',
    body: 'Hi {{customer_first}} — you\'re booked with {{business_name}} for {{service}} on {{date}} at {{time}}. Details and optional extras here: {{portal_link}}',
  },
  {
    key: 'reminder',
    name: 'Day-before reminder',
    description: 'A nudge the day before the appointment.',
    body: 'Hi {{customer_first}} — reminder: {{service}} on your {{vehicle}} tomorrow at {{time}}. Anything to add or change? {{portal_link}}',
  },
  {
    key: 'on_my_way',
    name: "I'm on my way",
    description: 'Sent when you press "I\'m on my way". Carries the live tracking link.',
    body: 'Hi {{customer_first}} — {{business_name}} here, on my way to you now. Follow along live (expires in {{tracking_minutes}} min): {{tracking_link}}',
  },
  {
    key: 'arrived',
    name: 'Arrived',
    description: 'Sent when you mark yourself as arrived.',
    body: 'I\'m outside with your {{vehicle}} whenever you\'re ready. — {{business_name}}',
  },
  {
    key: 'job_complete',
    name: 'Job complete',
    description: 'Sent when the appointment is completed. Links to photos and the invoice.',
    body: 'All finished on your {{vehicle}}. Before and after photos, your invoice and payment options: {{portal_link}}',
  },
  {
    key: 'invoice_sent',
    name: 'Invoice',
    description: 'Sent when an invoice is issued.',
    body: 'Your invoice from {{business_name}} for {{service}} comes to {{total}}. View and pay here: {{portal_link}}',
  },
  {
    key: 'review_request',
    name: 'Review request',
    description: 'A low-pressure ask for a review after the job.',
    body: 'Thanks again, {{customer_first}}. If you have 20 seconds, a quick word helps a small business more than you\'d think — no pressure either way: {{portal_link}}',
  },
];

function seedDefaults() {
  const now = Date.now();
  if (q.pluck('SELECT COUNT(*) AS n FROM services') === 0) {
    let i = 0;
    for (const s of DEFAULT_SERVICES) {
      q.run(
        `INSERT INTO services(name, description, price_cents, price_is_from, duration_min, active, sort_order, created_at, updated_at)
         VALUES(?,?,?,?,?,1,?,?,?)`,
        s.name, s.description, s.price_cents, s.price_is_from ?? 0, s.duration_min, i++, now, now
      );
    }
  }
  if (q.pluck('SELECT COUNT(*) AS n FROM addons') === 0) {
    let i = 0;
    for (const a of DEFAULT_ADDONS) {
      q.run(
        `INSERT INTO addons(name, description, price_cents, price_is_from, duration_min, active, customer_selectable, sort_order, created_at, updated_at)
         VALUES(?,?,?,?,?,1,1,?,?,?)`,
        a.name, a.description, a.price_cents, a.price_is_from ?? 0, a.duration_min ?? 0, i++, now, now
      );
    }
  }
  for (const t of DEFAULT_TEMPLATES) {
    const exists = q.pluck('SELECT COUNT(*) AS n FROM sms_templates WHERE key = ?', t.key);
    if (!exists) {
      q.run(
        'INSERT INTO sms_templates(key, name, description, body, built_in, updated_at) VALUES(?,?,?,?,1,?)',
        t.key, t.name, t.description, t.body, now
      );
    }
  }
}

export function audit(actor, action, entity = '', entityId = '', meta = '', ip = '') {
  q.run(
    'INSERT INTO audit_log(actor, action, entity, entity_id, meta, ip, created_at) VALUES(?,?,?,?,?,?,?)',
    actor, action, entity, String(entityId ?? ''), typeof meta === 'string' ? meta : JSON.stringify(meta), ip, Date.now()
  );
}

export function portalEvent(appointmentId, kind, detail = '') {
  q.run(
    'INSERT INTO portal_events(appointment_id, kind, detail, created_at) VALUES(?,?,?,?)',
    appointmentId, kind, typeof detail === 'string' ? detail : JSON.stringify(detail), Date.now()
  );
}
