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


/* ---------- icons ----------
   Drawn as inline SVG rather than emoji: the brand is sharp, monochrome and
   automotive, and full-colour emoji sitting in the chrome of the app fights
   that. These take the surrounding colour, so they work anywhere.
   Built with createElementNS, never from a markup string. */

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
  today:     ['M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  schedule:  ['M4 6h16v14H4zM4 10h16M8 3v4M16 3v4', 'M8 14h3'],
  customers: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6'],
  money:     ['M3 7h18v10H3z', 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z', 'M6 7v10M18 7v10'],
  setup:     ['M4 7h10M18 7h2M4 17h4M12 17h8', 'M16 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M10 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  phone:     ['M6 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L16 13l5 2v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4 5.2 2 2 0 0 1 6 3z'],
  message:   ['M4 5h16v11H9l-5 4z'],
  compass:   ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M15.5 8.5 13 13l-4.5 2.5L11 11z'],
  link:      ['M9.5 14.5 14.5 9.5', 'M11 7.5 13 5.5a3.5 3.5 0 1 1 5 5l-2 2', 'M13 16.5l-2 2a3.5 3.5 0 1 1-5-5l2-2'],
  pin:       ['M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z', 'M12 8a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z'],
  receipt:   ['M6 3h12v18l-2.5-1.6L13 21l-2.5-1.6L8 21l-2-1.4z', 'M9 8h6M9 12h6'],
  star:      ['M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9L3.5 9.7l5.9-.8z'],
  sparkle:   ['M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z'],
  camera:    ['M3 7h4l1.5-2h7L17 7h4v12H3z', 'M12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z'],
  search:    ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M16.2 16.2 21 21'],
  clock:     ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7.5V12l3 2'],
  calendar:  ['M4 6h16v14H4zM4 10h16M8 3v4M16 3v4'],
  car:       ['M4 15h16M5.5 15l1.6-5.2A2 2 0 0 1 9 8.4h6a2 2 0 0 1 1.9 1.4L18.5 15', 'M4 15v3h3v-3M17 15v3h3v-3'],
  list:      ['M5 7h14M5 12h14M5 17h9'],
  send:      ['M4 12 20 5l-6 15-2.6-6.4z'],
  history:   ['M12 3a9 9 0 1 1-8.5 6', 'M3 4v5h5', 'M12 8v4.5l3 1.8'],
  tag:       ['M4 4h7.5L20 12.5 12.5 20 4 11.5z', 'M8 8h.01'],
  shield:    ['M12 3 20 6v6c0 5-8 9-8 9s-8-4-8-9V6z'],
  close:     ['M6 6l12 12M18 6L6 18'],
  back:      ['M14.5 5 8 12l6.5 7'],
  chevron:   ['M9.5 5 16 12l-6.5 7'],
  more:      ['M6 12h.01M12 12h.01M18 12h.01'],
  edit:      ['M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z', 'M14.5 6.5 17.5 9.5'],
};

export function icon(name, { size = 22, stroke = 1.7, className = '', filled = false } = {}) {
  const paths = ICON_PATHS[name] || ICON_PATHS.sparkle;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/* Five stars, lit up to the rating. Used on both sides, so the owner sees
   exactly what the customer tapped. */
export function stars(rating, { size = 20, onPick = null } = {}) {
  const row = h('div', { class: `stars${onPick ? ' stars--pickable' : ''}` });
  for (let n = 1; n <= 5; n += 1) {
    const lit = n <= rating;
    const glyph = icon('star', { size, filled: lit, stroke: lit ? 1 : 1.5 });
    if (onPick) {
      row.append(h('button', {
        class: lit ? 'lit' : '',
        'aria-label': `${n} star${n > 1 ? 's' : ''}`,
        onClick: () => onPick(n),
      }, glyph));
    } else {
      row.append(h('span', { class: lit ? 'lit' : '' }, glyph));
    }
  }
  return row;
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

export function empty(iconName, message, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, icon(iconName, { size: 34, stroke: 1.4 })),
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
