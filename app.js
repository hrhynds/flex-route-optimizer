// ─── State ────────────────────────────────────────────────────────────────────
let addresses   = [];
let optimizedOrder = [];
let googleMapsLoaded = false;
let map    = null;
let markers = [];
let ocrWorker = null;   // reused across all screenshots — init once, fast for all

// ─── Google Maps ──────────────────────────────────────────────────────────────
const GMAPS_API_KEY = 'AIzaSyBjLabRdpEvNXzP1mAdme-RMEOxtbeyNzo';

function loadGoogleMapsScript(key) {
  if (document.getElementById('gmaps-script')) return;
  const s = document.createElement('script');
  s.id  = 'gmaps-script';
  s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&loading=async&libraries=geocoding&callback=onGoogleMapsReady`;
  s.async = true; s.defer = true;
  document.head.appendChild(s);
}

window.onGoogleMapsReady = function () { googleMapsLoaded = true; };

// ─── Delivery Area ────────────────────────────────────────────────────────────
function loadDeliveryArea() {
  const v = localStorage.getItem('delivery_area') || '';
  if (v) document.getElementById('delivery-area').value = v;
}
function onDeliveryAreaChange() {
  localStorage.setItem('delivery_area', (document.getElementById('delivery-area').value || '').trim());
}
function enrichAddress(addr) {
  const area = (document.getElementById('delivery-area').value || '').trim();
  if (!area || /\b[A-Z]{2}\b/.test(addr)) return addr;
  return addr + ', ' + area;
}

// ─── Image Normalization ──────────────────────────────────────────────────────
function normalizeImage(file) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      c.toBlob(b => resolve(b || file), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ─── OCR Worker (persistent — created once, reused for all screenshots) ──────
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  setOcrProgress(5, 'Loading OCR engine (one-time setup)…');
  try {
    ocrWorker = await Tesseract.createWorker('eng', 1, {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
      langPath:   'https://tessdata.projectnaptha.com/4.0.0_fast',
      logger: m => {
        if (m.status === 'loading tesseract core')       setOcrProgress(10, 'Loading OCR engine…');
        if (m.status === 'loading language traineddata')  setOcrProgress(20, 'Loading language data…');
        if (m.status === 'initializing tesseract')        setOcrProgress(30, 'Initializing…');
        if (m.status === 'recognizing text')              setOcrProgress(40 + Math.round(m.progress * 40), 'Reading text…');
      },
    });
  } catch (err) {
    ocrWorker = null;   // allow retry on next upload
    throw err;
  }
  return ocrWorker;
}

// Run OCR with a specific page-segmentation mode
async function ocrPass(imageBlob, psm) {
  const worker = await getOcrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: String(psm) });
  const { data: { text } } = await worker.recognize(imageBlob);
  return text;
}

// Two-pass OCR: PSM 4 (single column) + PSM 11 (sparse text).
// Merging both catches addresses that one mode misses.
async function extractFromImage(imageBlob, photoLabel) {
  setOcrProgress(40, `${photoLabel}: reading text…`);
  const text1 = await ocrPass(imageBlob, 4);   // single column

  setOcrProgress(65, `${photoLabel}: second pass…`);
  const text2 = await ocrPass(imageBlob, 11);  // sparse text (catches edge/partial addresses)

  setOcrProgress(85, `${photoLabel}: extracting addresses…`);
  const a1 = parseAddresses(text1);
  const a2 = parseAddresses(text2);

  // Merge: keep unique from both passes
  const seen = new Set(a1.map(normalizeKey));
  const merged = [...a1];
  for (const a of a2) {
    if (!seen.has(normalizeKey(a))) { seen.add(normalizeKey(a)); merged.push(a); }
  }
  return merged;
}

const normalizeKey = s => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ─── File Handling ────────────────────────────────────────────────────────────
function setOcrProgress(pct, msg) {
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = msg;
  document.getElementById('ocr-progress').style.display = 'block';
}

async function handleFiles(files) {
  if (!files || !files.length) return;
  const arr = Array.from(files);

  document.getElementById('addresses-section').style.display = 'block';
  document.getElementById('ocr-progress').style.display = 'block';
  document.getElementById('photo-strip').style.display = 'flex';

  for (let i = 0; i < arr.length; i++) {
    const file = arr[i];
    const label = `Photo ${i + 1}/${arr.length}`;

    // Add thumbnail immediately
    addThumbnail(file, label);

    // Normalize image (MIME fix)
    const blob = await normalizeImage(file);

    // Two-pass OCR
    let newAddrs;
    try {
      newAddrs = await extractFromImage(blob, label);
    } catch (err) {
      console.error('OCR error on', file.name, err);
      updateThumbnailBadge(i, '⚠ failed', true);
      setOcrProgress(0, `⚠ Couldn't read ${file.name} — check your internet connection and try again.`);
      continue;
    }

    // Append unique addresses
    const existing = new Set(addresses.map(normalizeKey));
    const unique = newAddrs.filter(a => !existing.has(normalizeKey(a)));
    addresses.push(...unique);

    updateThumbnailBadge(i, `${newAddrs.length} addr`);
    renderAddressList();
  }

  // Final status
  const total = addresses.length;
  if (total === 0) {
    setOcrProgress(0, 'No addresses found — try adding manually or uploading a clearer screenshot.');
  } else {
    setOcrProgress(100, `Done — ${total} addresses from ${arr.length} screenshot${arr.length > 1 ? 's' : ''}`);
    setTimeout(() => document.getElementById('ocr-progress').style.display = 'none', 3000);
    updateAddrCount();
    if (addresses.some(a => !/\b[A-Z]{2}\b/.test(a))) {
      const el = document.getElementById('delivery-area');
      if (!el.value.trim()) el.focus();
    }
  }
}

function addThumbnail(file, label) {
  const strip = document.getElementById('photo-thumbs');
  const div = document.createElement('div');
  const idx = strip.children.length;
  div.className = 'photo-thumb';
  div.id = `thumb-${idx}`;
  const img = document.createElement('img');
  img.src = URL.createObjectURL(file);
  img.alt = label;
  const badge = document.createElement('span');
  badge.className = 'thumb-badge';
  badge.id = `thumb-badge-${idx}`;
  badge.textContent = '…';
  div.appendChild(img);
  div.appendChild(badge);
  strip.appendChild(div);
}

function updateThumbnailBadge(idx, text, warn = false) {
  const el = document.getElementById(`thumb-badge-${idx}`);
  if (el) { el.textContent = text; if (warn) el.style.background = '#e0913a'; }
}

function updateAddrCount() {
  const row = document.getElementById('addr-count-row');
  const el  = document.getElementById('addr-count');
  if (addresses.length > 0) {
    row.style.display = 'block';
    el.textContent = `${addresses.length} address${addresses.length > 1 ? 'es' : ''} ready`;
  } else {
    row.style.display = 'none';
  }
}

function clearAll() {
  addresses = [];
  optimizedOrder = [];
  document.getElementById('address-list').innerHTML = '';
  document.getElementById('photo-thumbs').innerHTML = '';
  document.getElementById('photo-strip').style.display = 'none';
  document.getElementById('addresses-section').style.display = 'none';
  document.getElementById('result-section').style.display = 'none';
  document.getElementById('addr-count-row').style.display = 'none';
  document.getElementById('file-input').value = '';
  markers.forEach(m => m.setMap && m.setMap(null));
  markers = [];
}

// Drag & drop — supports multiple files
const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

// ─── Address Parsing ──────────────────────────────────────────────────────────
function parseAddresses(rawText) {
  const cleaned = rawText
    .replace(/\r\n/g, '\n').replace(/[|]/g, 'I')
    .replace(/['']/g, "'").replace(/[""]/g, '"');
  const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 2);
  const found = [];

  const houseNumRe     = /^\d{1,5}\s+[A-Za-z]/;
  const aptRe          = /^(apt|unit|suite|ste|#|bldg|building|floor|fl|room|rm)\.?\s*\S/i;
  const cityStateZipRe = /^[A-Za-z][A-Za-z\s\-']{1,30},?\s+[A-Z]{2}\s+\d{5}(-\d{4})?$/;
  const cityStateRe    = /^[A-Za-z][A-Za-z\s\-']{1,30},?\s+[A-Z]{2}$/;
  const stateZipRe     = /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/;
  const oneLineRe      = /^\d{1,5}\s+.{5,},\s*[A-Za-z\s]+,?\s+[A-Z]{2}(\s+\d{5})?/;
  const streetKwRe     = /\b(st\.?|ave\.?|blvd\.?|dr\.?|rd\.?|way|ln\.?|ct\.?|pl\.?|pkwy|hwy|highway|route|rte|circle|cir|terr?\.?|trail|trl|loop|court|place|drive|street|avenue|boulevard|lane|road|run|row|ridge|park|point|pointe|bend|crossing|chase|grove|glen|hollow|hill|heights|vista|view|creek|bridge|gate|pass|path|pike|square|sq\.?|commons|village|manor|estates?|xing)\b/i;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (oneLineRe.test(line)) { found.push(line); i++; continue; }
    if (houseNumRe.test(line)) {
      const parts = [line];
      let j = i + 1;
      while (j < lines.length && j < i + 6) {
        const next = lines[j];
        if (aptRe.test(next)) { parts.push(next); j++; }
        else if (cityStateZipRe.test(next) || cityStateRe.test(next) || stateZipRe.test(next)) {
          parts.push(next); j++; break;
        } else if (/^[A-Za-z][A-Za-z\s\-']{1,30}$/.test(next) && next.length < 35) {
          parts.push(next); j++;
        } else break;
      }
      const candidate = parts.join(', ').replace(/,\s*,/g, ',').trim();
      if (streetKwRe.test(candidate) || stateZipRe.test(candidate)) found.push(candidate);
      i = j; continue;
    }
    i++;
  }

  const seen = new Set();
  return found.filter(a => { const k = normalizeKey(a); if (seen.has(k)) return false; seen.add(k); return true; });
}

// ─── Address List UI ──────────────────────────────────────────────────────────
function renderAddressList() {
  const list = document.getElementById('address-list');
  list.innerHTML = '';
  addresses.forEach((addr, i) => {
    const partial = !/\b[A-Z]{2}\b/.test(addr);
    const li = document.createElement('li');
    li.className = partial ? 'addr-partial' : '';
    li.innerHTML = `
      <span class="addr-num">${i + 1}</span>
      <input type="text" value="${escHtml(addr)}"
             onchange="addresses[${i}]=this.value;this.parentElement.className=/\\b[A-Z]{2}\\b/.test(this.value)?'':'addr-partial'" />
      <button class="del-btn" onclick="deleteAddress(${i})" title="Remove">&#x2715;</button>`;
    list.appendChild(li);
  });
  updateAddrCount();
}

function syncAddressesFromDom() {
  addresses = Array.from(document.querySelectorAll('#address-list input[type=text]'))
    .map(el => el.value.trim()).filter(Boolean);
}
function deleteAddress(i)    { syncAddressesFromDom(); addresses.splice(i, 1); renderAddressList(); }
function addAddressManually() {
  const inp = document.getElementById('new-address-input');
  const val = inp.value.trim(); if (!val) return;
  syncAddressesFromDom(); addresses.push(val); inp.value = ''; renderAddressList();
}
document.getElementById('new-address-input').addEventListener('keydown', e => { if (e.key === 'Enter') addAddressManually(); });

// ─── Geocoding ────────────────────────────────────────────────────────────────
async function geocodeAddress(address) {
  if (googleMapsLoaded && window.google?.maps) {
    try { return await geocodeWithGoogle(address); }
    catch (e) { console.warn('Google geocode failed, trying Nominatim:', e.message); }
  }
  return geocodeWithNominatim(address);
}

function geocodeWithGoogle(address) {
  return new Promise((resolve, reject) => {
    new google.maps.Geocoder().geocode({ address, region: 'us' }, (results, status) => {
      if (status === 'OK' && results.length) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng() });
      } else reject(new Error(status));
    });
  });
}

async function geocodeWithNominatim(address) {
  const H = { 'User-Agent': 'FlexRouteOptimizer/1.0', 'Accept-Language': 'en-US,en' };
  const q = async p => {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ format:'json', limit:'1', countrycodes:'us', ...p })}`, { headers: H });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };
  let d = await q({ q: address });
  if (d.length) return { lat: +d[0].lat, lng: +d[0].lon };

  const m = address.match(/^(\d+\s+[^,]+),\s*([^,]+),\s*([A-Z]{2})[\s,]*(\d{5})?/);
  if (m) {
    await sleep(1100);
    d = await q({ street: m[1].trim(), city: m[2].trim(), state: m[3].trim(), ...(m[4] ? { postalcode: m[4] } : {}) });
    if (d.length) return { lat: +d[0].lat, lng: +d[0].lon };
    await sleep(1100);
    d = await q({ street: m[1].replace(/^\d+\s+/, ''), city: m[2].trim(), state: m[3].trim() });
    if (d.length) return { lat: +d[0].lat, lng: +d[0].lon };
    await sleep(1100);
    d = await q({ city: m[2].trim(), state: m[3].trim() });
    if (d.length) return { lat: +d[0].lat, lng: +d[0].lon };
  }
  throw new Error(`Not found: "${address}"`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Route Optimization (client-side TSP) ────────────────────────────────────
function haversineDistance(a, b) {
  const R = 3959, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLng/2)**2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function nearestNeighborTSP(pts, start = 0) {
  const n = pts.length, vis = new Array(n).fill(false), route = [start];
  vis[start] = true;
  for (let s = 0; s < n - 1; s++) {
    const cur = route[route.length - 1];
    let best = -1, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      if (!vis[j]) { const d = haversineDistance(pts[cur], pts[j]); if (d < bestD) { bestD = d; best = j; } }
    }
    vis[best] = true; route.push(best);
  }
  return route;
}

// ─── Optimize Button ──────────────────────────────────────────────────────────
async function optimizeRoute() {
  syncAddressesFromDom();
  if (addresses.length < 2) { alert('Add at least 2 delivery addresses first.'); return; }
  if (!googleMapsLoaded)    { alert('Google Maps is still loading — wait a moment.'); return; }

  onDeliveryAreaChange();
  const enriched   = addresses.map(enrichAddress);
  const startRaw   = document.getElementById('start-address').value.trim();
  if (startRaw) localStorage.setItem('start_address', startRaw);
  const startEnr   = startRaw ? enrichAddress(startRaw) : null;
  const allAddrs   = startEnr ? [startEnr, ...enriched] : enriched;

  const btn = document.getElementById('optimize-btn');
  btn.disabled = true;

  try {
    const points = [], failed = [];
    let startSkipped = false;

    for (let i = 0; i < allAddrs.length; i++) {
      btn.textContent = `Geocoding ${i + 1} / ${allAddrs.length}…`;
      try {
        const pt = await geocodeAddress(allAddrs[i]);
        points.push({ ...pt, address: allAddrs[i] });
      } catch {
        if (i === 0 && startEnr) { startSkipped = true; }
        else { failed.push(allAddrs[i]); }
      }
      if (i < allAddrs.length - 1 && !googleMapsLoaded) await sleep(1100);
    }

    if (startSkipped) showGeoNotice('⚠ Starting point not found — optimized delivery stops only.');
    if (failed.length) alert(`Skipped (couldn't geocode):\n\n${failed.join('\n')}\n\nCheck the Delivery Area field or edit those addresses.`);
    if (points.length < 2) { alert('Not enough addresses could be located. Check your addresses.'); return; }

    btn.textContent = 'Optimizing…';
    const order = nearestNeighborTSP(points, 0);
    const ordered = order.map(i => points[i]);
    optimizedOrder = ordered.map(p => p.address);
    showResultOnMap(ordered);

  } finally {
    btn.textContent = 'Optimize Route';
    btn.disabled = false;
  }
}

function showGeoNotice(msg) {
  let el = document.getElementById('geo-notice');
  if (!el) {
    el = document.createElement('p');
    el.id = 'geo-notice';
    el.style.cssText = 'color:#e0913a;font-size:0.82rem;margin-top:8px;';
    document.getElementById('optimize-btn').insertAdjacentElement('afterend', el);
  }
  el.textContent = msg;
}

// ─── Result Display ───────────────────────────────────────────────────────────
function showResultOnMap(ordered) {
  document.getElementById('result-section').style.display = 'block';
  document.getElementById('result-section').scrollIntoView({ behavior: 'smooth' });

  markers.forEach(m => m.setMap && m.setMap(null));
  markers = [];

  if (!map) {
    map = new google.maps.Map(document.getElementById('map'), {
      zoom: 12, mapTypeId: 'roadmap', styles: darkMapStyles(),
    });
  }

  const bounds = new google.maps.LatLngBounds();
  ordered.forEach((pt, i) => {
    const pos = { lat: pt.lat, lng: pt.lng };
    bounds.extend(pos);
    const m = new google.maps.Marker({
      position: pos, map,
      label: { text: String(i + 1), color: '#fff', fontWeight: 'bold', fontSize: '13px' },
      title: pt.address,
    });
    markers.push(m);
  });

  new google.maps.Polyline({
    path: ordered.map(p => ({ lat: p.lat, lng: p.lng })),
    map, strokeColor: '#4a90e2', strokeWeight: 3, strokeOpacity: 0.75,
  });

  map.fitBounds(bounds);

  let totalMiles = 0;
  for (let i = 0; i < ordered.length - 1; i++) totalMiles += haversineDistance(ordered[i], ordered[i+1]);

  document.getElementById('route-summary').innerHTML = `
    <div class="stat-row">
      <div class="stat"><span>Est. Distance</span><span>${totalMiles.toFixed(1)} mi</span></div>
      <div class="stat"><span>Stops</span><span>${ordered.length}</span></div>
    </div>
    <div class="ordered-stops">
      <h3>Optimized Stop Order</h3>
      <ol>${ordered.map(p => `<li>${escHtml(p.address)}</li>`).join('')}</ol>
    </div>
    <p class="result-note">Tap "Open in Google Maps" to navigate turn-by-turn on your phone.</p>
  `;
}

// ─── Open in Google Maps ──────────────────────────────────────────────────────
function openInGoogleMaps() {
  if (optimizedOrder.length < 2) { alert('Optimize the route first.'); return; }
  const enc = s => encodeURIComponent(s);
  const origin      = enc(optimizedOrder[0]);
  const destination = enc(optimizedOrder[optimizedOrder.length - 1]);
  const waypoints   = optimizedOrder.slice(1, -1).map(enc).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (waypoints) url += `&waypoints=${waypoints}`;
  window.open(url, '_blank');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function darkMapStyles() {
  return [
    { elementType: 'geometry',           stylers: [{ color: '#1a1d27' }] },
    { elementType: 'labels.text.fill',   stylers: [{ color: '#8a8a9a' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1d27' }] },
    { featureType: 'road',            elementType: 'geometry', stylers: [{ color: '#2a2d3a' }] },
    { featureType: 'road.arterial',   elementType: 'geometry', stylers: [{ color: '#343747' }] },
    { featureType: 'road.highway',    elementType: 'geometry', stylers: [{ color: '#4a90e2' }] },
    { featureType: 'water',           elementType: 'geometry', stylers: [{ color: '#0f1117' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  ];
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  document.getElementById('setup-section').style.display = 'none';
  localStorage.setItem('gmaps_api_key', GMAPS_API_KEY);
  loadGoogleMapsScript(GMAPS_API_KEY);
  loadDeliveryArea();
  const s = localStorage.getItem('start_address');
  if (s) document.getElementById('start-address').value = s;
})();
