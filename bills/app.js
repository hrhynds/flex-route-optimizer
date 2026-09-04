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
      version: 1,
      settings: {
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
      meta: { created: todayISO() }
    };
  }

  var state = defaults();
  var rev = 0;             // bumped on every mutation; invalidates caches
  var lastUndo = null;
  var toastTimer = null;
  var view = 'today';
  var calMonth = null;     // {y, m} for the plan calendar
  var showArchived = false;

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object') return;
      var base = defaults();
      state = {
        version: 1,
        settings: Object.assign(base.settings, d.settings || {}),
        bills: Array.isArray(d.bills) ? d.bills : [],
        contributions: Array.isArray(d.contributions) ? d.contributions : [],
        days: d.days && typeof d.days === 'object' ? d.days : {},
        overrides: Object.assign(base.overrides, d.overrides || {}),
        meta: Object.assign(base.meta, d.meta || {})
      };
      state.bills.forEach(function (b) {
        if (b.cycle == null) b.cycle = 0;
        if (!b.cycleStart) b.cycleStart = b.createdAt || state.meta.created;
        if (!Array.isArray(b.paidHistory)) b.paidHistory = [];
      });
      state.contributions.forEach(function (c) { if (c.cycle == null) c.cycle = 0; });
      if (!state.settings.workdays.length) state.settings.workdays = [1, 2, 3, 4, 5];
    } catch (e) {
      console.warn('Could not read saved data', e);
    }
  }

  function save() {
    rev++;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('⚠️ Could not save — device storage is full or blocked');
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
    var plannedRate = b.amount / Math.max(1, countFundingDays(b.cycleStart, target));
    var daysNeeded = plannedRate > 0 ? Math.ceil(remaining / plannedRate) : 0;
    var slack = remaining <= 0.004
      ? Math.max(0, daysToDue)
      : Math.floor(daysToDue - fundingToCalendar(daysNeeded));

    var key = 'ontrack', label = 'On track';
    if (remaining <= 0.004) { key = 'funded'; label = 'Fully funded'; }
    else if (urgent) { key = 'urgent'; label = daysToDue < 0 ? 'Overdue' : 'Due now'; }
    else if (saved + 0.5 < expected) { key = 'behind'; label = 'Behind'; }

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
    return added;
  }

  function removeContributions(ids) {
    state.contributions = state.contributions.filter(function (c) { return ids.indexOf(c.id) === -1; });
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

    if (!bills.length) { host.innerHTML = welcomeHTML(); return; }

    var undated = undatedBills();
    var undatedBanner = undated.length
      ? '<div class="banner warn"><span>📅</span><div><strong>' +
        plural(undated.length, 'bill') + ' still ' + (undated.length === 1 ? 'needs' : 'need') +
        ' a due date</strong>' + undated.map(function (u) { return esc(u.name); }).join(', ') +
        ' — not counted in today\'s number yet. Set the date on the Bills tab.</div></div>'
      : '';

    if (!datedBills().length) {
      host.innerHTML = undatedBanner +
        '<div class="empty"><div class="big">📅</div><h3>Add the due dates</h3>' +
        '<p>Your bills and amounts are in. Give each one a due date and the daily amount appears.</p>' +
        '<button class="btn primary" data-act="goto-bills">Set due dates</button></div>';
      return;
    }

    var day = todayPlan();
    var rec = state.days[t];
    var done = rec && rec.completed;
    var actual = dayActual(t);
    var vault = vaultTotal();
    var urgentItems = day.remaining.filter(function (i) { return i.urgent; });
    var html = '';

    // hero -----------------------------------------------------------------
    var cls = 'hero', eyebrow, amount, sub;
    if (done) {
      cls += ' is-done';
      eyebrow = '✓ Day complete';
      amount = money(actual);
      sub = actual > 0.004
        ? 'set aside today · ' + plural(streak(), 'day') + ' streak 🔥'
        : 'no money needed today · ' + plural(streak(), 'day') + ' streak 🔥';
    } else if (day.remainingTotal > 0.004) {
      if (urgentItems.length) cls += ' is-urgent';
      eyebrow = urgentItems.length ? '⚠️ Needed right now' : 'Set aside today';
      amount = money(day.remainingTotal);
      sub = 'across ' + plural(day.remaining.length, 'bill') +
            (actual > 0.004 ? ' · ' + money(actual) + ' already in today' : '') +
            slackPhrase();
    } else if (!day.funding) {
      cls += ' is-off';
      eyebrow = 'Day off';
      var nf = nextFundingDay(addDays(t, 1));
      var nfp = nf ? simulate(nf, nf)[nf] : null;
      amount = '$0.00';
      sub = nf ? 'Next workday ' + fmtDate(nf, 'dow') + ' · ' + money(nfp ? nfp.plannedTotal : 0) + ' due then'
               : 'No workdays set';
    } else {
      cls += ' is-done';
      eyebrow = '✓ Nothing left today';
      amount = money(actual);
      sub = actual > 0.004 ? 'already set aside' : 'every bill is fully funded';
    }

    html += undatedBanner;
    html += '<div class="' + cls + '">' +
      '<div class="hero-eyebrow">' + eyebrow + '</div>' +
      '<div class="hero-amount">' + amount + '</div>' +
      '<div class="hero-sub">' + sub + '</div>' +
      '<div class="hero-actions">';

    if (!done) {
      if (day.remainingTotal > 0.004) {
        html += '<button class="btn primary" data-act="quick-complete">Set aside ' +
                money(day.remainingTotal) + ' &amp; complete day</button>';
        html += '<div class="btn-row">' +
          '<button class="btn subtle" data-act="custom-amount">Different amount</button>' +
          '<button class="btn subtle" data-act="skip-day">Couldn\'t today</button>' +
          '</div>';
      } else {
        html += '<button class="btn primary" data-act="complete-only">Mark day complete</button>' +
                '<button class="btn subtle" data-act="custom-amount">Set aside extra</button>';
      }
    } else {
      html += '<div class="btn-row">' +
        '<button class="btn subtle" data-act="custom-amount">Add more</button>' +
        '<button class="btn subtle" data-act="reopen-day">Reopen day</button>' +
        '</div>';
    }
    html += '</div></div>';

    // stats ----------------------------------------------------------------
    var wk = weekWindow();
    var wkSim = simulate(wk.start, wk.end);
    var wkTotal = 0;
    Object.keys(wkSim).forEach(function (k) {
      // what the week costs: money already set aside plus what's still owed.
      // Today contributes both halves, so completing it doesn't zero the figure.
      wkTotal += wkSim[k].actual + (isPast(k) ? 0 : wkSim[k].remainingTotal);
    });

    html += '<div class="card tight"><div class="stat-grid">' +
      '<div class="stat"><div class="stat-val money">' + money0(vault) + '</div><div class="stat-lbl">Banked</div></div>' +
      '<div class="stat"><div class="stat-val money">' + money0(wkTotal) + '</div><div class="stat-lbl">This week</div></div>' +
      '<div class="stat"><div class="stat-val">' + streak() + '🔥</div><div class="stat-lbl">Day streak</div></div>' +
      '</div></div>';

    // per-bill split -------------------------------------------------------
    var covered = !day.remaining.length;
    var split = covered ? day.planned : day.remaining;
    if (split.length) {
      html += '<div class="card"><div class="card-title">Today\'s split' +
        '<span class="faint" style="text-transform:none;letter-spacing:0">' +
        (covered ? 'all covered ✓' : 'tap to log one') + '</span></div>';
      split.forEach(function (it) {
        var b = billById(it.billId);
        if (!b) return;
        var s = statusOf(b);
        html += '<button class="split-row" data-act="pay-one" data-id="' + b.id + '" data-amt="' + it.amount + '" ' +
          'style="width:100%;background:none;border:none;border-bottom:1px solid var(--line-soft);text-align:left">' +
          '<div class="split-main">' +
          '<div class="split-name">' + esc(b.icon || '🧾') + ' ' + esc(b.name) +
          (it.urgent ? ' <span class="pill urgent">now</span>' : '') + '</div>' +
          '<div class="split-note">' + money(s.saved) + ' of ' + money(b.amount) +
          ' · fully funded by ' + fmtDate(s.target) + '</div>' +
          '</div>' +
          '<div class="split-amt' + (covered ? ' zero' : '') + '">' +
          (covered ? '✓ ' : '') + money(it.amount) + '</div>' +
          '</button>';
      });
      html += '</div>';
    }

    // recent ---------------------------------------------------------------
    var recent = state.contributions.slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 6);
    if (recent.length) {
      html += '<div class="card"><div class="card-title">Recent activity</div>';
      recent.forEach(function (c) {
        var b = c.billId === BUFFER_ID ? null : billById(c.billId);
        html += '<div class="list-row"><div><div>' +
          (b ? esc(b.icon || '🧾') + ' ' + esc(b.name) : '💰 Extra buffer') + '</div>' +
          '<div class="lr-sub">' + fmtDate(c.date, 'dow') + ' · ' + relDay(c.date) +
          (c.note ? ' · ' + esc(c.note) : '') + '</div></div>' +
          '<div class="lr-amt">+' + money(c.amount) + '</div></div>';
      });
      html += '</div>';
    }

    host.innerHTML = html;
  }

  /** The tightest bill's slack, phrased for the hero line. */
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
    if (t.slack <= 0) return ' · <strong>no days to spare</strong>';
    return ' · ' + plural(t.slack, 'day') + ' to spare';
  }

  function welcomeHTML() {
    return '<div class="card">' +
      '<div class="empty">' +
      '<div class="big">💵</div>' +
      '<h3>Let\'s get your bills covered</h3>' +
      '<p>Add each bill with its amount and due date. This app then tells you exactly what to put aside every workday so each one is fully paid for <strong>' +
      cushionWords() + ' before</strong> it\'s due.</p>' +
      '<button class="btn primary" data-act="add-bill">＋ Add your first bill</button>' +
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
        '<p>Add one to start tracking.</p>' +
        '<button class="btn primary" data-act="add-bill">＋ Add a bill</button></div>';
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
        ? '<span>· <strong>' + (s.slack <= 0 ? 'no days to spare' : '1 day to spare') + '</strong></span>'
        : '') +
      (s.key === 'behind' ? '<span>· <strong>' + money(s.shortfall) + ' behind pace</strong></span>' : '') +
      '</div></button>';
    return h;
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

    var simStart = diffDays(t, firstISO) > 0 ? firstISO : t;   // never simulate before today
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

    html += '<div class="card"><div class="card-title">Backup</div>' +
      '<p class="small dim mb">Everything is stored on this device only. Clearing Safari data wipes it — ' +
      'save a backup file somewhere safe now and then.' +
      (s.lastBackup ? ' <strong>Last backup: ' + fmtDate(s.lastBackup) + '</strong>.' : ' <strong>You haven\'t backed up yet.</strong>') +
      '</p>' +
      '<div class="btn-row mb"><button class="btn" data-act="export">⬇︎ Save backup</button>' +
      '<button class="btn" data-act="copy-backup">⧉ Copy</button></div>' +
      '<button class="btn ghost" data-act="import">⬆︎ Restore from backup</button></div>';

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

  /* ---- Day detail -------------------------------------------------------- */

  function daySheet(iso) {
    var rec = state.days[iso];
    var funding = isFundingDay(iso);
    var actual = dayActual(iso);
    var sim = null;
    if (!isPast(iso)) sim = simulate(todayISO(), iso)[iso];

    var html = '<h2>' + fmtDate(iso, 'long') + '</h2>' +
      '<div class="sheet-sub">' + (funding ? 'Workday' : 'Day off') + ' · ' + relDay(iso) + '</div>';

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

  function importData() {
    openSheet('<h2>Restore a backup</h2>' +
      '<div class="sheet-sub">This replaces everything currently in the app.</div>' +
      '<div class="field"><label>Choose a backup file</label><input id="i-file" type="file" accept="application/json,.json"></div>' +
      '<div class="field"><label>…or paste the backup text</label><textarea id="i-text" rows="6" placeholder="{&quot;version&quot;:1,…}" style="font-size:12px"></textarea></div>' +
      '<button class="btn primary" data-act="do-import" style="margin-bottom:8px">Restore</button>' +
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
          if (!raw) return toast('⚠️ Pick a file or paste the text');
          try {
            var d = JSON.parse(raw);
            if (!d || !Array.isArray(d.bills)) throw new Error('bad shape');
            localStorage.setItem(STORE_KEY, JSON.stringify(d));
            load(); save(); closeSheet(); render();
            toast('✅ Backup restored — ' + plural(state.bills.length, 'bill') + ' loaded');
          } catch (err) {
            toast('⚠️ That doesn\'t look like a Bill Cushion backup');
          }
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
    if (!m) return null;

    var txt;
    try { txt = decodeURIComponent(m[1]); } catch (e) { txt = m[1]; }
    txt = txt.replace(/\+/g, ' ');

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
    if (!bills.length) return null;

    var data = { version: 1, bills: bills, settings: {}, meta: { created: todayISO() } };
    var wk = hash.match(/[#&]w=(\d)/);
    if (wk) { data.settings.countMode = 'estimate'; data.settings.daysPerWeek = clamp(+wk[1], 1, 7); }
    var cu = hash.match(/[#&]c=(\d{1,2})/);
    if (cu) { data.settings.cushionDays = clamp(+cu[1], 0, 60); data.settings.cushionMode = 'workdays'; }
    return data;
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

  /* ---------------------------------------------------------------------------
     10. Toast
     ------------------------------------------------------------------------ */

  function toast(msg, actionLabel) {
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
  render();
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
