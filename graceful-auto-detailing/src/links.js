import config from './config.js';
import { q, getSetting, audit } from './db.js';
import { newToken, hashToken, isTokenShape } from './security.js';
import { notFound, bad } from './http.js';
import { estimate } from './geo.js';

export function publicUrl(pathname) {
  return `${config.publicBaseUrl}${pathname}`;
}

/* ---------------------------------------------------------------------------
   Customer portal links

   The raw token is returned exactly once — at the moment it is created, so it
   can be put into a text message. Only its SHA-256 is stored, so a copy of the
   database does not hand anyone a working link.
   --------------------------------------------------------------------------- */

export function createPortalLink(appointmentId, { now = Date.now(), days = null } = {}) {
  const appt = q.get('SELECT id, starts_at, duration_min FROM appointments WHERE id = ?', appointmentId);
  if (!appt) throw notFound('That appointment no longer exists.');

  const window = (days ?? config.portal.daysAfterAppointment) * 24 * 60 * 60 * 1000;
  const endOfJob = appt.starts_at + appt.duration_min * 60 * 1000;
  const expiresAt = Math.max(now, endOfJob) + window;

  const token = newToken();
  q.run(
    'INSERT INTO portal_links(appointment_id, token_hash, created_at, expires_at) VALUES(?,?,?,?)',
    appointmentId, hashToken(token), now, expiresAt
  );
  return { token, url: publicUrl(`/p/${token}`), expiresAt };
}

/* Reuses the newest live link so a customer who kept an older text does not
   end up with a dead one, and only mints a fresh token when there is none. */
export function ensurePortalLink(appointmentId, { now = Date.now() } = {}) {
  const live = q.get(
    `SELECT id, expires_at FROM portal_links
      WHERE appointment_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`,
    appointmentId, now
  );
  if (live) return { token: null, url: null, expiresAt: live.expires_at, existing: true };
  return { ...createPortalLink(appointmentId, { now }), existing: false };
}

export function resolvePortalToken(token, { now = Date.now() } = {}) {
  if (!isTokenShape(token)) throw notFound('This link is not valid.');
  const link = q.get('SELECT * FROM portal_links WHERE token_hash = ?', hashToken(token));
  if (!link) throw notFound('This link is not valid.');
  if (link.revoked_at) throw notFound('This link has been turned off.');
  if (link.expires_at <= now) throw notFound('This link has expired. Ask for a fresh one.');

  const appt = q.get('SELECT * FROM appointments WHERE id = ?', link.appointment_id);
  if (!appt) throw notFound('This appointment no longer exists.');
  return { link, appointment: appt };
}

export function touchPortalLink(linkId, now = Date.now()) {
  q.run('UPDATE portal_links SET last_seen_at = ?, view_count = view_count + 1 WHERE id = ?', now, linkId);
}

export function revokePortalLinks(appointmentId, now = Date.now()) {
  return q.run(
    'UPDATE portal_links SET revoked_at = ? WHERE appointment_id = ? AND revoked_at IS NULL',
    now, appointmentId
  ).changes;
}

/* ---------------------------------------------------------------------------
   Trips — the only place location ever lives

   A trip row exists solely between pressing "I'm on my way" and arriving or
   expiring. Ending a trip deletes the breadcrumb trail and blanks the last
   known position on the row, so nothing about where the owner was survives.
   --------------------------------------------------------------------------- */

export function trackingMinutes() {
  const raw = Number.parseInt(getSetting('tracking_minutes'), 10);
  const n = Number.isFinite(raw) ? raw : config.tracking.defaultMinutes;
  return Math.min(Math.max(n, 5), config.tracking.maxMinutes);
}

export function liveTripForAppointment(appointmentId, now = Date.now()) {
  return q.get(
    'SELECT * FROM trips WHERE appointment_id = ? AND ended_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
    appointmentId, now
  );
}

export function startTrip(appointmentId, { minutes = null, now = Date.now(), actor = 'owner' } = {}) {
  const appt = q.get('SELECT * FROM appointments WHERE id = ?', appointmentId);
  if (!appt) throw notFound('That appointment no longer exists.');
  if (appt.status === 'cancelled' || appt.status === 'completed') {
    throw bad('That appointment is already closed out.');
  }

  /* Only one trip may be live per appointment; starting a new one retires the old. */
  const existing = liveTripForAppointment(appointmentId, now);
  if (existing) endTrip(existing.id, 'restarted', now);

  const mins = Math.min(Math.max(minutes ?? trackingMinutes(), 5), config.tracking.maxMinutes);
  const token = newToken();
  const res = q.run(
    `INSERT INTO trips(appointment_id, token_hash, created_at, expires_at, dest_lat, dest_lng, dest_label)
     VALUES(?,?,?,?,?,?,?)`,
    appointmentId, hashToken(token), now, now + mins * 60 * 1000,
    appt.lat, appt.lng, appt.address
  );
  audit(actor, 'trip.start', 'appointment', appointmentId, { minutes: mins });
  return { id: res.id, token, url: publicUrl(`/t/${token}`), expiresAt: now + mins * 60 * 1000, minutes: mins };
}

export function resolveTripToken(token, { now = Date.now() } = {}) {
  if (!isTokenShape(token)) throw notFound('This tracking link is not valid.');
  const trip = q.get('SELECT * FROM trips WHERE token_hash = ?', hashToken(token));
  /* Expired, ended and never-existed all answer the same way, so a stale link
     cannot be used to work out whether a job is running. */
  if (!trip) throw notFound('This tracking link has expired.');
  if (trip.ended_at) throw notFound('This tracking link has expired.');
  if (trip.expires_at <= now) {
    endTrip(trip.id, 'expired', now);
    throw notFound('This tracking link has expired.');
  }
  return trip;
}

export function recordPing(tripId, { lat, lng, accuracyM = null, speedMps = null, heading = null, now = Date.now() }) {
  const trip = q.get('SELECT * FROM trips WHERE id = ?', tripId);
  if (!trip) throw notFound('That trip is not running.');
  if (trip.ended_at || trip.expires_at <= now) throw bad('That trip has already finished.');

  const dest = trip.dest_lat != null && trip.dest_lng != null ? { lat: trip.dest_lat, lng: trip.dest_lng } : null;
  const est = dest ? estimate({ from: { lat, lng }, to: dest, speedMps, now }) : { distanceM: null, etaAt: null };

  q.run(
    `UPDATE trips SET last_lat = ?, last_lng = ?, last_accuracy_m = ?, last_heading = ?, last_speed_mps = ?,
            last_ping_at = ?, eta_at = ?, distance_m = ? WHERE id = ?`,
    lat, lng, accuracyM, heading, speedMps, now, est.etaAt, est.distanceM, tripId
  );
  q.run(
    'INSERT INTO trip_pings(trip_id, lat, lng, accuracy_m, recorded_at) VALUES(?,?,?,?,?)',
    tripId, lat, lng, accuracyM, now
  );
  /* The trail is only there to draw a short tail on the map. Keep the last 60. */
  q.run(
    `DELETE FROM trip_pings WHERE trip_id = ? AND id NOT IN (
       SELECT id FROM trip_pings WHERE trip_id = ? ORDER BY recorded_at DESC LIMIT 60)`,
    tripId, tripId
  );
  return est;
}

export function tripTrail(tripId, limit = 40) {
  return q.all(
    'SELECT lat, lng, recorded_at FROM trip_pings WHERE trip_id = ? ORDER BY recorded_at DESC LIMIT ?',
    tripId, limit
  ).reverse();
}

/* Ending a trip is also the privacy sweep: the trail is deleted and the last
   known position is wiped from the row. Nothing is kept for later. */
export function endTrip(tripId, reason = 'arrived', now = Date.now()) {
  const trip = q.get('SELECT id, appointment_id, ended_at FROM trips WHERE id = ?', tripId);
  if (!trip) return false;
  q.run('DELETE FROM trip_pings WHERE trip_id = ?', tripId);
  q.run(
    `UPDATE trips SET ended_at = COALESCE(ended_at, ?), ended_reason = COALESCE(ended_reason, ?),
            last_lat = NULL, last_lng = NULL, last_accuracy_m = NULL, last_heading = NULL,
            last_speed_mps = NULL, distance_m = NULL, eta_at = NULL
      WHERE id = ?`,
    now, reason, tripId
  );
  if (!trip.ended_at) audit('system', 'trip.end', 'appointment', trip.appointment_id, { reason });
  return true;
}

/* Runs on a timer. Any trip past its expiry is ended and purged even if nobody
   pressed anything — the one-hour limit does not depend on a button. */
export function sweepTrips(now = Date.now()) {
  const stale = q.all('SELECT id FROM trips WHERE ended_at IS NULL AND expires_at <= ?', now);
  for (const t of stale) endTrip(t.id, 'expired', now);
  /* Belt and braces: no ping may outlive its trip. */
  q.run('DELETE FROM trip_pings WHERE trip_id IN (SELECT id FROM trips WHERE ended_at IS NOT NULL)');
  return stale.length;
}

export function sweepPortalLinks(now = Date.now()) {
  /* Long-dead links are removed outright rather than left lying around. */
  const grace = 30 * 24 * 60 * 60 * 1000;
  return q.run('DELETE FROM portal_links WHERE expires_at < ?', now - grace).changes;
}

/* ---------------------------------------------------------------------------
   The one shape in which a position is ever handed out

   Used by the tracking link from the text message and by the customer's own
   appointment page. Both go through here, so there is a single place where
   "what may the customer see" is decided — and it only ever runs for a trip
   that resolveTripToken (or a live lookup) has already proven is running.
   --------------------------------------------------------------------------- */
export function publicTripState(trip, { now = Date.now() } = {}) {
  const appt = q.get('SELECT * FROM appointments WHERE id = ?', trip.appointment_id);
  const customer = appt ? q.get('SELECT name FROM customers WHERE id = ?', appt.customer_id) : null;
  const settings = {
    business_name: getSetting('business_name'),
    business_phone: getSetting('business_phone'),
    timezone: getSetting('timezone'),
  };

  const hasPosition = trip.last_lat != null && trip.last_lng != null;
  const dest = trip.dest_lat != null && trip.dest_lng != null
    ? { lat: trip.dest_lat, lng: trip.dest_lng }
    : null;

  /* Recompute rather than trust what was stored at ping time, so a stale ETA
     does not keep counting down after the owner's phone has gone quiet. */
  const fresh = hasPosition && dest
    ? estimate({ from: { lat: trip.last_lat, lng: trip.last_lng }, to: dest, speedMps: trip.last_speed_mps, now })
    : null;

  const staleSeconds = trip.last_ping_at ? Math.round((now - trip.last_ping_at) / 1000) : null;

  return {
    live: true,
    expires_at: trip.expires_at,
    seconds_left: Math.max(0, Math.round((trip.expires_at - now) / 1000)),
    started_at: trip.created_at,
    position: hasPosition ? {
      lat: trip.last_lat,
      lng: trip.last_lng,
      accuracy_m: trip.last_accuracy_m,
      heading: trip.last_heading,
      recorded_at: trip.last_ping_at,
      stale_seconds: staleSeconds,
    } : null,
    destination: dest ? { ...dest, label: trip.dest_label } : null,
    distance_m: fresh?.distanceM ?? null,
    eta_minutes: fresh?.etaMinutes ?? null,
    eta_at: fresh?.etaAt ?? null,
    trail: hasPosition ? tripTrail(trip.id, 40).map((p) => ({ lat: p.lat, lng: p.lng })) : [],
    status: appt?.status ?? null,
    business: { name: settings.business_name, phone: settings.business_phone },
    appointment: appt ? {
      service_name: appt.service_name,
      starts_at: appt.starts_at,
      customer_first: String(customer?.name || '').trim().split(/\s+/)[0] || '',
    } : null,
  };
}

export function countTripView(tripId) {
  q.run('UPDATE trips SET view_count = view_count + 1 WHERE id = ?', tripId);
}
