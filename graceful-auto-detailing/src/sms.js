import config from './config.js';
import { q, allSettings, audit } from './db.js';
import { bad, notFound } from './http.js';
import { money } from './validate.js';

/* ---------------------------------------------------------------------------
   Templates

   A template is plain text with {{placeholders}}. Anything the owner types is
   treated as text, never as code: substitution is a single pass over a fixed
   list of known keys, so a placeholder that happens to appear inside a
   substituted value is never expanded again.
   --------------------------------------------------------------------------- */

export const PLACEHOLDERS = [
  { key: 'customer_first', what: "Customer's first name" },
  { key: 'customer_name', what: "Customer's full name" },
  { key: 'business_name', what: 'Your business name' },
  { key: 'business_phone', what: 'Your phone number' },
  { key: 'service', what: 'The booked service' },
  { key: 'vehicle', what: 'The vehicle, e.g. 2019 Silver Tacoma' },
  { key: 'date', what: 'Appointment date, e.g. Friday 12 September' },
  { key: 'time', what: 'Appointment time, e.g. 9:30 AM' },
  { key: 'address', what: 'Where the job is' },
  { key: 'total', what: 'Appointment total including add-ons' },
  { key: 'portal_link', what: "The customer's private appointment link" },
  { key: 'tracking_link', what: 'Live tracking link (only while a trip is running)' },
  { key: 'tracking_minutes', what: 'How long the tracking link lasts' },
];

const KNOWN = new Set(PLACEHOLDERS.map((p) => p.key));

export function renderTemplate(body, vars = {}) {
  return String(body).replace(/\{\{\s*([a-z_]{1,40})\s*\}\}/gi, (whole, name) => {
    const key = name.toLowerCase();
    if (!KNOWN.has(key)) return '';
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function unknownPlaceholders(body) {
  const found = new Set();
  for (const m of String(body).matchAll(/\{\{\s*([a-z_]{1,40})\s*\}\}/gi)) {
    const key = m[1].toLowerCase();
    if (!KNOWN.has(key)) found.add(m[1]);
  }
  return [...found];
}

export function getTemplate(key) {
  const row = q.get('SELECT * FROM sms_templates WHERE key = ?', key);
  if (!row) throw notFound('That message template does not exist.');
  return row;
}

/* ---------------------------------------------------------------------------
   Building the variables for one appointment
   --------------------------------------------------------------------------- */

export function formatWhen(ms, timezone) {
  const date = new Date(ms);
  const opts = { timeZone: timezone || 'UTC' };
  return {
    date: new Intl.DateTimeFormat('en-US', { ...opts, weekday: 'long', month: 'long', day: 'numeric' }).format(date),
    time: new Intl.DateTimeFormat('en-US', { ...opts, hour: 'numeric', minute: '2-digit' }).format(date),
  };
}

export function vehicleLabel(vehicle) {
  if (!vehicle) return 'vehicle';
  const bits = [vehicle.year, vehicle.color, vehicle.make, vehicle.model].filter(Boolean);
  return bits.length ? bits.join(' ') : 'vehicle';
}

export function buildVars({ appointment, customer, vehicle, totals, portalLink, trackingLink, trackingMinutes }) {
  const s = allSettings();
  const when = appointment ? formatWhen(appointment.starts_at, s.timezone) : { date: '', time: '' };
  const firstName = String(customer?.name || '').trim().split(/\s+/)[0] || 'there';
  return {
    customer_first: firstName,
    customer_name: customer?.name || '',
    business_name: s.business_name,
    business_phone: s.business_phone,
    service: appointment?.service_name || '',
    vehicle: vehicleLabel(vehicle),
    date: when.date,
    time: when.time,
    address: appointment?.address || '',
    total: totals ? money(totals.total_cents ?? totals.subtotal_cents ?? 0) : '',
    portal_link: portalLink || '',
    tracking_link: trackingLink || '',
    tracking_minutes: trackingMinutes == null ? '' : String(trackingMinutes),
  };
}

/* ---------------------------------------------------------------------------
   Sending
   --------------------------------------------------------------------------- */

export const SMS_MAX_LENGTH = 1200;

export async function sendSms({ to, body, customerId = null, appointmentId = null, templateKey = '', skipConsentCheck = false }) {
  const phone = String(to || '').trim();
  if (!phone) throw bad('That customer has no phone number saved.');
  const text = String(body || '').trim();
  if (!text) throw bad('The message is empty.');
  if (text.length > SMS_MAX_LENGTH) throw bad(`Keep the message under ${SMS_MAX_LENGTH} characters.`);

  if (!skipConsentCheck && customerId) {
    const consent = q.pluck('SELECT sms_consent FROM customers WHERE id = ?', customerId);
    if (consent === 0) throw bad('That customer has opted out of text messages.');
  }

  const now = Date.now();
  const provider = config.sms.provider;
  const res = q.run(
    `INSERT INTO messages(customer_id, appointment_id, to_phone, body, template_key, status, provider, created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    customerId, appointmentId, phone, text, templateKey, 'queued', provider, now
  );
  const id = res.id;

  try {
    if (provider === 'twilio') {
      const sid = await sendViaTwilio(phone, text);
      q.run('UPDATE messages SET status = ?, provider_sid = ?, sent_at = ? WHERE id = ?', 'sent', sid, Date.now(), id);
      audit('system', 'sms.sent', 'message', id, { templateKey });
      return { id, status: 'sent', provider, body: text };
    }
    /* No provider configured. The message is kept ready to send by hand from the
       owner's own phone, which is honest: nothing pretends to have gone out. */
    q.run('UPDATE messages SET status = ? WHERE id = ?', 'outbox', id);
    audit('system', 'sms.outbox', 'message', id, { templateKey });
    return { id, status: 'outbox', provider, body: text };
  } catch (err) {
    const message = String(err?.message || err).slice(0, 400);
    q.run('UPDATE messages SET status = ?, error = ? WHERE id = ?', 'failed', message, id);
    audit('system', 'sms.failed', 'message', id, { error: message });
    return { id, status: 'failed', provider, error: message, body: text };
  }
}

async function sendViaTwilio(to, body) {
  const { accountSid, authToken, from } = config.sms.twilio;
  if (!accountSid || !authToken || !from) throw new Error('Twilio is not fully configured.');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: from, Body: body });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data?.message || `Twilio returned ${resp.status}`);
    return String(data?.sid || '');
  } finally {
    clearTimeout(timer);
  }
}

export function messageStatusLabel(status) {
  return {
    sent: 'Sent',
    outbox: 'Ready to send',
    failed: 'Failed',
    queued: 'Queued',
  }[status] || status;
}
