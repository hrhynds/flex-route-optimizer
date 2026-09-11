import { readFile } from 'node:fs/promises';
import config from '../config.js';
import { q, tx, allSettings, setSetting, SETTING_DEFAULTS, audit } from '../db.js';
import { Router, readJson, readBody, sendJson, send, bad, notFound, forbidden, conflict, tooMany } from '../http.js';
import * as v from '../validate.js';
import {
  requireOwner, requireCsrf, login, logout, ownerCount, ensureSetupCode, checkSetupCode,
  clearSetupCode, createOwner, changePassword,
} from '../auth.js';
import { clientIp, rateLimit } from '../security.js';
import {
  STATUSES, STATUS_KEYS, OPEN_STATUSES, loadAppointment, setStatus, adminView, listView,
  customerOf, vehicleOf, photosOf,
} from '../appointments.js';
import {
  createPortalLink, revokePortalLinks,
  startTrip, endTrip, recordPing, liveTripForAppointment, trackingMinutes,
} from '../links.js';
import {
  appointmentTotals, getInvoice, getInvoiceById, buildInvoice, recalcInvoice, issueInvoice,
  voidInvoice, recordPayment, deletePayment, PAYMENT_METHODS, INVOICE_STATUSES, taxRateBp,
} from '../billing.js';
import { savePhoto, getPhoto, photoPath, deletePhoto, PHOTO_KINDS } from '../photos.js';
import {
  sendSms, renderTemplate, buildVars, getTemplate, PLACEHOLDERS, unknownPlaceholders,
  SMS_MAX_LENGTH,
} from '../sms.js';

export const router = new Router();

/* Every admin route runs through here. Anything that changes state must carry
   a valid session cookie AND a matching CSRF token from our own origin. */
function guard(handler, { csrf = true } = {}) {
  return async (req, res, params) => {
    const ctx = requireOwner(req);
    if (csrf && req.method !== 'GET' && req.method !== 'HEAD') requireCsrf(req, ctx);
    return handler({
      req, res, params,
      owner: ctx.owner,
      session: ctx.session,
      actor: `owner:${ctx.owner.id}`,
      ip: clientIp(req),
    });
  };
}

const ok = (req, res, data = {}) => sendJson(req, res, 200, data);
const id = (params, name = 'id') => v.int(params[name], 'Id', { min: 1 });

/* --------------------------------------------------------------------------
   Sign in / first run
   -------------------------------------------------------------------------- */

router.get('/api/admin/bootstrap', async (req, res) => {
  const needsSetup = ownerCount() === 0;
  if (needsSetup) ensureSetupCode();
  let signedIn = false;
  let owner = null;
  try {
    const ctx = requireOwner(req);
    signedIn = true;
    owner = { id: ctx.owner.id, email: ctx.owner.email, name: ctx.owner.name };
  } catch { /* not signed in, which is a normal answer here */ }
  const s = allSettings();
  sendJson(req, res, 200, {
    needs_setup: needsSetup,
    signed_in: signedIn,
    owner,
    business_name: s.business_name,
    sms_provider: config.sms.provider,
  });
});

router.post('/api/admin/setup', async (req, res) => {
  if (ownerCount() > 0) throw forbidden('Setup is already complete.');
  const limit = rateLimit(`setup:${clientIp(req)}`, { limit: 10, windowMs: 15 * 60 * 1000 });
  if (!limit.ok) throw tooMany('Too many setup attempts. Wait a few minutes.', limit.retryAfterSec);

  const body = await readJson(req);
  checkSetupCode(body.code);
  const email = v.email(body.email, 'Email', { optional: false });
  const name = v.str(body.name, 'Your name', { max: 120, optional: true, fallback: 'Owner' });
  await createOwner({ email, password: body.password, name });
  clearSetupCode();
  if (body.business_name) setSetting('business_name', v.str(body.business_name, 'Business name', { max: 120 }));
  const result = await login(req, res, { email, password: body.password });
  ok(req, res, { owner: result.owner });
});

router.post('/api/admin/login', async (req, res) => {
  const body = await readJson(req);
  const result = await login(req, res, { email: body.email, password: body.password });
  ok(req, res, { owner: result.owner });
});

router.post('/api/admin/logout', guard(async ({ req, res, actor, ip }) => {
  audit(actor, 'logout', 'owner', '', '', ip);
  logout(req, res);
  ok(req, res, { signed_out: true });
}));

router.post('/api/admin/password', guard(async ({ req, res, owner }) => {
  const body = await readJson(req);
  await changePassword(owner.id, body.current, body.next);
  /* Changing the password drops every session including this one. */
  logout(req, res);
  ok(req, res, { changed: true });
}));

/* --------------------------------------------------------------------------
   Dashboard
   -------------------------------------------------------------------------- */

router.get('/api/admin/dashboard', guard(async ({ req, res }) => {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const settings = allSettings();

  const todayStart = startOfDayInZone(now, settings.timezone);
  const todayEnd = todayStart + dayMs;

  const today = q.all(
    'SELECT * FROM appointments WHERE starts_at >= ? AND starts_at < ? ORDER BY starts_at',
    todayStart, todayEnd
  ).map((a) => listView(a, { now }));

  const upcoming = q.all(
    `SELECT * FROM appointments WHERE starts_at >= ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
      ORDER BY starts_at LIMIT 12`,
    todayEnd, ...OPEN_STATUSES
  ).map((a) => listView(a, { now }));

  const liveTrip = q.get(
    'SELECT * FROM trips WHERE ended_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1', now
  );

  const weekStart = todayStart - 6 * dayMs;
  /* amount_cents is the money that actually arrived; tip_cents says how much
     of that same money was a tip. Adding them would count the tip twice. */
  const earned = q.get(
    `SELECT COALESCE(SUM(amount_cents),0) AS amt, COALESCE(SUM(tip_cents),0) AS tip
       FROM payments WHERE received_at >= ?`, weekStart
  );
  const outstanding = q.pluck(
    "SELECT COALESCE(SUM(total_cents - paid_cents),0) AS n FROM invoices WHERE status = 'sent'"
  );

  ok(req, res, {
    today,
    upcoming,
    live_trip: liveTrip && {
      id: liveTrip.id,
      appointment_id: liveTrip.appointment_id,
      expires_at: liveTrip.expires_at,
      last_ping_at: liveTrip.last_ping_at,
      has_position: liveTrip.last_lat != null,
    },
    stats: {
      today_count: today.length,
      week_collected_cents: earned.amt,
      week_tips_cents: earned.tip,
      outstanding_cents: outstanding,
      unsent_messages: q.pluck("SELECT COUNT(*) AS n FROM messages WHERE status = 'outbox'"),
      new_reviews: q.pluck('SELECT COUNT(*) AS n FROM reviews WHERE published = 0'),
    },
    settings: { timezone: settings.timezone, business_name: settings.business_name, tracking_minutes: trackingMinutes() },
  });
}));

/* Midnight in the business's own timezone, not the server's. */
export function startOfDayInZone(ms, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const secondsIntoDay =
    Number(parts.hour === '24' ? '0' : parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return ms - secondsIntoDay * 1000 - (ms % 1000);
}

/* --------------------------------------------------------------------------
   Services and add-ons — one shape, two tables
   -------------------------------------------------------------------------- */

const CATALOG = {
  services: { table: 'services', label: 'Service' },
  addons: { table: 'addons', label: 'Add-on' },
};

function catalogTable(kind) {
  const entry = CATALOG[kind];
  if (!entry) throw notFound('Unknown list.');
  return entry;
}

router.get('/api/admin/catalog', guard(async ({ req, res }) => {
  ok(req, res, {
    services: q.all('SELECT * FROM services ORDER BY sort_order, id'),
    addons: q.all('SELECT * FROM addons ORDER BY sort_order, id'),
    tax_rate_bp: taxRateBp(),
  });
}));

router.post('/api/admin/catalog/:kind', guard(async ({ req, res, params, actor }) => {
  const { table, label } = catalogTable(params.kind);
  const body = await readJson(req);
  const now = Date.now();
  const nextSort = (q.pluck(`SELECT COALESCE(MAX(sort_order), -1) AS n FROM ${table}`) ?? -1) + 1;

  const fields = readCatalogFields(body, label, params.kind);
  const cols = params.kind === 'addons'
    ? `(name, description, price_cents, price_is_from, duration_min, active, customer_selectable, sort_order, created_at, updated_at)`
    : `(name, description, price_cents, price_is_from, duration_min, active, sort_order, created_at, updated_at)`;
  const vals = params.kind === 'addons'
    ? [fields.name, fields.description, fields.price_cents, fields.price_is_from, fields.duration_min, fields.active, fields.customer_selectable, nextSort, now, now]
    : [fields.name, fields.description, fields.price_cents, fields.price_is_from, fields.duration_min, fields.active, nextSort, now, now];

  const res2 = q.run(`INSERT INTO ${table} ${cols} VALUES(${vals.map(() => '?').join(',')})`, ...vals);
  audit(actor, `${params.kind}.create`, params.kind, res2.id, { name: fields.name });
  ok(req, res, { item: q.get(`SELECT * FROM ${table} WHERE id = ?`, res2.id) });
}));

router.patch('/api/admin/catalog/:kind/:id', guard(async ({ req, res, params, actor }) => {
  const { table, label } = catalogTable(params.kind);
  const itemId = id(params);
  const existing = q.get(`SELECT * FROM ${table} WHERE id = ?`, itemId);
  if (!existing) throw notFound(`${label} not found.`);

  const body = await readJson(req);
  const patch = {};
  if ('name' in body) patch.name = v.str(body.name, 'Name', { min: 1, max: 120 });
  if ('description' in body) patch.description = v.text(body.description, 'Description', { max: 600, optional: true });
  if ('price_cents' in body) patch.price_cents = v.cents(body.price_cents, 'Price');
  if ('price_is_from' in body) patch.price_is_from = v.bool(body.price_is_from, 'Starting-at price') ? 1 : 0;
  if ('duration_min' in body) patch.duration_min = v.int(body.duration_min, 'Time needed', { min: 0, max: 1440 });
  if ('active' in body) patch.active = v.bool(body.active, 'Active') ? 1 : 0;
  if (params.kind === 'addons' && 'customer_selectable' in body) {
    patch.customer_selectable = v.bool(body.customer_selectable, 'Customers can add this') ? 1 : 0;
  }
  const keys = Object.keys(patch);
  if (!keys.length) throw bad('Nothing to change.');

  q.run(
    `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => patch[k]), Date.now(), itemId
  );
  audit(actor, `${params.kind}.update`, params.kind, itemId, patch);
  ok(req, res, { item: q.get(`SELECT * FROM ${table} WHERE id = ?`, itemId) });
}));

router.delete('/api/admin/catalog/:kind/:id', guard(async ({ req, res, params, actor }) => {
  const { table, label } = catalogTable(params.kind);
  const itemId = id(params);
  const existing = q.get(`SELECT * FROM ${table} WHERE id = ?`, itemId);
  if (!existing) throw notFound(`${label} not found.`);

  /* Anything already attached to an appointment is retired rather than deleted,
     so past jobs keep the name and price they were sold at. */
  const inUse = params.kind === 'services'
    ? q.pluck('SELECT COUNT(*) AS n FROM appointments WHERE service_id = ?', itemId)
    : q.pluck('SELECT COUNT(*) AS n FROM appointment_addons WHERE addon_id = ?', itemId);

  if (inUse > 0) {
    q.run(`UPDATE ${table} SET active = 0, updated_at = ? WHERE id = ?`, Date.now(), itemId);
    audit(actor, `${params.kind}.retire`, params.kind, itemId);
    ok(req, res, { retired: true, in_use: inUse });
    return;
  }
  q.run(`DELETE FROM ${table} WHERE id = ?`, itemId);
  audit(actor, `${params.kind}.delete`, params.kind, itemId);
  ok(req, res, { deleted: true });
}));

router.post('/api/admin/catalog/:kind/reorder', guard(async ({ req, res, params, actor }) => {
  const { table } = catalogTable(params.kind);
  const body = await readJson(req);
  const order = v.idList(body.order, 'Order', { max: 200 });
  tx(() => {
    order.forEach((itemId, index) => {
      q.run(`UPDATE ${table} SET sort_order = ?, updated_at = ? WHERE id = ?`, index, Date.now(), itemId);
    });
  });
  audit(actor, `${params.kind}.reorder`, params.kind, '', { count: order.length });
  ok(req, res, { reordered: order.length });
}));

function readCatalogFields(body, label, kind) {
  return {
    name: v.str(body.name, `${label} name`, { min: 1, max: 120 }),
    description: v.text(body.description, 'Description', { max: 600, optional: true }),
    price_cents: v.cents(body.price_cents, 'Price', { optional: true, fallback: 0 }),
    price_is_from: v.bool(body.price_is_from, 'Starting-at price') ? 1 : 0,
    duration_min: v.int(body.duration_min, 'Time needed', { min: 0, max: 1440, optional: true, fallback: kind === 'services' ? 60 : 0 }),
    active: v.bool(body.active, 'Active', { fallback: true }) ? 1 : 0,
    customer_selectable: v.bool(body.customer_selectable, 'Customers can add this', { fallback: true }) ? 1 : 0,
  };
}

/* --------------------------------------------------------------------------
   Customers and their vehicles
   -------------------------------------------------------------------------- */

router.get('/api/admin/customers', guard(async ({ req, res }) => {
  const url = new URL(req.url, 'http://local');
  const search = v.str(url.searchParams.get('search'), 'Search', { max: 80, optional: true });
  const includeArchived = url.searchParams.get('archived') === '1';

  let rows;
  if (search) {
    const like = `%${search.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    rows = q.all(
      `SELECT * FROM customers
        WHERE (archived = 0 OR ? = 1)
          AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
        ORDER BY name LIMIT 100`,
      includeArchived ? 1 : 0, like, like, like
    );
  } else {
    rows = q.all(
      'SELECT * FROM customers WHERE archived = 0 OR ? = 1 ORDER BY name LIMIT 200',
      includeArchived ? 1 : 0
    );
  }

  ok(req, res, {
    customers: rows.map((c) => ({
      ...c,
      sms_consent: Boolean(c.sms_consent),
      archived: Boolean(c.archived),
      vehicle_count: q.pluck('SELECT COUNT(*) AS n FROM vehicles WHERE customer_id = ?', c.id),
      appointment_count: q.pluck('SELECT COUNT(*) AS n FROM appointments WHERE customer_id = ?', c.id),
    })),
  });
}));

router.post('/api/admin/customers', guard(async ({ req, res, actor }) => {
  const body = await readJson(req);
  const now = Date.now();
  const fields = {
    name: v.str(body.name, 'Customer name', { min: 1, max: 120 }),
    phone: v.phone(body.phone, 'Phone'),
    email: v.email(body.email, 'Email'),
    address: v.str(body.address, 'Address', { max: 240, optional: true }),
    notes: v.text(body.notes, 'Notes', { max: 2000, optional: true }),
    sms_consent: v.bool(body.sms_consent, 'Text consent', { fallback: true }) ? 1 : 0,
  };
  const result = q.run(
    `INSERT INTO customers(name, phone, email, address, notes, sms_consent, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    fields.name, fields.phone, fields.email, fields.address, fields.notes, fields.sms_consent, now, now
  );
  audit(actor, 'customer.create', 'customer', result.id, { name: fields.name });

  if (body.vehicle && typeof body.vehicle === 'object') {
    insertVehicle(result.id, body.vehicle, actor);
  }
  ok(req, res, { customer: loadCustomer(result.id) });
}));

router.get('/api/admin/customers/:id', guard(async ({ req, res, params }) => {
  ok(req, res, { customer: loadCustomer(id(params)) });
}));

router.patch('/api/admin/customers/:id', guard(async ({ req, res, params, actor }) => {
  const customerId = id(params);
  if (!q.get('SELECT id FROM customers WHERE id = ?', customerId)) throw notFound('That customer does not exist.');
  const body = await readJson(req);
  const patch = {};
  if ('name' in body) patch.name = v.str(body.name, 'Customer name', { min: 1, max: 120 });
  if ('phone' in body) patch.phone = v.phone(body.phone, 'Phone');
  if ('email' in body) patch.email = v.email(body.email, 'Email');
  if ('address' in body) patch.address = v.str(body.address, 'Address', { max: 240, optional: true });
  if ('notes' in body) patch.notes = v.text(body.notes, 'Notes', { max: 2000, optional: true });
  if ('sms_consent' in body) patch.sms_consent = v.bool(body.sms_consent, 'Text consent') ? 1 : 0;
  if ('archived' in body) patch.archived = v.bool(body.archived, 'Archived') ? 1 : 0;
  const keys = Object.keys(patch);
  if (!keys.length) throw bad('Nothing to change.');
  q.run(
    `UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => patch[k]), Date.now(), customerId
  );
  audit(actor, 'customer.update', 'customer', customerId, Object.keys(patch).join(','));
  ok(req, res, { customer: loadCustomer(customerId) });
}));

router.delete('/api/admin/customers/:id', guard(async ({ req, res, params, actor }) => {
  const customerId = id(params);
  const customer = q.get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!customer) throw notFound('That customer does not exist.');
  const appts = q.pluck('SELECT COUNT(*) AS n FROM appointments WHERE customer_id = ?', customerId);
  if (appts > 0) {
    q.run('UPDATE customers SET archived = 1, updated_at = ? WHERE id = ?', Date.now(), customerId);
    audit(actor, 'customer.archive', 'customer', customerId);
    ok(req, res, { archived: true, appointments: appts });
    return;
  }
  q.run('DELETE FROM customers WHERE id = ?', customerId);
  audit(actor, 'customer.delete', 'customer', customerId);
  ok(req, res, { deleted: true });
}));

router.post('/api/admin/customers/:id/vehicles', guard(async ({ req, res, params, actor }) => {
  const customerId = id(params);
  if (!q.get('SELECT id FROM customers WHERE id = ?', customerId)) throw notFound('That customer does not exist.');
  const body = await readJson(req);
  const vehicleId = insertVehicle(customerId, body, actor);
  ok(req, res, { vehicle: q.get('SELECT * FROM vehicles WHERE id = ?', vehicleId) });
}));

router.patch('/api/admin/vehicles/:id', guard(async ({ req, res, params, actor }) => {
  const vehicleId = id(params);
  const existing = q.get('SELECT * FROM vehicles WHERE id = ?', vehicleId);
  if (!existing) throw notFound('That vehicle does not exist.');
  const body = await readJson(req);
  const patch = {};
  for (const field of ['year', 'make', 'model', 'color', 'plate']) {
    if (field in body) patch[field] = v.str(body[field], field, { max: 40, optional: true });
  }
  if ('notes' in body) patch.notes = v.text(body.notes, 'Notes', { max: 1000, optional: true });
  const keys = Object.keys(patch);
  if (!keys.length) throw bad('Nothing to change.');
  q.run(
    `UPDATE vehicles SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => patch[k]), Date.now(), vehicleId
  );
  audit(actor, 'vehicle.update', 'vehicle', vehicleId);
  ok(req, res, { vehicle: q.get('SELECT * FROM vehicles WHERE id = ?', vehicleId) });
}));

router.delete('/api/admin/vehicles/:id', guard(async ({ req, res, params, actor }) => {
  const vehicleId = id(params);
  if (!q.get('SELECT id FROM vehicles WHERE id = ?', vehicleId)) throw notFound('That vehicle does not exist.');
  q.run('DELETE FROM vehicles WHERE id = ?', vehicleId);
  audit(actor, 'vehicle.delete', 'vehicle', vehicleId);
  ok(req, res, { deleted: true });
}));

function insertVehicle(customerId, body, actor) {
  const now = Date.now();
  const fields = {
    year: v.str(body.year, 'Year', { max: 8, optional: true }),
    make: v.str(body.make, 'Make', { max: 40, optional: true }),
    model: v.str(body.model, 'Model', { max: 40, optional: true }),
    color: v.str(body.color, 'Colour', { max: 30, optional: true }),
    plate: v.str(body.plate, 'Plate', { max: 16, optional: true }),
    notes: v.text(body.notes, 'Notes', { max: 1000, optional: true }),
  };
  if (!fields.make && !fields.model) throw bad('Give the vehicle at least a make or a model.');
  const result = q.run(
    `INSERT INTO vehicles(customer_id, year, make, model, color, plate, notes, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    customerId, fields.year, fields.make, fields.model, fields.color, fields.plate, fields.notes, now, now
  );
  audit(actor, 'vehicle.create', 'vehicle', result.id, { customerId });
  return result.id;
}

function loadCustomer(customerId) {
  const customer = q.get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!customer) throw notFound('That customer does not exist.');
  return {
    ...customer,
    sms_consent: Boolean(customer.sms_consent),
    archived: Boolean(customer.archived),
    vehicles: q.all('SELECT * FROM vehicles WHERE customer_id = ? ORDER BY created_at', customerId),
    appointments: q.all(
      'SELECT * FROM appointments WHERE customer_id = ? ORDER BY starts_at DESC LIMIT 50', customerId
    ).map((a) => listView(a)),
  };
}

/* --------------------------------------------------------------------------
   Appointments
   -------------------------------------------------------------------------- */

router.get('/api/admin/appointments', guard(async ({ req, res }) => {
  const url = new URL(req.url, 'http://local');
  const from = v.timestamp(url.searchParams.get('from'), 'From', { optional: true });
  const to = v.timestamp(url.searchParams.get('to'), 'To', { optional: true });
  const status = url.searchParams.get('status');
  const customerId = url.searchParams.get('customer_id');

  const where = [];
  const args = [];
  if (from) { where.push('starts_at >= ?'); args.push(from); }
  if (to) { where.push('starts_at < ?'); args.push(to); }
  if (status === 'open') {
    where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
    args.push(...OPEN_STATUSES);
  } else if (status) {
    where.push('status = ?');
    args.push(v.oneOf(status, 'Status', STATUS_KEYS));
  }
  if (customerId) { where.push('customer_id = ?'); args.push(v.int(customerId, 'Customer', { min: 1 })); }

  const rows = q.all(
    `SELECT * FROM appointments ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY starts_at DESC LIMIT 300`,
    ...args
  );
  ok(req, res, { appointments: rows.map((a) => listView(a)), statuses: STATUSES });
}));

router.post('/api/admin/appointments', guard(async ({ req, res, actor }) => {
  const body = await readJson(req);
  const customerId = v.int(body.customer_id, 'Customer', { min: 1 });
  const customer = q.get('SELECT * FROM customers WHERE id = ?', customerId);
  if (!customer) throw notFound('Pick a customer that exists.');

  let vehicleId = null;
  if (body.vehicle_id != null && body.vehicle_id !== '') {
    vehicleId = v.int(body.vehicle_id, 'Vehicle', { min: 1 });
    const vehicle = q.get('SELECT * FROM vehicles WHERE id = ?', vehicleId);
    if (!vehicle || vehicle.customer_id !== customerId) throw bad('That vehicle belongs to someone else.');
  }

  const serviceId = v.int(body.service_id, 'Service', { min: 1 });
  const service = q.get('SELECT * FROM services WHERE id = ?', serviceId);
  if (!service) throw notFound('Pick a service that exists.');

  const startsAt = v.timestamp(body.starts_at, 'Date and time');
  const duration = v.int(body.duration_min, 'How long', { min: 15, max: 1440, optional: true, fallback: service.duration_min });
  const now = Date.now();

  const result = q.run(
    `INSERT INTO appointments(customer_id, vehicle_id, service_id, service_name, service_price_cents,
       starts_at, duration_min, address, lat, lng, status, notes, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    customerId, vehicleId, serviceId, service.name, service.price_cents,
    startsAt, duration,
    v.str(body.address, 'Address', { max: 240, optional: true, fallback: customer.address }),
    v.lat(body.lat, 'Latitude'), v.lng(body.lng, 'Longitude'),
    v.oneOf(body.status, 'Status', STATUS_KEYS, { optional: true, fallback: 'scheduled' }),
    v.text(body.notes, 'Notes', { max: 2000, optional: true }),
    now, now
  );

  /* Add-ons chosen at booking time are snapshotted straight away. */
  for (const addonId of v.idList(body.addon_ids, 'Add-ons')) {
    attachAddon(result.id, addonId, 'admin');
  }

  audit(actor, 'appointment.create', 'appointment', result.id, { customerId, serviceId });
  ok(req, res, { appointment: adminView(loadAppointment(result.id)) });
}));

router.get('/api/admin/appointments/:id', guard(async ({ req, res, params }) => {
  const appt = loadAppointment(id(params));
  const now = Date.now();
  const link = q.get(
    `SELECT id, created_at, expires_at, revoked_at, last_seen_at, view_count FROM portal_links
      WHERE appointment_id = ? ORDER BY created_at DESC LIMIT 1`,
    appt.id
  );
  ok(req, res, {
    appointment: adminView(appt, { now }),
    photos: photosOf(appt.id).map(publicPhoto),
    messages: q.all(
      'SELECT * FROM messages WHERE appointment_id = ? ORDER BY created_at DESC LIMIT 50', appt.id
    ),
    invoice: getInvoice(appt.id),
    available_addons: q.all('SELECT * FROM addons WHERE active = 1 ORDER BY sort_order, id'),
    portal_link: link && {
      ...link,
      live: !link.revoked_at && link.expires_at > now,
    },
    payment_methods: PAYMENT_METHODS,
  });
}));

router.patch('/api/admin/appointments/:id', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  const appt = loadAppointment(apptId);
  const body = await readJson(req);
  const patch = {};

  if ('starts_at' in body) patch.starts_at = v.timestamp(body.starts_at, 'Date and time');
  if ('duration_min' in body) patch.duration_min = v.int(body.duration_min, 'How long', { min: 15, max: 1440 });
  if ('address' in body) patch.address = v.str(body.address, 'Address', { max: 240, optional: true });
  if ('lat' in body) patch.lat = v.lat(body.lat, 'Latitude');
  if ('lng' in body) patch.lng = v.lng(body.lng, 'Longitude');
  if ('notes' in body) patch.notes = v.text(body.notes, 'Notes', { max: 2000, optional: true });
  if ('addons_locked' in body) patch.addons_locked = v.bool(body.addons_locked, 'Add-ons locked') ? 1 : 0;

  if ('vehicle_id' in body) {
    if (body.vehicle_id == null || body.vehicle_id === '') patch.vehicle_id = null;
    else {
      const vehicleId = v.int(body.vehicle_id, 'Vehicle', { min: 1 });
      const vehicle = q.get('SELECT * FROM vehicles WHERE id = ?', vehicleId);
      if (!vehicle || vehicle.customer_id !== appt.customer_id) throw bad('That vehicle belongs to someone else.');
      patch.vehicle_id = vehicleId;
    }
  }

  /* Changing the service re-snapshots its name and price onto the appointment;
     an invoice that has already gone out is left alone. */
  if ('service_id' in body) {
    const serviceId = v.int(body.service_id, 'Service', { min: 1 });
    const service = q.get('SELECT * FROM services WHERE id = ?', serviceId);
    if (!service) throw notFound('Pick a service that exists.');
    patch.service_id = serviceId;
    patch.service_name = service.name;
    patch.service_price_cents = service.price_cents;
  }
  if ('service_price_cents' in body) patch.service_price_cents = v.cents(body.service_price_cents, 'Price');

  const keys = Object.keys(patch);
  if (!keys.length) throw bad('Nothing to change.');
  q.run(
    `UPDATE appointments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => patch[k]), Date.now(), apptId
  );

  /* Dropping the destination pin part-way through a trip should show up on the
     customer's map straight away rather than waiting for the next journey. */
  if ('lat' in patch || 'lng' in patch || 'address' in patch) {
    const trip = liveTripForAppointment(apptId);
    if (trip) {
      const fresh = loadAppointment(apptId);
      q.run(
        'UPDATE trips SET dest_lat = ?, dest_lng = ?, dest_label = ? WHERE id = ?',
        fresh.lat, fresh.lng, fresh.address, trip.id
      );
    }
  }

  audit(actor, 'appointment.update', 'appointment', apptId, keys.join(','));
  ok(req, res, { appointment: adminView(loadAppointment(apptId)) });
}));

router.post('/api/admin/appointments/:id/status', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  const body = await readJson(req);
  const next = v.oneOf(body.status, 'Status', STATUS_KEYS);
  const before = loadAppointment(apptId);
  const appt = setStatus(apptId, next, { actor });

  /* Moving off an active status stops any live tracking straight away —
     location sharing never outlives the reason for it. */
  if (before.status === 'on_my_way' && next !== 'on_my_way') {
    const trip = liveTripForAppointment(apptId);
    if (trip) endTrip(trip.id, next === 'arrived' ? 'arrived' : 'status_change');
  }

  let message = null;
  if (v.bool(body.notify, 'Notify', { fallback: false })) {
    const key = { arrived: 'arrived', completed: 'job_complete' }[next];
    if (key) message = await dispatchTemplate(apptId, key, { actor });
  }
  ok(req, res, { appointment: adminView(appt), message });
}));

router.delete('/api/admin/appointments/:id', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  const appt = loadAppointment(apptId);
  if (q.get('SELECT id FROM invoices WHERE appointment_id = ? AND status != ?', apptId, 'draft')) {
    throw conflict('That appointment has an issued invoice. Cancel it instead of deleting it.');
  }
  const trip = liveTripForAppointment(apptId);
  if (trip) endTrip(trip.id, 'appointment_deleted');
  revokePortalLinks(apptId);
  q.run('DELETE FROM appointments WHERE id = ?', apptId);
  audit(actor, 'appointment.delete', 'appointment', apptId, { customerId: appt.customer_id });
  ok(req, res, { deleted: true });
}));

/* ---- add-ons on an appointment ---- */

router.post('/api/admin/appointments/:id/addons', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  loadAppointment(apptId);
  const body = await readJson(req);
  const addonId = v.int(body.addon_id, 'Add-on', { min: 1 });
  attachAddon(apptId, addonId, 'admin');
  audit(actor, 'appointment.addon_add', 'appointment', apptId, { addonId });
  ok(req, res, { totals: appointmentTotals(apptId) });
}));

router.delete('/api/admin/appointments/:id/addons/:lineId', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  const lineId = id(params, 'lineId');
  const line = q.get('SELECT * FROM appointment_addons WHERE id = ? AND appointment_id = ?', lineId, apptId);
  if (!line) throw notFound('That add-on is not on this appointment.');
  q.run('DELETE FROM appointment_addons WHERE id = ?', lineId);
  audit(actor, 'appointment.addon_remove', 'appointment', apptId, { lineId });
  ok(req, res, { totals: appointmentTotals(apptId) });
}));

/* Price and wording are copied onto the appointment at the moment it is added.
   Editing the price list later never silently re-prices a booked job. */
export function attachAddon(appointmentId, addonId, source) {
  const addon = q.get('SELECT * FROM addons WHERE id = ?', addonId);
  if (!addon) throw notFound('That add-on does not exist.');
  if (!addon.active) throw bad('That add-on is not being offered right now.');
  if (source === 'customer' && !addon.customer_selectable) {
    throw forbidden('That add-on is not one customers can pick themselves.');
  }
  const existing = q.get(
    'SELECT id FROM appointment_addons WHERE appointment_id = ? AND addon_id = ?', appointmentId, addonId
  );
  if (existing) return existing.id;
  const result = q.run(
    `INSERT INTO appointment_addons(appointment_id, addon_id, name, description, price_cents, price_is_from, source, created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    appointmentId, addonId, addon.name, addon.description, addon.price_cents, addon.price_is_from, source, Date.now()
  );
  return result.id;
}

/* --------------------------------------------------------------------------
   "I'm on my way" — the only thing that ever turns location sharing on
   -------------------------------------------------------------------------- */

router.post('/api/admin/appointments/:id/on-my-way', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  const appt = loadAppointment(apptId);
  const body = await readJson(req);

  const minutes = v.int(body.minutes, 'Minutes', {
    min: 5, max: config.tracking.maxMinutes, optional: true, fallback: trackingMinutes(),
  });

  if (appt.status !== 'on_my_way') setStatus(apptId, 'on_my_way', { actor });
  const trip = startTrip(apptId, { minutes, actor });

  /* An opening position, if the owner's browser had one ready, so the customer
     sees a live map immediately rather than an empty one. */
  if (body.lat != null && body.lng != null) {
    recordPing(trip.id, {
      lat: v.lat(body.lat, 'Latitude', { optional: false }),
      lng: v.lng(body.lng, 'Longitude', { optional: false }),
      accuracyM: body.accuracy_m == null ? null : v.int(body.accuracy_m, 'Accuracy', { min: 0, max: 100000, optional: true }),
      speedMps: body.speed_mps == null ? null : Number(body.speed_mps),
    });
  }

  let message = null;
  if (v.bool(body.send_text, 'Send text', { fallback: true })) {
    message = await dispatchTemplate(apptId, 'on_my_way', {
      actor,
      trackingLink: trip.url,
      trackingMinutes: trip.minutes,
      overrideBody: body.body,
    });
  }

  ok(req, res, {
    trip: { id: trip.id, url: trip.url, expires_at: trip.expiresAt, minutes: trip.minutes },
    appointment: adminView(loadAppointment(apptId)),
    message,
  });
}));

/* The owner's own browser posts here while the trip runs. */
router.post('/api/admin/appointments/:id/ping', guard(async ({ req, res, params }) => {
  const apptId = id(params);
  const trip = liveTripForAppointment(apptId);
  if (!trip) throw conflict('Tracking is not running for that appointment.');
  const body = await readJson(req);
  const est = recordPing(trip.id, {
    lat: v.lat(body.lat, 'Latitude', { optional: false }),
    lng: v.lng(body.lng, 'Longitude', { optional: false }),
    accuracyM: body.accuracy_m == null ? null : Math.round(Number(body.accuracy_m)) || null,
    speedMps: body.speed_mps == null || !Number.isFinite(Number(body.speed_mps)) ? null : Number(body.speed_mps),
    heading: body.heading == null || !Number.isFinite(Number(body.heading)) ? null : Number(body.heading),
  });
  ok(req, res, {
    accepted: true,
    expires_at: trip.expires_at,
    seconds_left: Math.max(0, Math.round((trip.expires_at - Date.now()) / 1000)),
    distance_m: est.distanceM,
    eta_minutes: est.etaMinutes,
  });
}));

router.get('/api/admin/appointments/:id/trip', guard(async ({ req, res, params }) => {
  const apptId = id(params);
  const trip = liveTripForAppointment(apptId);
  if (!trip) { ok(req, res, { trip: null }); return; }
  ok(req, res, {
    trip: {
      id: trip.id,
      started_at: trip.created_at,
      expires_at: trip.expires_at,
      seconds_left: Math.max(0, Math.round((trip.expires_at - Date.now()) / 1000)),
      last_ping_at: trip.last_ping_at,
      has_position: trip.last_lat != null,
      distance_m: trip.distance_m,
      eta_at: trip.eta_at,
      view_count: trip.view_count,
      ping_seconds: config.tracking.pingSeconds,
    },
  });
}));

router.post('/api/admin/appointments/:id/stop-tracking', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  loadAppointment(apptId);
  const trip = liveTripForAppointment(apptId);
  if (trip) endTrip(trip.id, 'stopped_by_owner');
  audit(actor, 'trip.stop', 'appointment', apptId);
  ok(req, res, { stopped: Boolean(trip) });
}));

/* --------------------------------------------------------------------------
   Customer links and text messages
   -------------------------------------------------------------------------- */

router.post('/api/admin/appointments/:id/portal-link', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  loadAppointment(apptId);
  const link = freshPortalLink(apptId);
  audit(actor, 'portal_link.create', 'appointment', apptId);
  /* The raw token is returned exactly once, here. */
  ok(req, res, { url: link.url, expires_at: link.expiresAt });
}));

router.post('/api/admin/appointments/:id/revoke-links', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  loadAppointment(apptId);
  const revoked = revokePortalLinks(apptId);
  const trip = liveTripForAppointment(apptId);
  if (trip) endTrip(trip.id, 'links_revoked');
  audit(actor, 'portal_link.revoke_all', 'appointment', apptId, { revoked });
  ok(req, res, { revoked });
}));

router.post('/api/admin/appointments/:id/message', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  loadAppointment(apptId);
  const body = await readJson(req);
  const key = body.template_key ? v.str(body.template_key, 'Template', { max: 60 }) : '';
  const override = body.body ? v.text(body.body, 'Message', { max: SMS_MAX_LENGTH }) : null;
  if (!key && !override) throw bad('Pick a template or write a message.');
  const message = await dispatchTemplate(apptId, key || 'custom', { actor, overrideBody: override });
  ok(req, res, { message });
}));

router.post('/api/admin/appointments/:id/preview', guard(async ({ req, res, params }) => {
  const apptId = id(params);
  const body = await readJson(req);
  const templateBody = body.body != null
    ? v.text(body.body, 'Message', { max: SMS_MAX_LENGTH })
    : getTemplate(v.str(body.template_key, 'Template', { max: 60 })).body;
  const vars = previewVars(apptId);
  const rendered = renderTemplate(templateBody, vars);
  ok(req, res, {
    preview: rendered,
    length: rendered.length,
    segments: Math.max(1, Math.ceil(rendered.length / 153)),
    unknown: unknownPlaceholders(templateBody),
  });
}));

function previewVars(appointmentId) {
  const appt = loadAppointment(appointmentId);
  return buildVars({
    appointment: appt,
    customer: customerOf(appt),
    vehicle: vehicleOf(appt),
    totals: appointmentTotals(appointmentId),
    portalLink: `${config.publicBaseUrl}/p/...`,
    trackingLink: `${config.publicBaseUrl}/t/...`,
    trackingMinutes: trackingMinutes(),
  });
}

/* Mints a fresh link for an outgoing text. Old links keep working until they
   expire, so a customer holding an earlier message is not locked out, but no
   more than five are ever live at once. */
function freshPortalLink(appointmentId) {
  const link = createPortalLink(appointmentId);
  const extra = q.all(
    `SELECT id FROM portal_links WHERE appointment_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT -1 OFFSET 5`,
    appointmentId
  );
  for (const row of extra) q.run('UPDATE portal_links SET revoked_at = ? WHERE id = ?', Date.now(), row.id);
  return link;
}

export async function dispatchTemplate(appointmentId, key, { actor = 'owner', trackingLink = null, trackingMinutes: mins = null, overrideBody = null } = {}) {
  const appt = loadAppointment(appointmentId);
  const customer = customerOf(appt);
  if (!customer) throw notFound('That appointment has no customer.');

  const templateBody = overrideBody ?? getTemplate(key).body;
  const needsPortal = templateBody.includes('{{portal_link}}');
  const portal = needsPortal ? freshPortalLink(appointmentId) : null;

  const rendered = renderTemplate(templateBody, buildVars({
    appointment: appt,
    customer,
    vehicle: vehicleOf(appt),
    totals: appointmentTotals(appointmentId),
    portalLink: portal?.url ?? '',
    trackingLink: trackingLink ?? '',
    trackingMinutes: mins,
  }));

  const result = await sendSms({
    to: customer.phone,
    body: rendered,
    customerId: customer.id,
    appointmentId,
    templateKey: key,
  });
  audit(actor, 'message.send', 'appointment', appointmentId, { key, status: result.status });
  return { ...result, to: customer.phone };
}

router.get('/api/admin/messages', guard(async ({ req, res }) => {
  const url = new URL(req.url, 'http://local');
  const status = url.searchParams.get('status');
  const rows = status
    ? q.all('SELECT * FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT 200',
        v.oneOf(status, 'Status', ['queued', 'outbox', 'sent', 'failed']))
    : q.all('SELECT * FROM messages ORDER BY created_at DESC LIMIT 200');
  ok(req, res, {
    messages: rows.map((m) => ({
      ...m,
      customer_name: m.customer_id ? q.pluck('SELECT name FROM customers WHERE id = ?', m.customer_id) : '',
    })),
    provider: config.sms.provider,
  });
}));

router.post('/api/admin/messages/:id/sent', guard(async ({ req, res, params, actor }) => {
  const messageId = id(params);
  const row = q.get('SELECT * FROM messages WHERE id = ?', messageId);
  if (!row) throw notFound('That message does not exist.');
  q.run('UPDATE messages SET status = ?, sent_at = ? WHERE id = ?', 'sent', Date.now(), messageId);
  audit(actor, 'message.mark_sent', 'message', messageId);
  ok(req, res, { message: q.get('SELECT * FROM messages WHERE id = ?', messageId) });
}));

/* --------------------------------------------------------------------------
   Photos
   -------------------------------------------------------------------------- */

function publicPhoto(row) {
  return {
    id: row.id,
    kind: row.kind,
    caption: row.caption,
    shared: Boolean(row.shared),
    bytes: row.bytes,
    created_at: row.created_at,
    url: `/api/admin/photos/${row.id}/file`,
  };
}

router.post('/api/admin/appointments/:id/photos', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  loadAppointment(apptId);
  const url = new URL(req.url, 'http://local');
  const kind = v.oneOf(url.searchParams.get('kind'), 'Kind', PHOTO_KINDS, { optional: true, fallback: 'before' });
  const caption = v.str(url.searchParams.get('caption'), 'Caption', { max: 200, optional: true });
  const shared = url.searchParams.get('shared') !== '0';

  const buffer = await readBody(req, config.uploads.maxBytes + 1024);
  const photo = await savePhoto(apptId, buffer, { kind, caption, shared, actor });
  ok(req, res, { photo: publicPhoto(photo) });
}));

router.get('/api/admin/photos/:id/file', guard(async ({ req, res, params }) => {
  const photo = getPhoto(id(params));
  const buffer = await readFile(photoPath(photo));
  send(req, res, 200, buffer, {
    'Content-Type': photo.mime,
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, max-age=3600',
  });
}));

router.patch('/api/admin/photos/:id', guard(async ({ req, res, params, actor }) => {
  const photoId = id(params);
  const photo = getPhoto(photoId);
  const body = await readJson(req);
  const patch = {};
  if ('caption' in body) patch.caption = v.str(body.caption, 'Caption', { max: 200, optional: true });
  if ('kind' in body) patch.kind = v.oneOf(body.kind, 'Kind', PHOTO_KINDS);
  if ('shared' in body) patch.shared = v.bool(body.shared, 'Shared with customer') ? 1 : 0;
  const keys = Object.keys(patch);
  if (!keys.length) throw bad('Nothing to change.');
  q.run(`UPDATE photos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), photoId);
  audit(actor, 'photo.update', 'appointment', photo.appointment_id, keys.join(','));
  ok(req, res, { photo: publicPhoto(getPhoto(photoId)) });
}));

router.delete('/api/admin/photos/:id', guard(async ({ req, res, params, actor }) => {
  await deletePhoto(id(params), { actor });
  ok(req, res, { deleted: true });
}));

/* --------------------------------------------------------------------------
   Invoices, payments and tips
   -------------------------------------------------------------------------- */

router.post('/api/admin/appointments/:id/invoice', guard(async ({ req, res, params, actor }) => {
  const apptId = id(params);
  loadAppointment(apptId);
  ok(req, res, { invoice: buildInvoice(apptId, { actor }) });
}));

router.get('/api/admin/invoices', guard(async ({ req, res }) => {
  const url = new URL(req.url, 'http://local');
  const status = url.searchParams.get('status');
  const rows = status
    ? q.all('SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC LIMIT 200', v.oneOf(status, 'Status', INVOICE_STATUSES))
    : q.all('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 200');
  ok(req, res, {
    invoices: rows.map((inv) => {
      const appt = q.get('SELECT customer_id, service_name, starts_at FROM appointments WHERE id = ?', inv.appointment_id);
      return {
        ...inv,
        balance_cents: inv.total_cents - inv.paid_cents,
        service_name: appt?.service_name ?? '',
        starts_at: appt?.starts_at ?? null,
        customer_name: appt ? q.pluck('SELECT name FROM customers WHERE id = ?', appt.customer_id) : '',
      };
    }),
  });
}));

router.get('/api/admin/invoices/:id', guard(async ({ req, res, params }) => {
  const invoice = getInvoiceById(id(params));
  const appt = q.get('SELECT customer_id, service_name, starts_at FROM appointments WHERE id = ?', invoice.appointment_id);
  ok(req, res, {
    invoice,
    customer: appt ? q.get('SELECT id, name, phone, email FROM customers WHERE id = ?', appt.customer_id) : null,
    service_name: appt?.service_name ?? '',
    starts_at: appt?.starts_at ?? null,
    payment_methods: PAYMENT_METHODS,
  });
}));

router.patch('/api/admin/invoices/:id', guard(async ({ req, res, params, actor }) => {
  const invoiceId = id(params);
  const invoice = q.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!invoice) throw notFound('That invoice does not exist.');
  const body = await readJson(req);
  const patch = {};
  if ('discount_cents' in body) patch.discount_cents = v.cents(body.discount_cents, 'Discount');
  if ('notes' in body) patch.notes = v.text(body.notes, 'Notes', { max: 1000, optional: true });
  const keys = Object.keys(patch);
  if (!keys.length) throw bad('Nothing to change.');
  q.run(
    `UPDATE invoices SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => patch[k]), Date.now(), invoiceId
  );
  audit(actor, 'invoice.update', 'invoice', invoiceId, keys.join(','));
  ok(req, res, { invoice: recalcInvoice(invoiceId) });
}));

router.post('/api/admin/invoices/:id/items', guard(async ({ req, res, params, actor }) => {
  const invoiceId = id(params);
  const invoice = q.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!invoice) throw notFound('That invoice does not exist.');
  if (invoice.status !== 'draft') throw conflict('Only a draft invoice can have lines added.');
  const body = await readJson(req);
  const label = v.str(body.label, 'Description', { min: 1, max: 120 });
  const qty = v.int(body.qty, 'Quantity', { min: 1, max: 999, optional: true, fallback: 1 });
  const unit = v.cents(body.unit_cents, 'Price', { min: -1000000 });
  const sort = (q.pluck('SELECT COALESCE(MAX(sort_order), -1) AS n FROM invoice_items WHERE invoice_id = ?', invoiceId) ?? -1) + 1;
  q.run(
    `INSERT INTO invoice_items(invoice_id, label, detail, qty, unit_cents, amount_cents, kind, sort_order)
     VALUES(?,?,?,?,?,?,'custom',?)`,
    invoiceId, label, v.str(body.detail, 'Detail', { max: 200, optional: true }), qty, unit, unit * qty, sort
  );
  audit(actor, 'invoice.item_add', 'invoice', invoiceId, { label });
  ok(req, res, { invoice: recalcInvoice(invoiceId) });
}));

router.delete('/api/admin/invoice-items/:id', guard(async ({ req, res, params, actor }) => {
  const itemId = id(params);
  const item = q.get('SELECT * FROM invoice_items WHERE id = ?', itemId);
  if (!item) throw notFound('That line does not exist.');
  const invoice = q.get('SELECT * FROM invoices WHERE id = ?', item.invoice_id);
  if (invoice.status !== 'draft') throw conflict('Only a draft invoice can have lines removed.');
  q.run('DELETE FROM invoice_items WHERE id = ?', itemId);
  audit(actor, 'invoice.item_remove', 'invoice', item.invoice_id, { itemId });
  ok(req, res, { invoice: recalcInvoice(item.invoice_id) });
}));

router.post('/api/admin/invoices/:id/issue', guard(async ({ req, res, params, actor }) => {
  const invoiceId = id(params);
  const invoice = issueInvoice(invoiceId, { actor });
  const body = await readJson(req).catch(() => ({}));
  let message = null;
  if (v.bool(body.send_text, 'Send text', { fallback: false })) {
    message = await dispatchTemplate(invoice.appointment_id, 'invoice_sent', { actor });
  }
  ok(req, res, { invoice, message });
}));

router.post('/api/admin/invoices/:id/void', guard(async ({ req, res, params, actor }) => {
  ok(req, res, { invoice: voidInvoice(id(params), { actor }) });
}));

router.post('/api/admin/invoices/:id/payments', guard(async ({ req, res, params, actor }) => {
  const invoiceId = id(params);
  const body = await readJson(req);
  const result = recordPayment(invoiceId, {
    amountCents: v.cents(body.amount_cents, 'Amount', { optional: true, fallback: 0 }),
    tipCents: v.cents(body.tip_cents, 'Tip', { optional: true, fallback: 0 }),
    method: v.oneOf(body.method, 'Method', PAYMENT_METHODS, { optional: true, fallback: 'cash' }),
    reference: v.str(body.reference, 'Reference', { max: 80, optional: true }),
    note: v.text(body.note, 'Note', { max: 400, optional: true }),
    receivedAt: v.timestamp(body.received_at, 'Received', { optional: true }),
    source: 'admin',
    actor,
  });
  ok(req, res, result);
}));

router.delete('/api/admin/payments/:id', guard(async ({ req, res, params, actor }) => {
  ok(req, res, { invoice: deletePayment(id(params), { actor }) });
}));

/* --------------------------------------------------------------------------
   Message templates
   -------------------------------------------------------------------------- */

router.get('/api/admin/templates', guard(async ({ req, res }) => {
  ok(req, res, {
    templates: q.all('SELECT * FROM sms_templates ORDER BY built_in DESC, name'),
    placeholders: PLACEHOLDERS,
    max_length: SMS_MAX_LENGTH,
  });
}));

router.patch('/api/admin/templates/:key', guard(async ({ req, res, params, actor }) => {
  const key = v.str(params.key, 'Template', { max: 60 });
  const template = getTemplate(key);
  const body = await readJson(req);
  const patch = {};
  if ('body' in body) {
    patch.body = v.text(body.body, 'Message', { min: 1, max: SMS_MAX_LENGTH });
    const unknown = unknownPlaceholders(patch.body);
    if (unknown.length) throw bad(`This app does not know these placeholders: ${unknown.join(', ')}.`);
  }
  if ('name' in body && !template.built_in) patch.name = v.str(body.name, 'Name', { min: 1, max: 80 });
  if ('description' in body) patch.description = v.text(body.description, 'Description', { max: 300, optional: true });
  const keys = Object.keys(patch);
  if (!keys.length) throw bad('Nothing to change.');
  q.run(
    `UPDATE sms_templates SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE key = ?`,
    ...keys.map((k) => patch[k]), Date.now(), key
  );
  audit(actor, 'template.update', 'template', key);
  ok(req, res, { template: getTemplate(key) });
}));

router.post('/api/admin/templates', guard(async ({ req, res, actor }) => {
  const body = await readJson(req);
  const name = v.str(body.name, 'Name', { min: 1, max: 80 });
  const key = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'message'}`;
  if (q.get('SELECT id FROM sms_templates WHERE key = ?', key)) throw conflict('A template with that name already exists.');
  const text = v.text(body.body, 'Message', { min: 1, max: SMS_MAX_LENGTH });
  const unknown = unknownPlaceholders(text);
  if (unknown.length) throw bad(`This app does not know these placeholders: ${unknown.join(', ')}.`);
  q.run(
    'INSERT INTO sms_templates(key, name, description, body, built_in, updated_at) VALUES(?,?,?,?,0,?)',
    key, name, v.text(body.description, 'Description', { max: 300, optional: true }), text, Date.now()
  );
  audit(actor, 'template.create', 'template', key);
  ok(req, res, { template: getTemplate(key) });
}));

router.delete('/api/admin/templates/:key', guard(async ({ req, res, params, actor }) => {
  const key = v.str(params.key, 'Template', { max: 60 });
  const template = getTemplate(key);
  if (template.built_in) throw forbidden('Built-in templates can be reworded but not deleted.');
  q.run('DELETE FROM sms_templates WHERE key = ?', key);
  audit(actor, 'template.delete', 'template', key);
  ok(req, res, { deleted: true });
}));

router.post('/api/admin/templates/:key/reset', guard(async ({ req, res, params, actor }) => {
  const key = v.str(params.key, 'Template', { max: 60 });
  const { DEFAULT_TEMPLATES } = await import('../db.js');
  const original = DEFAULT_TEMPLATES.find((t) => t.key === key);
  if (!original) throw notFound('That template has no built-in wording to go back to.');
  q.run('UPDATE sms_templates SET body = ?, updated_at = ? WHERE key = ?', original.body, Date.now(), key);
  audit(actor, 'template.reset', 'template', key);
  ok(req, res, { template: getTemplate(key) });
}));

/* --------------------------------------------------------------------------
   Reviews, settings, activity
   -------------------------------------------------------------------------- */

router.get('/api/admin/reviews', guard(async ({ req, res }) => {
  const rows = q.all('SELECT * FROM reviews ORDER BY created_at DESC LIMIT 200');
  ok(req, res, {
    reviews: rows.map((r) => {
      const appt = q.get('SELECT customer_id, service_name, starts_at FROM appointments WHERE id = ?', r.appointment_id);
      return {
        ...r,
        published: Boolean(r.published),
        service_name: appt?.service_name ?? '',
        starts_at: appt?.starts_at ?? null,
        customer_name: appt ? q.pluck('SELECT name FROM customers WHERE id = ?', appt.customer_id) : '',
      };
    }),
    average: q.pluck('SELECT ROUND(AVG(rating), 2) AS n FROM reviews'),
  });
}));

router.patch('/api/admin/reviews/:id', guard(async ({ req, res, params, actor }) => {
  const reviewId = id(params);
  if (!q.get('SELECT id FROM reviews WHERE id = ?', reviewId)) throw notFound('That review does not exist.');
  const body = await readJson(req);
  const published = v.bool(body.published, 'Published', { optional: false });
  q.run('UPDATE reviews SET published = ? WHERE id = ?', published ? 1 : 0, reviewId);
  audit(actor, 'review.publish', 'review', reviewId, { published });
  ok(req, res, { review: q.get('SELECT * FROM reviews WHERE id = ?', reviewId) });
}));

const EDITABLE_SETTINGS = {
  business_name: (x) => v.str(x, 'Business name', { min: 1, max: 120 }),
  business_phone: (x) => v.phone(x, 'Business phone'),
  business_email: (x) => v.email(x, 'Business email'),
  business_city: (x) => v.str(x, 'City', { max: 120, optional: true }),
  timezone: (x) => {
    const tz = v.str(x, 'Timezone', { min: 1, max: 60 });
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); }
    catch { throw bad('That is not a timezone this system knows.'); }
    return tz;
  },
  tax_rate_bp: (x) => String(v.int(x, 'Tax rate', { min: 0, max: 3000 })),
  tracking_minutes: (x) => String(v.int(x, 'Tracking window', { min: 5, max: config.tracking.maxMinutes })),
  tip_presets: (x) => {
    const parts = v.str(x, 'Tip presets', { max: 40 }).split(',').map((n) => Number.parseInt(n.trim(), 10));
    if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) {
      throw bad('Tip presets must be whole percentages, comma separated.');
    }
    return parts.slice(0, 4).join(',');
  },
  payment_instructions: (x) => v.text(x, 'Payment instructions', { max: 500, optional: true }),
  review_prompt: (x) => v.text(x, 'Review prompt', { max: 300, optional: true }),
  invoice_prefix: (x) => v.str(x, 'Invoice prefix', { min: 1, max: 8 }).replace(/[^A-Za-z0-9-]/g, ''),
  allow_customer_addons: (x) => (v.bool(x, 'Customers may add extras') ? '1' : '0'),
};

router.get('/api/admin/settings', guard(async ({ req, res, owner }) => {
  ok(req, res, {
    settings: allSettings(),
    defaults: SETTING_DEFAULTS,
    owner: { id: owner.id, email: owner.email, name: owner.name },
    sms_provider: config.sms.provider,
    public_base_url: config.publicBaseUrl,
    tracking_max_minutes: config.tracking.maxMinutes,
  });
}));

router.patch('/api/admin/settings', guard(async ({ req, res, actor }) => {
  const body = await readJson(req);
  const changed = [];
  for (const [key, validate] of Object.entries(EDITABLE_SETTINGS)) {
    if (!(key in body)) continue;
    setSetting(key, validate(body[key]));
    changed.push(key);
  }
  if (!changed.length) throw bad('Nothing to change.');
  audit(actor, 'settings.update', 'settings', '', changed.join(','));
  ok(req, res, { settings: allSettings(), changed });
}));

router.get('/api/admin/activity', guard(async ({ req, res }) => {
  ok(req, res, { activity: q.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200') });
}));

export default router;
