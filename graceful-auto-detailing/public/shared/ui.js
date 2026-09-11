/* ==========================================================================
   Shared browser helpers

   The rule that matters here: nothing ever builds HTML from a string. Every
   element is created, and every piece of text goes in through textContent, so
   a customer's name or a note typed by the owner is text and can never become
   markup. There is no innerHTML anywhere in this app.
   ========================================================================== */

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'html') throw new Error('h() does not accept html — pass text.');
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'style') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key in el && key !== 'list' && typeof value !== 'object') {
        try { el[key] = value; } catch { el.setAttribute(key, String(value)); }
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }

  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ---------- talking to the server ---------- */

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function readCookie(name) {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

export async function api(method, path, body, opts = {}) {
  const headers = {};
  let payload;

  if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    payload = body;
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  /* The CSRF cookie is readable on purpose: echoing it back in a header is
     what proves the request came from this page and not from another site. */
  if (method !== 'GET' && method !== 'HEAD') {
    const token = readCookie('gad_csrf');
    if (token) headers['X-CSRF-Token'] = token;
  }

  const resp = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });

  if (resp.status === 204) return null;
  const type = resp.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await resp.json() : await resp.text();

  if (!resp.ok) {
    const message = (data && typeof data === 'object' && data.error) || 'Something went wrong.';
    throw new ApiError(resp.status, message, data?.code);
  }
  return data;
}

api.get = (p) => api('GET', p);
api.post = (p, b, o) => api('POST', p, b ?? {}, o);
api.patch = (p, b) => api('PATCH', p, b ?? {});
api.del = (p) => api('DELETE', p);

/* ---------- formatting ---------- */

export function money(cents, { sign = false } = {}) {
  const n = Math.round(Number(cents) || 0);
  const out = (Math.abs(n) / 100).toLocaleString('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 2,
  });
  if (n < 0) return `-${out}`;
  return sign && n > 0 ? `+${out}` : out;
}

/* Whole dollars read better on a price list; cents matter on an invoice. */
export function price(cents) {
  const n = Math.round(Number(cents) || 0);
  return n % 100 === 0 ? `$${(n / 100).toLocaleString('en-US')}` : money(n);
}

let zone = null;
export function setTimezone(tz) { zone = tz || null; }

const dtf = (opts) => new Intl.DateTimeFormat('en-US', zone ? { ...opts, timeZone: zone } : opts);

export function fmtTime(ms) {
  return dtf({ hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

/* Hour, minute and AM/PM separately, because a job card stacks them. Asking
   Intl for just the hour returns "1 AM", which is not what a caller wants. */
export function timeParts(ms) {
  const parts = dtf({ hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms));
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return { hour: pick('hour'), minute: pick('minute'), period: pick('dayPeriod') };
}
export function fmtDate(ms) {
  return dtf({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(ms));
}
export function fmtLongDate(ms) {
  return dtf({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(ms));
}
export function fmtDateTime(ms) {
  return `${fmtDate(ms)}, ${fmtTime(ms)}`;
}

/* "Today", "Tomorrow" and "Yesterday" are worth the special case — they are
   what someone actually says. */
export function fmtDay(ms) {
  const dayKey = (t) => dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const today = dayKey(Date.now());
  const key = dayKey(ms);
  if (key === today) return 'Today';
  if (key === dayKey(Date.now() + 86400000)) return 'Tomorrow';
  if (key === dayKey(Date.now() - 86400000)) return 'Yesterday';
  return fmtDate(ms);
}

/* "3h" and "3h 30m" read better on a job card than "180m" and "210m". */
export function fmtDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function fmtCountdown(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  if (m >= 1) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}

export function fmtRelative(ms) {
  const diff = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(diff);
  if (abs < 60) return diff < 0 ? 'just now' : 'in a moment';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

export function fmtDistance(meters) {
  if (meters === null || meters === undefined) return '';
  const miles = meters / 1609.344;
  if (miles < 0.1) return 'Less than a block';
  if (miles < 10) return `${miles.toFixed(1)} mi`;
  return `${Math.round(miles)} mi`;
}

/* Accepts what people actually have to hand: a pair of numbers, or a link
   copied out of Google or Apple Maps. Anything else is refused plainly rather
   than guessed at. */
export function parseCoordinates(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  const patterns = [
    /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/,   // 42.7981, -83.7049
    /[@!]3?d?(-?\d{1,3}\.\d+),\s*!?4?d?(-?\d{1,3}\.\d+)/,      // google /@lat,lng and !3dlat!4dlng
    /[?&](?:q|ll|sll|daddr|destination)=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/, // ?q=lat,lng
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return null;
}

/* A business monogram reads better as the first letters of its first words
   than as first-and-last, which turns "Graceful Auto Detailing" into "GD". */
export function monogram(name, take = 2) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, take).map((w) => w[0]).join('').toUpperCase();
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/* ---------- toast ---------- */

let toastEl = null;
let toastTimer = null;

export function toast(message, { bad = false, ms = 2800 } = {}) {
  if (!toastEl) {
    toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.toggle('toast--bad', bad);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ---------- bottom sheet ---------- */

let sheetHost = null;
let closeSheetFn = null;

function ensureSheetHost() {
  if (sheetHost) return sheetHost;
  sheetHost = h('div', { class: 'sheet-host' });
  document.body.append(sheetHost);
  return sheetHost;
}

export function closeSheet() {
  if (closeSheetFn) closeSheetFn();
}

/* Returns a promise that settles with whatever resolve() is called with, or
   null if the customer or owner dismissed it. */
export function sheet({ title, subtitle, build, onOpen }) {
  const host = ensureSheetHost();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      host.classList.remove('open');
      clear(host);
      document.removeEventListener('keydown', onKey);
      closeSheetFn = null;
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };

    const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
      h('div', { class: 'sheet-grab' }),
      title ? h('h2', { text: title }) : null,
      subtitle ? h('p', { class: 'sheet-sub', text: subtitle }) : null,
      build ? build({ close: finish, resolve: finish }) : null
    );

    mount(host,
      h('div', { class: 'sheet-scrim', onClick: () => finish(null) }),
      panel
    );
    host.classList.add('open');
    document.addEventListener('keydown', onKey);
    closeSheetFn = () => finish(null);

    const focusable = panel.querySelector('input, select, textarea, button');
    if (onOpen) onOpen(panel);
    else if (focusable && !focusable.classList.contains('btn')) setTimeout(() => focusable.focus(), 60);
  });
}

export function confirmSheet({ title, subtitle, confirmLabel = 'Confirm', danger = false }) {
  return sheet({
    title,
    subtitle,
    build: ({ close }) => h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(false) }),
      h('button', {
        class: danger ? 'btn btn--danger' : 'btn btn--primary',
        text: confirmLabel,
        onClick: () => close(true),
      })
    ),
  }).then((v) => v === true);
}

/* ---------- small building blocks ---------- */

export function field(label, control, help) {
  return h('div', { class: 'field' },
    h('label', { text: label, for: control.id || undefined }),
    control,
    help ? h('p', { class: 'help', text: help }) : null
  );
}

export function switchRow(label, help, checked, onChange) {
  const input = h('input', { type: 'checkbox', checked, onChange: (e) => onChange(e.target.checked) });
  input.setAttribute('aria-label', label);
  return h('div', { class: 'switch-row' },
    h('div', {},
      h('div', { class: 'switch-label', text: label }),
      help ? h('div', { class: 'switch-help', text: help }) : null
    ),
    h('div', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', { class: 'thumb' }))
  );
}

export function moneyLine(label, value, { total = false, muted = false } = {}) {
  return h('div', { class: `money-line${total ? ' money-line--total' : ''}` },
    h('span', { class: 'label', text: label }),
    h('span', { class: `value${muted ? ' muted' : ''}`, text: value })
  );
}

export function empty(emoji, message, action) {
  return h('div', { class: 'empty' },
    h('span', { class: 'emoji', text: emoji }),
    h('p', { text: message }),
    action ? h('div', { style: { marginTop: '16px' } }, action) : null
  );
}

/* A dollars field that keeps cents as the truth. The server validates anyway;
   this only stops obvious nonsense reaching it. */
export function moneyInput(valueCents, { id, placeholder = '0.00' } = {}) {
  const input = h('input', {
    type: 'text', inputmode: 'decimal', id, placeholder,
    value: valueCents === null || valueCents === undefined ? '' : (valueCents / 100).toFixed(2),
  });
  input.getCents = () => {
    const raw = String(input.value).replace(/[^0-9.\-]/g, '');
    if (!raw) return 0;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };
  return input;
}

/* Turns an input[type=datetime-local] value into epoch ms in the browser's own
   timezone — which is the owner's phone, which is the right answer. */
export function localInputToMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function msToLocalInput(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
