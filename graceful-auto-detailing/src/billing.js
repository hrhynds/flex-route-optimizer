import { q, getSetting, setSetting, tx, audit } from './db.js';
import { bad, notFound, conflict } from './http.js';

/* ---------------------------------------------------------------------------
   Totals

   Every figure the customer or the owner sees is worked out here, on the
   server, from rows in the database. A client never sends a total; it only
   ever sends which add-ons it wants.
   --------------------------------------------------------------------------- */

export function taxRateBp() {
  const n = Number.parseInt(getSetting('tax_rate_bp'), 10);
  return Number.isFinite(n) && n >= 0 && n <= 3000 ? n : 0;
}

export function appointmentAddons(appointmentId) {
  return q.all(
    'SELECT * FROM appointment_addons WHERE appointment_id = ? ORDER BY created_at, id',
    appointmentId
  );
}

export function appointmentTotals(appointmentId, { discountCents = null } = {}) {
  const appt = q.get('SELECT * FROM appointments WHERE id = ?', appointmentId);
  if (!appt) throw notFound('That appointment no longer exists.');
  const addons = appointmentAddons(appointmentId);

  const addonsCents = addons.reduce((sum, a) => sum + a.price_cents, 0);
  const subtotal = appt.service_price_cents + addonsCents;

  const invoice = q.get('SELECT * FROM invoices WHERE appointment_id = ?', appointmentId);
  const discount = discountCents ?? invoice?.discount_cents ?? 0;
  const taxable = Math.max(0, subtotal - discount);
  const rate = invoice && invoice.status !== 'draft' ? invoice.tax_rate_bp : taxRateBp();
  const tax = Math.round((taxable * rate) / 10000);

  return {
    service_name: appt.service_name,
    service_price_cents: appt.service_price_cents,
    addons,
    addons_cents: addonsCents,
    subtotal_cents: subtotal,
    discount_cents: discount,
    tax_rate_bp: rate,
    tax_cents: tax,
    total_cents: taxable + tax,
    /* Any "starting at" line means the figure is a guide, not a final number. */
    is_estimate: Boolean(appt.service_price_cents && addons.some((a) => a.price_is_from)),
  };
}

/* ---------------------------------------------------------------------------
   Invoices
   --------------------------------------------------------------------------- */

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'];

function nextInvoiceNumber() {
  return tx(() => {
    const prefix = String(getSetting('invoice_prefix') || 'GAD').replace(/[^A-Za-z0-9-]/g, '').slice(0, 8) || 'GAD';
    const seq = Number.parseInt(getSetting('invoice_seq'), 10);
    const next = Number.isFinite(seq) ? seq + 1 : 1001;
    setSetting('invoice_seq', String(next));
    return `${prefix}-${next}`;
  });
}

export function getInvoice(appointmentId) {
  const invoice = q.get('SELECT * FROM invoices WHERE appointment_id = ?', appointmentId);
  if (!invoice) return null;
  return hydrate(invoice);
}

export function getInvoiceById(id) {
  const invoice = q.get('SELECT * FROM invoices WHERE id = ?', id);
  if (!invoice) throw notFound('That invoice does not exist.');
  return hydrate(invoice);
}

function hydrate(invoice) {
  return {
    ...invoice,
    items: q.all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, id', invoice.id),
    payments: q.all('SELECT * FROM payments WHERE invoice_id = ? ORDER BY received_at, id', invoice.id),
    balance_cents: invoice.total_cents - invoice.paid_cents,
    /* Nothing asks for a tip. This is only what came in with the money, for
       the owner's own books — it is not part of what was invoiced. */
    tips_received_cents: q.pluck(
      'SELECT COALESCE(SUM(tip_cents), 0) AS n FROM payments WHERE invoice_id = ?', invoice.id
    ),
  };
}

/* Builds the invoice from what is actually on the appointment. Safe to call
   repeatedly while the invoice is a draft; refuses once it has gone out, so a
   later price-list edit can never rewrite an invoice a customer already has. */
export function buildInvoice(appointmentId, { actor = 'owner' } = {}) {
  const appt = q.get('SELECT * FROM appointments WHERE id = ?', appointmentId);
  if (!appt) throw notFound('That appointment no longer exists.');

  const existing = q.get('SELECT * FROM invoices WHERE appointment_id = ?', appointmentId);
  if (existing && existing.status !== 'draft') {
    throw conflict('That invoice has already been issued. Void it first if it needs rebuilding.');
  }

  const now = Date.now();
  return tx(() => {
    let invoiceId = existing?.id;
    if (!invoiceId) {
      const res = q.run(
        `INSERT INTO invoices(appointment_id, number, status, created_at, updated_at)
         VALUES(?,?,'draft',?,?)`,
        appointmentId, nextInvoiceNumber(), now, now
      );
      invoiceId = res.id;
    }

    q.run('DELETE FROM invoice_items WHERE invoice_id = ?', invoiceId);

    let sort = 0;
    q.run(
      `INSERT INTO invoice_items(invoice_id, label, detail, qty, unit_cents, amount_cents, kind, sort_order)
       VALUES(?,?,?,1,?,?,'service',?)`,
      invoiceId, appt.service_name, '', appt.service_price_cents, appt.service_price_cents, sort++
    );
    for (const addon of appointmentAddons(appointmentId)) {
      q.run(
        `INSERT INTO invoice_items(invoice_id, label, detail, qty, unit_cents, amount_cents, kind, sort_order)
         VALUES(?,?,?,1,?,?,'addon',?)`,
        invoiceId, addon.name, addon.price_is_from ? 'Quoted from this price' : '',
        addon.price_cents, addon.price_cents, sort++
      );
    }

    recalcInvoice(invoiceId);
    audit(actor, 'invoice.build', 'invoice', invoiceId, { appointmentId });
    return getInvoiceById(invoiceId);
  });
}

/* One place that decides what an invoice adds up to.

   The model, stated once so nothing double-counts:
     items                     -> subtotal
     subtotal - discount + tax -> total
     payments (amount only)    -> paid
     total - paid              -> balance

   Nothing here asks a customer for a tip. If one is handed over anyway, it is
   recorded on the payment that brought it (payments.tip_cents) as a note on
   how that money arrived, and never as something the invoice demanded. */
export function recalcInvoice(invoiceId) {
  const invoice = q.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!invoice) throw notFound('That invoice does not exist.');

  const subtotal = q.pluck('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM invoice_items WHERE invoice_id = ?', invoiceId);
  const discount = Math.min(Math.max(invoice.discount_cents, 0), subtotal);
  const rate = invoice.status === 'draft' ? taxRateBp() : invoice.tax_rate_bp;
  const tax = Math.round(((subtotal - discount) * rate) / 10000);
  const total = subtotal - discount + tax;

  const paid = q.pluck('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE invoice_id = ?', invoiceId);

  let status = invoice.status;
  if (status !== 'void' && status !== 'draft') {
    status = total > 0 && paid >= total ? 'paid' : 'sent';
  }
  const paidAt = status === 'paid' ? (invoice.paid_at || Date.now()) : null;

  q.run(
    `UPDATE invoices SET subtotal_cents = ?, discount_cents = ?, tax_rate_bp = ?, tax_cents = ?,
            tip_cents = ?, total_cents = ?, paid_cents = ?, status = ?, paid_at = ?, updated_at = ?
      WHERE id = ?`,
    subtotal, discount, rate, tax, 0, total, paid, status, paidAt, Date.now(), invoiceId
  );
  return getInvoiceById(invoiceId);
}

export function issueInvoice(invoiceId, { actor = 'owner' } = {}) {
  const invoice = q.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!invoice) throw notFound('That invoice does not exist.');
  if (invoice.status === 'void') throw conflict('That invoice is void.');
  if (invoice.status === 'draft') {
    q.run('UPDATE invoices SET status = ?, issued_at = ?, tax_rate_bp = ?, updated_at = ? WHERE id = ?',
      'sent', Date.now(), taxRateBp(), Date.now(), invoiceId);
    audit(actor, 'invoice.issue', 'invoice', invoiceId);
  }
  return recalcInvoice(invoiceId);
}

export function voidInvoice(invoiceId, { actor = 'owner' } = {}) {
  const invoice = q.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!invoice) throw notFound('That invoice does not exist.');
  if (invoice.paid_cents > 0) throw conflict('Money has already been recorded against that invoice. Refund it outside the app, then void.');
  q.run('UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?', 'void', Date.now(), invoiceId);
  audit(actor, 'invoice.void', 'invoice', invoiceId);
  return getInvoiceById(invoiceId);
}

export const PAYMENT_METHODS = ['cash', 'card', 'zelle', 'venmo', 'cashapp', 'apple_pay', 'bank_transfer', 'check', 'other'];

export function recordPayment(invoiceId, { amountCents, tipCents = 0, method = 'cash', reference = '', note = '', source = 'admin', receivedAt = null, actor = 'owner' }) {
  const invoice = q.get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!invoice) throw notFound('That invoice does not exist.');
  if (invoice.status === 'void') throw conflict('That invoice is void.');
  if (invoice.status === 'draft') throw conflict('Issue the invoice before recording money against it.');
  if (amountCents <= 0) throw bad('Enter the amount you received.');
  /* The tip is the part of this payment that was a tip, so it cannot exceed it. */
  if (tipCents < 0 || tipCents > amountCents) throw bad('The tip cannot be more than the payment it came in with.');

  const now = Date.now();
  const res = q.run(
    `INSERT INTO payments(invoice_id, amount_cents, tip_cents, method, reference, note, source, received_at, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    invoiceId, amountCents, tipCents, method, reference, note, source, receivedAt ?? now, now
  );
  audit(actor, 'payment.record', 'invoice', invoiceId, { amountCents, tipCents, method, source });
  return { payment_id: res.id, invoice: recalcInvoice(invoiceId) };
}

export function deletePayment(paymentId, { actor = 'owner' } = {}) {
  const row = q.get('SELECT * FROM payments WHERE id = ?', paymentId);
  if (!row) throw notFound('That payment does not exist.');
  q.run('DELETE FROM payments WHERE id = ?', paymentId);
  audit(actor, 'payment.delete', 'invoice', row.invoice_id, { paymentId });
  return recalcInvoice(row.invoice_id);
}
