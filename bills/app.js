/* =============================================================================
   Bill Cushion — daily set-aside tracker with a safety cushion
   -----------------------------------------------------------------------------
   The rule this whole app enforces:

     Every bill must be FULLY funded `cushionDays` (default 5) BEFORE its due
     date. The daily amount is always:

         money still needed  ÷  funding days left until the cushion date

   Because it recalculates from what you've actually banked, missing a day
   automatically raises tomorrow's number instead of silently putting you
   behind. Nothing is sent anywhere — everything lives in this device.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
     1. Constants & small utilities
     ------------------------------------------------------------------------ */

  var STORE_KEY = 'billcushion.v1';
  var BACKUP_KEY = 'billcushion.lastgood';   // the state as of the last clean open
  var APP_VERSION = '2026.09.05';            // bump when shipping; shown under More
  var MS_DAY = 86400000;
  var DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DOW_MID = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var DOW_MIN = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  var MON_MID = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];
  var BUFFER_ID = '__buffer__';

  var RECURRENCE = [
    { v: 'once', label: 'One time only' },
    { v: 'weekly', label: 'Every week' },
    { v: 'biweekly', label: 'Every 2 weeks' },
    { v: 'monthly', label: 'Every month' },
    { v: 'quarterly', label: 'Every 3 months' },
    { v: 'yearly', label: 'Every year' },
    { v: 'schedule', label: 'A set list of dates' }
  ];

  var TEMPLATES = [
    { icon: '🏠', name: 'Rent' }, { icon: '🚗', name: 'Car payment' },
    { icon: '🛡️', name: 'Car insurance' }, { icon: '📱', name: 'Phone' },
    { icon: '⚡', name: 'Electric' }, { icon: '🌐', name: 'Internet' },
    { icon: '💧', name: 'Water' }, { icon: '🔥', name: 'Gas' },
    { icon: '💳', name: 'Credit card' }, { icon: '⛽', name: 'Fuel' },
    { icon: '🛒', name: 'Groceries' }, { icon: '🏦', name: 'Loan' },
    { icon: '📺', name: 'Subscriptions' }, { icon: '🏥', name: 'Medical' },
    { icon: '👶', name: 'Childcare' }, { icon: '📦', name: 'Storage' }
  ];
  var ICONS = ['🏠', '🚗', '🛡️', '📱', '⚡', '🌐', '💧', '🔥', '💳', '⛽', '🛒',
               '🏦', '📺', '🏥', '👶', '📦', '🎓', '🐕', '💼', '🧾'];

  // ----- the business side -----
  var SERVICES = ['Full detail', 'Interior only', 'Exterior only', 'Wash & wax',
                  'Ceramic coating', 'Headlight restore', 'Engine bay', 'Other'];
  var EXPENSE_CATS = [
    { v: 'supplies', label: 'Supplies', icon: '🧴' },
    { v: 'fuel', label: 'Fuel', icon: '⛽' },
    { v: 'equipment', label: 'Equipment', icon: '🔧' },
    { v: 'travel', label: 'Travel', icon: '🚙' },
    { v: 'marketing', label: 'Marketing', icon: '📣' },
    { v: 'fees', label: 'Fees', icon: '🏦' },
    { v: 'other', label: 'Other', icon: '📎' }
  ];
  var METHODS = [
    { v: 'cash', label: 'Cash', icon: '💵' },
    { v: 'card', label: 'Card', icon: '💳' },
    { v: 'transfer', label: 'Transfer', icon: '📲' }
  ];
  var PARTNER_MODES = [
    { v: 'none', label: 'Nothing' },
    { v: 'pctRevenue', label: '% of what comes in', suffix: '%' },
    { v: 'pctProfit', label: '% of profit after costs', suffix: '%' },
    { v: 'perJob', label: 'A set amount per job', suffix: '$' },
    { v: 'perDay', label: 'A set amount per working day', suffix: '$' }
  ];

  // validated categorical slots (see dataviz palette) — light / dark
  var VIZ = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
  var VIZ_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
  function vizColors() {
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    return dark ? VIZ_DARK : VIZ;
  }

  function pad(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fromISO(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function todayISO() { return toISO(new Date()); }
  function addDays(iso, n) { var d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); }
  function diffDays(a, b) { return Math.round((fromISO(b) - fromISO(a)) / MS_DAY); }
  function dow(iso) { return fromISO(iso).getDay(); }
  function isPast(iso) { return diffDays(iso, todayISO()) > 0; }
  function isFuture(iso) { return diffDays(todayISO(), iso) > 0; }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function ceilTo(n, step) {
    if (!step || step <= 0) step = 0.01;
    return Math.round(Math.ceil((n - 1e-9) / step) * step * 100) / 100;
  }
  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  var fmtMoney = null;
  function money(n) {
    if (!fmtMoney) {
      try {
        fmtMoney = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
      } catch (e) { fmtMoney = { format: function (x) { return '$' + x.toFixed(2); } }; }
    }
    return fmtMoney.format(round2(n || 0));
  }
  function money0(n) {
    n = round2(n || 0);
    if (Math.abs(n) >= 1000) return '$' + (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return '$' + (Math.abs(n % 1) < 0.005 ? n.toFixed(0) : n.toFixed(2));
  }
  function pct(n) { return Math.round(clamp(n, 0, 1) * 100); }

  function fmtDate(iso, style) {
    var d = fromISO(iso);
    if (style === 'long') return DOW_LONG[d.getDay()] + ', ' + MON_LONG[d.getMonth()] + ' ' + d.getDate();
    if (style === 'dow') return DOW_MID[d.getDay()] + ' ' + MON_MID[d.getMonth()] + ' ' + d.getDate();
    return MON_MID[d.getMonth()] + ' ' + d.getDate();
  }
  function relDay(iso) {
    var n = diffDays(todayISO(), iso);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    if (n < 0) return Math.abs(n) + ' days ago';
    return 'in ' + n + ' days';
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------------------------------------------------------------------------
     2. State & persistence
     ------------------------------------------------------------------------ */

  function defaults() {
    return {
      version: 2,
      settings: {
        partner: { name: 'Logan', mode: 'none', value: 0 },
        taxRate: 0,
        autoSetAside: true,        // money earned funds the bills without being asked
        cushionDays: 6,
        cushionMode: 'workdays',   // count the cushion in workdays, not calendar days
        countMode: 'workdays',     // 'workdays' | 'alldays' | 'estimate'
        workdays: [1, 2, 3, 4, 5], // 0 = Sunday
        daysPerWeek: 5,            // 'estimate' mode: how many days a week you usually work
        roundTo: 0.01,             // round the daily ask up to this step
        installDismissed: false,
        lastBackup: null
      },
      bills: [],
      contributions: [],
      days: {},                    // iso -> { completed, skipped, planned, at }
      overrides: { work: [], off: [] },
      jobs: [],                    // money in  { id, date, amount, service, client, method, note, ts }
      expenses: [],                // money out { id, date, amount, category, note, ts }
      payouts: [],                 // settled   { id, date, amount, to: 'partner'|'tax', note, ts }
      meta: { created: todayISO() }
    };
  }

  var state = defaults();
  var rev = 0;             // bumped on every mutation; invalidates caches
  var lastUndo = null;
  var toastTimer = null;
  var view = 'today';
  var loadState = 'empty';   // 'ok' | 'empty' | 'corrupt' | 'blocked'
  var saveWorks = true;      // set false when a write does not read back
  var calMonth = null;     // {y, m} for the plan calendar
  var showArchived = false;
  var showBillRows = null;    // null = decide by how many bills there are

  /**
   * A short list is worth seeing; a long one is a wall. Show up to four, fold
   * beyond that, and let an explicit tap win either way.
   */
  function billRowsVisible() {
    if (showBillRows !== null) return showBillRows;
    return datedBills().length <= 4;
  }

  function load() {
    var raw;
    try {
      raw = localStorage.getItem(STORE_KEY);
    } catch (e) {
      // storage itself is unavailable — a private tab, or blocked site data
      loadState = 'blocked';
      console.warn('Storage unavailable', e);
      return;
    }

    if (!raw) { loadState = 'empty'; return; }

    var d;
    try {
      d = JSON.parse(raw);
    } catch (e) {
      // Readable but not parseable. Leave it exactly where it is — overwriting
      // it with defaults would destroy whatever might still be recoverable.
      loadState = 'corrupt';
      console.warn('Saved data could not be read', e);
      return;
    }
    if (!d || typeof d !== 'object' || !Array.isArray(d.bills)) {
      loadState = 'corrupt';
      return;
    }

    try {
      var base = defaults();
      state = {
        version: 2,
        settings: Object.assign(base.settings, d.settings || {}),
        bills: Array.isArray(d.bills) ? d.bills : [],
        contributions: Array.isArray(d.contributions) ? d.contributions : [],
        days: d.days && typeof d.days === 'object' ? d.days : {},
        overrides: Object.assign(base.overrides, d.overrides || {}),
        jobs: Array.isArray(d.jobs) ? d.jobs : [],
        expenses: Array.isArray(d.expenses) ? d.expenses : [],
        payouts: Array.isArray(d.payouts) ? d.payouts : [],
        meta: Object.assign(base.meta, d.meta || {})
      };
      // a v1 backup has no partner block of its own
      state.settings.partner = Object.assign(
        { name: 'Logan', mode: 'none', value: 0 },
        (d.settings && d.settings.partner) || {}
      );
      state.bills.forEach(function (b) {
        if (b.cycle == null) b.cycle = 0;
        if (!b.cycleStart) b.cycleStart = b.createdAt || state.meta.created;
        if (!Array.isArray(b.paidHistory)) b.paidHistory = [];
      });
      state.contributions.forEach(function (c) { if (c.cycle == null) c.cycle = 0; });
      // expenses used to carry only a note; the note was always the item
      state.expenses.forEach(function (e) { if (!e.item) e.item = e.note || ''; });
      if (!state.settings.workdays.length) state.settings.workdays = [1, 2, 3, 4, 5];
      loadState = 'ok';

      // Keep the last clean open as a fallback, so a bad write later today
      // still has something to fall back to.
      if (state.bills.length || state.jobs.length || state.expenses.length) {
        try { localStorage.setItem(BACKUP_KEY, raw); } catch (e2) { /* not fatal */ }
      }
    } catch (e) {
      loadState = 'corrupt';
      console.warn('Could not read saved data', e);
    }
  }

  /** Is there a usable fallback copy? */
  function lastGood() {
    try {
      var raw = localStorage.getItem(BACKUP_KEY);
      if (!raw) return null;
      var d = JSON.parse(raw);
      return d && Array.isArray(d.bills) ? { raw: raw, data: d } : null;
    } catch (e) { return null; }
  }

  var syncing = false;

  function save() {
    // Rebuild the automatic set-aside from whatever just changed. Doing it
    // here rather than at each call site means no edit can quietly skip it.
    if (!syncing) {
      syncing = true;
      try { syncAllAuto(); } catch (e) { console.warn('auto set-aside', e); }
      syncing = false;
    }
    rev++;
    var payload = JSON.stringify(state);
    try {
      localStorage.setItem(STORE_KEY, payload);
      // Trust nothing: a write that does not read back has not happened.
      saveWorks = localStorage.getItem(STORE_KEY) === payload;
    } catch (e) {
      saveWorks = false;
    }
    if (!saveWorks) {
      toast('⚠️ This browser is not saving — see More for how to fix it');
    }
  }

  /* ---------------------------------------------------------------------------
     3. Schedule — which days count as "funding days"
     ------------------------------------------------------------------------ */

  function isFundingDay(iso) {
    if (state.settings.countMode === 'alldays') return true;
    if (state.overrides.off.indexOf(iso) !== -1) return false;
    if (state.overrides.work.indexOf(iso) !== -1) return true;
    // Unpredictable work: any day might be a working day, so any day can take money.
    if (state.settings.countMode === 'estimate') return true;
    return state.settings.workdays.indexOf(dow(iso)) !== -1;
  }

  function perWeek() { return clamp(state.settings.daysPerWeek || 5, 1, 7); }

  /** Funding days from `a` to `b`, both ends included. */
  function countFundingDays(a, b) {
    var span = diffDays(a, b);
    if (span < 0) return 0;
    if (state.settings.countMode === 'alldays') return span + 1;
    // No fixed pattern to count, so scale calendar days by how often you work.
    if (state.settings.countMode === 'estimate') {
      return Math.max(1, Math.round((span + 1) * perWeek() / 7));
    }
    if (span > 1500) span = 1500;
    var n = 0, iso = a;
    for (var i = 0; i <= span; i++) {
      if (isFundingDay(iso)) n++;
      iso = addDays(iso, 1);
    }
    return n;
  }

  function nextFundingDay(iso) {
    var d = iso;
    for (var i = 0; i < 400; i++) {
      if (isFundingDay(d)) return d;
      d = addDays(d, 1);
    }
    return null;
  }

  /* ---------------------------------------------------------------------------
     4. Bills — derived values
     ------------------------------------------------------------------------ */

  function activeBills() {
    return state.bills.filter(function (b) { return !b.archived; });
  }
  function isDated(b) { return !!b.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(b.dueDate); }
  /** Bills the maths can actually price. An undated bill is parked, not counted. */
  function datedBills() { return activeBills().filter(isDated); }
  function undatedBills() { return activeBills().filter(function (b) { return !isDated(b); }); }
  function billById(id) {
    for (var i = 0; i < state.bills.length; i++) if (state.bills[i].id === id) return state.bills[i];
    return null;
  }
  function cushionOf(b) {
    return b.cushionDays == null ? state.settings.cushionDays : b.cushionDays;
  }

  /** How many calendar days it takes to get through n working days. */
  function fundingToCalendar(k) {
    if (k <= 0) return 0;
    var mode = state.settings.countMode;
    if (mode === 'alldays') return k;
    if (mode === 'estimate') return Math.ceil(k * 7 / perWeek());
    var d = todayISO(), hit = 0, cal = 0;
    for (var i = 0; i < 900 && hit < k; i++) {
      d = addDays(d, 1); cal++;
      if (isFundingDay(d)) hit++;
    }
    return cal;
  }

  /** Walk back n funding days from a date — "6 workdays before it's due". */
  function backFundingDays(iso, n) {
    if (n <= 0) return iso;
    // Six working days is longer in calendar time the less often you work.
    if (state.settings.countMode === 'estimate') return addDays(iso, -Math.ceil(n * 7 / perWeek()));
    if (state.settings.countMode === 'alldays') return addDays(iso, -n);
    var d = iso, hit = 0;
    for (var i = 0; i < 600 && hit < n; i++) {
      d = addDays(d, -1);
      if (isFundingDay(d)) hit++;
    }
    return d;
  }

  /** The date money must be fully in place by, for a given due date. */
  function cushionDateFor(dueISO, n) {
    return state.settings.cushionMode === 'workdays'
      ? backFundingDays(dueISO, n)
      : addDays(dueISO, -n);
  }

  /** The date the bill must be 100% funded by. */
  function targetDate(b) { return cushionDateFor(b.dueDate, cushionOf(b)); }

  var unitWord = function () { return state.settings.countMode === 'alldays' ? 'day' : 'workday'; };
  var cushionWords = function (n) {
    if (n == null) n = state.settings.cushionDays;
    return plural(n, state.settings.cushionMode === 'workdays' ? unitWord() : 'day');
  };

  // contribution index, rebuilt when state changes
  var _idx = { rev: -1, byBill: null };
  function idx() {
    if (_idx.rev !== rev) {
      var m = {};
      state.contributions.forEach(function (c) {
        (m[c.billId] || (m[c.billId] = [])).push(c);
      });
      _idx = { rev: rev, byBill: m };
    }
    return _idx.byBill;
  }

  /** Money banked for a bill's CURRENT cycle. `beforeISO` = strictly before that date. */
  function savedFor(b, beforeISO) {
    var list = idx()[b.id] || [], sum = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.cycle !== b.cycle) continue;
      if (beforeISO && diffDays(c.date, beforeISO) <= 0) continue;
      sum += c.amount;
    }
    return round2(sum);
  }
  function sumOn(b, iso) {
    var list = idx()[b.id] || [], sum = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].cycle === b.cycle && list[i].date === iso) sum += list[i].amount;
    }
    return round2(sum);
  }
  function contributionsOn(iso) {
    return state.contributions.filter(function (c) { return c.date === iso; });
  }
  function dayActual(iso) {
    return round2(contributionsOn(iso).reduce(function (s, c) { return s + c.amount; }, 0));
  }
  function bufferTotal() {
    return round2((idx()[BUFFER_ID] || []).reduce(function (s, c) { return s + c.amount; }, 0));
  }
  /** Total cash you should physically be holding right now. */
  function vaultTotal() {
    return round2(activeBills().reduce(function (s, b) { return s + savedFor(b); }, 0) + bufferTotal());
  }

  /* ---------------------------------------------------------------------------
     5. The core math — daily requirement, projected forward
     ------------------------------------------------------------------------ */

  /**
   * Walk day by day from `startISO` to `endISO`, returning for each date:
   *   planned   : what the plan asks for that day (before that day's money)
   *   remaining : what's still owed that day (after money already logged)
   *   actual    : what was actually set aside that day
   * Past/today use real contributions; future days assume the plan is followed.
   */
  function simulate(startISO, endISO) {
    var bills = datedBills();
    var rows = bills.map(function (b) {
      return { b: b, target: targetDate(b), saved: savedFor(b, startISO) };
    });
    var out = {};
    var span = clamp(diffDays(startISO, endISO), 0, 800);
    var iso = startISO;
    var step = state.settings.roundTo;

    for (var i = 0; i <= span; i++) {
      var funding = isFundingDay(iso);

      // The day's ask is fixed at the start of the day...
      var planned = need(rows, iso, funding, step);

      // ...then money actually set aside that day is banked against it.
      var paid = {}, actualTotal = 0;
      for (var r = 0; r < rows.length; r++) {
        var got = sumOn(rows[r].b, iso);
        if (got) {
          paid[rows[r].b.id] = got;
          rows[r].saved = round2(rows[r].saved + got);
          actualTotal += got;
        }
      }

      // What's still owed today is simply the ask minus what's already in —
      // never a re-divide over a window that still counts today.
      var remItems = [], remTotal = 0;
      for (var q = 0; q < planned.items.length; q++) {
        var pit = planned.items[q];
        var left = round2(pit.amount - (paid[pit.billId] || 0));
        if (left <= 0.004) continue;
        var copy = {};
        for (var kk in pit) if (Object.prototype.hasOwnProperty.call(pit, kk)) copy[kk] = pit[kk];
        copy.amount = left;
        remItems.push(copy);
        remTotal += left;
      }

      out[iso] = {
        date: iso,
        funding: funding,
        planned: planned.items,
        plannedTotal: planned.total,
        remaining: remItems,
        remainingTotal: round2(remTotal),
        actual: round2(actualTotal)
      };

      // Today and beyond: assume the plan gets followed, so later days stay
      // realistic. Skipping today here would leave its share unbanked and
      // re-charge it across every following day.
      if (!isPast(iso)) {
        for (var k = 0; k < remItems.length; k++) {
          for (var j = 0; j < rows.length; j++) {
            if (rows[j].b.id === remItems[k].billId) rows[j].saved = round2(rows[j].saved + remItems[k].amount);
          }
        }
      }
      iso = addDays(iso, 1);
    }
    return out;
  }

  /** What each bill needs on a single day, given the running saved totals. */
  function need(rows, iso, funding, step) {
    var items = [], total = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var remaining = round2(Math.max(0, r.b.amount - r.saved));
      if (remaining <= 0.004) continue;

      var daysLeft = diffDays(iso, r.target);
      var fundingLeft = countFundingDays(iso, r.target);
      var urgent = daysLeft < 0 || fundingLeft === 0;

      var raw = urgent ? remaining : remaining / fundingLeft;
      var per = Math.min(remaining, ceilTo(raw, step));

      // On a day off nothing is required — unless the cushion date is here.
      var askToday = (urgent || funding) ? per : 0;
      if (askToday <= 0.004) continue;

      items.push({
        billId: r.b.id, name: r.b.name, icon: r.b.icon,
        amount: round2(askToday), urgent: urgent,
        remaining: remaining, fundingLeft: fundingLeft, target: r.target
      });
      total += askToday;
    }
    items.sort(function (a, b) {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      return diffDays(b.target, a.target) || b.amount - a.amount;
    });
    return { items: items, total: round2(total) };
  }

  /** Today's snapshot, used all over the UI. */
  function todayPlan() {
    var t = todayISO();
    return simulate(t, t)[t] || { date: t, funding: isFundingDay(t), planned: [], plannedTotal: 0, remaining: [], remainingTotal: 0, actual: 0 };
  }

  /** Where a bill stands right now. */
  function statusOf(b) {
    var today = todayISO();
    var step = state.settings.roundTo;
    var target = targetDate(b);

    var saved = savedFor(b);                       // everything banked, today included
    var savedStart = savedFor(b, today);           // banked before today
    var paidToday = round2(saved - savedStart);
    var remaining = round2(Math.max(0, b.amount - saved));
    var progress = b.amount > 0 ? clamp(saved / b.amount, 0, 1) : 1;

    var totalDays = Math.max(1, countFundingDays(b.cycleStart, target));
    var elapsed = countFundingDays(b.cycleStart, addDays(today, -1));
    var pace = clamp(elapsed / totalDays, 0, 1);
    var expected = round2(b.amount * pace);

    // Today's share, worked out from where you stood when the day began.
    var fundingIncToday = countFundingDays(today, target);
    var startRemaining = round2(Math.max(0, b.amount - savedStart));
    var todayShare = 0;
    if (startRemaining > 0.004 && fundingIncToday > 0 && isFundingDay(today)) {
      todayShare = Math.min(startRemaining, ceilTo(startRemaining / fundingIncToday, step));
    }
    // Once today's share is covered, today no longer counts as a day left to fund,
    // so the rate on show always satisfies:  rate x days left = still needed.
    var covered = todayShare <= 0.004 || paidToday + 0.004 >= todayShare;
    var fundingLeft = covered ? countFundingDays(addDays(today, 1), target) : fundingIncToday;

    var daysToTarget = diffDays(today, target);
    var daysToDue = diffDays(today, b.dueDate);

    var perDay = 0, urgent = false;
    if (remaining > 0.004) {
      urgent = daysToTarget < 0 || fundingLeft === 0;
      perDay = Math.min(remaining, ceilTo(urgent ? remaining : remaining / fundingLeft, step));
    }

    // Slack: at the rate this cycle was planned at, how many days could you
    // lose and still pay on time? Starts at the cushion, drops a day for every
    // day you don't set anything aside, and climbs back when you work extra.
    // Running it down is not danger — the daily figure rises to cover it — so
    // it is worded as a cushion being used up, never as a missed bill.
    var plannedRate = b.amount / Math.max(1, countFundingDays(b.cycleStart, target));
    var daysNeeded = plannedRate > 0 ? Math.ceil(remaining / plannedRate) : 0;
    var slack = remaining <= 0.004
      ? Math.max(0, daysToDue)
      : Math.floor(daysToDue - fundingToCalendar(daysNeeded));

    // The badge answers the only question that matters — will this bill be
    // paid on time? Being off a straight line with days of cushion still in
    // hand is catching up, not trouble: the daily figure has already taken it
    // on board. Badging all of those "Behind" only buries the ones that count.
    var key = 'ontrack', label = 'On track';
    if (remaining <= 0.004) { key = 'funded'; label = 'Fully funded'; }
    else if (urgent) { key = 'urgent'; label = daysToDue < 0 ? 'Overdue' : 'Due now'; }
    else if (saved + 0.5 < expected) { key = 'behind'; label = 'Catching up'; }
    else if (slack <= 1) { key = 'behind'; label = 'Tight'; }

    return {
      slack: slack,
      bill: b, saved: saved, remaining: remaining, progress: progress,
      pace: pace, expected: expected, shortfall: round2(Math.max(0, expected - saved)),
      perDay: perDay, fundingLeft: fundingLeft, target: target,
      daysToTarget: daysToTarget, daysToDue: daysToDue,
      urgent: urgent, key: key, label: label
    };
  }

  function sortedStatuses() {
    return datedBills().map(statusOf).sort(function (a, b) {
      var rank = { urgent: 0, behind: 1, ontrack: 2, funded: 3 };
      if (rank[a.key] !== rank[b.key]) return rank[a.key] - rank[b.key];
      return diffDays(b.target, a.target);
    });
  }

  /**
   * Split a lump sum across bills: today's asks first (most urgent first),
   * then any leftover pours into the next-most-urgent bill's future need.
   */
  function allocate(amount, iso) {
    var day = simulate(iso, iso)[iso];
    var left = round2(amount);
    var alloc = [];
    var give = function (billId, amt) {
      amt = round2(amt);
      if (amt <= 0.004) return;
      for (var i = 0; i < alloc.length; i++) {
        if (alloc[i].billId === billId) { alloc[i].amount = round2(alloc[i].amount + amt); return; }
      }
      alloc.push({ billId: billId, amount: amt });
    };

    // pass 1 — cover what today asks for
    day.remaining.forEach(function (it) {
      if (left <= 0.004) return;
      var g = Math.min(it.amount, left);
      give(it.billId, g);
      left = round2(left - g);
    });

    // pass 2 — overflow runs ahead on the most urgent bills
    if (left > 0.004) {
      sortedStatuses().forEach(function (s) {
        if (left <= 0.004) return;
        var already = 0;
        alloc.forEach(function (a) { if (a.billId === s.bill.id) already = a.amount; });
        var room = round2(s.remaining - sumOn(s.bill, iso) - already);
        if (room <= 0.004) return;
        var g = Math.min(room, left);
        give(s.bill.id, g);
        left = round2(left - g);
      });
    }
    return { alloc: alloc, leftover: round2(Math.max(0, left)) };
  }

  function streak() {
    var n = 0, iso = todayISO();
    if (!(state.days[iso] && state.days[iso].completed)) iso = addDays(iso, -1);
    for (var i = 0; i < 400; i++) {
      if (diffDays(state.meta.created, iso) < 0) break;
      if (!isFundingDay(iso)) { iso = addDays(iso, -1); continue; }
      if (state.days[iso] && state.days[iso].completed) { n++; iso = addDays(iso, -1); }
      else break;
    }
    return n;
  }

  /** Days a week actually worked over the last four weeks, or null if too new. */
  function actualDaysPerWeek() {
    var start = state.meta.created;
    var from = addDays(todayISO(), -28);
    if (diffDays(start, from) < 0) from = start;
    var span = diffDays(from, addDays(todayISO(), -1));
    if (span < 6) return null;                       // less than a week of history
    var worked = 0;
    for (var i = 0, d = from; i <= span; i++, d = addDays(d, 1)) {
      if (dayActual(d) > 0.004) worked++;
    }
    return worked / ((span + 1) / 7);
  }

  function weekWindow() {
    var t = todayISO();
    var start = addDays(t, -dow(t));
    return { start: start, end: addDays(start, 6) };
  }

  /* ---------------------------------------------------------------------------
     5b. The business side — what a day actually earns you
     -----------------------------------------------------------------------------
     Every day runs the same chain:

        money in
        − what it cost you to do the work
        − your partner's cut
        − tax put by
        − today's share of the bills
        = what you keep

     Break-even runs that chain backwards: given today's costs and bills, what
     does the day have to bring in before you are working for nothing?
     ------------------------------------------------------------------------ */

  function jobsOn(iso) { return state.jobs.filter(function (j) { return j.date === iso; }); }
  function expensesOn(iso) { return state.expenses.filter(function (e) { return e.date === iso; }); }
  function sum(list, key) {
    return round2(list.reduce(function (a, x) { return a + (+x[key || 'amount'] || 0); }, 0));
  }
  function revenueOn(iso) { return sum(jobsOn(iso)); }
  function costsOn(iso) { return sum(expensesOn(iso)); }

  function partnerRate() { return clamp((state.settings.partner || {}).value || 0, 0, 95) / 100; }
  function taxRate() { return clamp(state.settings.taxRate || 0, 0, 95) / 100; }
  function partnerName() { return ((state.settings.partner || {}).name || 'Partner').trim() || 'Partner'; }

  /** Does this job owe the partner a cut? Only false when switched off. */
  function jobHasCut(j) { return j.partnerCut !== false; }

  /**
   * What your partner earns on a given day.
   * Only jobs marked as owing him a cut count — some jobs are your own.
   */
  function partnerCutOn(iso) {
    var p = state.settings.partner || {};
    if (p.mode === 'none') return 0;

    var all = jobsOn(iso);
    var his = all.filter(jobHasCut);
    if (!his.length) return 0;                       // nothing of his today

    var cost = costsOn(iso);
    var totalRev = sum(all);
    var hisRev = sum(his);

    switch (p.mode) {
      case 'pctRevenue':
        return round2(hisRev * partnerRate());
      case 'pctProfit': {
        // costs shared out in proportion to the revenue they helped earn
        var share = totalRev > 0 ? hisRev / totalRev : 0;
        return round2(Math.max(0, hisRev - cost * share) * partnerRate());
      }
      case 'perJob':
        return round2(his.length * (p.value || 0));
      case 'perDay':
        return round2(p.value || 0);
      default:
        return 0;
    }
  }

  /** Tax is taken on what's left after costs and the partner's cut. */
  function taxOn(iso) {
    var base = revenueOn(iso) - costsOn(iso) - partnerCutOn(iso);
    return round2(Math.max(0, base) * taxRate());
  }

  function autoPaidOn(iso) {
    var tag = autoSrc(iso);
    return round2(contributionsOn(iso).reduce(function (a, c) {
      return a + (c.src === tag ? c.amount : 0);
    }, 0));
  }

  /** Bill money put in by hand — which may have come from savings, not today. */
  function manualPaidOn(iso) {
    var tag = autoSrc(iso);
    return round2(contributionsOn(iso).reduce(function (a, c) {
      return a + (c.src === tag ? 0 : c.amount);
    }, 0));
  }

  /**
   * What today's takings still have to cover for bills.
   *
   * The day's target, less anything put in by hand — money set aside from
   * savings does not have to be earned again. Money moved automatically is
   * NOT deducted here: it came out of today's takings, which are already
   * counted on the other side of the sum.
   */
  function billShareOn(iso) {
    var day = simulate(iso, iso)[iso];
    var target = day ? day.plannedTotal : 0;
    return round2(Math.max(0, target - manualPaidOn(iso)));
  }

  /** The whole chain for one day. */
  function dayMoney(iso) {
    var rev = revenueOn(iso);
    var cost = costsOn(iso);
    var partner = partnerCutOn(iso);
    var tax = taxOn(iso);
    var spare = round2(rev - cost - partner - tax);

    var day = simulate(iso, iso)[iso];
    var auto = autoPaidOn(iso);
    var owed = billShareOn(iso);

    // With money moving by itself, the chain shows what actually went across.
    // Without it, it shows what still has to, which is the thing to act on.
    var toBills = state.settings.autoSetAside ? auto : owed;

    return {
      date: iso, revenue: rev, costs: cost,
      grossProfit: round2(rev - cost),
      partner: partner, tax: tax,
      bills: toBills,
      billsAuto: auto,
      billsTarget: day ? day.plannedTotal : 0,
      billsShort: day ? day.remainingTotal : 0,
      jobs: jobsOn(iso).length,
      // what the work itself made you, before any bill money moves
      earned: spare,
      takeHome: round2(spare - toBills)
    };
  }

  /**
   * What the day has to bring in to cover everything.
   * Solved per partner rule, because a percentage cut moves with revenue.
   */
  function breakEvenOn(iso) {
    var p = state.settings.partner || {};
    var cost = costsOn(iso);
    var bills = billShareOn(iso);
    var t = taxRate();
    var afterTax = 1 - t;
    if (afterTax <= 0.01) return null;
    var needAfterPartner = bills / afterTax;          // profit needed once tax is out

    switch (p.mode) {
      case 'pctRevenue': {
        var r = partnerRate();
        if (1 - r <= 0.01) return null;
        return round2((cost + needAfterPartner) / (1 - r));
      }
      case 'pctProfit': {
        var r2 = partnerRate();
        if (1 - r2 <= 0.01) return null;
        return round2(cost + needAfterPartner / (1 - r2));
      }
      case 'perJob':
        return round2(cost + (Math.max(1, jobsOn(iso).filter(jobHasCut).length) * (p.value || 0)) + needAfterPartner);
      case 'perDay':
        return round2(cost + (p.value || 0) + needAfterPartner);
      default:
        return round2(cost + needAfterPartner);
    }
  }

  /* ---------------------------------------------------------------------------
     5c. Money earned funds the bills by itself
     -----------------------------------------------------------------------------
     What a day earns, after costs, the partner's cut and tax, goes straight
     into the bill pot — up to what that day actually owes. Anything above
     that is yours.

     These entries are derived, never typed, so they are rebuilt from scratch
     whenever the day's figures change. Anything set aside by hand is counted
     first and never touched.
     ------------------------------------------------------------------------ */

  function autoSrc(iso) { return 'auto:' + iso; }

  function dropAutoFor(iso) {
    var tag = autoSrc(iso);
    var before = state.contributions.length;
    state.contributions = state.contributions.filter(function (c) { return c.src !== tag; });
    rev++;                 // anything read after this must not see them
    return before !== state.contributions.length;
  }

  /**
   * Rebuild one day's automatic set-aside. Returns what it put in.
   * Safe to call as often as you like — it always clears its own work first.
   */
  /**
   * The earliest day still safe to re-derive. Once a bill is marked paid its
   * cycle closes, and rebuilding an older day would fund the new cycle out of
   * money that already went to the old one.
   */
  function autoSyncFloor() {
    var floor = state.meta.created || todayISO();
    activeBills().forEach(function (b) {
      if (b.cycleStart && diffDays(floor, b.cycleStart) > 0) floor = b.cycleStart;
    });
    return floor;
  }

  function syncAutoSetAside(iso) {
    if (diffDays(autoSyncFloor(), iso) < 0) return 0;   // settled cycle, leave it be
    dropAutoFor(iso);
    if (!state.settings.autoSetAside) return 0;

    // With its own entries gone, this is the day as it genuinely stands.
    var rev = revenueOn(iso);
    if (rev <= 0.004) return 0;
    var spare = round2(Math.max(0, rev - costsOn(iso) - partnerCutOn(iso) - taxOn(iso)));
    if (spare <= 0.004) return 0;

    var day = simulate(iso, iso)[iso];
    var owed = day ? day.remainingTotal : 0;      // after anything set aside by hand
    var give = round2(Math.min(spare, owed));
    if (give <= 0.004) return 0;

    var res = allocate(give, iso);
    logContributions(iso, res.alloc, { src: autoSrc(iso), note: 'From the day\'s work' });
    return give;
  }

  /** Every day that has any work on it — used when a rule changes under them. */
  function activeDays() {
    var seen = {};
    state.jobs.forEach(function (j) { seen[j.date] = 1; });
    state.expenses.forEach(function (e) { seen[e.date] = 1; });
    return Object.keys(seen).sort();
  }

  function syncAllAuto() {
    var total = 0;
    activeDays().forEach(function (iso) { total += syncAutoSetAside(iso); });
    return round2(total);
  }

  /** Running balances: what you still owe your partner, and what tax you're holding. */
  function owedTo(who) {
    var earned = 0;
    var seen = {};
    var scan = who === 'tax' ? taxOn : partnerCutOn;
    state.jobs.forEach(function (j) { seen[j.date] = 1; });
    state.expenses.forEach(function (e) { seen[e.date] = 1; });
    Object.keys(seen).forEach(function (iso) { earned += scan(iso); });
    var paid = state.payouts.reduce(function (a, x) {
      return a + (x.to === who ? (+x.amount || 0) : 0);
    }, 0);
    return round2(earned - paid);
  }

  /**
   * What actually happened across a range.
   *
   * `earned` is the business result — money in, less what it cost, the
   * partner's cut and tax. Bills are deliberately NOT subtracted here: a
   * day's bill figure is a target, not money that left your pocket, and
   * summing targets over days you did not work reports a loss that never
   * happened. What was genuinely moved into the bill pot is reported
   * separately as `billsSetAside`.
   */
  function rangeMoney(fromISO_, toISO_) {
    // Nothing existed before you started, so nothing is owed for those days.
    var from = fromISO_;
    if (state.meta.created && diffDays(state.meta.created, from) < 0) from = state.meta.created;
    if (diffDays(from, toISO_) < 0) from = toISO_;

    var out = { revenue: 0, costs: 0, partner: 0, tax: 0, earned: 0,
                billsSetAside: 0, jobs: 0, days: 0, worked: 0, from: from };
    var span = clamp(diffDays(from, toISO_), 0, 400);
    var iso = from;
    for (var i = 0; i <= span; i++) {
      var m = dayMoney(iso);
      out.revenue += m.revenue; out.costs += m.costs;
      out.partner += m.partner; out.tax += m.tax;
      out.jobs += m.jobs; out.days++;
      if (m.jobs) out.worked++;
      iso = addDays(iso, 1);
    }
    out.earned = out.revenue - out.costs - out.partner - out.tax;

    state.contributions.forEach(function (c) {
      if (diffDays(from, c.date) >= 0 && diffDays(c.date, toISO_) >= 0) out.billsSetAside += c.amount;
    });

    Object.keys(out).forEach(function (k) {
      if (typeof out[k] === 'number') out[k] = round2(out[k]);
    });
    return out;
  }

  /**
   * Things bought before, newest first, with the price last paid.
   * Turns a repeat purchase into one tap instead of typing it out again.
   */
  function recentItems(category, limit) {
    var seen = {}, out = [];
    state.expenses.slice().sort(function (a, b) { return b.ts - a.ts; }).forEach(function (e) {
      var name = (e.item || '').trim();
      if (!name) return;
      if (category && e.category !== category) return;
      var key = name.toLowerCase();
      if (seen[key]) { seen[key].times++; return; }
      seen[key] = { name: name, amount: e.amount, category: e.category, times: 1 };
      out.push(seen[key]);
    });
    out.sort(function (a, b) { return b.times - a.times; });
    return out.slice(0, limit || 6);
  }

  /** Everything spent in one category, with its own totals. */
  function categorySummary(cat, fromISO_, toISO_) {
    var list = state.expenses.filter(function (e) {
      if ((e.category || 'other') !== cat) return false;
      if (fromISO_ && diffDays(fromISO_, e.date) < 0) return false;
      if (toISO_ && diffDays(e.date, toISO_) < 0) return false;
      return true;
    });
    var byItem = {};
    list.forEach(function (e) {
      var k = (e.item || 'Unnamed').trim() || 'Unnamed';
      if (!byItem[k]) byItem[k] = { name: k, total: 0, times: 0 };
      byItem[k].total = round2(byItem[k].total + e.amount);
      byItem[k].times++;
    });
    var days = {};
    list.forEach(function (e) { days[e.date] = 1; });
    return {
      cat: cat, list: list, total: sum(list),
      days: Object.keys(days).length,
      items: Object.keys(byItem).map(function (k) { return byItem[k]; })
        .sort(function (a, b) { return b.total - a.total; })
    };
  }

  function monthWindow(iso) {
    var d = fromISO(iso || todayISO());
    return {
      start: toISO(new Date(d.getFullYear(), d.getMonth(), 1)),
      end: toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0))
    };
  }

  /* ---------------------------------------------------------------------------
     6. Actions
     ------------------------------------------------------------------------ */

  function logContributions(iso, alloc, opts) {
    opts = opts || {};
    var added = [];
    alloc.forEach(function (a) {
      var b = a.billId === BUFFER_ID ? null : billById(a.billId);
      if (a.billId !== BUFFER_ID && !b) return;
      var c = {
        id: uid(), billId: a.billId, cycle: b ? b.cycle : 0,
        date: iso, amount: round2(a.amount), note: opts.note || '',
        src: opts.src || 'manual', ts: Date.now()
      };
      state.contributions.push(c);
      added.push(c.id);
    });
    rev++;                 // the contribution index is keyed on rev
    return added;
  }

  function removeContributions(ids) {
    state.contributions = state.contributions.filter(function (c) { return ids.indexOf(c.id) === -1; });
    rev++;
  }

  function completeDay(iso, o) {
    o = o || {};
    var plan = simulate(iso, iso)[iso];
    var addedIds = [];
    var leftover = 0;

    if (!o.skip && o.amount > 0.004) {
      var res = allocate(o.amount, iso);
      leftover = res.leftover;
      if (leftover > 0.004) res.alloc.push({ billId: BUFFER_ID, amount: leftover });
      addedIds = logContributions(iso, res.alloc, { src: 'day:' + iso });
    }

    var prev = state.days[iso] ? JSON.parse(JSON.stringify(state.days[iso])) : null;
    state.days[iso] = {
      completed: true,
      skipped: !!o.skip,
      planned: plan.plannedTotal,
      at: Date.now()
    };
    save();

    lastUndo = {
      label: 'Day undone',
      fn: function () {
        removeContributions(addedIds);
        if (prev) state.days[iso] = prev; else delete state.days[iso];
        save(); render();
      }
    };

    var msg = o.skip ? '⏭️ ' + fmtDate(iso) + ' marked complete (no money)'
                     : '✅ ' + money(o.amount) + ' set aside · day complete';
    if (leftover > 0.004) msg += ' · ' + money(leftover) + ' extra banked';
    render();
    toast(msg, 'Undo');
  }

  function uncompleteDay(iso) {
    var linked = state.contributions.filter(function (c) { return c.src === 'day:' + iso; });
    var run = function (alsoRemoveMoney) {
      var removed = alsoRemoveMoney ? linked.slice() : [];
      var prev = state.days[iso];
      if (alsoRemoveMoney) removeContributions(linked.map(function (c) { return c.id; }));
      delete state.days[iso];
      save(); render();
      lastUndo = {
        label: 'Restored',
        fn: function () {
          removed.forEach(function (c) { state.contributions.push(c); });
          state.days[iso] = prev; save(); render();
        }
      };
      toast('↩️ ' + fmtDate(iso) + ' reopened', 'Undo');
    };

    if (!linked.length) return run(false);
    confirmSheet({
      title: 'Reopen ' + fmtDate(iso) + '?',
      body: 'You logged ' + money(linked.reduce(function (s, c) { return s + c.amount; }, 0)) +
            ' that day. Do you want to remove that money too, or keep it banked?',
      actions: [
        { label: 'Remove the money too', cls: 'danger', fn: function () { run(true); } },
        { label: 'Keep the money, reopen day', cls: '', fn: function () { run(false); } }
      ]
    });
  }

  function markPaid(b) {
    var saved = savedFor(b);
    var surplus = round2(saved - b.amount);
    var next = advanceDue(b);

    b.paidHistory.push({
      due: b.dueDate, paidOn: todayISO(), amount: b.amount,
      saved: saved, short: round2(Math.max(0, b.amount - saved))
    });

    if (!next) {
      b.archived = true;
      b.archivedAt = todayISO();
    } else {
      b.cycle += 1;
      b.dueDate = next;
      b.cycleStart = todayISO();
      if (surplus > 0.004) {
        state.contributions.push({
          id: uid(), billId: b.id, cycle: b.cycle, date: todayISO(),
          amount: surplus, note: 'Carried over from last cycle', src: 'carry', ts: Date.now()
        });
      }
    }
    save(); render();
    toast('🎉 ' + b.name + ' paid' + (surplus > 0.004 ? ' · ' + money(surplus) + ' rolled forward' : ''));
  }

  function advanceDue(b) {
    var d = fromISO(b.dueDate);
    switch (b.recurrence) {
      case 'weekly': return addDays(b.dueDate, 7);
      case 'biweekly': return addDays(b.dueDate, 14);
      case 'monthly': return shiftMonths(b, 1);
      case 'quarterly': return shiftMonths(b, 3);
      case 'yearly': return shiftMonths(b, 12);
      case 'schedule':
        var list = (b.scheduleDates || []).slice().sort();
        for (var i = 0; i < list.length; i++) {
          if (diffDays(b.dueDate, list[i]) > 0) return list[i];
        }
        // list ran out — keep the same rhythm going
        if (list.length >= 2) {
          var gap = diffDays(list[list.length - 2], list[list.length - 1]);
          if (gap > 0) return addDays(b.dueDate, gap);
        }
        return addDays(b.dueDate, 14);
      default: return null;
    }
  }
  /** Shift an ISO date by whole months, clamping to the end of short months. */
  function monthShift(iso, n) {
    var d = fromISO(iso);
    var anchor = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(anchor, last));
    return toISO(d);
  }

  function shiftMonths(b, n) {
    var d = fromISO(b.dueDate);
    var anchor = b.anchorDay || d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(anchor, last));
    return toISO(d);
  }

  function deleteBill(b) {
    confirmSheet({
      title: 'Delete ' + b.name + '?',
      body: 'This removes the bill and its ' + plural((idx()[b.id] || []).length, 'saved entry', 'saved entries') +
            '. This cannot be undone.',
      actions: [{
        label: 'Delete bill', cls: 'danger', fn: function () {
          state.bills = state.bills.filter(function (x) { return x.id !== b.id; });
          state.contributions = state.contributions.filter(function (c) { return c.billId !== b.id; });
          save(); render(); toast('🗑️ ' + b.name + ' deleted');
        }
      }]
    });
  }

  /* ---------------------------------------------------------------------------
     7. Rendering
     ------------------------------------------------------------------------ */

  function render() {
    var t = todayISO();
    $('#appbar-date').textContent =
      fmtDate(t, 'long') + ' · ' + (isFundingDay(t) ? 'workday' : 'day off');
    renderToday();
    renderBusiness();
    renderBills();
    renderPlan();
    renderMore();
    $$('#tabbar .tab').forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
  }

  /* ---- Today ------------------------------------------------------------- */

  function renderToday() {
    var host = $('#view-today');
    var t = todayISO();
    var bills = activeBills();

    if (!bills.length && !state.jobs.length && !state.expenses.length) {
      host.innerHTML = welcomeHTML();
      return;
    }

    var m = dayMoney(t);
    var be = breakEvenOn(t);
    var p = state.settings.partner || {};
    var day = todayPlan();
    var rec = state.days[t];
    var done = rec && rec.completed;
    var actual = dayActual(t);
    var html = '';

    if (!saveWorks || loadState === 'blocked') {
      html += '<div class="banner bad"><span>🚫</span><div><strong>This browser is not saving anything</strong>' +
        'Nothing you enter will still be here next time. The usual cause is a Private ' +
        'browsing tab — open the app in a normal tab instead. See More for the details.</div></div>';
    }

    var undated = undatedBills();
    if (undated.length) {
      html += '<div class="banner warn"><span>📅</span><div><strong>' +
        plural(undated.length, 'bill') + ' still ' + (undated.length === 1 ? 'needs' : 'need') +
        ' a due date</strong>' + undated.map(function (u) { return esc(u.name); }).join(', ') +
        ' — not counted yet. Set the date on the Bills tab.</div></div>';
    }

    /* ---- hero: what today actually leaves you ---- */
    var cls = 'hero', eyebrow, amount, sub;
    if (!m.jobs && !m.costs) {
      cls += ' is-off';
      eyebrow = 'No jobs yet today';
      amount = be != null ? money(be) : '—';
      sub = be != null
        ? 'what today needs to make to cover it all'
        : 'tap ＋ Job when you finish one';
    } else if (m.takeHome >= 0) {
      eyebrow = 'You keep today';
      amount = money(m.takeHome);
      // A hard day's work can still end at $0 kept. Say where it went rather
      // than leaving a bare zero to be puzzled over.
      sub = money(m.revenue) + ' in across ' + plural(m.jobs, 'job');
      if (m.bills > 0.004) sub += ' · ' + money(m.bills) + ' of it went to bills';
    } else {
      cls += ' is-urgent';
      eyebrow = '⚠️ Short today';
      amount = money(m.takeHome);
      sub = 'another ' + money(be != null ? Math.max(0, be - m.revenue) : -m.takeHome) +
        ' would cover everything';
    }

    html += '<div class="' + cls + '">' +
      '<div class="hero-eyebrow">' + eyebrow + '</div>' +
      '<div class="hero-amount">' + amount + '</div>' +
      '<div class="hero-sub">' + sub + '</div>' +
      '<div class="hero-actions"><div class="btn-row">' +
      '<button class="btn primary" data-act="add-job">＋ Job</button>' +
      '<button class="btn subtle" data-act="add-expense">＋ Expense</button>' +
      '</div></div></div>';

    /* ---- break-even progress, while the day is still short ---- */
    if (be != null && m.revenue < be - 0.004 && (m.jobs || m.costs)) {
      var pctDone = be > 0 ? clamp(m.revenue / be, 0, 1) : 1;
      html += '<div class="card tight"><div class="card-title">Today\'s target' +
        '<span class="faint" style="text-transform:none;letter-spacing:0">' +
        money(m.revenue) + ' of ' + money(be) + '</span></div>' +
        '<div class="bar"><div class="bar-fill" style="width:' + pct(pctDone) + '%"></div></div>' +
        '<div class="small dim mt"><strong>' + money(be - m.revenue) + ' more</strong> ' +
        'and today has paid for itself.</div></div>';
    }

    /* ---- the chain ---- */
    // Only worth showing once there is work on the day — otherwise it would
    // read as a loss to someone who just tracks bills.
    if (m.jobs || m.costs) {
      html += '<div class="card"><div class="card-title">Where today\'s money goes</div><div class="flow">';
      html += flowRow('Money in', plural(m.jobs, 'job'), m.revenue, '');
      if (m.costs > 0.004) html += flowRow('What it cost you', plural(expensesOn(t).length, 'expense'), -m.costs, 'out');
      if (m.partner > 0.004) html += flowRow(esc(partnerName()) + '’s cut', partnerRule(), -m.partner, 'out');
      if (m.tax > 0.004) html += flowRow('Tax put by', state.settings.taxRate + '%', -m.tax, 'out');
      var auto = state.settings.autoSetAside;
      if (m.bills > 0.004) {
        html += flowRow(auto ? 'Set aside for bills' : 'Bills',
          auto ? 'moved for you' : plural(day.planned.length, 'bill'),
          -m.bills, 'out');
      }
      html += '<div class="flow-row total ' + (m.takeHome < 0 ? 'neg' : 'pos') + '">' +
        '<div class="flow-label">You keep</div>' +
        '<div class="flow-amt">' + money(m.takeHome) + '</div></div>';
      html += '</div>';
      if (m.billsShort > 0.004 && m.revenue > 0.004) {
        html += '<div class="hint mt">Bills still want <strong>' + money(m.billsShort) +
          '</strong> today. Earn it and it goes across by itself — or it rolls into ' +
          'tomorrow\'s number.</div>';
      }
      html += '</div>';
    }

    /* ---- today's jobs ---- */
    var jl = jobsOn(t).sort(function (a, b) { return b.ts - a.ts; });
    if (jl.length) {
      html += '<div class="card"><div class="card-title">Jobs today' +
        '<span class="faint" style="text-transform:none;letter-spacing:0">' + money(m.revenue) + '</span></div>';
      jl.forEach(function (j) { html += jobRowHTML(j); });
      html += '</div>';
    }

    /* ---- today's costs ---- */
    var el = expensesOn(t).sort(function (a, b) { return b.ts - a.ts; });
    if (el.length) {
      html += '<div class="card"><div class="card-title">Spent today' +
        '<span class="faint" style="text-transform:none;letter-spacing:0">' + money(m.costs) + '</span></div>';
      el.forEach(function (e) {
        var cat = EXPENSE_CATS.filter(function (x) { return x.v === e.category; })[0];
        html += '<button class="log-row" data-act="edit-expense" data-id="' + e.id + '">' +
          '<div class="log-ico">' + (cat ? cat.icon : '📎') + '</div>' +
          '<div class="log-main"><div class="log-title">' + esc(e.item || (cat ? cat.label : 'Other')) + '</div>' +
          '<div class="log-sub">' + (cat ? cat.label : 'Other') + '</div></div>' +
          '<div class="log-amt out">−' + money(e.amount) + '</div></button>';
      });
      html += '</div>';
    }

    /* ---- yesterday is one tap away, not buried on another tab ---- */
    var yest = addDays(t, -1);
    var yj = jobsOn(yest), ye = expensesOn(yest);
    if (yj.length || ye.length) {
      var ym = dayMoney(yest);
      html += '<button class="log-row" style="width:100%;background:var(--bg-elev);' +
        'border:1px solid var(--line);border-radius:var(--radius);padding:14px;margin-bottom:14px" ' +
        'data-act="open-day" data-date="' + yest + '">' +
        '<div class="log-ico">↩︎</div>' +
        '<div class="log-main"><div class="log-title">Yesterday <span class="go">›</span></div>' +
        '<div class="log-sub">' + money(ym.revenue) + ' in · ' + plural(yj.length, 'job') +
        (ye.length ? ' · ' + plural(ye.length, 'cost') : '') +
        ' — tap to change anything</div></div>' +
        '<div class="log-amt ' + (ym.earned >= 0 ? 'in' : 'out') + '">' + money(ym.earned) + '</div>' +
        '</button>';
    }

    /* ---- the bill set-aside, still the thing that has to happen ---- */
    if (bills.length && datedBills().length) {
      html += '<div class="card"><div class="card-title">Bill money' +
        '<span class="faint" style="text-transform:none;letter-spacing:0" id="bill-state">' +
        (done ? 'day complete ✓' : (day.remainingTotal > 0.004 ? 'to set aside' : 'all covered ✓')) +
        '</span></div>' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:10px">' +
        '<div class="money" id="bill-ask" style="font-size:1.6rem;font-weight:800;letter-spacing:-0.6px">' +
        money(day.remainingTotal) + '</div>' +
        '<div class="small dim" id="bill-slack">' +
        (slackPhrase().replace(/^ · /, '') || plural(day.remaining.length, 'bill')) + '</div></div>';

      var behind = round2(sortedStatuses().reduce(function (a, x) { return a + x.shortfall; }, 0));
      if (behind > 0.5) {
        html += '<div class="hint mb">Today\'s figure includes <strong>' + money(behind) +
          '</strong> of catching up from days you missed — it spreads over the days you ' +
          'have left, so staying on it clears the lot.</div>';
      }

      // One line first. The full list is a tap away rather than nine rows
      // of scrolling before you reach anything else.
      var rowsOpen = billRowsVisible();
      var nextUp = sortedStatuses().filter(function (x) { return x.remaining > 0.004; })[0];
      html += '<div class="list-row" style="border-bottom:none;padding-top:0">' +
        '<div><div class="small">' + plural(datedBills().length, 'bill') + ' tracked</div>' +
        '<div class="lr-sub">' + (nextUp
          ? 'next up ' + esc(nextUp.bill.name) + ' by ' + fmtDate(nextUp.target)
          : 'every one fully funded') + '</div></div>' +
        '<button class="btn sm ghost" data-act="toggle-bill-rows">' +
        (rowsOpen ? 'Hide' : 'Show each') + '</button></div>';

      var split = rowsOpen ? (day.remaining.length ? day.remaining : day.planned) : [];
      split.forEach(function (it) {
        var b = billById(it.billId);
        if (!b) return;
        var st = statusOf(b);
        var covered = !day.remaining.length;
        html += '<button class="split-row" data-act="pay-one" data-id="' + b.id + '" data-amt="' + it.amount + '" ' +
          'style="width:100%;background:none;border:none;border-bottom:1px solid var(--line-soft);text-align:left">' +
          '<div class="split-main"><div class="split-name">' + esc(b.icon || '🧾') + ' ' + esc(b.name) +
          (it.urgent ? ' <span class="pill urgent">now</span>' : '') + '</div>' +
          '<div class="split-note">' + money(st.saved) + ' of ' + money(b.amount) +
          ' · by ' + fmtDate(st.target) + '</div></div>' +
          '<div class="split-amt' + (covered ? ' zero' : '') + '">' +
          (covered ? '✓ ' : '') + money(it.amount) + '</div></button>';
      });

      html += '<div class="mt">';
      if (!done) {
        if (day.remainingTotal > 0.004) {
          // Once the day's takings are accounted for, the rest could only come
          // out of savings. Asking for it in the big green button is how you end
          // up staring at a number you were never going to make today.
          var spent = m.revenue > 0.004 && m.takeHome <= 0.004;
          if (spent) {
            html += '<button class="btn primary" data-act="complete-only">Mark today done</button>' +
              '<div class="hint mt">Everything today made is already accounted for. The last ' +
              money(day.remainingTotal) + ' would have to come out of savings — leave it and it ' +
              'rolls into tomorrow\'s number instead.</div>' +
              '<div class="btn-row mt"><button class="btn" data-act="custom-amount">Add from savings</button>' +
              '<button class="btn" data-act="skip-day">Couldn\'t today</button></div>';
          } else {
            html += '<button class="btn primary" data-act="quick-complete">Set aside ' +
              money(day.remainingTotal) + ' &amp; complete day</button>' +
              '<div class="btn-row mt"><button class="btn" data-act="custom-amount">Different amount</button>' +
              '<button class="btn" data-act="skip-day">Couldn\'t today</button></div>';
          }
        } else {
          html += '<button class="btn primary" data-act="complete-only">Mark day complete</button>';
        }
      } else {
        html += '<div class="btn-row"><button class="btn" data-act="custom-amount">Add more</button>' +
          '<button class="btn" data-act="reopen-day">Reopen day</button></div>';
      }
      html += '</div></div>';
    }

    /* ---- headline numbers ---- */
    var wk = weekWindow();
    var w = rangeMoney(wk.start, wk.end);
    // Read across, these tell the same story as the day above: what came in,
    // what the bills took, what is left. A bare "Yours" here meant money before
    // bills, which sat on screen contradicting the hero's take-home.
    html += '<div class="card tight"><div class="stat-grid">' +
      '<div class="stat"><div class="stat-val money">' + money0(w.revenue) + '</div><div class="stat-lbl">In this week</div></div>' +
      '<div class="stat"><div class="stat-val money">' + money0(w.billsSetAside) + '</div><div class="stat-lbl">To bills</div></div>' +
      '<div class="stat"><div class="stat-val money">' + money0(w.earned - w.billsSetAside) + '</div><div class="stat-lbl">Kept</div></div>' +
      '</div>' +
      '<div class="list-row" style="border-bottom:none;padding-bottom:0"><div class="lr-sub">' +
      plural(w.worked, 'day') + ' worked this week</div>' +
      '<div class="lr-sub" id="day-streak">' + streak() + '🔥 day streak</div></div></div>';

    host.innerHTML = html;
  }

  /**
   * A logged job. The cut is switchable straight from the row — whose job it
   * was is the thing most likely to need changing after the fact, and it
   * should not require opening anything.
   */
  function jobRowHTML(j) {
    var meth = METHODS.filter(function (x) { return x.v === j.method; })[0];
    var p = state.settings.partner || {};
    var owes = jobHasCut(j);
    var cutLabel = p.mode === 'perJob' ? esc(partnerName()) + ' ' + money0(p.value)
      : p.mode === 'pctRevenue' || p.mode === 'pctProfit' ? esc(partnerName()) + ' ' + p.value + '%'
      : esc(partnerName());

    return '<div class="log-row">' +
      '<div class="log-ico">' + (meth ? meth.icon : '💵') + '</div>' +
      '<button class="log-main" data-act="edit-job" data-id="' + j.id + '">' +
      '<div class="log-title">' + esc(j.service || 'Job') + ' <span class="go">›</span></div>' +
      '<div class="log-sub">' + (j.client ? esc(j.client) + ' · ' : '') +
      (meth ? meth.label : '') + (j.note ? ' · ' + esc(j.note) : '') + '</div></button>' +
      '<div class="jrow-right">' +
      '<div class="log-amt in">+' + money(j.amount) + '</div>' +
      (p.mode !== 'none'
        ? '<button class="cut-chip ' + (owes ? 'owes' : 'mine') + '" ' +
          'data-act="toggle-job-cut" data-id="' + j.id + '" ' +
          'aria-label="' + (owes ? 'Owes ' + esc(partnerName()) : 'All yours') + ', tap to change">' +
          (owes ? cutLabel : 'All yours') + '</button>'
        : '') +
      '</div></div>';
  }

  function flowRow(label, sub, amount, cls) {
    return '<div class="flow-row"><div class="flow-label">' + label +
      (sub ? '<span class="fl-sub">' + sub + '</span>' : '') + '</div>' +
      '<div class="flow-amt ' + (cls || '') + '">' +
      (amount < 0 ? '−' + money(-amount) : money(amount)) + '</div></div>';
  }

  /** A short phrase describing the partner arrangement. */
  function partnerRule() {
    var p = state.settings.partner || {};
    switch (p.mode) {
      case 'pctRevenue': return p.value + '% of takings';
      case 'pctProfit': return p.value + '% of profit';
      case 'perJob': return money(p.value) + ' a job';
      case 'perDay': return money(p.value) + ' a day';
      default: return '';
    }
  }


  function tightestSlack() {
    var list = sortedStatuses().filter(function (s) { return s.remaining > 0.004; });
    if (!list.length) return null;
    var min = list[0];
    list.forEach(function (s) { if (s.slack < min.slack) min = s; });
    return min;
  }
  function slackPhrase() {
    var t = tightestSlack();
    if (!t) return '';
    if (t.slack <= 0) return ' · <strong>cushion used up</strong>';
    return ' · ' + plural(t.slack, 'day') + ' to spare';
  }

  function welcomeHTML() {
    return '<div class="card">' +
      '<div class="empty">' +
      '<div class="big">💵</div>' +
      '<h3>Money in, money out, money kept</h3>' +
      '<p>Log what a job pays and what the day costs. Add your bills and it works out what to ' +
      'put aside each day so every one is covered <strong>' + cushionWords() + ' before</strong> ' +
      'it\'s due — then tells you what is genuinely yours to keep.</p>' +
      '<button class="btn primary" data-act="add-job">＋ Log a job</button>' +
      '<button class="btn mt" data-act="add-bill">＋ Add a bill</button>' +
      '<button class="btn mt" data-act="import">📋 Paste a setup code</button>' +
      '</div>' +
      '<div class="sep"></div>' +
      '<div class="card-title">Quick add</div>' +
      '<div class="chip-row">' +
      TEMPLATES.map(function (t) {
        return '<button class="chip" data-act="add-bill" data-name="' + esc(t.name) + '" data-icon="' + t.icon + '">' +
          t.icon + ' ' + esc(t.name) + '</button>';
      }).join('') +
      '</div></div>' +
      '<div class="banner"><span>🗓️</span><div><strong>Workdays: ' +
      state.settings.workdays.map(function (d) { return DOW_MID[d]; }).join(', ') + '</strong>' +
      'Daily amounts are spread across the days you actually work. Change that any time under More.</div></div>';
  }

  /* ---- Bills ------------------------------------------------------------- */

  function renderBills() {
    var host = $('#view-bills');
    var list = sortedStatuses();
    var html = '';

    if (!list.length && !state.bills.length) {
      host.innerHTML = '<div class="empty"><div class="big">🧾</div><h3>No bills yet</h3>' +
        '<p>Add one to start tracking, or paste a setup code you were sent.</p>' +
        '<button class="btn primary" data-act="add-bill">＋ Add a bill</button>' +
        '<button class="btn mt" data-act="import">📋 Paste a setup code</button></div>';
      return;
    }

    if (undatedBills().length && !list.length) {
      html += '<div class="banner warn"><span>📅</span><div><strong>Set a due date on each bill</strong>' +
        'Amounts are in. Tap a bill, pick when it\'s due, and the daily figure appears.</div></div>';
    }

    var totalAmt = list.reduce(function (s, x) { return s + x.bill.amount; }, 0);
    var totalSaved = list.reduce(function (s, x) { return s + x.saved; }, 0);
    var perDayAll = list.reduce(function (s, x) { return s + x.perDay; }, 0);
    var buf = bufferTotal();

    // One plain line answering "am I okay?" before any of the detail below.
    var atRisk = list.filter(function (x) { return x.key === 'urgent'; });
    var tight = list.filter(function (x) { return x.remaining > 0.004 && x.slack <= 1; });
    var owing = list.filter(function (x) { return x.remaining > 0.004; });
    if (list.length) {
      var tone, icon, text;
      if (atRisk.length) {
        tone = 'warn'; icon = '⚠️';
        text = '<strong>' + plural(atRisk.length, 'bill') + ' need' + (atRisk.length === 1 ? 's' : '') +
          ' attention</strong>' +
          atRisk.map(function (x) { return esc(x.bill.name); }).join(', ') +
          ' — at this rate ' + (atRisk.length === 1 ? 'it will not' : 'they will not') +
          ' be ready in time. Put extra in whenever you can.';
      } else if (!owing.length) {
        tone = 'good'; icon = '🎉';
        text = '<strong>Every bill is fully funded</strong>' +
          'Nothing more to set aside. Anything you earn now is yours.';
      } else {
        var next = owing.slice().sort(function (a, b) { return diffDays(b.target, a.target); })[0];
        tone = 'good'; icon = '✅';
        text = '<strong>All ' + plural(list.length, 'bill') + ' are on course</strong>' +
          'Keep to ' + money(perDayAll) + ' a ' + unitWord() + ' and every one is ready before it is due. ' +
          'Next up ' + esc(next.bill.name) + ', fully funded by ' + fmtDate(next.target) + '.' +
          (tight.length ? ' ' + plural(tight.length, 'bill') + ' ' +
            (tight.length === 1 ? 'has' : 'have') + ' no cushion left, so try not to miss a day.' : '');
      }
      html += '<div class="banner ' + tone + '"><span>' + icon + '</span><div>' + text + '</div></div>';
    }

    html += '<div class="card tight"><div class="stat-grid">' +
      '<div class="stat"><div class="stat-val money">' + money0(totalSaved) + '</div><div class="stat-lbl">Saved</div></div>' +
      '<div class="stat"><div class="stat-val money">' + money0(Math.max(0, totalAmt - totalSaved)) + '</div><div class="stat-lbl">Still needed</div></div>' +
      '<div class="stat"><div class="stat-val money">' + money0(perDayAll) + '</div><div class="stat-lbl">Per workday</div></div>' +
      '</div>';
    if (buf > 0.004) {
      html += '<div class="list-row" style="margin-top:6px"><div><div>💰 Extra buffer</div>' +
        '<div class="lr-sub">Banked beyond what your bills need</div></div>' +
        '<div class="lr-amt">' + money(buf) + '</div></div>';
    }
    html += '</div>';

    list.forEach(function (s) { html += billCardHTML(s); });

    undatedBills().forEach(function (b) {
      html += '<button class="bill s-behind" data-act="open-bill" data-id="' + b.id + '">' +
        '<div class="bill-top"><div class="bill-name">' + esc(b.icon || '🧾') + ' ' + esc(b.name) + '</div>' +
        '<div class="bill-amt">' + money(b.amount) + '</div></div>' +
        '<div class="bill-meta"><span class="pill behind">needs a date</span>' +
        '<span>Tap to set when it\'s due — then it joins your daily amount.</span></div></button>';
    });

    var archived = state.bills.filter(function (b) { return b.archived; });
    if (archived.length) {
      html += '<button class="btn ghost mt" data-act="toggle-archived">' +
        (showArchived ? 'Hide' : 'Show') + ' ' + plural(archived.length, 'finished bill') + '</button>';
      if (showArchived) {
        archived.forEach(function (b) {
          html += '<button class="bill" data-act="open-bill" data-id="' + b.id + '" style="opacity:.6">' +
            '<div class="bill-top"><div class="bill-name strike">' + esc(b.icon || '🧾') + ' ' + esc(b.name) + '</div>' +
            '<div class="bill-amt">' + money(b.amount) + '</div></div>' +
            '<div class="bill-meta"><span class="pill paid">done</span><span>paid ' +
            (b.paidHistory.length ? fmtDate(b.paidHistory[b.paidHistory.length - 1].paidOn) : '—') + '</span></div>' +
            '</button>';
        });
      }
    }

    html += '<button class="btn mt" data-act="add-bill">＋ Add a bill</button>';
    host.innerHTML = html;
  }

  function billCardHTML(s) {
    var b = s.bill;
    var h = '<button class="bill s-' + s.key + '" data-act="open-bill" data-id="' + b.id + '">';
    h += '<div class="bill-top">' +
      '<div class="bill-name">' + esc(b.icon || '🧾') + ' ' + esc(b.name) + '</div>' +
      '<div class="bill-amt">' + money(s.saved) + ' <small>/ ' + money(b.amount) + '</small></div>' +
      '</div>';

    h += '<div class="bar"><div class="bar-fill" style="width:' + pct(s.progress) + '%"></div>' +
      (s.key === 'funded' ? '' : '<div class="bar-target" style="left:' + pct(s.pace) + '%"></div>') +
      '</div>';

    var unit = state.settings.countMode === 'alldays' ? 'day' : 'workday';

    h += '<div class="bill-meta"><span class="pill ' + s.key + '">' + s.label + '</span>';
    if (s.key === 'funded') {
      h += '<span>✓ covered ' + plural(Math.max(0, s.daysToDue), 'day') + ' before it\'s due</span>';
    } else if (s.urgent) {
      h += '<span><strong>' + money(s.remaining) + ' needed now</strong></span>';
    } else {
      h += '<span><strong>' + money(s.perDay) + ' per ' + unit + '</strong></span>' +
        '<span class="faint">× ' + plural(s.fundingLeft, unit) + ' left = ' + money(s.remaining) + '</span>';
    }
    h += '</div>';

    h += '<div class="bill-meta tiny">' +
      '<span>Fully funded by <strong>' + fmtDate(s.target, 'dow') + '</strong></span>' +
      '<span class="faint">· due ' + fmtDate(b.dueDate) + ' (' + relDay(b.dueDate) + ')</span>' +
      (s.remaining > 0.004 && s.slack <= 1
        ? '<span>· <strong>' + (s.slack <= 0 ? 'cushion used up' : '1 day to spare') + '</strong></span>'
        : '') +
      (s.key === 'behind' ? '<span>· <strong>' + money(s.shortfall) + ' behind pace</strong></span>' : '') +
      '</div></button>';
    return h;
  }

  /* ---- Business ----------------------------------------------------------- */

  function renderBusiness() {
    var host = $('#view-business');
    var t = todayISO();

    if (!state.jobs.length && !state.expenses.length) {
      host.innerHTML = '<div class="empty"><div class="big">📈</div><h3>No work logged yet</h3>' +
        '<p>Log what a job brought in and what the day cost you. Everything here fills in from that.</p>' +
        '<button class="btn primary" data-act="add-job">＋ Log a job</button>' +
        '<button class="btn mt" data-act="add-expense">＋ Log an expense</button></div>';
      return;
    }

    var mw = monthWindow(t);
    var mon = rangeMoney(mw.start, t);            // month so far
    var html = '';

    /* headline */
    html += '<div class="card tight"><div class="card-title">' + MON_LONG[fromISO(t).getMonth()] + ' so far</div>' +
      '<div class="stat-grid">' +
      '<div class="stat"><div class="stat-val money">' + money0(mon.revenue) + '</div><div class="stat-lbl">Money in</div></div>' +
      '<div class="stat"><div class="stat-val money">' + money0(mon.earned) + '</div><div class="stat-lbl">Yours</div></div>' +
      '<div class="stat"><div class="stat-val">' + mon.jobs + '</div><div class="stat-lbl">Jobs</div></div>' +
      '</div>';
    html += '<div class="hint" style="margin-top:8px">"Yours" is what the work made you — ' +
      'after costs' + ((state.settings.partner || {}).mode !== 'none'
        ? ' and ' + esc(partnerName()) + '\'s cut' : '') +
      (taxRate() > 0 ? ' and tax' : '') +
      ', before any of it goes to bills.</div>';

    if (mon.worked) {
      html += '<div class="list-row" style="margin-top:6px"><div><div>Average working day</div>' +
        '<div class="lr-sub">' + plural(mon.worked, 'day') + ' worked · ' +
        money(mon.jobs ? mon.revenue / mon.jobs : 0) + ' a job</div></div>' +
        '<div class="lr-amt">' + money(mon.revenue / mon.worked) + '</div></div>';
    }
    html += '</div>';

    /* ---- 14 days: what came in, against what a day needs ---- */
    html += chartHTML(14);

    /* ---- where the month's money went ---- */
    // Every dollar that came in, split by where it went. Bills are not in
    // here: money set aside is moved, not spent, and often comes from
    // savings rather than this month's work — it gets its own line below.
    var segs = [
      { label: 'Costs', v: mon.costs },
      { label: esc(partnerName()), v: mon.partner },
      { label: 'Tax', v: mon.tax },
      { label: 'Yours', v: Math.max(0, mon.earned) }
    ].filter(function (x) { return x.v > 0.004; });
    var segTotal = segs.reduce(function (a, x) { return a + x.v; }, 0);
    var cols = vizColors();

    if (segTotal > 0.004) {
      html += '<div class="card"><div class="card-title">Where the money went</div>' +
        '<div class="comp-bar">' +
        segs.map(function (x, i) {
          return '<i style="width:' + (x.v / segTotal * 100).toFixed(2) + '%;background:' + cols[i % cols.length] + '"></i>';
        }).join('') + '</div>' +
        '<div class="comp-key">' +
        segs.map(function (x, i) {
          return '<div class="list-row"><div class="ck"><i style="background:' + cols[i % cols.length] + '"></i>' +
            x.label + '</div><div class="lr-amt">' + money(x.v) +
            ' <span class="faint tiny">' + Math.round(x.v / segTotal * 100) + '%</span></div></div>';
        }).join('') + '</div>';
      if (mon.billsSetAside > 0.004) {
        html += '<div class="list-row" style="border-top:1px solid var(--line);margin-top:6px">' +
          '<div><div>Set aside for bills</div>' +
          '<div class="lr-sub">Moved into the bill pot this month, not spent</div></div>' +
          '<div class="lr-amt">' + money(mon.billsSetAside) + '</div></div>';
      }
      if (mon.earned < -0.004) {
        html += '<div class="banner bad mt"><span>⚠️</span><div><strong>' +
          money(-mon.earned) + ' down this month</strong>' +
          'What the work cost you' + ((state.settings.partner || {}).mode !== 'none'
            ? ', plus ' + esc(partnerName()) + '\'s cut' : '') +
          ', comes to more than the jobs brought in.</div></div>';
      }
      html += '</div>';
    }

    /* ---- what you owe ---- */
    var owedPartner = owedTo('partner');
    var heldTax = owedTo('tax');
    if ((state.settings.partner || {}).mode !== 'none' || taxRate() > 0) {
      html += '<div class="card"><div class="card-title">Money that isn\'t yours</div>';
      if ((state.settings.partner || {}).mode !== 'none') {
        html += '<div class="list-row"><div><div>Owed to ' + esc(partnerName()) + '</div>' +
          '<div class="lr-sub">' + partnerRule() + '</div></div>' +
          '<div class="lr-amt">' + money(owedPartner) + '</div></div>' +
          '<button class="btn mt" data-act="pay-partner">Record a payment to ' + esc(partnerName()) + '</button>';
      }
      if (taxRate() > 0) {
        html += '<div class="list-row" style="margin-top:10px"><div><div>Tax being held</div>' +
          '<div class="lr-sub">' + state.settings.taxRate + '% of profit</div></div>' +
          '<div class="lr-amt">' + money(heldTax) + '</div></div>' +
          '<button class="btn mt" data-act="pay-tax">Record a tax payment</button>';
      }
      html += '</div>';
    }

    /* ---- what sells ---- */
    var byService = {};
    state.jobs.forEach(function (j) {
      var k = j.service || 'Other';
      byService[k] = (byService[k] || 0) + (+j.amount || 0);
    });
    var svc = Object.keys(byService).map(function (k) { return { k: k, v: byService[k] }; })
      .sort(function (a, b) { return b.v - a.v; }).slice(0, 6);
    if (svc.length) {
      var svcMax = svc[0].v;
      html += '<div class="card"><div class="card-title">Best earners</div>';
      svc.forEach(function (x) {
        html += '<div style="padding:8px 0">' +
          '<div style="display:flex;justify-content:space-between;gap:10px;font-size:0.9rem">' +
          '<span>' + esc(x.k) + '</span><span class="lr-amt">' + money(x.v) + '</span></div>' +
          '<div class="bar" style="margin-top:6px"><div class="bar-fill" style="width:' +
          (x.v / svcMax * 100).toFixed(1) + '%;background:' + cols[0] + '"></div></div></div>';
      });
      html += '</div>';
    }

    /* ---- what it costs ---- */
    var byCat = {};
    state.expenses.forEach(function (e) {
      byCat[e.category || 'other'] = (byCat[e.category || 'other'] || 0) + (+e.amount || 0);
    });
    var cats = Object.keys(byCat).map(function (k) { return { k: k, v: byCat[k] }; })
      .sort(function (a, b) { return b.v - a.v; });
    if (cats.length) {
      var catMax = cats[0].v;
      html += '<div class="card"><div class="card-title">What it costs you</div>';
      cats.forEach(function (x) {
        var cat = EXPENSE_CATS.filter(function (c) { return c.v === x.k; })[0];
        html += '<button data-act="cat-detail" data-cat="' + esc(x.k) + '" ' +
          'style="display:block;width:100%;text-align:left;background:none;border:none;padding:8px 0;color:inherit">' +
          '<div style="display:flex;justify-content:space-between;gap:10px;font-size:0.9rem">' +
          '<span>' + (cat ? cat.icon + ' ' + cat.label : esc(x.k)) + '</span>' +
          '<span class="lr-amt">' + money(x.v) + ' <span class="faint">›</span></span></div>' +
          '<div class="bar" style="margin-top:6px"><div class="bar-fill" style="width:' +
          (x.v / catMax * 100).toFixed(1) + '%;background:' + cols[1] + '"></div></div></button>';
      });
      html += '<div class="hint mt">Tap any of these for what you bought and when.</div></div>';
    }

    /* ---- day by day ---- */
    var seen = {};
    state.jobs.forEach(function (j) { seen[j.date] = 1; });
    state.expenses.forEach(function (e) { seen[e.date] = 1; });
    var dayList = Object.keys(seen).sort().reverse().slice(0, 14);
    if (dayList.length) {
      html += '<div class="card"><div class="card-title">Day by day</div>';
      dayList.forEach(function (iso) {
        var d = dayMoney(iso);
        // the same measure as the month above it — the work's result, not
        // what happened to bill money, which moves on its own schedule
        html += '<button class="log-row" data-act="open-day" data-date="' + iso + '">' +
          '<div class="log-ico">' + (d.earned >= 0 ? '✅' : '⚠️') + '</div>' +
          '<div class="log-main"><div class="log-title">' + fmtDate(iso, 'dow') + '</div>' +
          '<div class="log-sub">' + money(d.revenue) + ' in · ' + plural(d.jobs, 'job') +
          (d.costs > 0.004 ? ' · ' + money(d.costs) + ' costs' : '') +
          (d.partner > 0.004 ? ' · ' + money(d.partner) + ' to ' + esc(partnerName()) : '') +
          '</div></div>' +
          '<div class="log-amt ' + (d.earned >= 0 ? 'in' : 'out') + '">' + money(d.earned) + '</div></button>';
      });
      html += '</div>';
    }

    host.innerHTML = html;
  }

  /**
   * Money in per day against what a day has to bring in.
   * One series, so no legend box is needed for the bars themselves — the
   * dashed line is the only other mark and it is labelled.
   */
  function chartHTML(days) {
    var t = todayISO();
    var start = addDays(t, -(days - 1));
    var rows = [], max = 0;
    for (var i = 0, iso = start; i < days; i++, iso = addDays(iso, 1)) {
      var rev = revenueOn(iso);
      rows.push({ iso: iso, rev: rev, be: breakEvenOn(iso), m: dayMoney(iso) });
      if (rev > max) max = rev;
    }
    // The line is what a day has to make *now* — averaging past days when there
    // were no bills yet would drag it down to something meaningless.
    var goal = breakEvenOn(t) || 0;
    if (goal > max) max = goal;
    if (max <= 0) return '';
    max = max * 1.12;

    var cols = vizColors();
    var html = '<div class="card"><div class="card-title">Last ' + days + ' days' +
      '<span class="faint" style="text-transform:none;letter-spacing:0">money in</span></div>' +
      '<div class="chart"><div class="chart-plot" id="chart-plot">';

    if (goal > 0) {
      html += '<div class="chart-goal" style="bottom:' + (goal / max * 100).toFixed(2) + '%">' +
        '<span>' + money0(goal) + '</span></div>';
    }
    rows.forEach(function (r) {
      var h = max > 0 ? (r.rev / max * 100) : 0;
      var under = r.rev > 0 && r.be != null && r.rev < r.be;
      html += '<button class="chart-col" data-act="chart-day" data-date="' + r.iso + '" ' +
        'aria-label="' + fmtDate(r.iso) + ': ' + money(r.rev) + ' in">' +
        '<div class="chart-bar' + (r.rev <= 0 ? ' zero' : (under ? ' under' : '')) + '" ' +
        'style="height:' + Math.max(h, r.rev > 0 ? 2 : 1).toFixed(2) + '%;' +
        (r.rev > 0 ? 'background:' + cols[0] : '') + '"></div></button>';
    });
    html += '</div><div class="chart-baseline"></div><div class="chart-xaxis">' +
      rows.map(function (r, i) {
        return '<div>' + (i % 2 === 0 || i === rows.length - 1 ? fromISO(r.iso).getDate() : '') + '</div>';
      }).join('') + '</div>';

    html += '<div class="chart-legend">' +
      '<span><i style="background:' + cols[0] + '"></i>money in</span>' +
      '<span><i style="background:' + cols[0] + ';opacity:.42"></i>under break-even</span>' +
      (goal > 0 ? '<span><i class="dash"></i>break-even today, ' + money0(goal) + '</span>' : '') +
      '</div></div></div>';
    return html;
  }

  /* ---- Plan -------------------------------------------------------------- */

  function renderPlan() {
    var host = $('#view-plan');
    if (!datedBills().length) {
      host.innerHTML = '<div class="empty"><div class="big">🗓️</div><h3>Nothing to plan yet</h3>' +
        '<p>Add a bill and your daily schedule shows up here.</p>' +
        '<button class="btn primary" data-act="add-bill">＋ Add a bill</button></div>';
      return;
    }

    var t = todayISO();
    if (!calMonth) calMonth = { y: fromISO(t).getFullYear(), m: fromISO(t).getMonth() };

    var first = new Date(calMonth.y, calMonth.m, 1);
    var lastDay = new Date(calMonth.y, calMonth.m + 1, 0).getDate();
    var firstISO = toISO(first);
    var lastISO = toISO(new Date(calMonth.y, calMonth.m, lastDay));

    // Always project from today, even when looking at a later month. Starting
    // at that month's 1st would forget everything banked between now and then
    // and re-charge bills that will already be paid for.
    var simStart = t;
    var sim = simulate(simStart, diffDays(simStart, lastISO) >= 0 ? lastISO : simStart);

    var html = '';

    // month header
    html += '<div class="card">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px">' +
      '<button class="icon-btn" data-act="cal-prev">‹</button>' +
      '<div style="font-weight:700;font-size:1.02rem">' + MON_LONG[calMonth.m] + ' ' + calMonth.y + '</div>' +
      '<button class="icon-btn" data-act="cal-next">›</button>' +
      '</div>';

    html += '<div class="cal-head">' + DOW_MIN.map(function (d, i) {
      return '<div>' + d + '</div>';
    }).join('') + '</div><div class="cal-grid">';

    for (var blank = 0; blank < first.getDay(); blank++) html += '<div class="cal-cell blank"></div>';

    var monthRequired = 0, monthActual = 0;
    for (var d = 1; d <= lastDay; d++) {
      var iso = toISO(new Date(calMonth.y, calMonth.m, d));
      var funding = isFundingDay(iso);
      var rec = state.days[iso];
      var past = isPast(iso);
      var cell = sim[iso];
      var amt = 0, mark = '';
      var cls = 'cal-cell';

      if (!funding) cls += ' off';
      if (iso === t) cls += ' today';

      if (past) {
        amt = dayActual(iso);
        monthActual += amt;
        if (rec && rec.completed) { cls += ' done'; mark = rec.skipped ? '⏭' : '✓'; }
        else if (funding && diffDays(state.meta.created, iso) >= 0) { cls += ' missed'; mark = '·'; }
        cls += ' past';
      } else {
        amt = cell ? cell.remainingTotal : 0;
        monthRequired += amt;
        // money banked today counts whether or not the day was marked complete
        monthActual += dayActual(iso);
        if (rec && rec.completed) { cls += ' done'; mark = '✓'; }
      }

      html += '<button class="' + cls + '" data-act="open-day" data-date="' + iso + '">' +
        '<div class="cal-day">' + d + '</div>' +
        (amt > 0.004 ? '<div class="cal-amt">' + money0(amt) + '</div>' : (mark ? '<div class="cal-dot">' + mark + '</div>' : '')) +
        '</button>';
    }
    html += '</div>';

    html += '<div class="legend">' +
      '<span><i style="background:rgba(34,197,94,.5)"></i>completed</span>' +
      '<span><i style="background:rgba(239,68,68,.4)"></i>missed</span>' +
      '<span><i style="background:var(--bg-elev-2);opacity:.45"></i>day off</span>' +
      '<span><i style="background:var(--blue)"></i>today</span>' +
      '</div>';

    html += '<div class="sep"></div>' +
      '<div class="list-row"><div>Still to set aside this month</div><div class="lr-amt">' + money(monthRequired) + '</div></div>' +
      '<div class="list-row"><div>Already set aside this month</div><div class="lr-amt">' + money(monthActual) + '</div></div>' +
      '</div>';

    // upcoming bills timeline
    html += '<div class="card"><div class="card-title">What\'s coming</div>';
    var ups = sortedStatuses().slice().sort(function (a, b) { return diffDays(b.bill.dueDate, a.bill.dueDate); });
    ups.forEach(function (s) {
      html += '<div class="list-row"><div>' +
        '<div>' + esc(s.bill.icon || '🧾') + ' ' + esc(s.bill.name) + ' <span class="pill ' + s.key + '">' + s.label + '</span></div>' +
        '<div class="lr-sub">due ' + fmtDate(s.bill.dueDate, 'dow') + ' · ' + relDay(s.bill.dueDate) +
        ' · fully funded by ' + fmtDate(s.target) + '</div>' +
        '</div><div class="lr-amt">' + money(s.remaining) + '<div class="lr-sub" style="text-align:right;font-weight:500">to go</div></div></div>';
    });
    html += '</div>';

    // cushion control
    html += '<div class="card"><div class="card-title">Safety cushion</div>' +
      '<p class="small dim mb">Every bill is fully funded this far <em>before</em> its due date. ' +
      'A bigger cushion means a slightly higher daily amount, but more breathing room.</p>' +
      '<div class="chip-row mb">' +
      [0, 3, 5, 6, 7, 10, 14].map(function (n) {
        return '<button class="chip' + (state.settings.cushionDays === n ? ' on' : '') +
          '" data-act="set-cushion" data-n="' + n + '">' + n + '</button>';
      }).join('') + '</div>' +
      '<div class="chip-row">' +
      [['workdays', 'workdays'], ['calendar', 'calendar days']].map(function (m) {
        return '<button class="chip' + (state.settings.cushionMode === m[0] ? ' on' : '') +
          '" data-act="set-cushion-mode" data-m="' + m[0] + '">counted in ' + m[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="hint mt">Currently <strong>' + cushionWords() + '</strong> ahead of every due date.</div></div>';

    host.innerHTML = html;
  }

  /* ---- More -------------------------------------------------------------- */

  function renderMore() {
    var host = $('#view-more');
    var s = state.settings;
    var html = '';

    var pp = s.partner || {};
    html += '<div class="card"><div class="card-title">Bill money</div>' +
      '<div class="switch-row"><div><div class="sr-label">Set money aside automatically</div>' +
      '<div class="sr-hint">What a job earns — after costs' +
      ((s.partner || {}).mode !== 'none' ? ', ' + esc((s.partner || {}).name || 'the cut') : '') +
      (s.taxRate ? ' and tax' : '') +
      ' — goes straight to that day\'s bills. Anything over is yours.</div></div>' +
      '<button class="switch' + (s.autoSetAside ? ' on' : '') + '" data-act="toggle-auto"></button>' +
      '</div></div>';

    html += '<div class="card"><div class="card-title">Splits &amp; tax</div>' +
      '<div class="list-row"><div><div>' +
      (pp.mode === 'none' ? 'Nobody takes a cut' : esc(pp.name || 'Partner') + '\'s cut') + '</div>' +
      '<div class="lr-sub">' + (pp.mode === 'none' ? 'Everything after costs is yours' : partnerRule()) + '</div></div>' +
      '<div class="lr-amt">' + (pp.mode === 'none' ? '—' : money(owedTo('partner')) + '<div class="lr-sub" style="text-align:right;font-weight:500">owed</div>') + '</div></div>' +
      '<div class="list-row"><div><div>Tax put by</div>' +
      '<div class="lr-sub">' + (s.taxRate ? s.taxRate + '% of what\'s left' : 'Off — nothing held back') + '</div></div>' +
      '<div class="lr-amt">' + (s.taxRate ? money(owedTo('tax')) + '<div class="lr-sub" style="text-align:right;font-weight:500">held</div>' : 'Off') + '</div></div>' +
      '<button class="btn mt" data-act="business-setup">Change splits &amp; tax</button></div>';

    html += '<div class="card"><div class="card-title">Your work schedule</div>' +
      '<p class="small dim mb">How your earning days fall decides what each day has to carry.</p>' +
      '<div class="chip-row mb">' +
      [['workdays', 'Same days each week'],
       ['estimate', 'Unpredictable'],
       ['alldays', 'Every day']].map(function (m) {
        return '<button class="chip' + (s.countMode === m[0] ? ' on' : '') +
          '" data-act="set-count-mode" data-m="' + m[0] + '">' + m[1] + '</button>';
      }).join('') + '</div>';

    if (s.countMode === 'workdays') {
      html += '<p class="small dim mb">Tap the days you normally earn.</p><div class="dow-picker">' +
        DOW_MID.map(function (d, i) {
          return '<button class="dow' + (s.workdays.indexOf(i) !== -1 ? ' on' : '') +
            '" data-act="toggle-dow" data-n="' + i + '">' + d.slice(0, 2) + '</button>';
        }).join('') + '</div>';
    } else if (s.countMode === 'estimate') {
      var avg = actualDaysPerWeek();
      html += '<p class="small dim mb">Roughly how many days a week do you work? Any day can take money — ' +
        'this just sets how many earning days the app expects between now and each due date.</p>' +
        '<div class="chip-row">' +
        [2, 3, 4, 5, 6, 7].map(function (n) {
          return '<button class="chip' + (perWeek() === n ? ' on' : '') +
            '" data-act="set-dpw" data-n="' + n + '">' + n + ' a week</button>';
        }).join('') + '</div>' +
        (avg != null
          ? '<div class="hint mt">You have actually averaged <strong>' + avg.toFixed(1) +
            ' days a week</strong> over the last four weeks.' +
            (Math.abs(avg - perWeek()) >= 1
              ? ' Worth changing this to ' + Math.max(1, Math.round(avg)) + '.'
              : '') + '</div>'
          : '<div class="hint mt">Once you have a few weeks logged, your real average shows up here.</div>');
    } else {
      html += '<p class="small dim">Every calendar day carries a share.</p>';
    }
    html += '</div>';

    html += '<div class="card"><div class="card-title">Daily amounts</div>' +
      '<div class="switch-row"><div><div class="sr-label">Safety cushion</div>' +
      '<div class="sr-hint">Bills are fully funded ' + cushionWords() + ' early.</div></div></div>' +
      '<div class="chip-row mb">' +
      [0, 3, 5, 6, 7, 10, 14].map(function (n) {
        return '<button class="chip' + (s.cushionDays === n ? ' on' : '') + '" data-act="set-cushion" data-n="' + n + '">' + n + '</button>';
      }).join('') + '</div>' +
      '<div class="chip-row mb">' +
      [['workdays', 'workdays'], ['calendar', 'calendar days']].map(function (m) {
        return '<button class="chip' + (s.cushionMode === m[0] ? ' on' : '') +
          '" data-act="set-cushion-mode" data-m="' + m[0] + '">counted in ' + m[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="switch-row"><div><div class="sr-label">Round the daily ask up to</div>' +
      '<div class="sr-hint">Easier to handle in cash — and it finishes early.</div></div></div>' +
      '<div class="chip-row">' +
      [[0.01, 'exact cents'], [1, '$1'], [5, '$5'], [10, '$10']].map(function (r) {
        return '<button class="chip' + (s.roundTo === r[0] ? ' on' : '') + '" data-act="set-round" data-n="' + r[0] + '">' + r[1] + '</button>';
      }).join('') + '</div></div>';

    var vault = vaultTotal();
    html += '<div class="card"><div class="card-title">Your money</div>' +
      '<div class="list-row"><div><div>Total banked right now</div>' +
      '<div class="lr-sub">Cash you should be holding for bills</div></div>' +
      '<div class="lr-amt">' + money(vault) + '</div></div>' +
      '<div class="list-row"><div><div>Bills tracked</div></div><div class="lr-amt">' + activeBills().length + '</div></div>' +
      '<div class="list-row"><div><div>Days logged</div></div><div class="lr-amt">' +
      Object.keys(state.days).length + '</div></div>' +
      '<button class="btn mt" data-act="opening-balance">＋ Money I already have set aside</button></div>';

    var good = lastGood();
    var storeBytes = 0;
    try { storeBytes = (localStorage.getItem(STORE_KEY) || '').length; } catch (e) {}

    html += '<div class="card"><div class="card-title">Is it saving?</div>' +
      '<div class="list-row"><div><div>' +
      (saveWorks && loadState !== 'blocked' ? '✅ Yes — this device is storing your data' :
        '🚫 No — nothing is being kept') + '</div>' +
      '<div class="lr-sub">' +
      (saveWorks && loadState !== 'blocked'
        ? plural(state.bills.length, 'bill') + ', ' + plural(state.jobs.length, 'job') + ', ' +
          plural(state.expenses.length, 'cost') + ' held here'
        : 'Almost always a Private browsing tab. Open the app in a normal Safari tab and ' +
          'it will start saving.') +
      '</div></div><div class="lr-amt tiny faint">' +
      (storeBytes ? Math.round(storeBytes / 1024 * 10) / 10 + ' KB' : '—') + '</div></div>' +
      (good ? '<div class="list-row"><div><div>Fallback copy</div>' +
        '<div class="lr-sub">From the last clean open · ' + plural(good.data.bills.length, 'bill') +
        '</div></div><div class="lr-amt tiny faint">kept</div></div>' : '') +
      '<div class="hint mt">Your data lives in this browser only. It is not on the internet, ' +
      'so clearing Safari data erases it — and the app on your Home Screen keeps its own ' +
      'separate copy from Safari.</div>' +
      '<div class="list-row" style="border-top:1px solid var(--line);margin-top:6px">' +
      '<div><div>App version</div><div class="lr-sub">Pull down to refresh if this looks old</div></div>' +
      '<div class="lr-amt tiny faint">' + APP_VERSION + '</div></div></div>';

    html += '<div class="card"><div class="card-title">Your setup code</div>' +
      '<p class="small dim mb">The quickest way back if anything is ever lost: copy this and ' +
      'keep it in Notes. Pasting it into any copy of the app rebuilds your bills and splits.</p>' +
      '<button class="btn primary" data-act="my-code">⧉ Copy my setup code</button></div>';

    html += '<div class="card"><div class="card-title">Backup</div>' +
      '<p class="small dim mb">Everything is stored on this device only. Clearing Safari data wipes it — ' +
      'save a backup file somewhere safe now and then.' +
      (s.lastBackup ? ' <strong>Last backup: ' + fmtDate(s.lastBackup) + '</strong>.' : ' <strong>You haven\'t backed up yet.</strong>') +
      '</p>' +
      '<div class="btn-row mb"><button class="btn" data-act="export">⬇︎ Save backup</button>' +
      '<button class="btn" data-act="copy-backup">⧉ Copy</button></div>' +
      '<button class="btn ghost" data-act="import">📋 Paste a setup code or backup</button></div>';

    html += '<div class="card"><div class="card-title">How the math works</div>' +
      '<p class="small dim">For every bill:</p>' +
      '<p class="small mt" style="background:var(--bg-elev-2);padding:12px;border-radius:10px;line-height:1.6">' +
      '<strong>Cushion date</strong> = ' + cushionWords() + ' back from the due date<br>' +
      '<strong>Per ' + unitWord() + '</strong> = money still needed ÷ ' +
      unitWord() + 's left until the cushion date' +
      '</p>' +
      (s.countMode === 'estimate'
        ? '<p class="small dim mt">Because your work is unpredictable, the app counts on about <strong>' +
          plural(perWeek(), 'day') + ' a week</strong>. Any day can take money. Miss a day and you spend a ' +
          'day of cushion — each bill shows how many days it can still afford to lose.</p>'
        : '') +
      '<p class="small dim mt">It recalculates every single day from what you\'ve actually banked. ' +
      'Miss a day and tomorrow\'s number goes up just enough to stay on time — you can\'t quietly fall behind. ' +
      'Set aside more than asked and every following day gets cheaper.</p></div>';

    html += '<div class="card"><div class="card-title">Add to your home screen</div>' +
      '<p class="small dim">In Safari tap <strong>Share ⬆︎ → Add to Home Screen</strong>. ' +
      'It then opens full screen like a real app and works with no signal.</p></div>';

    html += '<div class="card"><div class="card-title">Danger zone</div>' +
      '<button class="btn danger" data-act="reset">Erase all data</button></div>';

    html += '<p class="center tiny faint" style="padding:10px 0 20px">Bill Cushion · everything stays on your phone</p>';

    host.innerHTML = html;
  }

  /* ---------------------------------------------------------------------------
     8. Sheets (bottom modals)
     ------------------------------------------------------------------------ */

  function openSheet(html, onMount) {
    closeSheet();
    var wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML = '<div class="sheet"><div class="sheet-grip"></div>' + html + '</div>';
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeSheet(); });
    $('#sheet-host').appendChild(wrap);
    document.body.style.overflow = 'hidden';
    if (onMount) onMount($('.sheet', wrap));
    return wrap;
  }
  function closeSheet() {
    $('#sheet-host').innerHTML = '';
    document.body.style.overflow = '';
  }

  function confirmSheet(o) {
    var html = '<h2>' + esc(o.title) + '</h2><div class="sheet-sub">' + o.body + '</div>';
    o.actions.forEach(function (a, i) {
      html += '<button class="btn ' + (a.cls || '') + '" data-confirm="' + i + '" style="margin-bottom:8px">' + esc(a.label) + '</button>';
    });
    html += '<button class="btn ghost" data-act="close-sheet">Cancel</button>';
    openSheet(html, function (sheet) {
      $$('[data-confirm]', sheet).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var fn = o.actions[+btn.dataset.confirm].fn;
          closeSheet();
          fn();
        });
      });
    });
  }

  /* ---- Bill editor ------------------------------------------------------- */

  function billSheet(b, preset) {
    var isNew = !b;
    var d = b || {
      id: null, name: (preset && preset.name) || '', icon: (preset && preset.icon) || '🧾',
      amount: '', dueDate: addDays(todayISO(), 14), recurrence: 'monthly', cushionDays: null, note: ''
    };

    var html = '<h2>' + (isNew ? 'New bill' : 'Edit bill') + '</h2>' +
      '<div class="sheet-sub">The app works out the daily amount for you.</div>';

    html += '<div class="field"><label>Icon</label><div class="chip-row" id="icon-row">' +
      ICONS.map(function (i) {
        return '<button type="button" class="chip' + (d.icon === i ? ' on' : '') + '" data-icon="' + i + '">' + i + '</button>';
      }).join('') + '</div></div>';

    html += '<div class="field"><label>Bill name</label>' +
      '<input id="f-name" type="text" value="' + esc(d.name) + '" placeholder="Car insurance" autocomplete="off" enterkeyhint="next"></div>';

    html += '<div class="field-row">' +
      '<div class="field"><label>Amount due</label>' +
      '<input id="f-amount" type="text" inputmode="decimal" value="' + (d.amount === '' ? '' : d.amount) + '" placeholder="0.00"></div>' +
      '<div class="field"><label>Due date</label>' +
      '<input id="f-due" type="date" value="' + esc(d.dueDate) + '"></div>' +
      '</div>';

    html += '<div class="field"><label>Repeats</label><select id="f-rec">' +
      RECURRENCE.map(function (r) {
        return '<option value="' + r.v + '"' + (d.recurrence === r.v ? ' selected' : '') + '>' + r.label + '</option>';
      }).join('') + '</select></div>';

    html += '<div class="field" id="f-sched-wrap" style="display:none"><label>Payment dates</label>' +
      '<textarea id="f-sched" rows="5" style="font-size:14px" placeholder="2026-09-18&#10;2026-10-02&#10;2026-10-16">' +
      esc((d.scheduleDates || []).join('\n')) + '</textarea>' +
      '<div class="hint">One date per line, as YYYY-MM-DD. Each time you mark it paid it moves to the next date on the list. ' +
      'Handy for a finance plan that debits on your paydays rather than a fixed day of the month.</div></div>';

    html += '<div class="field"><label>Cushion for this bill</label><select id="f-cushion">' +
      '<option value="">Use my default (' + cushionWords() + ' early)</option>' +
      [0, 3, 5, 6, 7, 10, 14, 21].map(function (n) {
        return '<option value="' + n + '"' + (d.cushionDays === n ? ' selected' : '') + '>' + cushionWords(n) + ' early</option>';
      }).join('') + '</select>' +
      '<div class="hint" id="f-preview"></div></div>';

    html += '<button class="btn primary" data-act="save-bill" style="margin-bottom:8px">' +
      (isNew ? 'Add bill' : 'Save changes') + '</button>';
    if (!isNew) html += '<button class="btn danger" data-act="delete-bill" data-id="' + b.id + '" style="margin-bottom:8px">Delete bill</button>';
    html += '<button class="btn ghost" data-act="close-sheet">Cancel</button>';

    openSheet(html, function (sheet) {
      var icon = d.icon;
      $$('#icon-row .chip', sheet).forEach(function (c) {
        c.addEventListener('click', function () {
          icon = c.dataset.icon;
          $$('#icon-row .chip', sheet).forEach(function (x) { x.classList.remove('on'); });
          c.classList.add('on');
        });
      });

      function preview() {
        var amt = parseFloat($('#f-amount', sheet).value) || 0;
        var due = $('#f-due', sheet).value;
        var cRaw = $('#f-cushion', sheet).value;
        var cd = cRaw === '' ? state.settings.cushionDays : +cRaw;
        var out = $('#f-preview', sheet);
        if (!amt || !due) {
          out.textContent = amt
            ? 'Add a due date to see the daily number — you can leave it blank for now and set it later.'
            : 'Enter an amount and due date to see the daily number.';
          return;
        }
        var tgt = cushionDateFor(due, cd);
        var n = countFundingDays(todayISO(), tgt);
        if (n <= 0) {
          out.innerHTML = '⚠️ No ' + (state.settings.countMode === 'alldays' ? 'days' : 'workdays') +
            ' left before ' + fmtDate(tgt) + ' — the full ' + money(amt) + ' would be needed right away.';
        } else {
          out.innerHTML = '➜ <strong>' + money(Math.min(amt, ceilTo(amt / n, state.settings.roundTo))) +
            ' per ' + (state.settings.countMode === 'alldays' ? 'day' : 'workday') + '</strong> across ' +
            plural(n, state.settings.countMode === 'alldays' ? 'day' : 'workday') +
            ', fully funded by ' + fmtDate(tgt) + '.';
        }
      }
      function syncSchedule() {
        $('#f-sched-wrap', sheet).style.display = $('#f-rec', sheet).value === 'schedule' ? '' : 'none';
      }
      $('#f-rec', sheet).addEventListener('change', syncSchedule);
      syncSchedule();

      ['#f-amount', '#f-due', '#f-cushion'].forEach(function (sel) {
        $(sel, sheet).addEventListener('input', preview);
        $(sel, sheet).addEventListener('change', preview);
      });
      preview();

      $('[data-act="save-bill"]', sheet).addEventListener('click', function () {
        var name = $('#f-name', sheet).value.trim();
        var amount = round2(parseFloat($('#f-amount', sheet).value));
        var due = $('#f-due', sheet).value;
        var rec = $('#f-rec', sheet).value;
        var cRaw = $('#f-cushion', sheet).value;

        if (!name) return toast('⚠️ Give the bill a name');
        if (!(amount > 0)) return toast('⚠️ Enter an amount over $0');
        if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return toast('⚠️ That due date looks wrong');

        var sched = [];
        if (rec === 'schedule') {
          sched = ($('#f-sched', sheet).value || '').split(/[\s,]+/)
            .map(function (x) { return x.trim(); })
            .filter(function (x) { return /^\d{4}-\d{2}-\d{2}$/.test(x); })
            .sort();
        }

        if (isNew) {
          state.bills.push({
            id: uid(), name: name, icon: icon, amount: amount, dueDate: due,
            recurrence: rec, scheduleDates: sched, anchorDay: due ? fromISO(due).getDate() : null,
            cushionDays: cRaw === '' ? null : +cRaw,
            cycle: 0, cycleStart: todayISO(), createdAt: todayISO(),
            archived: false, paidHistory: []
          });
        } else {
          b.name = name; b.icon = icon; b.amount = amount;
          b.dueDate = due; b.recurrence = rec; b.scheduleDates = sched;
          b.anchorDay = due ? fromISO(due).getDate() : null;
          b.cushionDays = cRaw === '' ? null : +cRaw;
        }
        save(); closeSheet(); render();
        // Say what it did to today's number, so the re-pricing is visible.
        var tp = todayPlan();
        toast('✅ ' + name + (isNew ? ' added' : ' updated') + ' · today is now ' +
          money(tp.remainingTotal) + ' across ' + plural(tp.remaining.length, 'bill'));
      });

      setTimeout(function () { if (isNew && !d.name) $('#f-name', sheet).focus(); }, 220);
    });
  }

  /* ---- Bill detail ------------------------------------------------------- */

  function billDetailSheet(b) {
    var dated = isDated(b);
    var s = dated ? statusOf(b) : null;
    var hist = (idx()[b.id] || []).filter(function (c) { return c.cycle === b.cycle; })
      .sort(function (x, y) { return y.ts - x.ts; });

    var html = '<h2>' + esc(b.icon || '🧾') + ' ' + esc(b.name) + '</h2>' +
      '<div class="sheet-sub">' + money(b.amount) +
      (dated ? ' due ' + fmtDate(b.dueDate, 'dow') + ' · ' + relDay(b.dueDate)
             : ' · no due date set yet') + '</div>';

    if (!dated) {
      html += '<div class="banner warn"><span>📅</span><div><strong>Waiting on a due date</strong>' +
        'Pick when this is due and it joins your daily amount straight away.</div></div>';
    }

    if (dated) html += '<div class="card tight s-' + s.key + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline">' +
      '<div style="font-size:1.5rem;font-weight:800" class="money">' + money(s.saved) + '</div>' +
      '<div class="dim">of ' + money(b.amount) + ' (' + pct(s.progress) + '%)</div></div>' +
      '<div class="bar"><div class="bar-fill" style="width:' + pct(s.progress) + '%"></div>' +
      (s.key === 'funded' ? '' : '<div class="bar-target" style="left:' + pct(s.pace) + '%"></div>') + '</div>' +
      '<div class="bill-meta"><span class="pill ' + s.key + '">' + s.label + '</span>' +
      (s.key === 'funded'
        ? '<span>✓ ready ' + plural(Math.max(0, s.daysToDue), 'day') + ' early</span>'
        : '<span><strong>' + money(s.perDay) + '</strong> per ' + (state.settings.countMode === 'alldays' ? 'day' : 'workday') +
          ' · ' + plural(s.fundingLeft, state.settings.countMode === 'alldays' ? 'day' : 'workday') + ' left</span>') +
      '</div></div>';

    // --- correct the amount or the due date without leaving this sheet ---
    html += '<div class="card tight"><div class="card-title">Amount &amp; due date</div>' +
      '<div class="field-row">' +
      '<div class="field"><label>Amount due</label>' +
      '<input id="q-amount" type="text" inputmode="decimal" value="' + b.amount + '"></div>' +
      '<div class="field"><label>Due date</label>' +
      '<input id="q-due" type="date" value="' + esc(b.dueDate) + '"></div>' +
      '</div>' +
      '<div class="chip-row mb">' +
      '<button class="chip" data-shift="-1">−1 day</button>' +
      '<button class="chip" data-shift="1">+1 day</button>' +
      '<button class="chip" data-shift="7">+1 week</button>' +
      '<button class="chip" data-shift="m1">+1 month</button>' +
      '</div>' +
      '<div class="hint" id="q-preview"></div>' +
      '<button class="btn primary" id="q-save" disabled style="margin-top:10px">Save changes</button>' +
      '</div>';

    html += (dated
        ? '<div class="list-row"><div>Days you can miss and still be on time</div><div class="lr-amt">' +
            (s.remaining <= 0.004 ? '—' : (s.slack <= 0 ? 'none left' : s.slack)) + '</div></div>' +
          '<div class="list-row"><div>Still needed</div><div class="lr-amt">' + money(s.remaining) + '</div></div>' +
          (s.key === 'behind' ? '<div class="list-row"><div>Behind pace by</div><div class="lr-amt">' + money(s.shortfall) + '</div></div>' : '')
        : '') +
      '<div class="list-row"><div>Repeats</div><div class="lr-amt">' +
      (RECURRENCE.filter(function (r) { return r.v === b.recurrence; })[0] || { label: '—' }).label + '</div></div>';

    if (b.recurrence === 'schedule' && (b.scheduleDates || []).length) {
      var upcoming = b.scheduleDates.filter(function (x) { return diffDays(b.dueDate, x) > 0; }).slice(0, 4);
      if (upcoming.length) {
        html += '<div class="list-row"><div>Then debits on</div><div class="lr-amt small">' +
          upcoming.map(function (x) { return fmtDate(x); }).join(' · ') + '</div></div>';
      }
    }

    html += '<div class="btn-row mt" style="margin-bottom:8px">' +
      '<button class="btn primary" data-act="add-money" data-id="' + b.id + '">＋ Add money</button>' +
      '<button class="btn" data-act="mark-paid" data-id="' + b.id + '">Mark paid</button></div>' +
      '<div class="btn-row" style="margin-bottom:8px">' +
      '<button class="btn ghost" data-act="edit-bill" data-id="' + b.id + '">Name &amp; repeat</button>' +
      '<button class="btn danger" data-act="delete-bill" data-id="' + b.id + '">Delete</button></div>' +
      '<button class="btn ghost" data-act="close-sheet" style="margin-bottom:8px">Close</button>';

    if (hist.length) {
      html += '<div class="sep"></div><div class="card-title">This cycle\'s deposits</div>';
      hist.forEach(function (c) {
        html += '<div class="list-row"><div><div>' + fmtDate(c.date, 'dow') + '</div>' +
          '<div class="lr-sub">' + (c.note ? esc(c.note) : relDay(c.date)) + '</div></div>' +
          '<div style="display:flex;align-items:center;gap:10px">' +
          '<span class="lr-amt">+' + money(c.amount) + '</span>' +
          '<button class="btn sm ghost" data-act="del-contrib" data-cid="' + c.id + '">✕</button></div></div>';
      });
    }

    if (b.paidHistory && b.paidHistory.length) {
      html += '<div class="sep"></div><div class="card-title">Payment history</div>';
      b.paidHistory.slice().reverse().forEach(function (p) {
        html += '<div class="list-row"><div><div>Paid ' + fmtDate(p.paidOn) + '</div>' +
          '<div class="lr-sub">was due ' + fmtDate(p.due) +
          (p.short > 0.004 ? ' · ' + money(p.short) + ' short' : ' · covered in full') + '</div></div>' +
          '<div class="lr-amt">' + money(p.amount) + '</div></div>';
      });
    }

    openSheet(html, function (sheet) {
      var amtEl = $('#q-amount', sheet);
      var dueEl = $('#q-due', sheet);
      var saveEl = $('#q-save', sheet);
      var outEl = $('#q-preview', sheet);
      var unit = state.settings.countMode === 'alldays' ? 'day' : 'workday';

      function readAmount() { return round2(parseFloat(amtEl.value)); }
      function changed() {
        var a = readAmount();
        return (a > 0 && Math.abs(a - b.amount) > 0.004) || (dueEl.value && dueEl.value !== b.dueDate);
      }

      // Live preview: what this change does to the daily number, before saving.
      function preview() {
        var a = readAmount();
        var due = dueEl.value;
        var ok = a > 0 && /^\d{4}-\d{2}-\d{2}$/.test(due);
        saveEl.disabled = !(ok && changed());

        if (!ok) { outEl.innerHTML = '⚠️ Enter an amount over $0 and a due date.'; return; }

        var cd = cushionOf(b);
        var tgt = cushionDateFor(due, cd);
        var banked = savedFor(b, todayISO());
        var left = round2(Math.max(0, a - banked));
        var n = countFundingDays(todayISO(), tgt);

        if (left <= 0.004) {
          outEl.innerHTML = '✓ Already covered — ' + money(banked) + ' banked against ' + money(a) + '.';
        } else if (n <= 0) {
          outEl.innerHTML = '⚠️ No ' + unit + 's left before ' + fmtDate(tgt, 'dow') +
            ' — the whole ' + money(left) + ' would be needed right away.';
        } else {
          var per = Math.min(left, ceilTo(left / n, state.settings.roundTo));
          outEl.innerHTML = (changed() ? '➜ becomes ' : '➜ ') + '<strong>' + money(per) + ' per ' + unit +
            '</strong> × ' + plural(n, unit) + ', fully funded by <strong>' + fmtDate(tgt, 'dow') +
            '</strong> (' + cushionWords(cd) + ' before it\'s due).';
        }
      }

      $$('.chip[data-shift]', sheet).forEach(function (c) {
        c.addEventListener('click', function () {
          var v = c.dataset.shift;
          var from = /^\d{4}-\d{2}-\d{2}$/.test(dueEl.value) ? dueEl.value : b.dueDate;
          dueEl.value = v === 'm1' ? monthShift(from, 1) : addDays(from, +v);
          preview();
        });
      });
      amtEl.addEventListener('input', preview);
      dueEl.addEventListener('input', preview);
      dueEl.addEventListener('change', preview);

      saveEl.addEventListener('click', function () {
        var a = readAmount();
        var due = dueEl.value;
        if (!(a > 0)) return toast('⚠️ Enter an amount over $0');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return toast('⚠️ Pick a due date');

        b.amount = a;
        b.dueDate = due;
        b.anchorDay = fromISO(due).getDate();   // keeps monthly bills on the right day
        save();
        render();                                // every view re-prices off the new numbers
        billDetailSheet(b);                      // reopen so the new daily amount is visible

        var ns = statusOf(b);
        toast('✅ ' + b.name + ' updated · ' +
          (ns.remaining <= 0.004 ? 'fully covered' : money(ns.perDay) + ' per ' + unit));
      });

      preview();
    });
  }

  /* ---- Money entry ------------------------------------------------------- */

  function amountSheet(o) {
    // o: {title, sub, value, billId, date, allowComplete}
    var iso = o.date || todayISO();
    var html = '<h2>' + esc(o.title) + '</h2><div class="sheet-sub">' + o.sub + '</div>' +
      '<div class="field"><label>Amount</label>' +
      '<input id="a-amt" type="text" inputmode="decimal" value="' + (o.value != null ? o.value : '') + '" placeholder="0.00"></div>' +
      '<div class="chip-row mb" id="a-quick">' +
      [10, 20, 25, 50, 100].map(function (n) {
        return '<button class="chip" data-add="' + n + '">+$' + n + '</button>';
      }).join('') + '<button class="chip" data-add="clear">clear</button></div>' +
      '<div class="field"><label>Note (optional)</label><input id="a-note" type="text" value="' +
      esc(o.note || '') + '" placeholder="e.g. Tuesday block"></div>' +
      '<div id="a-preview" class="hint mb"></div>';

    if (o.allowComplete) {
      html += '<div class="switch-row"><div><div class="sr-label">Mark ' +
        (iso === todayISO() ? 'today' : fmtDate(iso)) + ' complete</div>' +
        '<div class="sr-hint">Adds it to your streak.</div></div>' +
        '<button class="switch on" id="a-complete"></button></div>';
    }

    html += '<button class="btn primary mt" data-act="confirm-amount" style="margin-bottom:8px">Set it aside</button>' +
      '<button class="btn ghost" data-act="close-sheet">Cancel</button>';

    openSheet(html, function (sheet) {
      var input = $('#a-amt', sheet);
      var completeBtn = $('#a-complete', sheet);
      if (completeBtn) completeBtn.addEventListener('click', function () { completeBtn.classList.toggle('on'); });

      $$('#a-quick .chip', sheet).forEach(function (c) {
        c.addEventListener('click', function () {
          if (c.dataset.add === 'clear') input.value = '';
          else input.value = round2((parseFloat(input.value) || 0) + (+c.dataset.add)).toFixed(2);
          preview();
        });
      });

      function preview() {
        var amt = parseFloat(input.value) || 0;
        var out = $('#a-preview', sheet);
        if (amt <= 0) { out.textContent = ''; return; }
        if (o.billId) {
          var b = billById(o.billId);
          var after = round2(savedFor(b) + amt);
          out.innerHTML = 'Brings ' + esc(b.name) + ' to <strong>' + money(Math.min(after, b.amount)) +
            ' of ' + money(b.amount) + '</strong>' + (after > b.amount ? ' (' + money(after - b.amount) + ' over)' : '') + '.';
        } else {
          var res = allocate(amt, iso);
          var lines = res.alloc.map(function (a) {
            var bb = billById(a.billId);
            return (bb ? esc(bb.icon || '🧾') + ' ' + esc(bb.name) : 'buffer') + ' ' + money(a.amount);
          });
          if (res.leftover > 0.004) lines.push('💰 extra buffer ' + money(res.leftover));
          out.innerHTML = 'Splits as: ' + lines.join(' · ');
        }
      }
      input.addEventListener('input', preview);
      preview();

      $('[data-act="confirm-amount"]', sheet).addEventListener('click', function () {
        var amt = round2(parseFloat(input.value));
        var note = $('#a-note', sheet).value.trim();
        if (!(amt > 0)) return toast('⚠️ Enter an amount');

        if (o.billId) {
          var ids = logContributions(iso, [{ billId: o.billId, amount: amt }], { note: note });
          save();
          lastUndo = { fn: function () { removeContributions(ids); save(); render(); } };
          closeSheet(); render();
          toast('✅ ' + money(amt) + ' added to ' + billById(o.billId).name, 'Undo');
        } else {
          var doComplete = completeBtn && completeBtn.classList.contains('on');
          if (doComplete) {
            closeSheet();
            completeDay(iso, { amount: amt });
          } else {
            var res = allocate(amt, iso);
            if (res.leftover > 0.004) res.alloc.push({ billId: BUFFER_ID, amount: res.leftover });
            var ids2 = logContributions(iso, res.alloc, { note: note });
            save();
            lastUndo = { fn: function () { removeContributions(ids2); save(); render(); } };
            closeSheet(); render();
            toast('✅ ' + money(amt) + ' set aside', 'Undo');
          }
        }
      });
      setTimeout(function () { input.focus(); input.select(); }, 220);
    });
  }

  /* ---- Logging work and costs -------------------------------------------- */

  function jobSheet(job, dateISO) {
    var isNew = !job;
    var d = job || { amount: '', service: SERVICES[0], client: '', method: 'cash',
                     date: dateISO || todayISO(), note: '', partnerCut: true };
    var pRule = state.settings.partner || {};
    var cutApplies = pRule.mode !== 'none';

    var html = '<h2>' + (isNew ? 'Log a job' : 'Edit job') + '</h2>' +
      '<div class="sheet-sub">What the job brought in.</div>' +
      '<div class="field"><label>Amount</label>' +
      '<input id="j-amt" type="text" inputmode="decimal" value="' + (d.amount === '' ? '' : d.amount) + '" placeholder="0.00"></div>' +
      '<div class="chip-row mb" id="j-quick">' +
      [40, 60, 80, 120, 150, 200].map(function (n) {
        return '<button type="button" class="chip" data-set="' + n + '">$' + n + '</button>';
      }).join('') + '</div>' +
      '<div class="field"><label>Service</label><select id="j-service">' +
      SERVICES.map(function (x) {
        return '<option value="' + esc(x) + '"' + (d.service === x ? ' selected' : '') + '>' + esc(x) + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field"><label>Paid by</label><div class="chip-row" id="j-method">' +
      METHODS.map(function (x) {
        return '<button type="button" class="chip' + (d.method === x.v ? ' on' : '') +
          '" data-m="' + x.v + '">' + x.icon + ' ' + x.label + '</button>';
      }).join('') + '</div></div>' +
      (cutApplies
        ? '<div class="switch-row">' +
          '<div><div class="sr-label">' + esc(partnerName()) + '\'s cut on this one</div>' +
          '<div class="sr-hint">' + partnerRule() + ' — switch off if this job is all yours.</div></div>' +
          '<button class="switch' + (jobHasCut(d) ? ' on' : '') + '" id="j-cut"></button></div>'
        : '') +
      '<div class="field-row">' +
      '<div class="field"><label>Customer (optional)</label>' +
      '<input id="j-client" type="text" value="' + esc(d.client || '') + '" placeholder="Name" autocomplete="off"></div>' +
      '<div class="field"><label>Date</label><input id="j-date" type="date" value="' + esc(d.date) + '"></div>' +
      '</div>' +
      '<div class="field"><label>Note (optional)</label>' +
      '<input id="j-note" type="text" value="' + esc(d.note || '') + '" placeholder="e.g. tipped $20"></div>' +
      '<button class="btn primary" id="j-save" style="margin-bottom:8px">' +
      (isNew ? 'Log it' : 'Save changes') + '</button>';
    if (!isNew) html += '<button class="btn danger" id="j-del" style="margin-bottom:8px">Delete this job</button>';
    html += '<button class="btn ghost" data-act="close-sheet">Cancel</button>';

    openSheet(html, function (sheet) {
      var method = d.method;
      var cutOn = jobHasCut(d);
      var cutEl = $('#j-cut', sheet);
      if (cutEl) {
        cutEl.addEventListener('click', function () {
          cutOn = !cutOn;
          cutEl.classList.toggle('on', cutOn);
        });
      }
      $$('#j-method .chip', sheet).forEach(function (c) {
        c.addEventListener('click', function () {
          method = c.dataset.m;
          $$('#j-method .chip', sheet).forEach(function (x) { x.classList.remove('on'); });
          c.classList.add('on');
        });
      });
      $$('#j-quick .chip', sheet).forEach(function (c) {
        c.addEventListener('click', function () { $('#j-amt', sheet).value = c.dataset.set; });
      });

      $('#j-save', sheet).addEventListener('click', function () {
        var amt = round2(parseFloat($('#j-amt', sheet).value));
        var date = $('#j-date', sheet).value;
        if (!(amt > 0)) return toast('⚠️ Enter what the job paid');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('⚠️ Pick a date');

        var rec = {
          id: job ? job.id : uid(), date: date, amount: amt,
          service: $('#j-service', sheet).value,
          client: $('#j-client', sheet).value.trim(),
          method: method, note: $('#j-note', sheet).value.trim(),
          partnerCut: cutOn,
          ts: job ? job.ts : Date.now()
        };
        if (job) {
          state.jobs = state.jobs.map(function (x) { return x.id === job.id ? rec : x; });
        } else {
          state.jobs.push(rec);
        }
        if (job && job.date !== date) syncAutoSetAside(job.date);
        var moved = syncAutoSetAside(date);
        save(); closeSheet(); render();
        var m = dayMoney(date);
        toast('✅ ' + money(amt) + ' logged' +
          (moved > 0.004 ? ' · ' + money(moved) + ' straight to bills' : '') +
          ' · ' + money(Math.max(0, m.takeHome)) + ' yours');
      });

      if (!isNew) {
        $('#j-del', sheet).addEventListener('click', function () {
          var gone = job;
          state.jobs = state.jobs.filter(function (x) { return x.id !== job.id; });
          syncAutoSetAside(job.date);
          save(); closeSheet(); render();
          lastUndo = { fn: function () {
            state.jobs.push(gone); syncAutoSetAside(gone.date); save(); render();
          } };
          toast('🗑️ Job removed', 'Undo');
        });
      }
      setTimeout(function () { if (isNew) $('#j-amt', sheet).focus(); }, 220);
    });
  }

  function expenseSheet(exp, dateISO, presetCat) {
    var isNew = !exp;
    var d = exp || { amount: '', category: presetCat || 'supplies',
                     date: dateISO || todayISO(), item: '' };
    var again = isNew ? recentItems(null, 8) : [];

    var html = '<h2>' + (isNew ? 'Log an expense' : 'Edit expense') + '</h2>' +
      '<div class="sheet-sub">What the work cost you. Some days that\'s nothing — ' +
      'there is no standing amount, only what you log.</div>';

    if (again.length) {
      html += '<div class="field"><label>Bought before</label><div class="chip-row" id="e-again">' +
        again.map(function (r, i) {
          var c = EXPENSE_CATS.filter(function (x) { return x.v === r.category; })[0];
          return '<button type="button" class="chip" data-i="' + i + '">' +
            (c ? c.icon : '📎') + ' ' + esc(r.name) + ' <span class="faint">' + money(r.amount) + '</span></button>';
        }).join('') + '</div>' +
        '<div class="hint">One tap fills it in. Change the amount if the price moved.</div></div>';
    }

    html += '<div class="field"><label>Amount</label>' +
      '<input id="e-amt" type="text" inputmode="decimal" value="' + (d.amount === '' ? '' : d.amount) + '" placeholder="0.00"></div>' +
      '<div class="field"><label>What was it</label>' +
      '<input id="e-item" type="text" value="' + esc(d.item || '') + '" placeholder="e.g. wax, towels, tyre shine" autocomplete="off"></div>' +
      '<div class="field"><label>What kind</label><div class="chip-row" id="e-cat">' +
      EXPENSE_CATS.map(function (c) {
        return '<button type="button" class="chip' + (d.category === c.v ? ' on' : '') +
          '" data-c="' + c.v + '">' + c.icon + ' ' + c.label + '</button>';
      }).join('') + '</div></div>' +
      '<div class="field"><label>Date</label><input id="e-date" type="date" value="' + esc(d.date) + '"></div>' +
      '<button class="btn primary" id="e-save" style="margin-bottom:8px">' +
      (isNew ? 'Log it' : 'Save changes') + '</button>';
    if (!isNew) html += '<button class="btn danger" id="e-del" style="margin-bottom:8px">Delete this expense</button>';
    html += '<button class="btn ghost" data-act="close-sheet">Cancel</button>';

    openSheet(html, function (sheet) {
      var cat = d.category;
      var setCat = function (v) {
        cat = v;
        $$('#e-cat .chip', sheet).forEach(function (x) { x.classList.toggle('on', x.dataset.c === v); });
      };
      $$('#e-cat .chip', sheet).forEach(function (c) {
        c.addEventListener('click', function () { setCat(c.dataset.c); });
      });
      $$('#e-again .chip', sheet).forEach(function (c) {
        c.addEventListener('click', function () {
          var r = again[+c.dataset.i];
          if (!r) return;
          $('#e-amt', sheet).value = r.amount;
          $('#e-item', sheet).value = r.name;
          setCat(r.category);
        });
      });

      $('#e-save', sheet).addEventListener('click', function () {
        var amt = round2(parseFloat($('#e-amt', sheet).value));
        var date = $('#e-date', sheet).value;
        if (!(amt > 0)) return toast('⚠️ Enter what it cost');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('⚠️ Pick a date');

        var item = $('#e-item', sheet).value.trim();
        var rec = {
          id: exp ? exp.id : uid(), date: date, amount: amt, category: cat,
          item: item, note: item, ts: exp ? exp.ts : Date.now()
        };
        if (exp) {
          state.expenses = state.expenses.map(function (x) { return x.id === exp.id ? rec : x; });
        } else {
          state.expenses.push(rec);
        }
        if (exp && exp.date !== date) syncAutoSetAside(exp.date);
        syncAutoSetAside(date);
        save(); closeSheet(); render();
        var catLbl = (EXPENSE_CATS.filter(function (c) { return c.v === cat; })[0] || {}).label || 'Expense';
        toast('✅ ' + money(amt) + ' · ' + (item || catLbl) + ' logged');
      });

      if (!isNew) {
        $('#e-del', sheet).addEventListener('click', function () {
          var gone = exp;
          state.expenses = state.expenses.filter(function (x) { return x.id !== exp.id; });
          syncAutoSetAside(exp.date);
          save(); closeSheet(); render();
          lastUndo = { fn: function () {
            state.expenses.push(gone); syncAutoSetAside(gone.date); save(); render();
          } };
          toast('🗑️ Expense removed', 'Undo');
        });
      }
      setTimeout(function () { if (isNew) $('#e-amt', sheet).focus(); }, 220);
    });
  }

  function categorySheet(cat) {
    var meta = EXPENSE_CATS.filter(function (c) { return c.v === cat; })[0] || { label: 'Other', icon: '📎' };
    var all = categorySummary(cat);
    var mw = monthWindow(todayISO());
    var mon = categorySummary(cat, mw.start, todayISO());

    // how often it actually comes up — the point being that it isn't every day
    var worked = {};
    state.jobs.forEach(function (j) { worked[j.date] = 1; });
    var workedDays = Object.keys(worked).length;
    var boughtOnWorked = Object.keys(worked).filter(function (iso) {
      return state.expenses.some(function (e) { return e.date === iso && (e.category || 'other') === cat; });
    }).length;

    var html = '<h2>' + meta.icon + ' ' + esc(meta.label) + '</h2>' +
      '<div class="sheet-sub">Logged when you actually buy something — there is no ' +
      'daily amount running in the background.</div>';

    html += '<div class="card tight"><div class="stat-grid">' +
      '<div class="stat"><div class="stat-val money">' + money0(mon.total) + '</div><div class="stat-lbl">This month</div></div>' +
      '<div class="stat"><div class="stat-val money">' + money0(all.total) + '</div><div class="stat-lbl">All time</div></div>' +
      '<div class="stat"><div class="stat-val money">' + money0(all.days ? all.total / all.days : 0) + '</div><div class="stat-lbl">A shopping day</div></div>' +
      '</div>';
    if (workedDays) {
      html += '<div class="hint mt">You bought ' + esc(meta.label.toLowerCase()) + ' on <strong>' +
        boughtOnWorked + ' of ' + plural(workedDays, 'working day') + '</strong>' +
        (boughtOnWorked < workedDays
          ? ' — the other ' + (workedDays - boughtOnWorked) + ' cost you nothing here.'
          : '.') + '</div>';
    }
    html += '</div>';

    if (all.items.length) {
      var top = all.items[0].total;
      html += '<div class="card"><div class="card-title">What you buy</div>';
      all.items.slice(0, 10).forEach(function (x) {
        html += '<div style="padding:8px 0">' +
          '<div style="display:flex;justify-content:space-between;gap:10px;font-size:0.9rem">' +
          '<span>' + esc(x.name) + ' <span class="faint tiny">×' + x.times + '</span></span>' +
          '<span class="lr-amt">' + money(x.total) + '</span></div>' +
          '<div class="bar" style="margin-top:6px"><div class="bar-fill" style="width:' +
          (top > 0 ? (x.total / top * 100).toFixed(1) : 0) + '%;background:' + vizColors()[1] + '"></div></div></div>';
      });
      html += '</div>';
    }

    html += '<button class="btn primary" data-act="add-expense" data-cat="' + cat + '" style="margin-bottom:8px">' +
      '＋ Log ' + esc(meta.label.toLowerCase()) + '</button>';

    if (all.list.length) {
      html += '<div class="sep"></div><div class="card-title">Every purchase</div>';
      all.list.slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 30).forEach(function (e) {
        html += '<button class="log-row" data-act="edit-expense" data-id="' + e.id + '">' +
          '<div class="log-ico">' + meta.icon + '</div><div class="log-main">' +
          '<div class="log-title">' + esc(e.item || meta.label) + '</div>' +
          '<div class="log-sub">' + fmtDate(e.date, 'dow') + ' · ' + relDay(e.date) + '</div></div>' +
          '<div class="log-amt out">−' + money(e.amount) + '</div></button>';
      });
    }

    html += '<button class="btn ghost mt" data-act="close-sheet">Close</button>';
    openSheet(html);
  }

  function payoutSheet(who) {
    var owed = owedTo(who);
    var label = who === 'tax' ? 'tax' : partnerName();
    var html = '<h2>Pay ' + esc(label) + '</h2>' +
      '<div class="sheet-sub">' + money(owed) + ' has built up. Recording a payment clears it down.</div>' +
      '<div class="field"><label>Amount paid</label>' +
      '<input id="p-amt" type="text" inputmode="decimal" value="' + (owed > 0 ? owed.toFixed(2) : '') + '"></div>' +
      '<div class="field"><label>Date</label><input id="p-date" type="date" value="' + todayISO() + '"></div>' +
      '<div class="field"><label>Note (optional)</label><input id="p-note" type="text" placeholder="e.g. cash on Friday"></div>' +
      '<button class="btn primary" id="p-save" style="margin-bottom:8px">Record it</button>' +
      '<button class="btn ghost" data-act="close-sheet">Cancel</button>';

    openSheet(html, function (sheet) {
      $('#p-save', sheet).addEventListener('click', function () {
        var amt = round2(parseFloat($('#p-amt', sheet).value));
        var date = $('#p-date', sheet).value;
        if (!(amt > 0)) return toast('⚠️ Enter an amount');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('⚠️ Pick a date');
        var rec = { id: uid(), date: date, amount: amt, to: who,
                    note: $('#p-note', sheet).value.trim(), ts: Date.now() };
        state.payouts.push(rec);
        save(); closeSheet(); render();
        lastUndo = {
          fn: function () {
            state.payouts = state.payouts.filter(function (x) { return x.id !== rec.id; });
            save(); render();
          }
        };
        toast('✅ ' + money(amt) + ' to ' + esc(label) + ' · ' + money(owedTo(who)) + ' left', 'Undo');
      });
      setTimeout(function () { $('#p-amt', sheet).focus(); }, 220);
    });
  }

  function businessSetupSheet() {
    var p = state.settings.partner || { name: 'Logan', mode: 'none', value: 0 };
    var html = '<h2>Splits &amp; tax</h2>' +
      '<div class="sheet-sub">Money that leaves before you keep anything. Both are taken out ' +
      'automatically on every job you log.</div>' +
      '<div class="field"><label>Who takes a cut</label>' +
      '<input id="b-name" type="text" value="' + esc(p.name || '') + '" placeholder="Logan" autocomplete="off"></div>' +
      '<div class="field"><label>They take</label><select id="b-mode">' +
      PARTNER_MODES.map(function (m) {
        return '<option value="' + m.v + '"' + (p.mode === m.v ? ' selected' : '') + '>' + m.label + '</option>';
      }).join('') + '</select></div>' +
      '<div class="field" id="b-val-wrap"><label id="b-val-label">How much</label>' +
      '<input id="b-value" type="text" inputmode="decimal" value="' + (p.value || '') + '"></div>' +
      '<div class="hint mb" id="b-preview"></div>' +
      '<div class="sep"></div>' +
      '<div class="switch-row">' +
      '<div><div class="sr-label">Put money by for tax</div>' +
      '<div class="sr-hint">Off unless you want it held back.</div></div>' +
      '<button class="switch' + (state.settings.taxRate > 0 ? ' on' : '') + '" id="b-tax-on"></button>' +
      '</div>' +
      '<div class="field" id="b-tax-wrap"' + (state.settings.taxRate > 0 ? '' : ' style="display:none"') + '>' +
      '<label>How much of what\'s left</label>' +
      '<div class="chip-row" id="b-tax">' +
      [10, 15, 20, 25, 30].map(function (n) {
        return '<button type="button" class="chip' + (state.settings.taxRate === n ? ' on' : '') +
          '" data-t="' + n + '">' + n + '%</button>';
      }).join('') + '</div>' +
      '<div class="hint">Taken off what\'s left after costs and the cut, and held as a balance ' +
      'until you record paying it.</div></div>' +
      '<button class="btn primary" id="b-save" style="margin-bottom:8px">Save</button>' +
      '<button class="btn ghost" data-act="close-sheet">Cancel</button>';

    openSheet(html, function (sheet) {
      var tax = state.settings.taxRate || 0;
      var taxOn = tax > 0;
      var lastRate = tax > 0 ? tax : 15;      // remembered while the switch is off

      var taxSwitch = $('#b-tax-on', sheet);
      function syncTax() {
        taxSwitch.classList.toggle('on', taxOn);
        $('#b-tax-wrap', sheet).style.display = taxOn ? '' : 'none';
        tax = taxOn ? lastRate : 0;
        $$('#b-tax .chip', sheet).forEach(function (x) {
          x.classList.toggle('on', +x.dataset.t === lastRate);
        });
        preview();
      }
      taxSwitch.addEventListener('click', function () { taxOn = !taxOn; syncTax(); });
      $$('#b-tax .chip', sheet).forEach(function (c) {
        c.addEventListener('click', function () { lastRate = +c.dataset.t; taxOn = true; syncTax(); });
      });

      function preview() {
        var mode = $('#b-mode', sheet).value;
        var val = parseFloat($('#b-value', sheet).value) || 0;
        var m = PARTNER_MODES.filter(function (x) { return x.v === mode; })[0] || {};
        $('#b-val-wrap', sheet).style.display = mode === 'none' ? 'none' : '';
        $('#b-val-label', sheet).textContent =
          m.suffix === '%' ? 'What percentage' : 'How much per ' + (mode === 'perJob' ? 'job' : 'day');

        // worked example on a $200 day with $30 of costs
        var rev = 200, cost = 30;
        var cut = mode === 'pctRevenue' ? rev * val / 100
          : mode === 'pctProfit' ? Math.max(0, rev - cost) * val / 100
          : mode === 'perJob' ? val
          : mode === 'perDay' ? val : 0;
        var afterCut = rev - cost - cut;
        var t = Math.max(0, afterCut) * tax / 100;
        $('#b-preview', sheet).innerHTML =
          'On a ' + money(rev) + ' day with ' + money(cost) + ' of costs: ' +
          (cut > 0 ? '<strong>' + money(cut) + '</strong> to ' +
            esc($('#b-name', sheet).value.trim() || 'them') + ', ' : '') +
          (t > 0 ? '<strong>' + money(t) + '</strong> to tax, ' : '') +
          '<strong>' + money(afterCut - t) + '</strong> left before bills.';
      }
      ['#b-mode', '#b-value', '#b-name'].forEach(function (sel) {
        $(sel, sheet).addEventListener('input', preview);
        $(sel, sheet).addEventListener('change', preview);
      });
      syncTax();

      $('#b-save', sheet).addEventListener('click', function () {
        var mode = $('#b-mode', sheet).value;
        var val = round2(parseFloat($('#b-value', sheet).value)) || 0;
        if (mode !== 'none' && !(val > 0)) return toast('⚠️ Enter how much they take');
        state.settings.partner = {
          name: $('#b-name', sheet).value.trim() || 'Partner',
          mode: mode, value: val
        };
        state.settings.taxRate = tax;
        save(); closeSheet(); render();
        toast('✅ Splits saved');
      });
    });
  }

  /* ---- Day detail -------------------------------------------------------- */

  function daySheet(iso) {
    var rec = state.days[iso];
    var funding = isFundingDay(iso);
    var actual = dayActual(iso);
    var sim = null;
    if (!isPast(iso)) sim = simulate(todayISO(), iso)[iso];

    var dm = dayMoney(iso);
    var html = '<h2>' + fmtDate(iso, 'long') + '</h2>' +
      '<div class="sheet-sub">' + (funding ? 'Workday' : 'Day off') + ' · ' + relDay(iso) + '</div>';

    if (dm.revenue > 0.004 || dm.costs > 0.004) {
      html += '<div class="card tight"><div class="card-title">That day\'s money</div><div class="flow">' +
        flowRow('Money in', plural(dm.jobs, 'job'), dm.revenue, '') +
        (dm.costs > 0.004 ? flowRow('Cost you', '', -dm.costs, 'out') : '') +
        (dm.partner > 0.004 ? flowRow(esc(partnerName()), '', -dm.partner, 'out') : '') +
        (dm.tax > 0.004 ? flowRow('Tax', '', -dm.tax, 'out') : '') +
        (dm.bills > 0.004 ? flowRow('Bills', '', -dm.bills, 'out') : '') +
        '<div class="flow-row total ' + (dm.takeHome < 0 ? 'neg' : 'pos') + '">' +
        '<div class="flow-label">Kept</div><div class="flow-amt">' + money(dm.takeHome) + '</div></div>' +
        '</div></div>';

      jobsOn(iso).forEach(function (j) { html += jobRowHTML(j); });
      expensesOn(iso).forEach(function (e) {
        var cat = EXPENSE_CATS.filter(function (c) { return c.v === e.category; })[0];
        html += '<button class="log-row" data-act="edit-expense" data-id="' + e.id + '">' +
          '<div class="log-ico">' + (cat ? cat.icon : '📎') + '</div><div class="log-main">' +
          '<div class="log-title">' + (cat ? cat.label : 'Other') + '</div>' +
          '<div class="log-sub">' + (e.note ? esc(e.note) : '') + '</div></div>' +
          '<div class="log-amt out">−' + money(e.amount) + '</div></button>';
      });
    }

    html += '<div class="btn-row mt" style="margin-bottom:8px">' +
      '<button class="btn" data-act="add-job" data-date="' + iso + '">＋ Job</button>' +
      '<button class="btn" data-act="add-expense" data-date="' + iso + '">＋ Expense</button></div>';

    if (sim && sim.remainingTotal > 0.004) {
      html += '<div class="card tight"><div class="card-title">Plan for this day</div>';
      sim.remaining.forEach(function (it) {
        var b = billById(it.billId);
        html += '<div class="list-row"><div>' + esc(b ? (b.icon || '🧾') + ' ' + b.name : '—') + '</div>' +
          '<div class="lr-amt">' + money(it.amount) + '</div></div>';
      });
      html += '<div class="list-row"><div><strong>Total</strong></div><div class="lr-amt">' + money(sim.remainingTotal) + '</div></div></div>';
    }

    if (actual > 0.004) {
      html += '<div class="card tight"><div class="card-title">Set aside that day</div>';
      contributionsOn(iso).forEach(function (c) {
        var b = c.billId === BUFFER_ID ? null : billById(c.billId);
        html += '<div class="list-row"><div>' + (b ? esc(b.icon || '🧾') + ' ' + esc(b.name) : '💰 Extra buffer') + '</div>' +
          '<div style="display:flex;align-items:center;gap:10px"><span class="lr-amt">+' + money(c.amount) + '</span>' +
          '<button class="btn sm ghost" data-act="del-contrib" data-cid="' + c.id + '">✕</button></div></div>';
      });
      html += '<div class="list-row"><div><strong>Total</strong></div><div class="lr-amt">' + money(actual) + '</div></div></div>';
    }

    if (rec && rec.completed) {
      html += '<div class="banner"><span>✅</span><div><strong>Day marked complete</strong>' +
        (rec.skipped ? 'Logged as a day you couldn\'t set money aside.' : 'Counted toward your streak.') + '</div></div>' +
        '<button class="btn ghost" data-act="reopen-specific" data-date="' + iso + '" style="margin-bottom:8px">Reopen this day</button>';
    } else if (!isFuture(iso)) {
      html += '<button class="btn primary" data-act="log-for-day" data-date="' + iso + '" style="margin-bottom:8px">Log money for this day</button>' +
        '<button class="btn" data-act="complete-specific" data-date="' + iso + '" style="margin-bottom:8px">Mark complete without money</button>';
    }

    html += '<button class="btn ghost" data-act="toggle-day-type" data-date="' + iso + '" style="margin-bottom:8px">' +
      (funding ? 'Mark as a day off' : 'Mark as a workday') + '</button>';
    html += '<button class="btn ghost" data-act="close-sheet">Close</button>';

    openSheet(html);
  }

  /* ---------------------------------------------------------------------------
     9. Backup / restore
     ------------------------------------------------------------------------ */

  function exportData() {
    var text = JSON.stringify(state, null, 2);
    var name = 'bill-cushion-backup-' + todayISO() + '.json';
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      state.settings.lastBackup = todayISO(); save(); render();
      toast('⬇︎ Backup saved to Files');
    } catch (e) {
      copyBackup();
    }
  }

  function copyBackup() {
    var text = JSON.stringify(state);
    var done = function () {
      state.settings.lastBackup = todayISO(); save(); render();
      toast('⧉ Backup copied — paste it somewhere safe');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { showBackupText(text); });
    } else showBackupText(text);
  }

  function showBackupText(text) {
    openSheet('<h2>Your backup</h2><div class="sheet-sub">Select all and copy this somewhere safe.</div>' +
      '<div class="field"><textarea rows="8" readonly style="font-size:12px">' + esc(text) + '</textarea></div>' +
      '<button class="btn ghost" data-act="close-sheet">Done</button>');
  }

  /** Read a backup or a setup link out of arbitrary pasted text. */
  function parsePastedSetup(raw) {
    var txt = String(raw || '').trim();
    if (!txt) return null;

    // a whole setup link, or just the part after the #
    if (/(^|[#&])(add|import)=/.test(txt)) {
      var hash = txt.slice(txt.indexOf('#') === -1 ? 0 : txt.indexOf('#'));
      if (hash.charAt(0) !== '#') hash = '#' + hash;
      var short = parseAddLink(hash);
      if (short) return short;
      var m = hash.match(/[#&]import=([A-Za-z0-9+/=_-]+)/);
      if (m) {
        try {
          var b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
          return JSON.parse(decodeURIComponent(escape(atob(b64))));
        } catch (e) { return null; }
      }
      return null;
    }

    try {
      var d = JSON.parse(txt);
      return d && Array.isArray(d.bills) ? d : null;
    } catch (e) { return null; }
  }

  function importData() {
    openSheet('<h2>Paste a setup code</h2>' +
      '<div class="sheet-sub">Paste a setup code, a setup link, or a backup you saved earlier. ' +
      'Any of them works — the whole link, or just the part after the #.</div>' +
      '<div class="field"><label>Paste it here</label>' +
      '<textarea id="i-text" rows="6" placeholder="add=Rent,300,2026-10-07;Phone,100,2026-10-02" ' +
      'style="font-size:12px" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea></div>' +
      '<div class="field"><label>…or choose a backup file</label><input id="i-file" type="file" accept="application/json,.json"></div>' +
      '<button class="btn primary" data-act="do-import" style="margin-bottom:8px">Load it</button>' +
      '<button class="btn ghost" data-act="close-sheet">Cancel</button>',
      function (sheet) {
        var pending = null;
        $('#i-file', sheet).addEventListener('change', function (e) {
          var f = e.target.files && e.target.files[0];
          if (!f) return;
          var fr = new FileReader();
          fr.onload = function () { pending = fr.result; toast('📄 File loaded — tap Restore'); };
          fr.readAsText(f);
        });
        $('[data-act="do-import"]', sheet).addEventListener('click', function () {
          var raw = pending || $('#i-text', sheet).value.trim();
          if (!raw) return toast('⚠️ Pick a file or paste a link');

          var d = parsePastedSetup(raw);
          if (!d) return toast('⚠️ That is not a Bill Cushion backup or setup link');

          // a setup link names only some settings — keep the rest
          if (!d.settings || !d.settings.roundTo) {
            d.settings = Object.assign({}, state.settings, d.settings || {});
          }
          localStorage.setItem(STORE_KEY, JSON.stringify(d));
          load(); save(); closeSheet(); render();
          toast('✅ Loaded ' + plural(state.bills.length, 'bill'));
        });
      });
  }

  /**
   * A setup link: billcushion.../#import=<url-safe base64 of a backup>.
   * Lets a whole list of bills arrive in one tap instead of being typed on a phone.
   */
  /** Pick an icon from the bill's name, so a short link needn't carry one. */
  function guessIcon(name) {
    var n = String(name).toLowerCase();
    var map = [
      // card/credit first: a bare /car/ would claim "credit card"
      [/credit|card|smartpay|loan|finance|pay\s*plan/, '💳'],
      [/rent|mortgage|hous/, '🏠'], [/insur/, '🛡️'],
      [/\bcars?\b|auto|vehicle|accident|truck|van/, '🚗'],
      [/phone|mobile|cell/, '📱'], [/electric|power|light/, '⚡'], [/internet|wifi|broadband/, '🌐'],
      [/water/, '💧'], [/\bgas\b|heat/, '🔥'],
      [/fuel|petrol/, '⛽'], [/grocer|food/, '🛒'], [/bank/, '🏦'], [/warrant|repair|service/, '🔧'],
      [/tv|stream|subscri/, '📺'], [/medic|health|doctor|dental/, '🏥'], [/child|daycare/, '👶'],
      [/storage|unit/, '📦'], [/school|tuition|student/, '🎓'], [/pet|dog|cat|vet/, '🐕']
    ];
    for (var i = 0; i < map.length; i++) if (map[i][0].test(n)) return map[i][1];
    return '🧾';
  }

  /**
   * The short form of a setup link:
   *   #add=Name,amount,YYYY-MM-DD[,d1/d2/...];Name,amount,...&w=5&c=6
   * Same idea as #import= but a fraction of the length, so it survives being
   * pasted through a chat app. "+" reads as a space.
   */
  function parseAddLink(hash) {
    var m = hash.match(/[#&]add=([^&]*)/);
    var hasSettings = /[#&](w|c|p|tax)=/.test(hash);
    if (!m && !hasSettings) return null;

    var txt = '';
    if (m) {
      try { txt = decodeURIComponent(m[1]); } catch (e) { txt = m[1]; }
      txt = txt.replace(/\+/g, ' ');
    }

    var bills = [];
    txt.split(';').forEach(function (chunk) {
      var f = chunk.split(',');
      var name = (f[0] || '').trim();
      var amount = parseFloat(f[1]);
      if (!name || !(amount > 0)) return;

      var b = {
        id: uid(), name: name, icon: guessIcon(name),
        amount: round2(amount), recurrence: 'monthly', cycle: 0
      };
      var due = (f[2] || '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
        b.dueDate = due;
        b.anchorDay = fromISO(due).getDate();
      }
      var sched = (f[3] || '').split('/').filter(function (x) { return /^\d{4}-\d{2}-\d{2}$/.test(x.trim()); });
      if (sched.length) { b.recurrence = 'schedule'; b.scheduleDates = sched.sort(); }
      bills.push(b);
    });
    var data = {
      version: 2, bills: bills, settings: {},
      settingsOnly: !bills.length,
      meta: { created: todayISO() }
    };

    var wk = hash.match(/[#&]w=(\d)/);
    if (wk) { data.settings.countMode = 'estimate'; data.settings.daysPerWeek = clamp(+wk[1], 1, 7); }

    var cu = hash.match(/[#&]c=(\d{1,2})/);
    if (cu) { data.settings.cushionDays = clamp(+cu[1], 0, 60); data.settings.cushionMode = 'workdays'; }

    // p=Name:mode:value  — who takes a cut and how
    var pm = hash.match(/[#&]p=([^&]*)/);
    if (pm) {
      var raw;
      try { raw = decodeURIComponent(pm[1]); } catch (e) { raw = pm[1]; }
      var f = raw.replace(/\+/g, ' ').split(':');
      var mode = (f[1] || 'none').trim();
      var known = PARTNER_MODES.filter(function (x) { return x.v === mode; }).length;
      if (known) {
        data.settings.partner = {
          name: (f[0] || 'Partner').trim() || 'Partner',
          mode: mode,
          value: round2(parseFloat(f[2])) || 0
        };
        if (mode !== 'none' && !(data.settings.partner.value > 0)) data.settings.partner.mode = 'none';
      }
    }

    // tax=0 turns it off; tax=20 sets the rate
    var tx = hash.match(/[#&]tax=(\d{1,2})/);
    if (tx) data.settings.taxRate = clamp(+tx[1], 0, 95);

    if (!bills.length && !Object.keys(data.settings).length) return null;
    return data;
  }

  /** Describe a settings-only code in plain words, so it can be confirmed. */
  function describeSettings(st) {
    var out = [];
    if (st.partner) {
      out.push(st.partner.mode === 'none'
        ? 'Nobody takes a cut'
        : esc(st.partner.name) + ' takes ' +
          (st.partner.mode === 'pctRevenue' ? st.partner.value + '% of takings'
            : st.partner.mode === 'pctProfit' ? st.partner.value + '% of profit'
            : st.partner.mode === 'perJob' ? money(st.partner.value) + ' a job'
            : money(st.partner.value) + ' a working day'));
    }
    if (st.taxRate != null) {
      out.push(st.taxRate > 0 ? 'Tax held back at ' + st.taxRate + '%' : 'Tax off — nothing held back');
    }
    if (st.daysPerWeek) out.push('About ' + plural(st.daysPerWeek, 'working day') + ' a week');
    if (st.cushionDays != null) out.push('Cushion of ' + plural(st.cushionDays, 'working day'));
    return out;
  }

  function checkImportLink() {
    var hash = location.hash || '';
    var short = parseAddLink(hash);
    var m = short ? null : hash.match(/[#&]import=([A-Za-z0-9+/=_-]+)/);
    if (!m && !short) return;

    var clearHash = function () {
      try { history.replaceState(null, '', location.pathname + location.search); }
      catch (e) { location.hash = ''; }
    };

    var data = short;
    if (!data) {
      try {
        var b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        data = JSON.parse(decodeURIComponent(escape(atob(b64))));
      } catch (e) { data = null; }
    }

    if (!data || !Array.isArray(data.bills)) {
      clearHash();
      toast('⚠️ That setup link is damaged — nothing was changed');
      return;
    }
    clearHash();

    if (data.settingsOnly) {
      var lines = describeSettings(data.settings);
      confirmSheet({
        title: 'Change these settings?',
        body: '<strong>' + lines.join('<br>') + '</strong><br><br>' +
          'Your bills, jobs and expenses are left exactly as they are.',
        actions: [{
          label: 'Apply', cls: 'primary',
          fn: function () {
            Object.keys(data.settings).forEach(function (k) { state.settings[k] = data.settings[k]; });
            save(); render();
            toast('✅ Settings updated');
          }
        }]
      });
      return;
    }

    var names = data.bills.map(function (b) { return esc(b.name); }).join(', ');
    var total = data.bills.reduce(function (a, b) { return a + (+b.amount || 0); }, 0);
    var body = '<strong>' + plural(data.bills.length, 'bill') + ' · ' + money(total) + ' a cycle</strong>' +
      names + '<br><br>' +
      (state.bills.length
        ? 'You already have ' + plural(state.bills.length, 'bill') + ' in here.'
        : 'Nothing is in the app yet.');

    var actions = [{
      label: state.bills.length ? 'Replace everything' : 'Load these bills',
      cls: 'primary',
      fn: function () {
        // A short link names only a few settings; keep whatever else is set.
        if (short) data.settings = Object.assign({}, state.settings, data.settings);
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
        load(); save(); view = 'bills'; render();
        toast('✅ Loaded ' + plural(state.bills.length, 'bill'));
      }
    }];
    if (state.bills.length) {
      actions.push({
        label: 'Add them to what I have',
        fn: function () {
          data.bills.forEach(function (b) {
            var copy = JSON.parse(JSON.stringify(b));
            copy.id = uid();
            copy.cycleStart = todayISO();
            copy.createdAt = todayISO();
            copy.cycle = 0;
            copy.paidHistory = [];
            state.bills.push(copy);
          });
          save(); view = 'bills'; render();
          toast('✅ Added ' + plural(data.bills.length, 'bill'));
        }
      });
    }

    confirmSheet({ title: 'Load this setup?', body: body, actions: actions });
  }

  /**
   * If the saved data could not be read, say so and offer the last clean copy.
   * Never silently present an empty app to someone who had data in it.
   */
  function offerRecovery() {
    if (loadState !== 'corrupt') return;
    var good = lastGood();

    var actions = [];
    if (good) {
      actions.push({
        label: 'Restore ' + plural(good.data.bills.length, 'bill') + ' from the last good copy',
        cls: 'primary',
        fn: function () {
          try { localStorage.setItem(STORE_KEY, good.raw); } catch (e) {}
          loadState = 'empty'; load(); save(); render();
          toast('✅ Restored ' + plural(state.bills.length, 'bill'));
        }
      });
    }
    actions.push({
      label: 'Start fresh',
      cls: good ? '' : 'primary',
      fn: function () {
        state = defaults();
        loadState = 'empty'; save(); render();
        toast('Started fresh');
      }
    });
    actions.push({
      label: 'Paste a setup code instead',
      fn: function () { importData(); }
    });

    confirmSheet({
      title: 'Your saved data could not be read',
      body: 'Something went wrong with the copy stored on this device. ' +
        '<strong>Nothing has been deleted</strong> — it is still there, just unreadable.' +
        (good
          ? '<br><br>There is a clean copy from the last time the app opened properly.'
          : '<br><br>There is no fallback copy, so a setup code is the quickest way back.'),
      actions: actions
    });
  }

  /**
   * Rebuild a setup code from what is in the app right now, so the whole
   * setup can be kept somewhere outside this browser and pasted back.
   */
  function myCode() {
    var parts = activeBills().map(function (b) {
      var seg = b.name.replace(/[,;&+]/g, ' ').trim().replace(/\s+/g, '+') + ',' +
        (Math.round(b.amount * 100) / 100);
      if (isDated(b)) seg += ',' + b.dueDate;
      if (b.recurrence === 'schedule' && (b.scheduleDates || []).length) {
        seg += ',' + b.scheduleDates.join('/');
      }
      return seg;
    });
    var code = parts.length ? 'add=' + parts.join(';') : '';
    var s = state.settings;
    var tail = [];
    if (s.countMode === 'estimate') tail.push('w=' + perWeek());
    tail.push('c=' + s.cushionDays);
    if (s.partner && s.partner.mode !== 'none') {
      tail.push('p=' + s.partner.name.replace(/[:&]/g, '').replace(/\s+/g, '+') +
        ':' + s.partner.mode + ':' + s.partner.value);
    }
    tail.push('tax=' + (s.taxRate || 0));
    return (code ? code + '&' : '') + tail.join('&');
  }

  function myCodeSheet() {
    var code = myCode();
    var html = '<h2>Your setup code</h2>' +
      '<div class="sheet-sub">Everything about your bills and splits, as text. Keep it in ' +
      'Notes or message it to yourself — pasting it back rebuilds the lot.</div>' +
      '<div class="field"><textarea id="my-code" rows="6" readonly ' +
      'style="font-size:12px" onclick="this.select()">' + esc(code) + '</textarea></div>' +
      '<div class="hint mb">It does not include your jobs, costs or day history — ' +
      'use <strong>Save backup</strong> for those.</div>' +
      '<button class="btn primary" id="my-copy" style="margin-bottom:8px">Copy it</button>' +
      '<button class="btn ghost" data-act="close-sheet">Close</button>';
    openSheet(html, function (sheet) {
      $('#my-copy', sheet).addEventListener('click', function () {
        var ta = $('#my-code', sheet);
        ta.select(); ta.setSelectionRange(0, 99999);
        var done = function () {
          state.settings.lastBackup = todayISO(); save(); render();
          toast('⧉ Copied — paste it somewhere safe');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(ta.value).then(done, function () {
            try { document.execCommand('copy'); done(); } catch (e) { toast('Select the text and copy it'); }
          });
        } else {
          try { document.execCommand('copy'); done(); } catch (e) { toast('Select the text and copy it'); }
        }
      });
    });
  }

  function helpSheet() {
    var p = state.settings.partner || {};
    var hasCut = p.mode !== 'none';
    var hasTax = taxRate() > 0;

    var html = '<h2>How this works</h2>' +
      '<div class="sheet-sub">The short version, in plain words.</div>';

    html += '<div class="card tight"><div class="card-title">Every day</div>' +
      '<p class="small">Log a job when you finish one. Log what you spent, if you spent ' +
      'anything. The app takes off' +
      (hasCut ? ' ' + esc(partnerName()) + '\'s cut' : '') +
      (hasTax ? ', tax' : '') +
      ' and today\'s share of your bills, and the big green number is what is ' +
      '<strong>actually yours</strong>.</p></div>';

    html += '<div class="card tight"><div class="card-title">The bills</div>' +
      '<p class="small">Each bill is chopped into daily pieces so it is fully paid for ' +
      '<strong>' + cushionWords() + ' before it is due</strong>. Miss a day and tomorrow\'s ' +
      'piece grows a little — you cannot quietly fall behind.</p>' +
      (state.settings.autoSetAside
        ? '<p class="small mt">You do not have to move that money yourself. What a day ' +
          'earns, after costs' + (hasCut ? ' and ' + esc(partnerName()) + '\'s cut' : '') +
          ', <strong>goes to the bills on its own</strong> — nearest due date first, ' +
          'until the day\'s share is covered. Anything past that is yours.</p>'
        : '<p class="small mt">Moving the money is down to you at the moment. Turn on ' +
          '<strong>More → Fund bills automatically</strong> and the app does it out of ' +
          'each day\'s takings instead.</p>') +
      '<p class="small dim mt">"Days to spare" is your cushion: how many days you could ' +
      'skip and still pay on time. Use it all up and the bills still get paid — the ' +
      'daily figure just climbs to catch up.</p></div>';

    if (hasCut || hasTax) {
      html += '<div class="card tight"><div class="card-title">Money that is not yours</div>' +
        '<p class="small">' +
        (hasCut ? esc(partnerName()) + '\'s cut' : '') +
        (hasCut && hasTax ? ' and tax ' : ' ') +
        'build up as a running total on the <strong>Business</strong> tab. When you ' +
        'actually hand it over, record it there and the balance clears.</p>' +
        (hasCut && p.mode === 'perJob'
          ? '<p class="small dim mt">Some jobs are not his — switch off ' +
            esc(partnerName()) + '\'s cut when logging that job.</p>'
          : '') +
        '</div>';
    }

    html += '<div class="card tight"><div class="card-title">If anything ever goes missing</div>' +
      '<p class="small"><strong>More → Copy my setup code</strong>. Keep it in Notes. ' +
      'Pasting it back rebuilds every bill in one go.</p></div>';

    html += '<button class="btn ghost" data-act="close-sheet">Got it</button>';
    openSheet(html);
  }

  /* ---------------------------------------------------------------------------
     10. Toast
     ------------------------------------------------------------------------ */

  function toast(msg, actionLabel) {
    // Never report success when the write did not stick.
    if (!saveWorks && String(msg).indexOf('✅') === 0) {
      msg = '⚠️ NOT saved — this browser is not storing anything';
      actionLabel = null;
    }
    var el = $('#toast');
    el.innerHTML = '<span>' + msg + '</span>';
    if (actionLabel && lastUndo) {
      var btn = document.createElement('button');
      btn.textContent = actionLabel;
      btn.addEventListener('click', function () {
        if (lastUndo) { lastUndo.fn(); lastUndo = null; }
        el.classList.remove('show');
      });
      el.appendChild(btn);
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, actionLabel ? 6500 : 3200);
  }

  /* ---------------------------------------------------------------------------
     11. Events
     ------------------------------------------------------------------------ */

  document.addEventListener('click', function (e) {
    var tab = e.target.closest ? e.target.closest('#tabbar .tab') : null;
    if (tab) { view = tab.dataset.view; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }

    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.dataset.act;
    var id = t.dataset.id;
    var b = id ? billById(id) : null;
    var iso = todayISO();

    switch (act) {
      case 'close-sheet': closeSheet(); break;

      case 'add-bill':
        billSheet(null, t.dataset.name ? { name: t.dataset.name, icon: t.dataset.icon } : null);
        break;

      case 'open-bill': if (b) billDetailSheet(b); break;
      case 'edit-bill': if (b) billSheet(b); break;
      case 'delete-bill': if (b) { closeSheet(); deleteBill(b); } break;

      case 'mark-paid':
        if (!b) break;
        var st = statusOf(b);
        closeSheet();
        confirmSheet({
          title: 'Mark ' + esc(b.name) + ' as paid?',
          body: st.remaining > 0.004
            ? 'You\'ve banked <strong>' + money(st.saved) + '</strong> of ' + money(b.amount) +
              ' — you\'re ' + money(st.remaining) + ' short. Marking it paid starts the next cycle from zero.'
            : 'You\'ve banked <strong>' + money(st.saved) + '</strong>. That money gets used, and ' +
              (b.recurrence === 'once' ? 'the bill is archived.' :
               'the next one (' + fmtDate(advanceDue(b)) + ') starts fresh' +
               (st.saved > b.amount ? ' with ' + money(st.saved - b.amount) + ' rolled over.' : '.')),
          actions: [{ label: 'Yes, it\'s paid', cls: 'primary', fn: function () { markPaid(b); } }]
        });
        break;

      case 'add-money':
        if (!b) break;
        closeSheet();
        var s2 = statusOf(b);
        amountSheet({
          title: 'Add to ' + b.name,
          sub: money(s2.remaining) + ' still needed · ' + money(s2.perDay) + ' is today\'s share',
          value: s2.perDay > 0 ? s2.perDay.toFixed(2) : '',
          billId: b.id
        });
        break;

      case 'pay-one':
        if (!b) break;
        var s3 = statusOf(b);
        amountSheet({
          title: 'Set aside for ' + b.name,
          sub: 'Today\'s share is ' + money(+t.dataset.amt),
          value: (+t.dataset.amt).toFixed(2),
          billId: b.id
        });
        break;

      case 'quick-complete':
        var plan = todayPlan();
        completeDay(iso, { amount: plan.remainingTotal });
        break;

      case 'complete-only':
        completeDay(iso, { amount: 0 });
        break;

      case 'skip-day':
        confirmSheet({
          title: 'Couldn\'t set money aside today?',
          body: 'That\'s fine — the app spreads what\'s left over your remaining workdays, so tomorrow\'s number just goes up a little. Nothing is lost.',
          actions: [{ label: 'Mark today complete anyway', fn: function () { completeDay(iso, { skip: true }); } }]
        });
        break;

      case 'custom-amount':
        var p2 = todayPlan();
        amountSheet({
          title: 'Set aside money',
          sub: 'Today\'s plan asks for ' + money(p2.remainingTotal) + ' — enter whatever you actually have.',
          value: p2.remainingTotal > 0 ? p2.remainingTotal.toFixed(2) : '',
          allowComplete: true
        });
        break;

      case 'reopen-day': uncompleteDay(iso); break;
      case 'reopen-specific': closeSheet(); uncompleteDay(t.dataset.date); break;
      case 'complete-specific': closeSheet(); completeDay(t.dataset.date, { skip: true }); break;

      case 'log-for-day':
        var dISO = t.dataset.date;
        var dp = simulate(dISO, dISO)[dISO];
        closeSheet();
        amountSheet({
          title: 'Money for ' + fmtDate(dISO),
          sub: 'The plan asked for ' + money(dp ? dp.remainingTotal : 0) + ' that day.',
          value: dp && dp.remainingTotal > 0 ? dp.remainingTotal.toFixed(2) : '',
          date: dISO, allowComplete: true
        });
        break;

      case 'open-day': daySheet(t.dataset.date); break;

      case 'toggle-day-type':
        var day = t.dataset.date;
        var on = isFundingDay(day);
        state.overrides.work = state.overrides.work.filter(function (x) { return x !== day; });
        state.overrides.off = state.overrides.off.filter(function (x) { return x !== day; });
        if (on) state.overrides.off.push(day); else state.overrides.work.push(day);
        save(); closeSheet(); render();
        toast(on ? '🛌 ' + fmtDate(day) + ' is now a day off' : '💼 ' + fmtDate(day) + ' is now a workday');
        break;

      case 'del-contrib':
        var cid = t.dataset.cid;
        var gone = state.contributions.filter(function (c) { return c.id === cid; });
        removeContributions([cid]); save();
        lastUndo = { fn: function () { gone.forEach(function (c) { state.contributions.push(c); }); save(); render(); } };
        closeSheet(); render();
        toast('🗑️ Entry removed', 'Undo');
        break;

      case 'toggle-dow':
        var n = +t.dataset.n;
        var w = state.settings.workdays.slice();
        var at = w.indexOf(n);
        if (at === -1) w.push(n); else w.splice(at, 1);
        if (!w.length) return toast('⚠️ Keep at least one workday');
        state.settings.workdays = w.sort();
        save(); render();
        break;

      case 'set-count-mode':
        state.settings.countMode = t.dataset.m;
        save(); render();
        toast(t.dataset.m === 'estimate'
          ? '🎲 Set for an unpredictable schedule — about ' + perWeek() + ' days a week'
          : (t.dataset.m === 'alldays' ? '📅 Spreading over every day' : '💼 Spreading over set workdays'));
        break;

      case 'set-dpw':
        state.settings.daysPerWeek = clamp(+t.dataset.n, 1, 7);
        save(); render();
        toast('🎲 Planning on about ' + plural(perWeek(), 'day') + ' a week');
        break;

      case 'set-cushion':
        state.settings.cushionDays = +t.dataset.n;
        save(); render();
        toast('🛡️ Bills now fully funded ' + cushionWords() + ' early');
        break;

      case 'set-cushion-mode':
        state.settings.cushionMode = t.dataset.m === 'workdays' ? 'workdays' : 'calendar';
        save(); render();
        toast('🛡️ Cushion now ' + cushionWords() + ' ahead of each due date');
        break;

      case 'opening-balance':
        amountSheet({
          title: 'Money already set aside',
          sub: 'Anything you have banked for bills already. It goes to the most urgent bills first and lowers every daily amount from here on.',
          value: '', note: 'Already in the account'
        });
        break;

      case 'set-round':
        state.settings.roundTo = +t.dataset.n;
        save(); render();
        break;

      case 'goto-bills': view = 'bills'; render(); window.scrollTo({ top: 0 }); break;

      case 'add-job': jobSheet(null, t.dataset.date || null); break;
      case 'edit-job': {
        var jb = null;
        state.jobs.forEach(function (x) { if (x.id === id) jb = x; });
        if (jb) jobSheet(jb);
        break;
      }
      case 'add-expense': expenseSheet(null, t.dataset.date || null, t.dataset.cat || null); break;
      case 'cat-detail': categorySheet(t.dataset.cat); break;
      case 'edit-expense': {
        var ex = null;
        state.expenses.forEach(function (x) { if (x.id === id) ex = x; });
        if (ex) expenseSheet(ex);
        break;
      }
      case 'toggle-job-cut': {
        var tj = null;
        state.jobs.forEach(function (x) { if (x.id === id) tj = x; });
        if (!tj) break;
        var wasOwed = jobHasCut(tj);
        tj.partnerCut = !wasOwed;
        syncAutoSetAside(tj.date);
        save(); render();
        // the sheet, if one is open, is showing a stale row
        if ($('.sheet')) daySheet(tj.date);
        lastUndo = {
          fn: function () { tj.partnerCut = wasOwed; syncAutoSetAside(tj.date); save(); render(); }
        };
        toast(tj.partnerCut
          ? '💰 ' + esc(partnerName()) + ' owed ' + money(partnerCutOn(tj.date)) + ' for ' + fmtDate(tj.date)
          : '✅ That one is all yours', 'Undo');
        break;
      }

      case 'pay-partner': payoutSheet('partner'); break;
      case 'pay-tax': payoutSheet('tax'); break;
      case 'toggle-auto': {
        state.settings.autoSetAside = !state.settings.autoSetAside;
        var moved = state.settings.autoSetAside ? syncAllAuto() : 0;
        save(); render();
        toast(state.settings.autoSetAside
          ? '⚙️ Earnings now fund your bills' + (moved > 0.004 ? ' · ' + money(moved) + ' moved across' : '')
          : '⚙️ Bill money is yours to move by hand');
        break;
      }

      case 'business-setup': businessSetupSheet(); break;
      case 'my-code': myCodeSheet(); break;
      case 'chart-day': daySheet(t.dataset.date); break;

      case 'toggle-bill-rows': showBillRows = !billRowsVisible(); render(); break;
      case 'toggle-archived': showArchived = !showArchived; render(); break;

      case 'cal-prev':
        calMonth.m--; if (calMonth.m < 0) { calMonth.m = 11; calMonth.y--; }
        renderPlan(); break;
      case 'cal-next':
        calMonth.m++; if (calMonth.m > 11) { calMonth.m = 0; calMonth.y++; }
        renderPlan(); break;

      case 'export': exportData(); break;
      case 'copy-backup': copyBackup(); break;
      case 'import': importData(); break;

      case 'reset':
        confirmSheet({
          title: 'Erase everything?',
          body: 'All bills, deposits and completed days are deleted from this device. Save a backup first if you\'re not sure.',
          actions: [{
            label: 'Erase all data', cls: 'danger', fn: function () {
              localStorage.removeItem(STORE_KEY);
              state = defaults(); save(); view = 'today'; render();
              toast('Everything erased');
            }
          }]
        });
        break;

      case 'dismiss-banner':
        state.settings.installDismissed = true; save(); render(); break;
    }
  });

  $('#btn-add-bill').addEventListener('click', function () { billSheet(null); });
  $('#btn-help').addEventListener('click', helpSheet);

  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  // Recalculate when the day rolls over or the app comes back to the foreground
  var openedOn = todayISO();
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      if (todayISO() !== openedOn) { openedOn = todayISO(); calMonth = null; }
      render();
    }
  });
  setInterval(function () {
    if (todayISO() !== openedOn) { openedOn = todayISO(); calMonth = null; render(); }
  }, 60000);

  /* ---------------------------------------------------------------------------
     12. Boot
     ------------------------------------------------------------------------ */

  load();
  // Only rewrite storage when we genuinely understood what was there. Saving
  // over a corrupt or unreadable store would throw away the only copy.
  if (loadState === 'ok' || loadState === 'empty') save();
  render();
  offerRecovery();
  checkImportLink();

  // A setup link tapped while the app is already open only changes the
  // fragment — no reload fires, so watch for it directly.
  window.addEventListener('hashchange', checkImportLink);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
    });
  }
})();
