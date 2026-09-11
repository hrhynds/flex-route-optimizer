import {
  h, mount, api, ApiError, money, price, toast, sheet, confirmSheet,
  field, switchRow, moneyLine, empty, moneyInput, localInputToMs, msToLocalInput,
  fmtTime, fmtDate, fmtDay, fmtCountdown, fmtRelative, fmtDistance, timeParts, fmtDuration,
  initials, setTimezone, parseCoordinates,
} from '../shared/ui.js';

const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');

const state = {
  boot: null,
  settings: {},
  catalog: null,
  statuses: {},
  timers: [],
  cleanups: [],
};

/* ==========================================================================
   Boot and the sign-in gate
   ========================================================================== */

async function boot() {
  try {
    state.boot = await api.get('/api/admin/bootstrap');
  } catch {
    mount(app, h('div', { class: 'gate' },
      h('h1', { text: 'Cannot reach the server' }),
      h('p', { class: 'gate-sub', text: 'Check the connection and reload.' })
    ));
    return;
  }

  if (state.boot.needs_setup) { renderSetup(); return; }
  if (!state.boot.signed_in) { renderLogin(); return; }
  await startApp();
}

function gateShell(...children) {
  tabbar.hidden = true;
  mount(app, h('div', { class: 'gate' },
    h('div', { class: 'gate-mark', text: 'GA' }),
    ...children
  ));
}

function renderLogin(message) {
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true, placeholder: 'you@example.com' });
  const pass = h('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true, placeholder: 'Your password' });
  const submit = h('button', { class: 'btn btn--primary btn--block btn--big', type: 'submit', text: 'Sign in' });
  const errorBox = h('div', { class: 'gate-error', hidden: !message, text: message || '' });

  const form = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      errorBox.hidden = true;
      try {
        await api.post('/api/admin/login', { email: email.value, password: pass.value });
        state.boot = await api.get('/api/admin/bootstrap');
        await startApp();
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        pass.value = '';
        submit.disabled = false;
      }
    },
  },
    field('Email', email),
    field('Password', pass),
    errorBox,
    h('div', { style: { marginTop: '18px' } }, submit)
  );

  gateShell(
    h('h1', { text: state.boot?.business_name || 'Graceful Auto Detailing' }),
    h('p', { class: 'gate-sub', text: 'Owner sign in' }),
    form,
    h('p', { class: 'gate-note', text: 'This page is for the business owner. Customers never sign in — they open the private link they were texted.' })
  );
}

function renderSetup() {
  const code = h('input', { type: 'text', id: 'code', autocapitalize: 'characters', required: true, placeholder: 'From the server log' });
  const name = h('input', { type: 'text', id: 'name', autocomplete: 'name', placeholder: 'Your name' });
  const business = h('input', { type: 'text', id: 'business', value: 'Graceful Auto Detailing' });
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true });
  const pass = h('input', { type: 'password', id: 'password', autocomplete: 'new-password', required: true, minlength: 12 });
  const submit = h('button', { class: 'btn btn--primary btn--block btn--big', type: 'submit', text: 'Create the owner account' });
  const errorBox = h('div', { class: 'gate-error', hidden: true });

  const form = h('form', {
    onSubmit: async (e) => {
      e.preventDefault();
      submit.disabled = true;
      errorBox.hidden = true;
      try {
        await api.post('/api/admin/setup', {
          code: code.value, name: name.value, business_name: business.value,
          email: email.value, password: pass.value,
        });
        state.boot = await api.get('/api/admin/bootstrap');
        await startApp();
        toast('Welcome. This is your dashboard.');
      } catch (err) {
        errorBox.textContent = err.message;
        errorBox.hidden = false;
        submit.disabled = false;
      }
    },
  },
    field('Setup code', code, 'Printed in the server log when it started up.'),
    field('Business name', business),
    field('Your name', name),
    field('Email', email, 'This is what you will sign in with.'),
    field('Password', pass, 'At least 12 characters. A short sentence works well.'),
    h('div', { style: { marginTop: '18px' } }, submit)
  );

  gateShell(
    h('h1', { text: 'Set up your dashboard' }),
    h('p', { class: 'gate-sub', text: 'This happens once. Only you get an account.' }),
    form,
    errorBox
  );
}

/* ==========================================================================
   The app itself
   ========================================================================== */

const TABS = [
  { id: 'today', label: 'Today', icon: '☀️' },
  { id: 'schedule', label: 'Schedule', icon: '🗓️' },
  { id: 'customers', label: 'Customers', icon: '👤' },
  { id: 'money', label: 'Money', icon: '💵' },
  { id: 'setup', label: 'Setup', icon: '⚙️' },
];

async function startApp() {
  const settings = await api.get('/api/admin/settings');
  state.settings = settings.settings;
  state.publicBaseUrl = settings.public_base_url;
  state.smsProvider = settings.sms_provider;
  state.trackingMaxMinutes = settings.tracking_max_minutes;
  setTimezone(state.settings.timezone);

  renderTabbar();
  window.addEventListener('hashchange', route);
  tracker.resume();
  route();
}

function renderTabbar(badges = {}) {
  tabbar.hidden = false;
  mount(tabbar, ...TABS.map((tab) =>
    h('a', {
      class: 'tab',
      href: `#/${tab.id}`,
      'aria-current': currentRoute().view === tab.id ? 'page' : null,
    },
      h('span', { class: 'ti', text: tab.icon }),
      badges[tab.id] ? h('span', { class: 'badge', text: String(badges[tab.id]) }) : null,
      tab.label
    )
  ));
}

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [view, ...rest] = raw.split('/');
  return { view: view || 'today', args: rest };
}

/* Leaving a view tears down anything it left running: intervals, and any
   listener it registered on the tracker. */
function clearTimers() {
  for (const t of state.timers) clearInterval(t);
  state.timers = [];
  for (const fn of state.cleanups) { try { fn(); } catch { /* already gone */ } }
  state.cleanups = [];
}

function every(ms, fn) {
  const id = setInterval(fn, ms);
  state.timers.push(id);
  return id;
}

const VIEWS = {
  today: renderToday,
  schedule: renderSchedule,
  customers: renderCustomers,
  customer: renderCustomerDetail,
  appointment: renderAppointment,
  money: renderMoney,
  invoice: renderInvoiceDetail,
  messages: renderMessages,
  setup: renderSetupHome,
  services: renderCatalogView,
  addons: renderCatalogView,
  templates: renderTemplates,
  business: renderBusinessSettings,
  reviews: renderReviews,
  activity: renderActivity,
};

async function route() {
  clearTimers();
  const { view, args } = currentRoute();
  renderTabbar();
  window.scrollTo(0, 0);

  const render = VIEWS[view];
  if (!render) { location.hash = '#/today'; return; }

  mount(app, h('div', { class: 'boot-splash' }, h('div', { class: 'spinner' })));
  try {
    await render(...args);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) { state.boot.signed_in = false; renderLogin('Your session ended. Sign in again.'); return; }
    mount(app,
      header('Something went wrong'),
      h('div', { class: 'card' },
        h('p', { class: 'muted', text: err.message }),
        h('div', { style: { marginTop: '14px' } },
          h('button', { class: 'btn', text: 'Try again', onClick: route })
        )
      )
    );
  }
}

function header(title, subtitle, ...actions) {
  return h('div', { class: 'appbar' },
    h('div', { class: 'brandmark', text: 'GA' }),
    h('div', { class: 'grow' },
      h('h1', { text: title }),
      subtitle ? h('div', { class: 'sub', text: subtitle }) : null
    ),
    ...actions
  );
}

function backHeader(title, href, ...actions) {
  return h('div', { class: 'appbar' },
    h('a', { class: 'icon-btn', href, 'aria-label': 'Back', text: '‹' }),
    h('div', { class: 'grow' }, h('h1', { text: title })),
    ...actions
  );
}

/* ==========================================================================
   Location sharing

   This is the only code in the app that touches the owner's position, and it
   only runs between pressing "I'm on my way" and arriving. There is no
   background mode, no start-on-load, and no way for a customer to switch it
   on. Ending a trip clears the watch and the server erases what it held.
   ========================================================================== */

const TRACK_KEY = 'gad.trip';

const tracker = {
  watchId: null,
  appointmentId: null,
  lastSentAt: 0,
  listeners: new Set(),

  get active() { return this.appointmentId !== null; },

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  announce() { for (const fn of this.listeners) fn(); },

  /* A single reading, used to seed the trip so the customer's map is never
     blank on first open. Rejects rather than silently continuing without it. */
  firstFix({ timeout = 12000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('This browser cannot share a location.'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos),
        (err) => reject(translateGeoError(err)),
        { enableHighAccuracy: true, timeout, maximumAge: 15000 }
      );
    });
  },

  async start(appointmentId, { minutes, sendText, position }) {
    const payload = { minutes, send_text: sendText };
    if (position) {
      payload.lat = position.coords.latitude;
      payload.lng = position.coords.longitude;
      payload.accuracy_m = Math.round(position.coords.accuracy ?? 0) || null;
      payload.speed_mps = Number.isFinite(position.coords.speed) ? position.coords.speed : null;
    }
    const result = await api.post(`/api/admin/appointments/${appointmentId}/on-my-way`, payload);
    this.attach(appointmentId, result.trip.expires_at);
    return result;
  },

  attach(appointmentId, expiresAt) {
    this.appointmentId = appointmentId;
    this.expiresAt = expiresAt;
    try { localStorage.setItem(TRACK_KEY, JSON.stringify({ appointmentId, expiresAt })); } catch { /* private mode */ }
    this.watch();
    this.announce();
  },

  watch() {
    if (this.watchId !== null || !('geolocation' in navigator)) return;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.push(pos),
      (err) => {
        /* A denied permission mid-trip is worth saying out loud — the customer
           is watching a map that has stopped moving. */
        toast(translateGeoError(err).message, { bad: true });
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
    );
  },

  async push(pos) {
    if (!this.appointmentId) return;
    const now = Date.now();
    /* One update every twelve seconds is plenty for an ETA and is kind to the
       battery; a browser can fire watchPosition far more often than that. */
    if (now - this.lastSentAt < 12000) return;
    this.lastSentAt = now;
    try {
      const res = await api.post(`/api/admin/appointments/${this.appointmentId}/ping`, {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy_m: Math.round(pos.coords.accuracy ?? 0) || null,
        speed_mps: Number.isFinite(pos.coords.speed) ? pos.coords.speed : null,
        heading: Number.isFinite(pos.coords.heading) ? pos.coords.heading : null,
      });
      this.expiresAt = res.expires_at;
      this.lastState = res;
      this.announce();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) this.detach();
    }
  },

  async stop() {
    const id = this.appointmentId;
    this.detach();
    if (id) await api.post(`/api/admin/appointments/${id}/stop-tracking`, {});
  },

  detach() {
    if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    this.appointmentId = null;
    this.expiresAt = null;
    this.lastState = null;
    this.lastSentAt = 0;
    try { localStorage.removeItem(TRACK_KEY); } catch { /* private mode */ }
    this.announce();
  },

  /* Picks a trip back up after a reload, but only if the server still says one
     is running — the stored id alone is never enough. */
  async resume() {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem(TRACK_KEY) || 'null'); } catch { stored = null; }
    if (!stored?.appointmentId) return;
    try {
      const { trip } = await api.get(`/api/admin/appointments/${stored.appointmentId}/trip`);
      if (trip) this.attach(stored.appointmentId, trip.expires_at);
      else this.detach();
    } catch { this.detach(); }
  },
};

function translateGeoError(err) {
  const code = err?.code;
  if (code === 1) {
    return new Error(
      window.isSecureContext
        ? 'Location permission was refused. Allow it in your browser settings to share your arrival.'
        : 'Location needs a secure connection. Open this dashboard over https.'
    );
  }
  if (code === 2) return new Error('Your location is not available right now. Check that GPS is on.');
  if (code === 3) return new Error('Getting a location took too long. Try again in a moment.');
  return new Error('Could not read your location.');
}

/* ==========================================================================
   Today
   ========================================================================== */

async function renderToday() {
  const data = await api.get('/api/admin/dashboard');
  state.settings.timezone = data.settings.timezone;
  setTimezone(data.settings.timezone);

  const liveSlot = h('div');
  const body = h('div', {},
    liveSlot,

    h('div', { class: 'stat-grid' },
      stat(String(data.stats.today_count), data.stats.today_count === 1 ? 'job today' : 'jobs today'),
      stat(money(data.stats.week_collected_cents), 'taken this week', 'accent'),
      stat(money(data.stats.outstanding_cents), 'still owed', data.stats.outstanding_cents > 0 ? 'gold' : ''),
      stat(money(data.stats.week_tips_cents), 'in tips', 'gold')
    ),

    data.stats.unsent_messages > 0
      ? h('a', { class: 'card card--accent spread', href: '#/messages', style: { display: 'flex' } },
          h('div', {},
            h('div', { style: { fontWeight: '650' }, text: `${data.stats.unsent_messages} ${data.stats.unsent_messages === 1 ? 'text is' : 'texts are'} ready to send` }),
            h('div', { class: 'small muted', text: 'No SMS provider is connected, so these are waiting for you.' })
          ),
          h('span', { class: 'chev', text: '›' })
        )
      : null,

    h('div', { class: 'section-title', text: 'Today' }),
    data.today.length
      ? h('div', {}, ...data.today.map(jobCard))
      : h('div', { class: 'card' }, empty('🌤️', 'Nothing booked today.',
          h('a', { class: 'btn btn--primary', href: '#/schedule', text: 'Book a job' })))
  );

  if (data.upcoming.length) {
    body.append(
      h('div', { class: 'section-title', text: 'Coming up' }),
      ...data.upcoming.map((job) => jobCard(job, { showDay: true }))
    );
  }

  mount(app, header(state.settings.business_name || 'Graceful Auto Detailing', todayLabel()), body);
  renderTabbar({ messages: data.stats.unsent_messages });

  const paintLive = () => mount(liveSlot, liveBanner(data));
  paintLive();
  every(1000, paintLive);
  state.cleanups.push(tracker.onChange(paintLive));
}

function todayLabel() {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: state.settings.timezone,
  }).format(new Date());
}

function stat(value, label, tone = '') {
  return h('div', { class: `stat${tone ? ` stat--${tone}` : ''}` },
    h('div', { class: 'stat-value', text: value }),
    h('div', { class: 'stat-label', text: label })
  );
}

function liveBanner() {
  if (!tracker.active) return null;
  const secondsLeft = Math.max(0, Math.round((tracker.expiresAt - Date.now()) / 1000));
  if (secondsLeft <= 0) { tracker.detach(); return null; }

  const total = (state.settings.tracking_minutes || 60) * 60;
  const pct = Math.max(0, Math.min(100, (secondsLeft / total) * 100));
  const st = tracker.lastState;

  return h('div', { class: 'live-banner' },
    h('div', { class: 'live-top' },
      h('span', { class: 'dot-live' }),
      h('span', { class: 'live-title', text: 'Sharing your location' }),
      h('span', { class: 'live-clock', text: fmtCountdown(secondsLeft) })
    ),
    h('div', { class: 'live-meta', text: st?.distance_m != null
      ? `${fmtDistance(st.distance_m)} away · about ${st.eta_minutes} min out`
      : 'Waiting for your first position fix…' }),
    h('div', { class: 'live-bar' }, h('span', { style: { width: `${pct}%` } })),
    h('div', { class: 'btn-row' },
      h('a', { class: 'btn btn--sm', href: `#/appointment/${tracker.appointmentId}`, text: 'Open job' }),
      h('button', {
        class: 'btn btn--sm btn--danger', text: 'Stop sharing',
        onClick: async () => {
          await tracker.stop();
          toast('Location sharing stopped. The link is dead.');
          route();
        },
      })
    )
  );
}

function jobCard(job, { showDay = false } = {}) {
  const { hour, minute, period } = timeParts(job.starts_at);

  return h('a', { class: `job${job.trip_live ? ' job--live' : ''}`, href: `#/appointment/${job.id}` },
    h('div', { class: 'job-time' },
      h('div', { class: 'job-hour', text: minute === '00' ? hour : `${hour}:${minute}` }),
      h('div', { class: 'job-ampm', text: period }),
      h('div', { class: 'job-dur', text: fmtDuration(job.duration_min) })
    ),
    h('div', { class: 'job-body' },
      h('div', { class: 'job-name', text: job.customer_name }),
      h('div', { class: 'job-service', text: job.service_name }),
      job.vehicle_label ? h('div', { class: 'job-vehicle', text: job.vehicle_label }) : null,
      h('div', { class: 'job-foot' },
        statusPill(job),
        showDay ? h('span', { class: 'pill', text: fmtDay(job.starts_at) }) : null,
        job.addon_count ? h('span', { class: 'pill', text: `+${job.addon_count} extra${job.addon_count > 1 ? 's' : ''}` }) : null,
        h('span', { class: 'job-total', text: money(job.total_cents) })
      )
    )
  );
}

function statusPill(job) {
  const tone = job.status_tone === 'live' ? 'live' : job.status_tone === 'good' ? 'good' : job.status_tone === 'bad' ? 'bad' : '';
  return h('span', { class: `pill${tone ? ` pill--${tone}` : ''}` },
    tone === 'live' ? h('span', { class: 'dot' }) : null,
    job.status_label
  );
}

/* ==========================================================================
   One appointment, everything about it
   ========================================================================== */

async function renderAppointment(idRaw) {
  const id = Number(idRaw);
  const data = await api.get(`/api/admin/appointments/${id}`);
  const a = data.appointment;
  const reload = () => renderAppointment(idRaw);

  const liveSlot = h('div');

  mount(app,
    backHeader(a.customer.name, '#/today',
      h('button', { class: 'icon-btn', 'aria-label': 'More', text: '⋯', onClick: () => appointmentMenu(a, reload) })
    ),

    h('div', { class: 'detail-head' },
      h('div', { class: 'detail-service', text: a.service.name }),
      h('div', { class: 'detail-when', text: `${fmtDay(a.starts_at)} at ${fmtTime(a.starts_at)} · ${fmtDuration(a.duration_min)}` }),
      h('div', { class: 'detail-pills' },
        statusPill(a),
        a.vehicle ? h('span', { class: 'pill', text: vehicleLabel(a.vehicle) }) : null,
        a.totals.addons.length ? h('span', { class: 'pill', text: `${a.totals.addons.length} extra${a.totals.addons.length > 1 ? 's' : ''}` }) : null
      )
    ),

    liveSlot,

    onMyWayCard(a, reload),
    destinationCard(a, reload),
    statusCard(a, reload),
    contactCard(a),
    addonsCard(a, data.available_addons, reload),
    photosCard(a, data.photos, reload),
    invoiceCard(a, data.invoice, reload),
    messagesCard(a, data.messages, data.portal_link, reload),
    a.notes ? h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Your notes' }), h('span', { class: 'hint', text: 'Never shown to the customer' })),
      h('p', { class: 'small', style: { whiteSpace: 'pre-wrap' }, text: a.notes })
    ) : null
  );

  const paint = () => mount(liveSlot, tracker.active && tracker.appointmentId === id ? liveBanner() : null);
  paint();
  every(1000, paint);
  state.cleanups.push(tracker.onChange(paint));
}

function vehicleLabel(v) {
  return [v.year, v.color, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle';
}

/* ---- the button this whole feature is named after ---- */

function onMyWayCard(a, reload) {
  const isLive = tracker.active && tracker.appointmentId === a.id;
  const closed = ['completed', 'cancelled', 'no_show'].includes(a.status);
  if (closed) return null;

  if (isLive) {
    return h('div', { class: 'card card--accent' },
      h('div', { class: 'card-head' },
        h('h2', { text: 'Your customer is watching you arrive' }),
        h('span', { class: 'hint', text: 'Live' })
      ),
      h('p', { class: 'small muted', text: 'They see a map, a distance and an ETA. Nothing about where you are is kept once this ends.' }),
      h('div', { class: 'btn-row', style: { marginTop: '14px' } },
        h('button', {
          class: 'btn btn--primary', text: "I've arrived",
          onClick: async () => {
            /* Arriving is the one moment the owner is standing at the address.
               If it has no pin, offer to keep this spot — explicitly, once —
               so every future job here gets a real ETA. Nothing is saved
               unless they say yes, and the trip is purged either way. */
            if (a.lat == null) await offerToKeepPin(a);
            await tracker.stop();
            await api.post(`/api/admin/appointments/${a.id}/status`, { status: 'arrived', notify: true });
            toast('Marked as arrived. Sharing stopped.');
            reload();
          },
        }),
        h('button', {
          class: 'btn btn--danger', text: 'Stop sharing',
          onClick: async () => { await tracker.stop(); toast('Location sharing stopped.'); reload(); },
        })
      )
    );
  }

  return h('div', { class: 'card card--accent' },
    h('div', { class: 'card-head' },
      h('h2', { text: 'Heading over?' }),
      h('span', { class: 'hint', text: `${state.settings.tracking_minutes || 60} min link` })
    ),
    h('p', { class: 'small muted', text: 'Sends a text with a live tracking link. Your location is shared from the moment you press it until you arrive or the link expires — and at no other time.' }),
    a.lat == null
      ? h('p', { class: 'small', style: { marginTop: '10px', color: 'var(--warn)' },
          text: 'No pin on this address yet, so they will see you moving but no ETA. Drop one below and the countdown works.' })
      : null,
    h('button', {
      class: 'btn btn--primary btn--block btn--big', style: { marginTop: '14px' },
      text: "I'm on my way",
      onClick: (e) => startTrip(a, e.currentTarget, reload),
    })
  );
}

async function startTrip(a, button, reload) {
  if (!a.customer.phone) {
    toast('Add a phone number for this customer first.', { bad: true });
    return;
  }
  const label = button.textContent;
  button.disabled = true;
  mount(button, h('span', { class: 'spinner' }), ' Finding you…');

  let position = null;
  try {
    position = await tracker.firstFix();
  } catch (err) {
    button.disabled = false;
    button.textContent = label;
    const goAnyway = await confirmSheet({
      title: 'Share without a map?',
      subtitle: `${err.message} You can still text them that you are on the way — they just will not see a live map.`,
      confirmLabel: 'Text without tracking',
    });
    if (!goAnyway) return;
  }

  button.disabled = true;
  mount(button, h('span', { class: 'spinner' }), ' Sending…');

  const minutes = Number(state.settings.tracking_minutes) || 60;
  try {
    const result = await tracker.start(a.id, { minutes, sendText: true, position });
    if (result.message?.status === 'outbox') {
      await outboxSheet(result.message);
    } else {
      toast(`Texted ${a.customer.name.split(' ')[0]}. Tracking is live for ${minutes} minutes.`);
    }
    reload();
  } catch (err) {
    button.disabled = false;
    button.textContent = label;
    toast(err.message, { bad: true });
  }
}

/* When no SMS provider is wired up, nothing pretends the text went out. The
   owner gets the exact words and a one-tap handoff to their own messages app. */
function outboxSheet(message) {
  return sheet({
    title: 'Ready to send',
    subtitle: 'No texting service is connected yet, so send this from your own phone. It is saved either way.',
    build: ({ close }) => h('div', {},
      h('div', { class: 'preview-box', text: message.body }),
      h('div', { class: 'sheet-actions' },
        h('button', {
          class: 'btn btn--ghost', text: 'Copy',
          onClick: async () => {
            try { await navigator.clipboard.writeText(message.body); toast('Copied.'); }
            catch { toast('Select the text above to copy it.', { bad: true }); }
          },
        }),
        h('a', {
          class: 'btn btn--primary',
          href: `sms:${encodeURIComponent(message.to)}?&body=${encodeURIComponent(message.body)}`,
          text: 'Open Messages',
          onClick: () => setTimeout(close, 300),
        })
      ),
      h('button', { class: 'btn btn--quiet btn--block', style: { marginTop: '10px' }, text: 'Done', onClick: () => close(true) })
    ),
  });
}

/* ---- where you are going ---- */

function destinationCard(a, reload) {
  const closed = ['completed', 'cancelled', 'no_show'].includes(a.status);
  if (closed) return null;

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: 'Where to' }),
      a.lat != null
        ? h('span', { class: 'pill pill--good', text: 'pin set' })
        : h('span', { class: 'pill', text: 'no pin' })
    ),
    h('p', { class: 'small muted', text: a.lat != null
      ? 'Your customer sees the distance and a countdown while you are on your way.'
      : 'An address alone cannot give an ETA — the app needs a point on the map. Drop one and the tracking link gets a real countdown.' }),

    h('div', { class: 'btn-row', style: { marginTop: '14px' } },
      h('button', {
        class: `btn btn--sm${a.lat == null ? ' btn--primary' : ''}`,
        text: 'Use where I am now',
        onClick: async (e) => {
          const button = e.currentTarget;
          button.disabled = true;
          const original = button.textContent;
          mount(button, h('span', { class: 'spinner' }), ' Finding…');
          try {
            const pos = await tracker.firstFix();
            await savePin(a.id, pos.coords.latitude, pos.coords.longitude);
            toast('Pin dropped here.');
            reload();
          } catch (err) {
            button.disabled = false;
            button.textContent = original;
            toast(err.message, { bad: true });
          }
        },
      }),
      h('button', { class: 'btn btn--sm btn--ghost', text: 'Paste a map link', onClick: () => pinSheet(a, reload) }),
      a.lat != null ? h('a', {
        class: 'btn btn--sm btn--ghost',
        href: `https://maps.google.com/?q=${a.lat},${a.lng}`,
        target: '_blank', rel: 'noopener noreferrer',
        text: 'Check it',
      }) : null
    )
  );
}

async function savePin(appointmentId, lat, lng) {
  await api.patch(`/api/admin/appointments/${appointmentId}`, {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
  });
}

function pinSheet(a, reload) {
  return sheet({
    title: 'Drop a pin',
    subtitle: 'Open the address in Maps, copy the link, and paste it here. A plain "latitude, longitude" pair works too.',
    build: ({ close }) => {
      const input = h('textarea', { placeholder: 'https://maps.google.com/…  or  42.7981, -83.7049', rows: 3 });
      const status = h('p', { class: 'help' });
      input.addEventListener('input', () => {
        const parsed = parseCoordinates(input.value);
        status.textContent = parsed
          ? `Reads as ${parsed.lat.toFixed(5)}, ${parsed.lng.toFixed(5)}`
          : input.value.trim() ? 'No coordinates in that yet.' : '';
      });

      return h('div', {},
        h('div', { class: 'field' }, h('div', { class: 'field-label', text: 'Map link or coordinates' }), input, status),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Drop it',
            onClick: async () => {
              const parsed = parseCoordinates(input.value);
              if (!parsed) { toast('Could not find coordinates in that.', { bad: true }); return; }
              try {
                await savePin(a.id, parsed.lat, parsed.lng);
                close(true);
                toast('Pin dropped.');
                reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

async function offerToKeepPin(a) {
  let position = null;
  try { position = await tracker.firstFix({ timeout: 6000 }); } catch { return; }
  const keep = await confirmSheet({
    title: 'Remember this spot?',
    subtitle: `Saving where you are now as the pin for ${a.address || 'this address'} means the next job here shows a real ETA. Your position is not kept for anything else.`,
    confirmLabel: 'Save the pin',
  });
  if (!keep) return;
  try { await savePin(a.id, position.coords.latitude, position.coords.longitude); }
  catch { /* the arrival itself still goes through */ }
}

/* ---- status ---- */

const STATUS_FLOW = {
  scheduled: ['confirmed', 'in_progress', 'cancelled', 'no_show'],
  confirmed: ['in_progress', 'cancelled', 'no_show'],
  on_my_way: ['arrived', 'in_progress', 'cancelled'],
  arrived: ['in_progress', 'completed', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: ['scheduled'],
  no_show: ['scheduled'],
};

const STATUS_LABELS = {
  scheduled: 'Scheduled', confirmed: 'Confirmed', on_my_way: 'On my way', arrived: 'Arrived',
  in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No show',
};

function statusCard(a, reload) {
  const options = STATUS_FLOW[a.status] || [];
  if (!options.length) return null;
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: 'Move it along' })),
    h('div', { class: 'status-picker' }, ...options.map((next) =>
      h('button', {
        class: 'chip', text: STATUS_LABELS[next],
        onClick: async () => {
          const notify = next === 'completed' || next === 'arrived';
          try {
            const res = await api.post(`/api/admin/appointments/${a.id}/status`, { status: next, notify });
            if (res.message?.status === 'outbox') await outboxSheet(res.message);
            else toast(`Now ${STATUS_LABELS[next].toLowerCase()}.`);
            if (next === 'completed' || next === 'cancelled') tracker.detach();
            reload();
          } catch (err) { toast(err.message, { bad: true }); }
        },
      })
    ))
  );
}

/* ---- contact ---- */

function contactCard(a) {
  return h('div', { class: 'card card--flush' },
    h('div', { class: 'row' },
      h('div', { class: 'avatar', text: initials(a.customer.name) }),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title', text: a.customer.name }),
        h('div', { class: 'row-sub', text: a.address || a.customer.phone || 'No address on file' })
      )
    ),
    h('div', { class: 'row', style: { gap: '8px' } },
      a.customer.phone ? h('a', { class: 'btn btn--sm', href: `tel:${a.customer.phone}`, text: '📞 Call' }) : null,
      a.customer.phone ? h('a', { class: 'btn btn--sm', href: `sms:${a.customer.phone}`, text: '💬 Text' }) : null,
      a.address ? h('a', {
        class: 'btn btn--sm',
        href: `https://maps.google.com/?q=${encodeURIComponent(a.address)}`,
        target: '_blank', rel: 'noopener noreferrer',
        text: '🧭 Directions',
      }) : null,
      h('a', { class: 'btn btn--sm btn--ghost', href: `#/customer/${a.customer.id}`, text: 'Profile' })
    )
  );
}

/* ---- add-ons ---- */

function addonsCard(a, available, reload) {
  const lines = a.totals.addons;
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: 'The job' }),
      a.totals.is_estimate ? h('span', { class: 'hint', text: 'Includes a "from" price' }) : null
    ),

    h('div', { class: 'addon-row' },
      h('div', { class: 'addon-main' }, h('div', { class: 'addon-name', text: a.service.name })),
      h('div', { class: 'addon-price', text: money(a.service.price_cents) })
    ),

    ...lines.map((line) => h('div', { class: 'addon-row' },
      h('div', { class: 'addon-main' },
        h('div', { class: 'addon-name', text: line.name }),
        line.source === 'customer' ? h('div', { class: 'addon-by', text: 'Added by the customer' }) : null
      ),
      h('div', { class: 'addon-price' },
        line.price_is_from ? h('span', { class: 'faint small', text: 'from ' }) : null,
        money(line.price_cents)
      ),
      a.addons_locked ? null : h('button', {
        class: 'btn btn--quiet', text: '✕', 'aria-label': `Remove ${line.name}`,
        onClick: async () => {
          await api.del(`/api/admin/appointments/${a.id}/addons/${line.id}`);
          reload();
        },
      })
    )),

    moneyLine('Subtotal', money(a.totals.subtotal_cents)),
    a.totals.tax_cents ? moneyLine('Tax', money(a.totals.tax_cents)) : null,
    a.totals.tip_cents ? moneyLine('Tip', money(a.totals.tip_cents)) : null,
    moneyLine('Total', money(a.totals.total_cents), { total: true }),

    a.addons_locked
      ? h('p', { class: 'small faint', style: { marginTop: '10px' }, text: 'This job is closed to changes.' })
      : h('button', {
          class: 'btn btn--ghost btn--block', style: { marginTop: '14px' }, text: '+ Add an extra',
          onClick: () => pickAddon(a, available, reload),
        })
  );
}

function pickAddon(a, available, reload) {
  const taken = new Set(a.totals.addons.map((l) => l.addon_id));
  const offer = available.filter((x) => !taken.has(x.id));
  if (!offer.length) { toast('Every extra is already on this job.'); return; }

  return sheet({
    title: 'Add an extra',
    subtitle: 'The price and wording are copied onto this job now, so changing the price list later will not alter it.',
    build: ({ close }) => h('div', { class: 'stack' }, ...offer.map((addon) =>
      h('button', {
        class: 'row', style: { borderRadius: '12px', border: '1px solid var(--line)', padding: '13px 14px' },
        onClick: async () => {
          try {
            await api.post(`/api/admin/appointments/${a.id}/addons`, { addon_id: addon.id });
            close(true);
            reload();
          } catch (err) { toast(err.message, { bad: true }); }
        },
      },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: addon.name }),
          addon.description ? h('div', { class: 'row-sub', text: addon.description }) : null
        ),
        h('div', { class: 'row-end' },
          h('div', { class: 'row-amount' },
            addon.price_is_from ? h('span', { class: 'faint small', text: 'from ' }) : null,
            price(addon.price_cents))
        )
      )
    )),
  });
}

/* ---- photos ---- */

function photosCard(a, photos, reload) {
  const before = photos.filter((p) => p.kind === 'before');
  const after = photos.filter((p) => p.kind === 'after');

  const input = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, hidden: true });
  let pendingKind = 'before';
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    toast(`Uploading ${files.length} photo${files.length > 1 ? 's' : ''}…`);
    try {
      for (const file of files) {
        const buffer = await file.arrayBuffer();
        await api('POST', `/api/admin/appointments/${a.id}/photos?kind=${pendingKind}`, buffer,
          { contentType: file.type || 'application/octet-stream' });
      }
      toast('Added.');
      reload();
    } catch (err) { toast(err.message, { bad: true }); }
  });

  const grid = (list, kind) => h('div', { class: 'photo-grid' },
    ...list.map((p) => h('button', {
      class: 'photo-cell', 'aria-label': `Photo, ${p.kind}`,
      onClick: () => photoSheet(p, reload),
    },
      h('img', { src: p.url, alt: p.caption || `${p.kind} photo`, loading: 'lazy' }),
      h('span', { class: 'photo-tag', text: p.kind }),
      p.shared ? null : h('span', { class: 'photo-hidden', text: 'hidden' })
    )),
    h('button', {
      class: 'photo-add', 'aria-label': `Add a ${kind} photo`, text: '+',
      onClick: () => { pendingKind = kind; input.click(); },
    })
  );

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: 'Before and after' }),
      h('span', { class: 'hint', text: `${photos.filter((p) => p.shared).length} shared` })
    ),
    input,
    h('div', { class: 'field-label', text: 'Before' }),
    grid(before, 'before'),
    h('div', { class: 'field-label', style: { marginTop: '14px' }, text: 'After' }),
    grid(after, 'after')
  );
}

function photoSheet(photo, reload) {
  return sheet({
    title: photo.kind === 'before' ? 'Before photo' : 'After photo',
    build: ({ close }) => {
      const caption = h('input', { type: 'text', value: photo.caption, placeholder: 'A short caption (optional)', maxlength: 200 });
      return h('div', {},
        h('img', { src: photo.url, alt: photo.caption || 'Photo', style: { borderRadius: '14px', marginBottom: '6px' } }),
        field('Caption', caption),
        switchRow('Show to the customer', 'Unshared photos stay on your side only.', photo.shared,
          async (on) => {
            await api.patch(`/api/admin/photos/${photo.id}`, { shared: on });
            photo.shared = on;
            toast(on ? 'Shared with the customer.' : 'Hidden from the customer.');
          }),
        h('div', { class: 'sheet-actions' },
          h('button', {
            class: 'btn btn--danger', text: 'Delete',
            onClick: async () => {
              if (!(await confirmSheet({ title: 'Delete this photo?', confirmLabel: 'Delete', danger: true }))) return;
              await api.del(`/api/admin/photos/${photo.id}`);
              close(true); reload();
            },
          }),
          h('button', {
            class: 'btn btn--primary', text: 'Save',
            onClick: async () => {
              await api.patch(`/api/admin/photos/${photo.id}`, { caption: caption.value });
              close(true); reload();
            },
          })
        )
      );
    },
  });
}

/* ---- invoice ---- */

function invoiceCard(a, invoice, reload) {
  if (!invoice) {
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Invoice' })),
      h('p', { class: 'small muted', text: 'Build it from the job when you are ready — the service, every extra and any tax, priced as sold.' }),
      h('button', {
        class: 'btn btn--block', style: { marginTop: '14px' }, text: 'Build the invoice',
        onClick: async () => {
          await api.post(`/api/admin/appointments/${a.id}/invoice`, {});
          toast('Invoice drafted.');
          reload();
        },
      })
    );
  }

  const isDraft = invoice.status === 'draft';
  const balance = invoice.total_cents - invoice.paid_cents;

  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: `Invoice ${invoice.number}` }),
      h('span', { class: `pill${invoice.status === 'paid' ? ' pill--good' : invoice.status === 'void' ? ' pill--bad' : ''}`, text: invoice.status })
    ),

    ...invoice.items.map((item) => moneyLine(item.label, money(item.amount_cents))),
    invoice.discount_cents ? moneyLine('Discount', `−${money(invoice.discount_cents)}`) : null,
    invoice.tax_cents ? moneyLine('Tax', money(invoice.tax_cents)) : null,
    invoice.tip_cents ? moneyLine('Tip', money(invoice.tip_cents)) : null,
    moneyLine('Total', money(invoice.total_cents), { total: true }),
    invoice.paid_cents ? moneyLine('Paid', `−${money(invoice.paid_cents)}`) : null,
    invoice.paid_cents && balance > 0 ? moneyLine('Balance', money(balance), { total: true }) : null,

    h('div', { class: 'btn-row', style: { marginTop: '16px' } },
      isDraft ? h('button', {
        class: 'btn btn--primary', text: 'Send it',
        onClick: async () => {
          const res = await api.post(`/api/admin/invoices/${invoice.id}/issue`, { send_text: true });
          if (res.message?.status === 'outbox') await outboxSheet(res.message);
          else toast('Invoice sent.');
          reload();
        },
      }) : null,
      isDraft ? h('button', { class: 'btn btn--ghost', text: 'Discount', onClick: () => discountSheet(invoice, reload) }) : null,
      !isDraft && invoice.status !== 'void' && balance > 0 ? h('button', {
        class: 'btn btn--primary', text: 'Record payment',
        onClick: () => paymentSheet(invoice, balance, reload),
      }) : null,
      h('a', { class: 'btn btn--ghost', href: `#/invoice/${invoice.id}`, text: 'Open' })
    )
  );
}

function discountSheet(invoice, reload) {
  return sheet({
    title: 'Discount',
    subtitle: 'Taken off the subtotal before tax.',
    build: ({ close }) => {
      const input = moneyInput(invoice.discount_cents);
      return h('div', {},
        field('Amount off', input),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Apply',
            onClick: async () => {
              try {
                await api.patch(`/api/admin/invoices/${invoice.id}`, { discount_cents: input.getCents() });
                close(true); reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

const METHOD_LABELS = {
  cash: 'Cash', card: 'Card', zelle: 'Zelle', venmo: 'Venmo', cashapp: 'Cash App',
  apple_pay: 'Apple Pay', bank_transfer: 'Bank transfer', check: 'Check', other: 'Other',
};

function paymentSheet(invoice, balance, reload) {
  return sheet({
    title: 'Record a payment',
    subtitle: 'What actually arrived. The tip is the part of it that was a tip.',
    build: ({ close }) => {
      const amount = moneyInput(balance);
      const tip = moneyInput(invoice.tip_cents);
      let method = 'cash';
      const chips = h('div', { class: 'chip-row' });
      const paint = () => mount(chips, ...Object.entries(METHOD_LABELS).map(([key, label]) =>
        h('button', {
          class: `chip${method === key ? ' chip--on' : ''}`, text: label,
          onClick: () => { method = key; paint(); },
        })
      ));
      paint();

      const reference = h('input', { type: 'text', placeholder: 'Reference (optional)', maxlength: 80 });

      return h('div', {},
        field('Amount received', amount),
        field('Of which tip', tip),
        h('div', { class: 'field' }, h('div', { class: 'field-label', text: 'How' }), chips),
        field('Note', reference),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Record it',
            onClick: async () => {
              try {
                await api.post(`/api/admin/invoices/${invoice.id}/payments`, {
                  amount_cents: amount.getCents(),
                  tip_cents: tip.getCents(),
                  method,
                  reference: reference.value,
                });
                close(true);
                toast('Recorded.');
                reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

/* ---- messages and the customer link ---- */

function messagesCard(a, messages, portalLink, reload) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', { text: 'Texts' }),
      h('span', { class: 'hint', text: state.smsProvider === 'twilio' ? 'Sending live' : 'Send from your phone' })
    ),

    h('div', { class: 'btn-row' },
      h('button', { class: 'btn btn--sm', text: 'Send a template', onClick: () => templateSheet(a, reload) }),
      h('button', {
        class: 'btn btn--sm btn--ghost', text: 'Copy their link',
        onClick: async () => {
          const { url } = await api.post(`/api/admin/appointments/${a.id}/portal-link`, {});
          try { await navigator.clipboard.writeText(url); toast('Link copied. It is good for a fortnight.'); }
          catch { await sheet({ title: 'Their private link', build: () => h('p', { class: 'small wrap-anywhere', text: url }) }); }
        },
      })
    ),

    portalLink ? h('p', { class: 'small faint', style: { marginTop: '10px' },
      text: portalLink.live
        ? `Their link works until ${fmtDate(portalLink.expires_at)}${portalLink.view_count ? ` · opened ${portalLink.view_count} time${portalLink.view_count > 1 ? 's' : ''}` : ' · not opened yet'}`
        : 'Their link has expired or been turned off.',
    }) : null,

    messages.length
      ? h('div', {}, ...messages.slice(0, 5).map((m) => h('div', {},
          h('div', { class: 'message-bubble', text: m.body }),
          h('div', { class: 'message-meta' },
            h('span', { class: `pill${m.status === 'sent' ? ' pill--good' : m.status === 'failed' ? ' pill--bad' : ''}`, text: m.status === 'outbox' ? 'ready to send' : m.status }),
            fmtRelative(m.created_at),
            m.status === 'outbox' ? h('button', {
              class: 'btn btn--quiet', text: 'Send it',
              onClick: () => outboxSheet({ body: m.body, to: m.to_phone }).then(async () => {
                await api.post(`/api/admin/messages/${m.id}/sent`, {});
                reload();
              }),
            }) : null
          )
        )))
      : h('p', { class: 'small faint', style: { marginTop: '12px' }, text: 'Nothing sent yet.' })
  );
}

async function templateSheet(a, reload) {
  const { templates } = await api.get('/api/admin/templates');
  return sheet({
    title: 'Send a text',
    subtitle: 'Preview first — every link is made fresh when you send.',
    build: ({ close }) => {
      const preview = h('div', { class: 'preview-box', text: 'Pick a template…' });
      let chosen = null;

      const pick = async (template) => {
        chosen = template;
        preview.textContent = 'Loading…';
        try {
          const res = await api.post(`/api/admin/appointments/${a.id}/preview`, { template_key: template.key });
          preview.textContent = res.preview;
        } catch (err) { preview.textContent = err.message; }
      };

      return h('div', {},
        h('div', { class: 'chip-row' }, ...templates.map((t) =>
          h('button', { class: 'chip', text: t.name, onClick: (e) => {
            for (const c of e.currentTarget.parentElement.children) c.classList.remove('chip--on');
            e.currentTarget.classList.add('chip--on');
            pick(t);
          } })
        )),
        preview,
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Send',
            onClick: async () => {
              if (!chosen) { toast('Pick a template first.', { bad: true }); return; }
              try {
                const res = await api.post(`/api/admin/appointments/${a.id}/message`, { template_key: chosen.key });
                close(true);
                if (res.message?.status === 'outbox') await outboxSheet(res.message);
                else toast('Sent.');
                reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

function appointmentMenu(a, reload) {
  return sheet({
    title: 'This appointment',
    build: ({ close }) => h('div', { class: 'stack' },
      h('button', { class: 'btn btn--block btn--ghost', text: 'Edit time and details', onClick: () => { close(); editAppointment(a, reload); } }),
      h('button', {
        class: 'btn btn--block btn--ghost', text: 'Turn off every customer link',
        onClick: async () => {
          close();
          if (!(await confirmSheet({
            title: 'Turn off their links?',
            subtitle: 'Any link this customer holds stops working at once, and live tracking ends. You can make a new one any time.',
            confirmLabel: 'Turn them off', danger: true,
          }))) return;
          await api.post(`/api/admin/appointments/${a.id}/revoke-links`, {});
          tracker.detach();
          toast('Links turned off.');
          reload();
        },
      }),
      h('button', {
        class: 'btn btn--block btn--danger', text: 'Delete this appointment',
        onClick: async () => {
          close();
          if (!(await confirmSheet({
            title: 'Delete this appointment?', subtitle: 'It will be gone for good.',
            confirmLabel: 'Delete', danger: true,
          }))) return;
          try {
            await api.del(`/api/admin/appointments/${a.id}`);
            toast('Deleted.');
            location.hash = '#/schedule';
          } catch (err) { toast(err.message, { bad: true }); }
        },
      })
    ),
  });
}

async function editAppointment(a, reload) {
  const { data: catalog } = { data: await api.get('/api/admin/catalog') };
  const customer = await api.get(`/api/admin/customers/${a.customer.id}`);

  return sheet({
    title: 'Edit appointment',
    build: ({ close }) => {
      const when = h('input', { type: 'datetime-local', value: msToLocalInput(a.starts_at) });
      const duration = h('input', { type: 'number', value: a.duration_min, min: 15, max: 1440, step: 15 });
      const address = h('input', { type: 'text', value: a.address, maxlength: 240 });
      const notes = h('textarea', { maxlength: 2000, value: a.notes });

      const service = h('select', {}, ...catalog.services.map((s) =>
        h('option', { value: String(s.id), text: `${s.name} — ${price(s.price_cents)}`, selected: s.id === a.service.id })
      ));
      const vehicle = h('select', {},
        h('option', { value: '', text: 'No vehicle', selected: !a.vehicle }),
        ...customer.customer.vehicles.map((v) =>
          h('option', { value: String(v.id), text: vehicleLabel(v), selected: a.vehicle?.id === v.id })
        )
      );

      return h('div', {},
        field('Service', service),
        field('Vehicle', vehicle),
        h('div', { class: 'field-pair' }, field('When', when), field('Minutes', duration)),
        field('Address', address),
        field('Your notes', notes, 'Only you ever see these.'),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Save',
            onClick: async () => {
              try {
                await api.patch(`/api/admin/appointments/${a.id}`, {
                  service_id: Number(service.value),
                  vehicle_id: vehicle.value ? Number(vehicle.value) : null,
                  starts_at: localInputToMs(when.value),
                  duration_min: Number(duration.value),
                  address: address.value,
                  notes: notes.value,
                });
                close(true);
                toast('Saved.');
                reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

/* ==========================================================================
   Schedule
   ========================================================================== */

async function renderSchedule() {
  const { appointments } = await api.get('/api/admin/appointments?status=open');
  const upcoming = [...appointments].sort((x, y) => x.starts_at - y.starts_at);

  const days = new Map();
  for (const job of upcoming) {
    const key = fmtDay(job.starts_at);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(job);
  }

  mount(app,
    header('Schedule', `${upcoming.length} open ${upcoming.length === 1 ? 'job' : 'jobs'}`,
      h('button', { class: 'icon-btn', 'aria-label': 'Book a job', text: '+', onClick: () => newAppointment() })
    ),

    upcoming.length
      ? h('div', {}, ...[...days].map(([day, jobs]) => h('div', {},
          h('div', { class: 'day-heading' },
            h('span', { class: 'day-name', text: day }),
            h('span', { class: 'day-count', text: `${jobs.length} · ${money(jobs.reduce((s, j) => s + j.total_cents, 0))}` })
          ),
          ...jobs.map((job) => jobCard(job))
        )))
      : h('div', { class: 'card' }, empty('🗓️', 'Nothing on the books.',
          h('button', { class: 'btn btn--primary', text: 'Book a job', onClick: () => newAppointment() }))),

    h('div', { class: 'section-title', text: 'History' }),
    h('a', { class: 'card row', href: '#/money', style: { display: 'flex' } },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title', text: 'Past jobs and invoices' }),
        h('div', { class: 'row-sub', text: 'Everything finished, cancelled or paid' })
      ),
      h('span', { class: 'chev', text: '›' })
    )
  );
}

async function newAppointment(presetCustomerId = null) {
  const [catalog, customers] = await Promise.all([
    api.get('/api/admin/catalog'),
    api.get('/api/admin/customers'),
  ]);

  if (!customers.customers.length) {
    const make = await confirmSheet({
      title: 'No customers yet',
      subtitle: 'Add someone first, then book them in.',
      confirmLabel: 'Add a customer',
    });
    if (make) newCustomer();
    return;
  }

  return sheet({
    title: 'Book a job',
    build: ({ close }) => {
      const customer = h('select', {}, ...customers.customers.map((c) =>
        h('option', { value: String(c.id), text: c.name, selected: c.id === presetCustomerId })
      ));
      const vehicle = h('select', {}, h('option', { value: '', text: 'Loading…' }));
      const service = h('select', {}, ...catalog.services.filter((s) => s.active).map((s) =>
        h('option', { value: String(s.id), text: `${s.name} — ${price(s.price_cents)}`, dataset: { duration: s.duration_min } })
      ));

      const start = new Date(Date.now() + 60 * 60 * 1000);
      start.setMinutes(0, 0, 0);
      const when = h('input', { type: 'datetime-local', value: msToLocalInput(start.getTime()) });
      const duration = h('input', { type: 'number', value: catalog.services[0]?.duration_min ?? 60, min: 15, max: 1440, step: 15 });
      const address = h('input', { type: 'text', placeholder: 'Where the job is', maxlength: 240 });
      const notes = h('textarea', { placeholder: 'Anything you want to remember', maxlength: 2000 });

      service.addEventListener('change', () => {
        const opt = service.selectedOptions[0];
        if (opt?.dataset.duration) duration.value = opt.dataset.duration;
      });

      const loadVehicles = async () => {
        const detail = await api.get(`/api/admin/customers/${customer.value}`);
        mount(vehicle,
          h('option', { value: '', text: detail.customer.vehicles.length ? 'Pick a vehicle' : 'No vehicle on file' }),
          ...detail.customer.vehicles.map((v) => h('option', { value: String(v.id), text: vehicleLabel(v) }))
        );
        if (detail.customer.vehicles.length === 1) vehicle.value = String(detail.customer.vehicles[0].id);
        if (!address.value && detail.customer.address) address.value = detail.customer.address;
      };
      customer.addEventListener('change', loadVehicles);
      loadVehicles();

      const selected = new Set();
      const addonChips = h('div', { class: 'chip-row' }, ...catalog.addons.filter((a) => a.active).map((addon) =>
        h('button', {
          class: 'chip',
          onClick: (e) => {
            if (selected.has(addon.id)) selected.delete(addon.id); else selected.add(addon.id);
            e.currentTarget.classList.toggle('chip--on', selected.has(addon.id));
          },
        }, addon.name, h('span', { class: 'faint', text: ` ${price(addon.price_cents)}` }))
      ));

      return h('div', {},
        field('Customer', customer),
        field('Vehicle', vehicle),
        field('Service', service),
        h('div', { class: 'field-pair' }, field('When', when), field('Minutes', duration)),
        field('Address', address),
        h('div', { class: 'field' }, h('div', { class: 'field-label', text: 'Extras (optional)' }), addonChips),
        field('Notes', notes, 'Private to you.'),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Book it',
            onClick: async (e) => {
              e.currentTarget.disabled = true;
              try {
                const res = await api.post('/api/admin/appointments', {
                  customer_id: Number(customer.value),
                  vehicle_id: vehicle.value ? Number(vehicle.value) : null,
                  service_id: Number(service.value),
                  starts_at: localInputToMs(when.value),
                  duration_min: Number(duration.value),
                  address: address.value,
                  notes: notes.value,
                  addon_ids: [...selected],
                });
                close(true);
                toast('Booked.');
                location.hash = `#/appointment/${res.appointment.id}`;
              } catch (err) {
                e.currentTarget.disabled = false;
                toast(err.message, { bad: true });
              }
            },
          })
        )
      );
    },
  });
}

/* ==========================================================================
   Customers
   ========================================================================== */

async function renderCustomers() {
  const list = h('div');
  const search = h('input', { type: 'search', placeholder: 'Search by name or number', 'aria-label': 'Search customers' });

  const load = async (term = '') => {
    const { customers } = await api.get(`/api/admin/customers${term ? `?search=${encodeURIComponent(term)}` : ''}`);
    mount(list, customers.length
      ? h('div', { class: 'card card--flush' }, ...customers.map((c) =>
          h('a', { class: 'row', href: `#/customer/${c.id}` },
            h('div', { class: 'avatar', text: initials(c.name) }),
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title', text: c.name }),
              h('div', { class: 'row-sub', text: [
                c.phone,
                c.vehicle_count ? `${c.vehicle_count} vehicle${c.vehicle_count > 1 ? 's' : ''}` : null,
                c.appointment_count ? `${c.appointment_count} job${c.appointment_count > 1 ? 's' : ''}` : null,
              ].filter(Boolean).join(' · ') })
            ),
            h('span', { class: 'chev', text: '›' })
          )
        ))
      : h('div', { class: 'card' }, empty('🔍', term ? 'Nobody matches that.' : 'No customers yet.')));
  };

  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => load(search.value.trim()), 220);
  });

  mount(app,
    header('Customers', null,
      h('button', { class: 'icon-btn', 'aria-label': 'Add a customer', text: '+', onClick: () => newCustomer() })
    ),
    h('div', { class: 'search-bar' }, h('span', { class: 'search-icon', text: '🔍' }), search),
    list
  );
  await load();
}

function newCustomer() {
  return sheet({
    title: 'New customer',
    build: ({ close }) => {
      const name = h('input', { type: 'text', required: true, maxlength: 120, autocomplete: 'name' });
      const phone = h('input', { type: 'tel', placeholder: '(810) 555-0134', autocomplete: 'tel' });
      const email = h('input', { type: 'email', autocomplete: 'email' });
      const address = h('input', { type: 'text', maxlength: 240 });
      const year = h('input', { type: 'text', placeholder: '2019', maxlength: 8 });
      const make = h('input', { type: 'text', placeholder: 'Toyota', maxlength: 40 });
      const model = h('input', { type: 'text', placeholder: 'Tacoma', maxlength: 40 });
      const color = h('input', { type: 'text', placeholder: 'Silver', maxlength: 30 });
      let consent = true;

      return h('div', {},
        field('Name', name),
        field('Phone', phone, 'Needed for texts and tracking links.'),
        field('Email', email),
        field('Address', address),
        h('div', { class: 'section-title', text: 'Their vehicle' }),
        h('div', { class: 'field-pair' }, field('Year', year), field('Colour', color)),
        h('div', { class: 'field-pair' }, field('Make', make), field('Model', model)),
        switchRow('They are happy to receive texts', 'Turn this off and the app will refuse to text them.', true, (on) => { consent = on; }),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Add',
            onClick: async (e) => {
              e.currentTarget.disabled = true;
              try {
                const payload = {
                  name: name.value, phone: phone.value, email: email.value,
                  address: address.value, sms_consent: consent,
                };
                if (make.value || model.value) {
                  payload.vehicle = { year: year.value, make: make.value, model: model.value, color: color.value };
                }
                const res = await api.post('/api/admin/customers', payload);
                close(true);
                location.hash = `#/customer/${res.customer.id}`;
              } catch (err) {
                e.currentTarget.disabled = false;
                toast(err.message, { bad: true });
              }
            },
          })
        )
      );
    },
  });
}

async function renderCustomerDetail(idRaw) {
  const id = Number(idRaw);
  const { customer } = await api.get(`/api/admin/customers/${id}`);
  const reload = () => renderCustomerDetail(idRaw);

  mount(app,
    backHeader(customer.name, '#/customers',
      h('button', { class: 'icon-btn', 'aria-label': 'Edit', text: '✎', onClick: () => editCustomer(customer, reload) })
    ),

    h('div', { class: 'card card--flush' },
      h('div', { class: 'row' },
        h('div', { class: 'avatar', text: initials(customer.name) }),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: customer.name }),
          h('div', { class: 'row-sub', text: customer.phone || 'No phone on file' })
        ),
        customer.sms_consent ? null : h('span', { class: 'pill pill--bad', text: 'no texts' })
      ),
      h('div', { class: 'row', style: { gap: '8px' } },
        customer.phone ? h('a', { class: 'btn btn--sm', href: `tel:${customer.phone}`, text: '📞 Call' }) : null,
        customer.phone ? h('a', { class: 'btn btn--sm', href: `sms:${customer.phone}`, text: '💬 Text' }) : null,
        h('button', { class: 'btn btn--sm btn--primary', text: '+ Book', onClick: () => newAppointment(id) })
      )
    ),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', { text: 'Vehicles' }),
        h('button', { class: 'btn btn--quiet', text: '+ Add', onClick: () => vehicleSheet(id, null, reload) })
      ),
      customer.vehicles.length
        ? h('div', {}, ...customer.vehicles.map((v) => h('button', { class: 'row', style: { padding: '12px 0' }, onClick: () => vehicleSheet(id, v, reload) },
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title', text: vehicleLabel(v) }),
              v.plate ? h('div', { class: 'row-sub', text: v.plate }) : null
            ),
            h('span', { class: 'chev', text: '›' })
          )))
        : h('p', { class: 'small faint', text: 'No vehicles saved yet.' })
    ),

    customer.notes ? h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Notes' })),
      h('p', { class: 'small', style: { whiteSpace: 'pre-wrap' }, text: customer.notes })
    ) : null,

    h('div', { class: 'section-title', text: 'Their jobs' }),
    customer.appointments.length
      ? h('div', {}, ...customer.appointments.map((job) => jobCard(job, { showDay: true })))
      : h('div', { class: 'card' }, empty('🧽', 'No jobs yet.'))
  );
}

function vehicleSheet(customerId, vehicle, reload) {
  return sheet({
    title: vehicle ? 'Edit vehicle' : 'Add a vehicle',
    build: ({ close }) => {
      const year = h('input', { type: 'text', value: vehicle?.year ?? '', maxlength: 8 });
      const make = h('input', { type: 'text', value: vehicle?.make ?? '', maxlength: 40 });
      const model = h('input', { type: 'text', value: vehicle?.model ?? '', maxlength: 40 });
      const color = h('input', { type: 'text', value: vehicle?.color ?? '', maxlength: 30 });
      const plate = h('input', { type: 'text', value: vehicle?.plate ?? '', maxlength: 16 });
      const notes = h('textarea', { value: vehicle?.notes ?? '', maxlength: 1000 });

      return h('div', {},
        h('div', { class: 'field-pair' }, field('Year', year), field('Colour', color)),
        h('div', { class: 'field-pair' }, field('Make', make), field('Model', model)),
        field('Plate', plate),
        field('Notes', notes, 'Swirl marks, a cracked trim clip — whatever you want to remember.'),
        h('div', { class: 'sheet-actions' },
          vehicle ? h('button', {
            class: 'btn btn--danger', text: 'Delete',
            onClick: async () => {
              if (!(await confirmSheet({ title: 'Delete this vehicle?', confirmLabel: 'Delete', danger: true }))) return;
              await api.del(`/api/admin/vehicles/${vehicle.id}`);
              close(true); reload();
            },
          }) : h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Save',
            onClick: async () => {
              const payload = { year: year.value, make: make.value, model: model.value, color: color.value, plate: plate.value, notes: notes.value };
              try {
                if (vehicle) await api.patch(`/api/admin/vehicles/${vehicle.id}`, payload);
                else await api.post(`/api/admin/customers/${customerId}/vehicles`, payload);
                close(true); reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

function editCustomer(customer, reload) {
  return sheet({
    title: 'Edit customer',
    build: ({ close }) => {
      const name = h('input', { type: 'text', value: customer.name, maxlength: 120 });
      const phone = h('input', { type: 'tel', value: customer.phone, maxlength: 32 });
      const email = h('input', { type: 'email', value: customer.email, maxlength: 254 });
      const address = h('input', { type: 'text', value: customer.address, maxlength: 240 });
      const notes = h('textarea', { value: customer.notes, maxlength: 2000 });
      let consent = customer.sms_consent;

      return h('div', {},
        field('Name', name),
        field('Phone', phone),
        field('Email', email),
        field('Address', address),
        field('Notes', notes, 'Private to you.'),
        switchRow('Happy to receive texts', 'Off means this app will not text them at all.', consent, (on) => { consent = on; }),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Save',
            onClick: async () => {
              try {
                await api.patch(`/api/admin/customers/${customer.id}`, {
                  name: name.value, phone: phone.value, email: email.value,
                  address: address.value, notes: notes.value, sms_consent: consent,
                });
                close(true); toast('Saved.'); reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

/* ==========================================================================
   Money
   ========================================================================== */

async function renderMoney() {
  const { invoices } = await api.get('/api/admin/invoices');
  const outstanding = invoices.filter((i) => i.status === 'sent');
  const paid = invoices.filter((i) => i.status === 'paid');
  const drafts = invoices.filter((i) => i.status === 'draft');

  const owed = outstanding.reduce((s, i) => s + i.balance_cents, 0);
  const collected = paid.reduce((s, i) => s + i.paid_cents, 0);
  const tips = paid.reduce((s, i) => s + i.tip_cents, 0);

  const invoiceRow = (inv) => h('a', { class: 'row', href: `#/invoice/${inv.id}` },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title', text: inv.customer_name || 'Unknown' }),
      h('div', { class: 'row-sub', text: `${inv.number} · ${inv.service_name}${inv.starts_at ? ` · ${fmtDate(inv.starts_at)}` : ''}` })
    ),
    h('div', { class: 'row-end' },
      h('div', { class: 'row-amount', text: money(inv.status === 'paid' ? inv.paid_cents : inv.balance_cents) }),
      h('div', { class: 'small faint', text: inv.status === 'paid' ? 'paid' : inv.status === 'draft' ? 'draft' : 'owed' })
    )
  );

  mount(app,
    header('Money', 'Invoices, payments and tips'),
    h('div', { class: 'stat-grid' },
      stat(money(owed), 'owed to you', owed > 0 ? 'gold' : ''),
      stat(money(collected), 'collected', 'accent'),
      stat(money(tips), 'in tips', 'gold'),
      stat(String(drafts.length), drafts.length === 1 ? 'draft' : 'drafts')
    ),

    outstanding.length ? h('div', {},
      h('div', { class: 'section-title', text: 'Waiting on payment' }),
      h('div', { class: 'card card--flush' }, ...outstanding.map(invoiceRow))
    ) : null,

    drafts.length ? h('div', {},
      h('div', { class: 'section-title', text: 'Not sent yet' }),
      h('div', { class: 'card card--flush' }, ...drafts.map(invoiceRow))
    ) : null,

    paid.length ? h('div', {},
      h('div', { class: 'section-title', text: 'Settled' }),
      h('div', { class: 'card card--flush' }, ...paid.slice(0, 30).map(invoiceRow))
    ) : null,

    invoices.length ? null : h('div', { class: 'card' }, empty('💵', 'No invoices yet. Build one from a finished job.'))
  );
}

async function renderInvoiceDetail(idRaw) {
  const data = await api.get(`/api/admin/invoices/${idRaw}`);
  const inv = data.invoice;
  const reload = () => renderInvoiceDetail(idRaw);
  const balance = inv.total_cents - inv.paid_cents;

  mount(app,
    backHeader(inv.number, '#/money'),

    h('div', { class: 'detail-head' },
      h('div', { class: 'detail-service', text: money(inv.total_cents) }),
      h('div', { class: 'detail-when', text: `${data.customer?.name ?? 'Unknown'} · ${data.service_name}` }),
      h('div', { class: 'detail-pills' },
        h('span', { class: `pill${inv.status === 'paid' ? ' pill--good' : inv.status === 'void' ? ' pill--bad' : ''}`, text: inv.status }),
        balance > 0 && inv.status !== 'draft' ? h('span', { class: 'pill pill--gold', text: `${money(balance)} owed` }) : null
      )
    ),

    h('div', { class: 'card' },
      ...inv.items.map((item) => moneyLine(item.label, money(item.amount_cents))),
      inv.discount_cents ? moneyLine('Discount', `−${money(inv.discount_cents)}`) : null,
      inv.tax_cents ? moneyLine('Tax', money(inv.tax_cents)) : null,
      inv.tip_cents ? moneyLine('Tip', money(inv.tip_cents)) : null,
      moneyLine('Total', money(inv.total_cents), { total: true })
    ),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Payments' })),
      inv.payments.length
        ? h('div', {}, ...inv.payments.map((p) => h('div', { class: 'row', style: { padding: '11px 0' } },
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title', text: METHOD_LABELS[p.method] ?? p.method }),
              h('div', { class: 'row-sub', text: [fmtDate(p.received_at), p.reference, p.tip_cents ? `${money(p.tip_cents)} tip` : null].filter(Boolean).join(' · ') })
            ),
            h('div', { class: 'row-end' }, h('div', { class: 'row-amount', text: money(p.amount_cents) })),
            h('button', {
              class: 'btn btn--quiet', text: '✕', 'aria-label': 'Remove this payment',
              onClick: async () => {
                if (!(await confirmSheet({ title: 'Remove this payment?', confirmLabel: 'Remove', danger: true }))) return;
                await api.del(`/api/admin/payments/${p.id}`);
                reload();
              },
            })
          )))
        : h('p', { class: 'small faint', text: 'Nothing recorded yet.' }),

      inv.status !== 'draft' && inv.status !== 'void' && balance > 0
        ? h('button', {
            class: 'btn btn--primary btn--block', style: { marginTop: '14px' }, text: 'Record a payment',
            onClick: () => paymentSheet(inv, balance, reload),
          })
        : null
    ),

    h('div', { class: 'card' },
      h('div', { class: 'btn-row' },
        h('a', { class: 'btn btn--ghost', href: `#/appointment/${inv.appointment_id}`, text: 'Open the job' }),
        inv.paid_cents === 0 && inv.status !== 'void' ? h('button', {
          class: 'btn btn--danger', text: 'Void',
          onClick: async () => {
            if (!(await confirmSheet({ title: 'Void this invoice?', subtitle: 'It stops being owed. Nothing is deleted.', confirmLabel: 'Void', danger: true }))) return;
            await api.post(`/api/admin/invoices/${inv.id}/void`, {});
            reload();
          },
        }) : null
      )
    )
  );
}

/* ==========================================================================
   Messages
   ========================================================================== */

async function renderMessages() {
  const { messages, provider } = await api.get('/api/admin/messages');
  const waiting = messages.filter((m) => m.status === 'outbox');

  mount(app,
    backHeader('Texts', '#/today'),
    provider !== 'twilio'
      ? h('div', { class: 'card card--accent' },
          h('p', { class: 'small', text: 'No texting service is connected, so nothing is sent automatically. Every message is written out for you here — open it, send it from your own phone, and mark it done.' }))
      : null,

    waiting.length ? h('div', {},
      h('div', { class: 'section-title', text: 'Ready to send' }),
      ...waiting.map((m) => h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('div', { style: { fontWeight: '650', fontSize: '0.92rem' } }, m.customer_name || m.to_phone),
          h('span', { class: 'small faint', text: fmtRelative(m.created_at) })
        ),
        h('div', { class: 'message-bubble', text: m.body }),
        h('div', { class: 'btn-row', style: { marginTop: '12px' } },
          h('a', {
            class: 'btn btn--sm btn--primary',
            href: `sms:${encodeURIComponent(m.to_phone)}?&body=${encodeURIComponent(m.body)}`,
            text: 'Open Messages',
          }),
          h('button', {
            class: 'btn btn--sm btn--ghost', text: 'Mark as sent',
            onClick: async () => { await api.post(`/api/admin/messages/${m.id}/sent`, {}); renderMessages(); },
          })
        )
      )),
    ) : null,

    h('div', { class: 'section-title', text: 'Everything sent' }),
    messages.length
      ? h('div', { class: 'card card--flush' }, ...messages.slice(0, 60).map((m) => h('div', { class: 'row' },
          h('div', { class: 'row-main' },
            h('div', { class: 'row-title', text: m.customer_name || m.to_phone }),
            h('div', { class: 'row-sub', text: m.body })
          ),
          h('div', { class: 'row-end' },
            h('span', { class: `pill${m.status === 'sent' ? ' pill--good' : m.status === 'failed' ? ' pill--bad' : ''}`, text: m.status === 'outbox' ? 'waiting' : m.status }),
            h('div', { class: 'small faint', style: { marginTop: '4px' }, text: fmtRelative(m.created_at) })
          )
        )))
      : h('div', { class: 'card' }, empty('💬', 'No texts yet.'))
  );
}

/* ==========================================================================
   Setup
   ========================================================================== */

async function renderSetupHome() {
  const links = [
    ['services', '🧽', 'Services and prices', 'What you offer and what it costs'],
    ['addons', '✨', 'Add-ons', 'The extras a customer can pick themselves'],
    ['templates', '💬', 'Text templates', 'The exact words that go out'],
    ['business', '🏷️', 'Business details', 'Name, phone, timezone, tax, tracking window'],
    ['reviews', '⭐', 'Reviews', 'What customers said, and what to publish'],
    ['messages', '📤', 'All texts', 'Everything sent or waiting'],
    ['activity', '📜', 'Activity log', 'Every change, with a timestamp'],
  ];

  mount(app,
    header('Setup', state.settings.business_name),
    h('div', { class: 'card card--flush' }, ...links.map(([route, icon, title, sub]) =>
      h('a', { class: 'row', href: `#/${route}` },
        h('span', { style: { fontSize: '1.25rem' }, text: icon }),
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: title }),
          h('div', { class: 'row-sub', text: sub })
        ),
        h('span', { class: 'chev', text: '›' })
      )
    )),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Your account' })),
      h('p', { class: 'small muted', text: 'Only this account can reach the dashboard. Customers never sign in at all — they open a link that works for one appointment.' }),
      h('div', { class: 'btn-row', style: { marginTop: '14px' } },
        h('button', { class: 'btn btn--sm', text: 'Change password', onClick: passwordSheet }),
        h('button', {
          class: 'btn btn--sm btn--ghost', text: 'Sign out',
          onClick: async () => {
            await api.post('/api/admin/logout', {});
            tracker.detach();
            location.hash = '';
            location.reload();
          },
        })
      )
    )
  );
}

function passwordSheet() {
  return sheet({
    title: 'Change your password',
    subtitle: 'Every signed-in device is signed out, including this one.',
    build: ({ close }) => {
      const current = h('input', { type: 'password', autocomplete: 'current-password' });
      const next = h('input', { type: 'password', autocomplete: 'new-password', minlength: 12 });
      return h('div', {},
        field('Current password', current),
        field('New password', next, 'At least 12 characters.'),
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Change it',
            onClick: async () => {
              try {
                await api.post('/api/admin/password', { current: current.value, next: next.value });
                close(true);
                location.reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

async function renderCatalogView() {
  const kind = currentRoute().view === 'services' ? 'services' : 'addons';
  const data = await api.get('/api/admin/catalog');
  const items = data[kind];
  const reload = () => renderCatalogView();

  mount(app,
    backHeader(kind === 'services' ? 'Services' : 'Add-ons', '#/setup',
      h('button', { class: 'icon-btn', 'aria-label': 'Add', text: '+', onClick: () => catalogSheet(kind, null, reload) })
    ),

    h('div', { class: 'card' },
      h('p', { class: 'small muted', text: kind === 'services'
        ? 'Every price here can be changed whenever you like. A job already booked keeps the price it was sold at.'
        : 'Extras a customer sees on their own page. Give each one a friendly line so they know what they are getting — and turn off "customers can add this" for anything you would rather quote yourself.' })
    ),

    items.length
      ? h('div', { class: 'card' }, ...items.map((item) =>
          h('button', { class: `catalog-item${item.active ? '' : ' is-off'}`, onClick: () => catalogSheet(kind, item, reload) },
            h('div', { class: 'catalog-main' },
              h('div', { class: 'catalog-name' },
                item.name,
                item.active ? null : h('span', { class: 'faint small', text: '  (off)' }),
                kind === 'addons' && !item.customer_selectable ? h('span', { class: 'faint small', text: '  · you add this' }) : null
              ),
              item.description ? h('div', { class: 'catalog-desc', text: item.description }) : null
            ),
            h('div', { class: 'catalog-price' },
              item.price_is_from ? h('span', { class: 'catalog-from', text: 'from' }) : null,
              price(item.price_cents)
            )
          )
        ))
      : h('div', { class: 'card' }, empty('📋', 'Nothing here yet.'))
  );
}

function catalogSheet(kind, item, reload) {
  const label = kind === 'services' ? 'service' : 'add-on';
  return sheet({
    title: item ? `Edit ${label}` : `New ${label}`,
    build: ({ close }) => {
      const name = h('input', { type: 'text', value: item?.name ?? '', maxlength: 120, required: true });
      const description = h('textarea', { value: item?.description ?? '', maxlength: 600,
        placeholder: kind === 'addons' ? 'What it actually does, in plain words.' : 'What is included.' });
      const priceField = moneyInput(item?.price_cents ?? 0);
      const duration = h('input', { type: 'number', value: item?.duration_min ?? (kind === 'services' ? 60 : 0), min: 0, max: 1440, step: 5 });
      let isFrom = Boolean(item?.price_is_from);
      let active = item ? Boolean(item.active) : true;
      let selectable = item ? Boolean(item.customer_selectable) : true;

      return h('div', {},
        field('Name', name),
        field('Description', description, kind === 'addons' ? 'This is what the customer reads. No jargon.' : null),
        h('div', { class: 'field-pair' },
          field('Price', priceField),
          field('Minutes it adds', duration)
        ),
        switchRow('Price is a starting point', 'Shows as "from $80" — for jobs where the real number depends on the state of the car.', isFrom, (on) => { isFrom = on; }),
        kind === 'addons'
          ? switchRow('Customers can add this themselves', 'Off means it only appears on your side.', selectable, (on) => { selectable = on; })
          : null,
        switchRow('Offer it', 'Turn off to retire something without losing its history.', active, (on) => { active = on; }),

        h('div', { class: 'sheet-actions' },
          item ? h('button', {
            class: 'btn btn--danger', text: 'Delete',
            onClick: async () => {
              if (!(await confirmSheet({
                title: `Delete this ${label}?`,
                subtitle: 'If it has ever been sold it is retired instead, so past jobs keep their wording and price.',
                confirmLabel: 'Delete', danger: true,
              }))) return;
              const res = await api.del(`/api/admin/catalog/${kind}/${item.id}`);
              close(true);
              toast(res.retired ? 'Retired — past jobs keep it.' : 'Deleted.');
              reload();
            },
          }) : h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Save',
            onClick: async () => {
              const payload = {
                name: name.value,
                description: description.value,
                price_cents: priceField.getCents(),
                price_is_from: isFrom,
                duration_min: Number(duration.value) || 0,
                active,
              };
              if (kind === 'addons') payload.customer_selectable = selectable;
              try {
                if (item) await api.patch(`/api/admin/catalog/${kind}/${item.id}`, payload);
                else await api.post(`/api/admin/catalog/${kind}`, payload);
                close(true);
                toast('Saved.');
                reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

async function renderTemplates() {
  const { templates, placeholders } = await api.get('/api/admin/templates');
  const reload = () => renderTemplates();

  mount(app,
    backHeader('Text templates', '#/setup',
      h('button', { class: 'icon-btn', 'aria-label': 'New template', text: '+', onClick: () => templateEditor(null, placeholders, reload) })
    ),

    h('div', { class: 'card' },
      h('p', { class: 'small muted', text: 'These are the exact words that go out. Anything in double braces is filled in when the text is sent.' }),
      h('div', { class: 'placeholder-grid' }, ...placeholders.map((p) =>
        h('span', { class: 'placeholder-chip', text: `{{${p.key}}}` })
      ))
    ),

    h('div', { class: 'card card--flush' }, ...templates.map((t) =>
      h('button', { class: 'row', onClick: () => templateEditor(t, placeholders, reload) },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title', text: t.name }),
          h('div', { class: 'row-sub', text: t.body })
        ),
        h('span', { class: 'chev', text: '›' })
      )
    ))
  );
}

function templateEditor(template, placeholders, reload) {
  return sheet({
    title: template ? template.name : 'New template',
    subtitle: template?.description || null,
    build: ({ close }) => {
      const body = h('textarea', { class: 'template-body', value: template?.body ?? '', maxlength: 1200, rows: 6 });
      const name = template ? null : h('input', { type: 'text', maxlength: 80, placeholder: 'What you will call it' });
      const counter = h('p', { class: 'help' });

      const updateCount = () => {
        const len = body.value.length;
        counter.textContent = `${len} characters · about ${Math.max(1, Math.ceil(len / 153))} message${len > 153 ? 's' : ''}`;
      };
      body.addEventListener('input', updateCount);
      updateCount();

      const insert = (key) => {
        const at = body.selectionStart ?? body.value.length;
        const token = `{{${key}}}`;
        body.value = body.value.slice(0, at) + token + body.value.slice(body.selectionEnd ?? at);
        body.focus();
        body.selectionStart = body.selectionEnd = at + token.length;
        updateCount();
      };

      return h('div', {},
        name ? field('Name', name) : null,
        h('div', { class: 'field' }, h('div', { class: 'field-label', text: 'Message' }), body, counter),
        h('div', { class: 'placeholder-grid' }, ...placeholders.map((p) =>
          h('button', { class: 'placeholder-chip', title: p.what, text: `{{${p.key}}}`, onClick: () => insert(p.key) })
        )),
        h('div', { class: 'sheet-actions' },
          template && !template.built_in ? h('button', {
            class: 'btn btn--danger', text: 'Delete',
            onClick: async () => {
              if (!(await confirmSheet({ title: 'Delete this template?', confirmLabel: 'Delete', danger: true }))) return;
              await api.del(`/api/admin/templates/${encodeURIComponent(template.key)}`);
              close(true); reload();
            },
          }) : template ? h('button', {
            class: 'btn btn--ghost', text: 'Reset wording',
            onClick: async () => {
              await api.post(`/api/admin/templates/${encodeURIComponent(template.key)}/reset`, {});
              close(true); toast('Back to the original wording.'); reload();
            },
          }) : h('button', { class: 'btn btn--ghost', text: 'Cancel', onClick: () => close(null) }),
          h('button', {
            class: 'btn btn--primary', text: 'Save',
            onClick: async () => {
              try {
                if (template) await api.patch(`/api/admin/templates/${encodeURIComponent(template.key)}`, { body: body.value });
                else await api.post('/api/admin/templates', { name: name.value, body: body.value });
                close(true); toast('Saved.'); reload();
              } catch (err) { toast(err.message, { bad: true }); }
            },
          })
        )
      );
    },
  });
}

async function renderBusinessSettings() {
  const data = await api.get('/api/admin/settings');
  const s = data.settings;

  const name = h('input', { type: 'text', value: s.business_name, maxlength: 120 });
  const phone = h('input', { type: 'tel', value: s.business_phone, maxlength: 32 });
  const email = h('input', { type: 'email', value: s.business_email, maxlength: 254 });
  const city = h('input', { type: 'text', value: s.business_city, maxlength: 120 });
  const timezone = h('input', { type: 'text', value: s.timezone, maxlength: 60 });
  const tax = h('input', { type: 'number', value: (Number(s.tax_rate_bp) / 100).toFixed(2), min: 0, max: 30, step: 0.01 });
  const trackingMinutes = h('input', { type: 'number', value: s.tracking_minutes, min: 5, max: data.tracking_max_minutes, step: 5 });
  const tips = h('input', { type: 'text', value: s.tip_presets, maxlength: 40 });
  const payInstructions = h('textarea', { value: s.payment_instructions, maxlength: 500 });
  const reviewPrompt = h('textarea', { value: s.review_prompt, maxlength: 300 });
  const invoicePrefix = h('input', { type: 'text', value: s.invoice_prefix, maxlength: 8 });
  let allowAddons = s.allow_customer_addons === '1';

  const save = async (e) => {
    e.currentTarget.disabled = true;
    try {
      await api.patch('/api/admin/settings', {
        business_name: name.value,
        business_phone: phone.value,
        business_email: email.value,
        business_city: city.value,
        timezone: timezone.value,
        tax_rate_bp: Math.round(Number(tax.value) * 100),
        tracking_minutes: Number(trackingMinutes.value),
        tip_presets: tips.value,
        payment_instructions: payInstructions.value,
        review_prompt: reviewPrompt.value,
        invoice_prefix: invoicePrefix.value,
        allow_customer_addons: allowAddons,
      });
      const fresh = await api.get('/api/admin/settings');
      state.settings = fresh.settings;
      setTimezone(state.settings.timezone);
      toast('Saved.');
    } catch (err) { toast(err.message, { bad: true }); }
    e.currentTarget.disabled = false;
  };

  mount(app,
    backHeader('Business details', '#/setup'),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'The basics' })),
      field('Business name', name),
      field('Phone', phone, 'Goes into texts wherever {{business_phone}} appears.'),
      field('Email', email),
      field('Town or city', city),
      field('Timezone', timezone, 'An IANA name such as America/Detroit. Every time in the app is shown in this zone.')
    ),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Arrival tracking' })),
      field('How long a tracking link lasts', trackingMinutes, `Minutes. One hour is the default, ${data.tracking_max_minutes} is the most allowed.`),
      h('p', { class: 'small muted', text: 'Your location is only ever shared after you press "I\'m on my way", and the link dies on its own when this runs out — even if you forget to stop it.' })
    ),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Money' })),
      field('Sales tax %', tax, 'Leave at 0 if you do not charge it.'),
      field('Tip suggestions %', tips, 'Comma separated, up to four. Customers can always type their own.'),
      field('Invoice prefix', invoicePrefix),
      field('How to pay', payInstructions, 'Shown on the customer\'s invoice.')
    ),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'The customer page' })),
      switchRow('Let customers add extras themselves', 'They only ever see the ones you have marked as theirs to pick.', allowAddons, (on) => { allowAddons = on; }),
      field('Review prompt', reviewPrompt, 'The wording above the star rating. Keep it light.')
    ),

    h('div', { class: 'card' },
      h('button', { class: 'btn btn--primary btn--block btn--big', text: 'Save settings', onClick: save })
    ),

    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { text: 'Texting' })),
      h('p', { class: 'small muted', text: data.sms_provider === 'twilio'
        ? 'Connected to Twilio — texts go out on their own.'
        : 'No texting service is connected. Every message is prepared for you to send from your own phone, which costs nothing and needs no account.' }),
      h('p', { class: 'small faint', style: { marginTop: '8px' }, text: `Links are built on ${data.public_base_url}` })
    )
  );
}

async function renderReviews() {
  const { reviews, average } = await api.get('/api/admin/reviews');
  const reload = () => renderReviews();

  mount(app,
    backHeader('Reviews', '#/setup'),
    average ? h('div', { class: 'card' },
      h('div', { class: 'spread' },
        h('div', {},
          h('div', { class: 'stat-value', text: String(average) }),
          h('div', { class: 'stat-label', text: `across ${reviews.length} review${reviews.length === 1 ? '' : 's'}` })
        ),
        h('div', { style: { fontSize: '1.5rem' }, text: '⭐' })
      )
    ) : null,

    reviews.length
      ? h('div', {}, ...reviews.map((r) => h('div', { class: 'card' },
          h('div', { class: 'spread' },
            h('div', { style: { fontWeight: '650' }, text: r.customer_name || 'A customer' }),
            h('span', { text: '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) })
          ),
          r.comment ? h('p', { class: 'small', style: { marginTop: '8px' }, text: r.comment }) : null,
          h('div', { class: 'spread', style: { marginTop: '12px' } },
            h('span', { class: 'small faint', text: `${r.service_name} · ${fmtDate(r.created_at)}` }),
            h('button', {
              class: `btn btn--sm${r.published ? '' : ' btn--primary'}`,
              text: r.published ? 'Published' : 'Publish',
              onClick: async () => {
                await api.patch(`/api/admin/reviews/${r.id}`, { published: !r.published });
                reload();
              },
            })
          )
        )))
      : h('div', { class: 'card' }, empty('⭐', 'No reviews yet. They are asked for gently, after the job.'))
  );
}

async function renderActivity() {
  const { activity } = await api.get('/api/admin/activity');
  mount(app,
    backHeader('Activity log', '#/setup'),
    h('div', { class: 'card' },
      h('p', { class: 'small muted', text: 'Every change, sign-in attempt and link handed out, with a timestamp. Useful if you ever need to work out what happened.' })
    ),
    h('div', { class: 'card card--flush' }, ...activity.map((row) => h('div', { class: 'row' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title', text: row.action }),
        h('div', { class: 'row-sub', text: [row.entity && `${row.entity} ${row.entity_id}`, row.meta].filter(Boolean).join(' · ') })
      ),
      h('div', { class: 'row-end small faint', text: fmtRelative(row.created_at) })
    )))
  );
}

/* ========================================================================== */

boot();
