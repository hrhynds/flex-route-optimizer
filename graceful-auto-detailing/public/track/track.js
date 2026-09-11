import { h, mount, api, ApiError, fmtCountdown, fmtDistance } from '../shared/ui.js';

const app = document.getElementById('app');

/* Two doors into the same view: the link from the text message, and the
   customer's own appointment page. Both end up asking the server for exactly
   the same thing, and neither can ask for anything else. */
const path = location.pathname;
const fromPortal = path.startsWith('/m/');
const TOKEN = decodeURIComponent(path.replace(/^\/(t|m)\//, '')).replace(/\/+$/, '');
const ENDPOINT = fromPortal
  ? `/api/portal/${encodeURIComponent(TOKEN)}/tracking`
  : `/api/track/${encodeURIComponent(TOKEN)}`;

let trip = null;
let poll = null;
let clock = null;

/* ==========================================================================
   Drawing

   An SVG built element by element. The projection is equirectangular with the
   longitude squashed by cos(latitude), which is accurate enough over the few
   miles this ever covers and needs nothing from the network.
   ========================================================================== */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, String(v));
  }
  for (const child of children.flat(3)) if (child) el.append(child);
  return el;
}

function project(points, width, height, pad = 58) {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);

  const xs = lngs.map((lng) => lng * kx);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...lats);
  const maxY = Math.max(...lats);

  /* A minimum span stops two points a few metres apart filling the screen. */
  const spanX = Math.max(maxX - minX, 0.0025);
  const spanY = Math.max(maxY - minY, 0.0025);
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  return ({ lat, lng }) => ({
    x: width / 2 + (lng * kx - cx) * scale,
    y: height / 2 - (lat - cy) * scale,
  });
}

function drawMap(container) {
  const width = container.clientWidth || 360;
  const height = container.clientHeight || 320;

  const here = trip.position ? { lat: trip.position.lat, lng: trip.position.lng } : null;
  const dest = trip.destination;
  const trail = (trip.trail || []).filter((p) => Number.isFinite(p.lat));

  const points = [here, dest, ...trail].filter(Boolean);
  if (!points.length) {
    return svg('svg', { class: 'map-svg', viewBox: `0 0 ${width} ${height}` },
      svg('text', {
        x: width / 2, y: height / 2, 'text-anchor': 'middle',
        fill: 'var(--text-faint)', 'font-size': '14', 'font-family': 'inherit',
      }, document.createTextNode('Waiting for a location…'))
    );
  }

  const to = project(points, width, height);
  const layers = [];

  /* The straight line between the two, as a hint rather than a route — it is
     not a road and is not drawn as though it were. */
  if (here && dest) {
    const a = to(here);
    const b = to(dest);
    layers.push(svg('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: 'var(--accent)', 'stroke-width': 2.5,
      'stroke-dasharray': '2 9', 'stroke-linecap': 'round', opacity: 0.55,
    }));
  }

  if (trail.length > 1) {
    const d = trail.map((p, i) => { const q = to(p); return `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`; }).join(' ');
    layers.push(svg('path', {
      d, fill: 'none', stroke: 'var(--live)', 'stroke-width': 3.5,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.35,
    }));
  }

  if (dest) {
    const p = to(dest);
    layers.push(
      svg('circle', { cx: p.x, cy: p.y, r: 19, fill: 'var(--accent)', opacity: 0.13 }),
      svg('circle', { cx: p.x, cy: p.y, r: 8.5, fill: 'var(--accent)', stroke: 'var(--ink)', 'stroke-width': 3 }),
      svg('text', {
        x: p.x, y: p.y + 32, 'text-anchor': 'middle',
        fill: 'var(--text-dim)', 'font-size': '12', 'font-weight': '650', 'font-family': 'inherit',
      }, document.createTextNode('You'))
    );
  }

  if (here) {
    const p = to(here);
    /* The accuracy halo is honest about how precise the fix actually is. */
    if (trip.position.accuracy_m) {
      layers.push(svg('circle', { cx: p.x, cy: p.y, r: 26, fill: 'var(--live)', opacity: 0.12 }));
    }
    const marker = svg('g', { transform: `translate(${p.x} ${p.y})` },
      svg('circle', { r: 13, fill: 'var(--live)', opacity: 0.22 },
        svg('animate', { attributeName: 'r', values: '13;22;13', dur: '2.4s', repeatCount: 'indefinite' }),
        svg('animate', { attributeName: 'opacity', values: '0.28;0;0.28', dur: '2.4s', repeatCount: 'indefinite' })
      ),
      svg('circle', { r: 9, fill: 'var(--live)', stroke: 'var(--ink)', 'stroke-width': 3 })
    );
    layers.push(marker,
      svg('text', {
        x: p.x, y: p.y - 22, 'text-anchor': 'middle',
        fill: 'var(--text-dim)', 'font-size': '12', 'font-weight': '650', 'font-family': 'inherit',
      }, document.createTextNode(trip.business?.name?.split(' ')[0] || 'Us'))
    );
  }

  return svg('svg', { class: 'map-svg', viewBox: `0 0 ${width} ${height}`, 'aria-label': 'Arrival map' }, ...layers);
}

/* ==========================================================================
   The page
   ========================================================================== */

function render() {
  const secondsLeft = Math.max(0, Math.round((trip.expires_at - Date.now()) / 1000));
  if (secondsLeft <= 0) { renderEnded('expired'); return; }

  const mapWrap = h('div', { class: 'map-wrap' },
    h('div', { class: 'map-overlay' },
      h('span', { class: 'map-chip map-chip--live' }, h('span', { class: 'dot-live' }), 'Live'),
      h('span', { class: 'map-chip', text: fmtCountdown(secondsLeft) + ' left' })
    ),
    trip.position?.stale_seconds > 90
      ? h('div', { class: 'map-stale', text: 'The signal dropped a moment ago — this may be a little behind.' })
      : null
  );

  const eta = trip.eta_minutes;
  const panel = h('div', { class: 'track-panel' },
    h('div', { class: 'who', text: `${trip.business?.name || 'Your detailer'} is on the way` }),
    eta != null
      ? h('div', { class: 'eta' }, String(eta), h('span', { class: 'unit', text: eta === 1 ? 'minute away' : 'minutes away' }))
      : h('div', { class: 'eta' }, 'On the move'),

    h('div', { class: 'facts' },
      trip.distance_m != null ? h('span', { class: 'pill', text: fmtDistance(trip.distance_m) }) : null,
      trip.appointment?.service_name ? h('span', { class: 'pill', text: trip.appointment.service_name }) : null,
      trip.destination?.label ? h('span', { class: 'pill', text: trip.destination.label }) : null
    ),

    h('div', { class: 'expiry' },
      'This link turns itself off in ',
      h('strong', { text: fmtCountdown(secondsLeft) }),
      '. Location is only shared while the job is on the way — never at any other time, and nothing is kept afterwards.'
    ),

    h('div', { class: 'actions' },
      trip.business?.phone
        ? h('a', { class: 'btn btn--primary', href: `tel:${trip.business.phone}`, text: 'Call' })
        : null,
      fromPortal
        ? h('a', { class: 'btn btn--ghost', href: `/p/${encodeURIComponent(TOKEN)}`, text: 'Back to appointment' })
        : null
    )
  );

  mount(app, h('div', { class: 'track-page' }, mapWrap, panel));
  mapWrap.prepend(drawMap(mapWrap));
}

function renderEnded(reason) {
  clearInterval(poll);
  clearInterval(clock);
  const arrived = reason === 'arrived';
  mount(app, h('div', { class: 'ended' },
    h('span', { class: 'ended-emoji', text: arrived ? '👋' : '🔒' }),
    h('h1', { text: arrived ? 'Arrived' : 'Tracking has finished' }),
    h('p', { text: arrived
      ? 'They are with you now. This link has turned itself off.'
      : 'Tracking links last about an hour and then stop on their own. Nothing about the journey is kept.' }),
    fromPortal
      ? h('a', { class: 'btn btn--primary', href: `/p/${encodeURIComponent(TOKEN)}`, text: 'Back to your appointment' })
      : null
  ));
}

async function tick() {
  try {
    const next = await api.get(ENDPOINT);
    if (!next || next.live === false) { renderEnded(trip ? 'arrived' : 'expired'); return; }
    trip = next;
    render();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) { renderEnded(trip ? 'arrived' : 'expired'); return; }
    /* A blip is not worth clearing the screen for — keep the last view. */
    if (!trip) {
      mount(app, h('div', { class: 'ended' },
        h('span', { class: 'ended-emoji', text: '⚠️' }),
        h('h1', { text: 'Cannot reach the map' }),
        h('p', { text: 'Check your connection — this will pick itself back up.' })
      ));
    }
  }
}

/* Ten seconds is frequent enough to feel live and light enough that a phone on
   mobile data does not notice. */
poll = setInterval(tick, 10000);
clock = setInterval(() => { if (trip) render(); }, 1000);
window.addEventListener('resize', () => { if (trip) render(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
tick();
