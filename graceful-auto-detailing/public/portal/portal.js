import {
  h, mount, api, ApiError, money, price, toast, sheet, field, moneyLine, moneyInput,
  fmtCountdown, fmtDistance, fmtDuration, monogram, setTimezone,
} from '../shared/ui.js';

const app = document.getElementById('app');

/* The token is the whole of this page's authority and it is already in the
   address bar. It is never written anywhere else — not into storage, not into
   a query string, and no other site can read it. */
const TOKEN = decodeURIComponent(location.pathname.split('/p/')[1] || '').replace(/\/+$/, '');

let data = null;
let trackTimer = null;
let clockTimer = null;

async function load() {
  try {
    data = await api.get(`/api/portal/${encodeURIComponent(TOKEN)}`);
  } catch (err) {
    renderGone(err);
    return;
  }
  render();
  watchArrival();
}

function renderGone(err) {
  const expired = err instanceof ApiError && err.status === 404;
  mount(app, h('div', { class: 'gone' },
    h('span', { class: 'gone-emoji', text: expired ? '🔒' : '⚠️' }),
    h('h1', { text: expired ? 'This link is no longer live' : 'Something went wrong' }),
    h('p', { text: expired
      ? 'Appointment links expire after a while, for your privacy. Send us a message and we will text you a fresh one.'
      : err.message })
  ));
}

/* ==========================================================================
   The page
   ========================================================================== */

function render() {
  const a = data.appointment;
  const biz = data.business;
  setTimezone(null);

  const arrivalSlot = h('div');

  mount(app,
    h('header', { class: 'portal-top' },
      h('div', { class: 'biz-mark', text: monogram(biz.name) }),
      h('div', { class: 'biz-name', text: biz.name }),
      h('h1', { class: 'greeting', text: a.customer_first ? `Hi ${a.customer_first}` : 'Your appointment' }),
      h('div', { class: 'when', text: `${a.service_name} · ${a.date_label} at ${a.time_label}` }),
      h('div', { class: 'status-line' },
        h('span', { class: `pill${toneClass(a.status_tone)}` },
          a.status_tone === 'live' ? h('span', { class: 'dot' }) : null,
          a.status_label
        )
      )
    ),

    arrivalSlot,
    detailsCard(),
    includedCard(),
    offersCard(),
    photosCard(),
    invoiceCard(),
    reviewCard(),

    h('footer', { class: 'no-pressure' },
      h('p', { text: biz.phone ? `Questions? Call or text ${biz.phone}.` : 'Questions? Just reply to our text.' }),
      h('p', { style: { marginTop: '8px' }, text: 'This page is yours alone. Nothing to download, no account, no subscription.' })
    ),

    totalBar()
  );

  mount(arrivalSlot, arrivalCard());
}

function toneClass(tone) {
  return tone === 'live' ? ' pill--live' : tone === 'good' ? ' pill--good' : tone === 'bad' ? ' pill--bad' : '';
}

/* ---- arrival ---- */

function arrivalCard() {
  const t = data.tracking;
  if (!t?.live) return null;

  const secondsLeft = Math.max(0, Math.round((t.expires_at - Date.now()) / 1000));
  const eta = t.eta_minutes;

  return h('section', { class: 'arrival' },
    h('div', { class: 'arrival-top' },
      h('span', { class: 'dot-live', style: { color: 'var(--live)' } }),
      h('span', { class: 'arrival-title', text: 'On the way to you' })
    ),
    eta != null
      ? h('div', { class: 'arrival-eta' }, String(eta), h('span', { class: 'unit', text: eta === 1 ? 'minute away' : 'minutes away' }))
      : h('div', { class: 'arrival-eta' }, 'Nearly there'),
    h('div', { class: 'arrival-sub', text: t.distance_m != null
      ? `${fmtDistance(t.distance_m)} · live for another ${fmtCountdown(secondsLeft)}`
      : `Live for another ${fmtCountdown(secondsLeft)}` }),
    h('button', {
      class: 'btn btn--primary btn--block', style: { marginTop: '14px' },
      text: 'Follow on the map',
      onClick: openMap,
    })
  );
}

/* The map opens on this page's own token, so a customer never needs a second
   link and nothing extra has to be handed around. */
function openMap() {
  location.assign(`/m/${encodeURIComponent(TOKEN)}`);
}

/* Polls only while a trip is actually running, and stops the moment it ends. */
function watchArrival() {
  clearInterval(trackTimer);
  clearInterval(clockTimer);

  const tick = async () => {
    try {
      const t = await api.get(`/api/portal/${encodeURIComponent(TOKEN)}/tracking`);
      const wasLive = Boolean(data.tracking?.live);
      data.tracking = t.live ? t : { live: false };
      if (t.live !== wasLive) { render(); }
      else if (t.live) { repaintArrival(); }
      if (!t.live) { clearInterval(trackTimer); trackTimer = setInterval(tick, 45000); }
    } catch { /* a hiccup is not worth shouting about; the next tick tries again */ }
  };

  trackTimer = setInterval(tick, data.tracking?.live ? 10000 : 45000);
  clockTimer = setInterval(() => { if (data.tracking?.live) repaintArrival(); }, 1000);
  tick();
}

function repaintArrival() {
  const current = app.querySelector('.arrival');
  const next = arrivalCard();
  if (current && next) current.replaceWith(next);
  else render();
}

/* ---- the appointment ---- */

function detailsCard() {
  const a = data.appointment;
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: 'Where and when' })),
    moneyLine('Date', `${a.date_label}`),
    moneyLine('Time', a.time_label),
    a.duration_min ? moneyLine('Takes about', fmtDuration(a.duration_min)) : null,
    a.vehicle_label && a.vehicle_label !== 'vehicle' ? moneyLine('Vehicle', a.vehicle_label) : null,
    a.address ? moneyLine('Address', a.address) : null
  );
}

function includedCard() {
  const t = data.totals;
  const a = data.appointment;
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: "What you're booked in for" })),
    h('div', { class: 'line-item' },
      h('div', { class: 'line-main' }, h('div', { class: 'line-name', text: a.service_name })),
      h('div', { class: 'line-price', text: money(t.service_price_cents) })
    ),
    ...t.addons.map((line) => h('div', { class: 'line-item' },
      h('div', { class: 'line-main' },
        h('div', { class: 'line-name', text: line.name }),
        line.description ? h('div', { class: 'line-desc', text: line.description }) : null,
        line.added_by_you && data.addons_open
          ? h('button', { class: 'line-yours', text: 'You added this — tap to remove', onClick: () => removeAddon(line.line_id) })
          : line.added_by_you ? h('span', { class: 'line-yours', text: 'You added this' }) : null
      ),
      h('div', { class: 'line-price' },
        line.price_is_from ? h('span', { class: 'line-from', text: 'from' }) : null,
        money(line.price_cents)
      )
    ))
  );
}

/* ---- optional extras ---- */

function offersCard() {
  if (!data.addons_open || !data.available_addons.length) return null;
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: 'Worth adding?' }),
      h('span', { class: 'hint', text: 'Entirely up to you' })
    ),
    h('p', { class: 'small muted', text: 'Tap any of these and it goes on the job. The total updates straight away, and you can take it back off just as easily.' }),
    ...data.available_addons.map((addon) => h('button', {
      class: 'offer',
      onClick: (e) => addAddon(addon, e.currentTarget),
    },
      h('div', { class: 'offer-main' },
        h('div', { class: 'offer-name', text: addon.name }),
        addon.description ? h('div', { class: 'offer-desc', text: addon.description }) : null,
        h('span', { class: 'offer-add', text: '+ Add it' })
      ),
      h('div', { class: 'offer-end' },
        addon.price_is_from ? h('span', { class: 'offer-from', text: 'from' }) : null,
        h('div', { class: 'offer-price', text: price(addon.price_cents) })
      )
    )),
    h('p', { class: 'no-pressure', text: 'No hard sell — the job is complete without any of these.' })
  );
}

async function addAddon(addon, button) {
  button.disabled = true;
  try {
    data = await api.post(`/api/portal/${encodeURIComponent(TOKEN)}/addons`, { addon_id: addon.id });
    render();
    bumpTotal();
    toast(`${addon.name} added.`);
  } catch (err) {
    button.disabled = false;
    toast(err.message, { bad: true });
  }
}

async function removeAddon(lineId) {
  try {
    data = await api.del(`/api/portal/${encodeURIComponent(TOKEN)}/addons/${lineId}`);
    render();
    bumpTotal();
    toast('Taken off.');
  } catch (err) { toast(err.message, { bad: true }); }
}

/* ---- the running total ---- */

function totalBar() {
  const t = data.totals;
  const settled = data.invoice && data.invoice.balance_cents <= 0;
  if (settled) return null;

  return h('div', { class: 'total-bar' },
    h('div', {},
      h('div', { class: 'total-label', text: data.invoice ? 'Amount due' : 'Your total so far' }),
      t.is_estimate ? h('div', { class: 'total-note', text: 'A "from" price is in here — we will confirm on the day' }) : null
    ),
    h('div', { class: 'total-value', id: 'total-value',
      text: money(data.invoice ? data.invoice.balance_cents : t.total_cents) })
  );
}

function bumpTotal() {
  const el = document.getElementById('total-value');
  if (!el) return;
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 700);
}

/* ---- photos ---- */

function photosCard() {
  if (!data.photos.length) return null;
  const before = data.photos.filter((p) => p.kind === 'before');
  const after = data.photos.filter((p) => p.kind === 'after');

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: 'How it went' })),
    before.length && after.length
      ? h('div', { class: 'before-after' },
          h('div', { class: 'ba-col' },
            h('div', { class: 'ba-label', text: 'Before' }),
            ...before.map((p) => h('img', { src: p.url, alt: p.caption || 'Before', loading: 'lazy' }))
          ),
          h('div', { class: 'ba-col' },
            h('div', { class: 'ba-label', text: 'After' }),
            ...after.map((p) => h('img', { src: p.url, alt: p.caption || 'After', loading: 'lazy' }))
          )
        )
      : h('div', { class: 'before-after' }, ...data.photos.map((p) =>
          h('div', { class: 'ba-col' },
            h('div', { class: 'ba-label', text: p.kind }),
            h('img', { src: p.url, alt: p.caption || p.kind, loading: 'lazy' })
          )
        ))
  );
}

/* ---- invoice, tip and paying ---- */

function invoiceCard() {
  const inv = data.invoice;
  if (!inv) return null;
  const settled = inv.balance_cents <= 0;

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: settled ? 'Paid in full' : 'Your invoice' }),
      h('span', { class: `pill${settled ? ' pill--good' : ''}`, text: inv.number })
    ),

    ...inv.items.map((item) => moneyLine(item.label, money(item.amount_cents))),
    inv.discount_cents ? moneyLine('Discount', `−${money(inv.discount_cents)}`) : null,
    inv.tax_cents ? moneyLine('Tax', money(inv.tax_cents)) : null,
    inv.tip_cents ? moneyLine('Tip', money(inv.tip_cents)) : null,
    moneyLine('Total', money(inv.total_cents), { total: true }),
    inv.paid_cents ? moneyLine('Paid', `−${money(inv.paid_cents)}`) : null,

    settled
      ? h('p', { class: 'small muted', style: { marginTop: '12px' }, text: 'Nothing owing. Thanks very much.' })
      : h('div', {},
          inv.can_tip ? tipSection(inv) : null,
          data.business.payment_instructions
            ? h('p', { class: 'small muted', style: { marginTop: '14px' }, text: data.business.payment_instructions })
            : null,
          h('button', {
            class: 'btn btn--block', style: { marginTop: '12px' }, text: "Let them know how I'm paying",
            onClick: () => payingSheet(),
          })
        )
  );
}

function tipSection(inv) {
  const base = inv.subtotal_cents - inv.discount_cents;
  const presets = inv.tip_presets || [];

  const row = h('div', { class: 'tip-row' });
  const paint = () => mount(row,
    ...presets.map((pct) => {
      const cents = Math.round((base * pct) / 100);
      return h('button', {
        class: `tip-btn${inv.tip_cents === cents && cents > 0 ? ' on' : ''}`,
        onClick: () => saveTip(cents),
      },
        h('span', { class: 'tip-pct', text: `${pct}%` }),
        h('span', { class: 'tip-amt', text: money(cents) })
      );
    }),
    h('button', {
      class: `tip-btn${inv.tip_cents > 0 && !presets.some((p) => Math.round((base * p) / 100) === inv.tip_cents) ? ' on' : ''}`,
      onClick: () => customTipSheet(inv),
    },
      h('span', { class: 'tip-pct', text: inv.tip_cents > 0 ? money(inv.tip_cents) : 'Other' }),
      h('span', { class: 'tip-amt', text: inv.tip_cents > 0 ? 'change' : 'or none' })
    )
  );
  paint();

  return h('div', { style: { marginTop: '18px' } },
    h('div', { class: 'field-label', text: 'Add a tip?' }),
    row,
    h('p', { class: 'no-pressure', style: { marginTop: '10px' },
      text: inv.tip_cents > 0 ? 'Thank you — genuinely.' : 'Completely optional, and never assumed.' })
  );
}

async function saveTip(cents) {
  try {
    data = await api.post(`/api/portal/${encodeURIComponent(TOKEN)}/tip`, { tip_cents: cents });
    render();
    bumpTotal();
  } catch (err) { toast(err.message, { bad: true }); }
}

function customTipSheet(inv) {
  return sheet({
    title: 'Tip amount',
    subtitle: 'Anything you like, including nothing at all.',
    build: ({ close }) => {
      const input = moneyInput(inv.tip_cents);
      return h('div', {},
        field('Amount', input),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'No tip', onClick: () => { close(); saveTip(0); } }),
          h('button', { class: 'btn btn--gold', text: 'Add it', onClick: () => { close(); saveTip(input.getCents()); } })
        )
      );
    },
  });
}

const METHODS = [
  ['cash', 'Cash'], ['card', 'Card'], ['zelle', 'Zelle'], ['venmo', 'Venmo'],
  ['cashapp', 'Cash App'], ['apple_pay', 'Apple Pay'], ['check', 'Check'], ['other', 'Something else'],
];

function payingSheet() {
  return sheet({
    title: "How you're paying",
    subtitle: 'This just gives them a heads-up. Nothing is charged here and no card details are ever asked for.',
    build: ({ close }) => h('div', { class: 'chip-row' }, ...METHODS.map(([key, label]) =>
      h('button', {
        class: 'chip', text: label,
        onClick: async () => {
          try {
            await api.post(`/api/portal/${encodeURIComponent(TOKEN)}/paying`, { method: key });
            close(true);
            toast('Thanks — they know.');
          } catch (err) { toast(err.message, { bad: true }); }
        },
      })
    )),
  });
}

/* ---- review ---- */

function reviewCard() {
  if (data.appointment.status !== 'completed') return null;
  const existing = data.review;

  let chosen = existing?.rating ?? 0;
  const stars = h('div', { class: 'stars' });
  const comment = h('textarea', {
    placeholder: 'Anything you want to add? (optional)', maxlength: 1500,
    value: existing?.comment ?? '',
  });
  const submit = h('button', {
    class: 'btn btn--primary btn--block', style: { marginTop: '14px' },
    text: existing ? 'Update it' : 'Send it',
    disabled: !chosen,
    onClick: async () => {
      submit.disabled = true;
      try {
        data = await api.post(`/api/portal/${encodeURIComponent(TOKEN)}/review`, {
          rating: chosen, comment: comment.value,
        });
        render();
        toast('Thank you.');
      } catch (err) { submit.disabled = false; toast(err.message, { bad: true }); }
    },
  });

  const paintStars = () => mount(stars, ...[1, 2, 3, 4, 5].map((n) =>
    h('button', {
      class: n <= chosen ? 'lit' : '', text: '★',
      'aria-label': `${n} star${n > 1 ? 's' : ''}`,
      onClick: () => { chosen = n; paintStars(); submit.disabled = false; },
    })
  ));
  paintStars();

  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: existing ? 'Your review' : 'How did we do?' })),
    h('p', { class: 'small muted', text: data.business.review_prompt }),
    stars,
    h('div', { class: 'field' }, comment),
    submit
  );
}

load();
