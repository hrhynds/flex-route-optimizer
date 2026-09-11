import { readFile } from 'node:fs/promises';
import config from '../config.js';
import { q, allSettings, getSetting, portalEvent, audit } from '../db.js';
import { Router, readJson, sendJson, send, notFound, forbidden, conflict, tooMany } from '../http.js';
import * as v from '../validate.js';
import { clientIp, rateLimit, sameOrigin } from '../security.js';
import { resolvePortalToken, touchPortalLink, liveTripForAppointment, publicTripState, countTripView } from '../links.js';
import { STATUSES, customerOf, vehicleOf, photosOf } from '../appointments.js';
import { appointmentTotals, getInvoice, setTip, tipPresets } from '../billing.js';
import { getPhoto, photoPath } from '../photos.js';
import { vehicleLabel, formatWhen } from '../sms.js';

export const router = new Router();

/* --------------------------------------------------------------------------
   Every portal route resolves the token first. The token is the whole of the
   customer's authority: it names exactly one appointment, and nothing reached
   through it can widen to another.
   -------------------------------------------------------------------------- */

function portalGuard(handler, { write = false } = {}) {
  return async (req, res, params) => {
    const ip = clientIp(req);

    /* A link is a bearer token, so guessing is the attack. Rate limit by source
       address before the token is even hashed. */
    const limit = rateLimit(`portal:${ip}`, { limit: write ? 60 : 240, windowMs: 5 * 60 * 1000 });
    if (!limit.ok) throw tooMany('Too many requests. Give it a minute.', limit.retryAfterSec);

    if (write && !sameOrigin(req)) throw forbidden('Request blocked: unexpected origin.');

    const { link, appointment } = resolvePortalToken(params.token);
    return handler({ req, res, params, link, appointment, ip });
  };
}

const ok = (req, res, data) => sendJson(req, res, 200, data);

/* --------------------------------------------------------------------------
   The customer's view of their own appointment

   Built field by field. Nothing from the admin side is copied wholesale, so a
   column added to `appointments` later stays private until someone puts it here
   on purpose. Owner notes, other customers, and anything about location when a
   trip is not running are simply not present.
   -------------------------------------------------------------------------- */

router.get('/api/portal/:token', portalGuard(async ({ req, res, link, appointment, params }) => {
  touchPortalLink(link.id);
  ok(req, res, buildPortalPayload(appointment, link, params.token));
}));

function buildPortalPayload(appointment, link, token) {
  const now = Date.now();
  const settings = allSettings();
  const customer = customerOf(appointment);
  const vehicle = vehicleOf(appointment);
  const totals = appointmentTotals(appointment.id);
  const invoice = getInvoice(appointment.id);
  const trip = liveTripForAppointment(appointment.id, now);
  const when = formatWhen(appointment.starts_at, settings.timezone);
  const review = q.get('SELECT * FROM reviews WHERE appointment_id = ?', appointment.id);

  const addonsOpen =
    !appointment.addons_locked &&
    getSetting('allow_customer_addons') === '1' &&
    ['scheduled', 'confirmed', 'on_my_way', 'arrived', 'in_progress'].includes(appointment.status);

  return {
    business: {
      name: settings.business_name,
      phone: settings.business_phone,
      email: settings.business_email,
      payment_instructions: settings.payment_instructions,
      review_prompt: settings.review_prompt,
    },
    appointment: {
      status: appointment.status,
      status_label: STATUSES[appointment.status]?.customer ?? appointment.status,
      status_tone: STATUSES[appointment.status]?.tone ?? 'neutral',
      starts_at: appointment.starts_at,
      date_label: when.date,
      time_label: when.time,
      duration_min: appointment.duration_min,
      address: appointment.address,
      service_name: appointment.service_name,
      service_price_cents: appointment.service_price_cents,
      vehicle_label: vehicleLabel(vehicle),
      customer_first: String(customer?.name || '').trim().split(/\s+/)[0] || '',
    },
    totals: {
      service_price_cents: totals.service_price_cents,
      addons: totals.addons.map((a) => ({
        line_id: a.id,
        addon_id: a.addon_id,
        name: a.name,
        description: a.description,
        price_cents: a.price_cents,
        price_is_from: Boolean(a.price_is_from),
        added_by_you: a.source === 'customer',
      })),
      subtotal_cents: totals.subtotal_cents,
      discount_cents: totals.discount_cents,
      tax_cents: totals.tax_cents,
      tip_cents: totals.tip_cents,
      total_cents: totals.total_cents,
      is_estimate: totals.is_estimate,
    },
    /* Only add-ons the owner has marked as customer-choosable, and only while
       the job is still open to changes. */
    available_addons: addonsOpen
      ? q.all(
          `SELECT id, name, description, price_cents, price_is_from FROM addons
            WHERE active = 1 AND customer_selectable = 1
              AND id NOT IN (SELECT addon_id FROM appointment_addons WHERE appointment_id = ? AND addon_id IS NOT NULL)
            ORDER BY sort_order, id`,
          appointment.id
        ).map((a) => ({ ...a, price_is_from: Boolean(a.price_is_from) }))
      : [],
    addons_open: addonsOpen,
    photos: photosOf(appointment.id, { sharedOnly: true }).map((p) => ({
      id: p.id,
      kind: p.kind,
      caption: p.caption,
      url: `/api/portal/${encodeURIComponent(token)}/photo/${p.id}`,
    })),
    invoice: invoice && invoice.status !== 'draft' ? {
      number: invoice.number,
      status: invoice.status,
      issued_at: invoice.issued_at,
      items: invoice.items.map((i) => ({ label: i.label, detail: i.detail, qty: i.qty, amount_cents: i.amount_cents })),
      subtotal_cents: invoice.subtotal_cents,
      discount_cents: invoice.discount_cents,
      tax_cents: invoice.tax_cents,
      tip_cents: invoice.tip_cents,
      total_cents: invoice.total_cents,
      paid_cents: invoice.paid_cents,
      balance_cents: invoice.balance_cents,
      notes: invoice.notes,
      can_tip: invoice.status === 'sent',
      tip_presets: tipPresets(),
    } : null,
    /* Present only while the owner has a trip running, and then it is exactly
       what the tracking endpoint returns — one shape, one decision about what
       a customer may see, so the first paint already has the ETA. When nothing
       is live this is a bare { live: false } with no position field at all. */
    tracking: trip ? publicTripState(trip, { now }) : { live: false },
    review: review ? { rating: review.rating, comment: review.comment, created_at: review.created_at } : null,
    link: { expires_at: link.expires_at },
  };
}

/* --------------------------------------------------------------------------
   Add-ons — friendly descriptions, prices that update immediately
   -------------------------------------------------------------------------- */

router.post('/api/portal/:token/addons', portalGuard(async ({ req, res, link, appointment, params }) => {
  const body = await readJson(req);
  const addonId = v.int(body.addon_id, 'Add-on', { min: 1 });

  if (appointment.addons_locked) throw conflict('This job is closed to changes now — give us a call and we will sort it.');
  if (getSetting('allow_customer_addons') !== '1') throw forbidden('Extras are added by us at the moment. Just ask.');
  if (!['scheduled', 'confirmed', 'on_my_way', 'arrived', 'in_progress'].includes(appointment.status)) {
    throw conflict('This appointment is no longer open to changes.');
  }

  const addon = q.get('SELECT * FROM addons WHERE id = ?', addonId);
  if (!addon || !addon.active) throw notFound('That extra is not on offer right now.');
  if (!addon.customer_selectable) throw forbidden('That one is added by us — just ask and we will take a look.');

  const existing = q.get(
    'SELECT id FROM appointment_addons WHERE appointment_id = ? AND addon_id = ?', appointment.id, addonId
  );
  if (!existing) {
    q.run(
      `INSERT INTO appointment_addons(appointment_id, addon_id, name, description, price_cents, price_is_from, source, created_at)
       VALUES(?,?,?,?,?,?,'customer',?)`,
      appointment.id, addonId, addon.name, addon.description, addon.price_cents, addon.price_is_from, Date.now()
    );
    portalEvent(appointment.id, 'addon_added', addon.name);
  }
  ok(req, res, buildPortalPayload(q.get('SELECT * FROM appointments WHERE id = ?', appointment.id), link, params.token));
}, { write: true }));

router.delete('/api/portal/:token/addons/:lineId', portalGuard(async ({ req, res, link, appointment, params }) => {
  const lineId = v.int(params.lineId, 'Add-on', { min: 1 });
  const line = q.get('SELECT * FROM appointment_addons WHERE id = ? AND appointment_id = ?', lineId, appointment.id);
  if (!line) throw notFound('That extra is not on this appointment.');
  /* A customer may take back only what they added themselves. */
  if (line.source !== 'customer') throw forbidden('That one was added by us. Give us a call if it should come off.');
  if (appointment.addons_locked) throw conflict('This job is closed to changes now.');

  q.run('DELETE FROM appointment_addons WHERE id = ?', lineId);
  portalEvent(appointment.id, 'addon_removed', line.name);
  ok(req, res, buildPortalPayload(q.get('SELECT * FROM appointments WHERE id = ?', appointment.id), link, params.token));
}, { write: true }));

/* --------------------------------------------------------------------------
   Tracking handoff

   The customer's page asks here whether a trip is live. It never receives a
   position from this route — only whether there is something to follow, and
   the link to follow it with, which the server holds and hands over only while
   the owner has one running.
   -------------------------------------------------------------------------- */

router.get('/api/portal/:token/tracking', portalGuard(async ({ req, res, appointment }) => {
  const trip = liveTripForAppointment(appointment.id);
  if (!trip) { ok(req, res, { live: false }); return; }
  countTripView(trip.id);
  ok(req, res, publicTripState(trip));
}));

/* --------------------------------------------------------------------------
   Photos — shared ones only, and only for this appointment
   -------------------------------------------------------------------------- */

router.get('/api/portal/:token/photo/:photoId', portalGuard(async ({ req, res, appointment, params }) => {
  const photo = getPhoto(v.int(params.photoId, 'Photo', { min: 1 }));
  if (photo.appointment_id !== appointment.id) throw notFound('That photo is not on this appointment.');
  if (!photo.shared) throw notFound('That photo is not shared.');
  const buffer = await readFile(photoPath(photo));
  send(req, res, 200, buffer, {
    'Content-Type': photo.mime,
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, max-age=600',
  });
}));

/* --------------------------------------------------------------------------
   Tip, payment intent and review
   -------------------------------------------------------------------------- */

router.post('/api/portal/:token/tip', portalGuard(async ({ req, res, link, appointment, params }) => {
  const body = await readJson(req);
  const invoice = getInvoice(appointment.id);
  if (!invoice || invoice.status === 'draft') throw conflict('There is no invoice to tip on yet.');
  const tip = v.cents(body.tip_cents, 'Tip', { min: 0, max: 1000000 });
  setTip(invoice.id, tip, { actor: 'customer' });
  portalEvent(appointment.id, 'tip_set', String(tip));
  ok(req, res, buildPortalPayload(appointment, link, params.token));
}, { write: true }));

/* The customer saying how they intend to pay is a heads-up for the owner, not
   a payment. Nothing is marked as received until the owner records it. */
router.post('/api/portal/:token/paying', portalGuard(async ({ req, res, appointment }) => {
  const body = await readJson(req);
  const method = v.oneOf(body.method, 'Method',
    ['cash', 'card', 'zelle', 'venmo', 'cashapp', 'apple_pay', 'bank_transfer', 'check', 'other']);
  const invoice = getInvoice(appointment.id);
  if (!invoice || invoice.status === 'draft') throw conflict('There is no invoice to pay yet.');
  portalEvent(appointment.id, 'payment_declared', method);
  audit('customer', 'payment.declared', 'invoice', invoice.id, { method });
  ok(req, res, { noted: true, method });
}, { write: true }));

router.post('/api/portal/:token/review', portalGuard(async ({ req, res, link, appointment, params }) => {
  const body = await readJson(req);
  if (appointment.status !== 'completed') throw conflict('Reviews open up once the job is finished.');
  const rating = v.int(body.rating, 'Rating', { min: 1, max: 5 });
  const comment = v.text(body.comment, 'Comment', { max: 1500, optional: true });
  const customer = customerOf(appointment);
  const now = Date.now();

  const existing = q.get('SELECT id FROM reviews WHERE appointment_id = ?', appointment.id);
  if (existing) {
    q.run('UPDATE reviews SET rating = ?, comment = ?, published = 0 WHERE id = ?', rating, comment, existing.id);
  } else {
    q.run(
      'INSERT INTO reviews(appointment_id, rating, comment, author_name, published, created_at) VALUES(?,?,?,?,0,?)',
      appointment.id, rating, comment, String(customer?.name || '').trim().split(/\s+/)[0] || '', now
    );
  }
  portalEvent(appointment.id, 'review_left', String(rating));
  ok(req, res, buildPortalPayload(appointment, link, params.token));
}, { write: true }));

export default router;
