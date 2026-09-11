import { q, audit } from './db.js';
import { bad, notFound, conflict } from './http.js';
import { appointmentTotals, getInvoice } from './billing.js';
import { liveTripForAppointment } from './links.js';

/* ---------------------------------------------------------------------------
   Statuses

   Deliberately few, and each one means something a customer would recognise.
   --------------------------------------------------------------------------- */

export const STATUSES = {
  scheduled:   { label: 'Scheduled',   customer: 'Booked in',        tone: 'neutral' },
  confirmed:   { label: 'Confirmed',   customer: 'Confirmed',        tone: 'good' },
  on_my_way:   { label: 'On my way',   customer: 'On the way to you', tone: 'live' },
  arrived:     { label: 'Arrived',     customer: 'Arrived',          tone: 'live' },
  in_progress: { label: 'In progress', customer: 'Being detailed',   tone: 'live' },
  completed:   { label: 'Completed',   customer: 'All finished',     tone: 'good' },
  cancelled:   { label: 'Cancelled',   customer: 'Cancelled',        tone: 'bad' },
  no_show:     { label: 'No show',     customer: 'Missed',           tone: 'bad' },
};

export const STATUS_KEYS = Object.keys(STATUSES);

const TRANSITIONS = {
  scheduled:   ['confirmed', 'on_my_way', 'in_progress', 'cancelled', 'no_show'],
  confirmed:   ['scheduled', 'on_my_way', 'in_progress', 'cancelled', 'no_show'],
  on_my_way:   ['arrived', 'in_progress', 'confirmed', 'cancelled'],
  arrived:     ['in_progress', 'completed', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed:   [],
  cancelled:   ['scheduled'],
  no_show:     ['scheduled'],
};

export function canTransition(from, to) {
  if (from === to) return true;
  return (TRANSITIONS[from] || []).includes(to);
}

export function assertTransition(from, to) {
  if (!STATUS_KEYS.includes(to)) throw bad('That is not a status this app uses.');
  if (!canTransition(from, to)) {
    throw conflict(`An appointment that is "${STATUSES[from].label}" cannot move straight to "${STATUSES[to].label}".`);
  }
  return true;
}

export const LIVE_STATUSES = ['on_my_way', 'arrived', 'in_progress'];
export const OPEN_STATUSES = ['scheduled', 'confirmed', 'on_my_way', 'arrived', 'in_progress'];

/* ---------------------------------------------------------------------------
   Loading
   --------------------------------------------------------------------------- */

export function loadAppointment(id) {
  const appt = q.get('SELECT * FROM appointments WHERE id = ?', id);
  if (!appt) throw notFound('That appointment does not exist.');
  return appt;
}

export function customerOf(appointment) {
  return q.get('SELECT * FROM customers WHERE id = ?', appointment.customer_id);
}

export function vehicleOf(appointment) {
  return appointment.vehicle_id ? q.get('SELECT * FROM vehicles WHERE id = ?', appointment.vehicle_id) : null;
}

export function photosOf(appointmentId, { sharedOnly = false } = {}) {
  const rows = sharedOnly
    ? q.all('SELECT * FROM photos WHERE appointment_id = ? AND shared = 1 ORDER BY created_at, id', appointmentId)
    : q.all('SELECT * FROM photos WHERE appointment_id = ? ORDER BY created_at, id', appointmentId);
  return rows;
}

export function setStatus(appointmentId, next, { actor = 'owner' } = {}) {
  const appt = loadAppointment(appointmentId);
  assertTransition(appt.status, next);
  const now = Date.now();
  const completedAt = next === 'completed' ? (appt.completed_at || now) : (next === 'cancelled' ? null : appt.completed_at);
  /* Once a job is finished or called off, the customer's add-on list is closed. */
  const lock = next === 'completed' || next === 'cancelled' || next === 'no_show' ? 1 : appt.addons_locked;
  q.run(
    'UPDATE appointments SET status = ?, completed_at = ?, addons_locked = ?, updated_at = ? WHERE id = ?',
    next, completedAt, lock, now, appointmentId
  );
  if (appt.status !== next) audit(actor, 'appointment.status', 'appointment', appointmentId, { from: appt.status, to: next });
  return loadAppointment(appointmentId);
}

/* ---------------------------------------------------------------------------
   Serialisers

   Two views of the same appointment. The customer view is built by naming
   every field that goes out, never by removing fields from the admin view —
   so a column added later is private until someone deliberately shares it.
   --------------------------------------------------------------------------- */

export function adminView(appointment, { now = Date.now() } = {}) {
  const customer = customerOf(appointment);
  const vehicle = vehicleOf(appointment);
  const totals = appointmentTotals(appointment.id);
  const trip = liveTripForAppointment(appointment.id, now);
  const invoice = getInvoice(appointment.id);
  const review = q.get('SELECT * FROM reviews WHERE appointment_id = ?', appointment.id);

  return {
    id: appointment.id,
    status: appointment.status,
    status_label: STATUSES[appointment.status]?.label ?? appointment.status,
    status_tone: STATUSES[appointment.status]?.tone ?? 'neutral',
    starts_at: appointment.starts_at,
    duration_min: appointment.duration_min,
    address: appointment.address,
    lat: appointment.lat,
    lng: appointment.lng,
    notes: appointment.notes,
    addons_locked: Boolean(appointment.addons_locked),
    created_at: appointment.created_at,
    completed_at: appointment.completed_at,
    customer: customer && {
      id: customer.id, name: customer.name, phone: customer.phone,
      email: customer.email, sms_consent: Boolean(customer.sms_consent), notes: customer.notes,
    },
    vehicle: vehicle && {
      id: vehicle.id, year: vehicle.year, make: vehicle.make,
      model: vehicle.model, color: vehicle.color, plate: vehicle.plate,
    },
    service: { id: appointment.service_id, name: appointment.service_name, price_cents: appointment.service_price_cents },
    totals,
    trip: trip && {
      id: trip.id,
      expires_at: trip.expires_at,
      started_at: trip.created_at,
      last_ping_at: trip.last_ping_at,
      has_position: trip.last_lat != null,
      eta_at: trip.eta_at,
      distance_m: trip.distance_m,
    },
    invoice: invoice && {
      id: invoice.id, number: invoice.number, status: invoice.status,
      total_cents: invoice.total_cents, paid_cents: invoice.paid_cents,
      balance_cents: invoice.balance_cents, tip_cents: invoice.tip_cents,
    },
    photo_count: q.pluck('SELECT COUNT(*) AS n FROM photos WHERE appointment_id = ?', appointment.id),
    review: review && { rating: review.rating, comment: review.comment, published: Boolean(review.published) },
    message_count: q.pluck('SELECT COUNT(*) AS n FROM messages WHERE appointment_id = ?', appointment.id),
  };
}

export function listView(appointment, { now = Date.now() } = {}) {
  const customer = customerOf(appointment);
  const vehicle = vehicleOf(appointment);
  const totals = appointmentTotals(appointment.id);
  const trip = liveTripForAppointment(appointment.id, now);
  return {
    id: appointment.id,
    status: appointment.status,
    status_label: STATUSES[appointment.status]?.label ?? appointment.status,
    status_tone: STATUSES[appointment.status]?.tone ?? 'neutral',
    starts_at: appointment.starts_at,
    duration_min: appointment.duration_min,
    address: appointment.address,
    service_name: appointment.service_name,
    customer_name: customer?.name ?? 'Unknown',
    customer_phone: customer?.phone ?? '',
    customer_id: customer?.id ?? null,
    vehicle_label: vehicle ? [vehicle.year, vehicle.color, vehicle.make, vehicle.model].filter(Boolean).join(' ') : '',
    total_cents: totals.total_cents,
    addon_count: totals.addons.length,
    trip_live: Boolean(trip),
    trip_expires_at: trip?.expires_at ?? null,
  };
}
