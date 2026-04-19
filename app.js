// ─── State ────────────────────────────────────────────────────────────────────
let addresses      = [];
let optimizedOrder = [];
let googleMapsLoaded = false;
let map            = null;
let markers        = [];
let ocrWorker      = null;

let orderedStops = [];   // { lat, lng, address } in optimized order
let dirRenderers = [];   // DirectionsRenderer instances (one per batch)
let fallbackPoly = null; // straight-line fallback while real roads load

// Which batch of stops we're on for "Open in Maps"
let currentBatch = 0;
const MAPS_BATCH_SIZE = 10;

// Address verification cache  key = normalizeKey(addr) → { ok, lat, lng }
let addrVerified = new Map();

// ─── Session Persistence ──────────────────────────────────────────────────────
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveSession, 600);
}

function saveSession() {
  if (!addresses.length && !orderedStops.length) return;
  try {
    localStorage.setItem('flex_session', JSON.stringify({
      savedAt:        Date.now(),
      addresses,
      orderedStops,
      currentBatch,
      addrVerifiedArr: [...addrVerified.entries()],
    }));
  } catch(e) { /* storage full — ignore */ }
}

function clearSession() {
  localStorage.removeItem('flex_session');
}

function discardSession() {
  clearSession();
  const banner = document.getElementById('session-banner');
  if (banner) banner.style.display = 'none';
}

function checkSavedSession() {
  try {
    const raw = localStorage.getItem('flex_session');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data.orderedStops?.length && !data.addresses?.length) return;
    // Expire sessions older than 18 hours
    if (Date.now() - (data.savedAt || 0) > 18 * 3600 * 1000) { clearSession(); return; }
    const banner = document.getElementById('session-banner');
    if (!banner) return;
    const age  = Date.now() - (data.savedAt || 0);
    const mins = Math.floor(age / 60000);
    const ageStr = mins < 60
      ? `${mins}m ago`
      : `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
    const stopInfo = data.orderedStops?.length
      ? `${data.orderedStops.length} stops · saved ${ageStr}`
      : `${data.addresses?.length || 0} addresses · saved ${ageStr}`;
    document.getElementById('session-detail').textContent = stopInfo;
    banner.style.display = 'block';
  } catch(e) { /* corrupt data — ignore */ }
}

async function restoreSession() {
  try {
    const raw = localStorage.getItem('flex_session');
    if (!raw) return;
    const data = JSON.parse(raw);
    const banner = document.getElementById('session-banner');
    if (banner) banner.style.display = 'none';

    // Restore state
    addrVerified  = new Map(data.addrVerifiedArr || []);
    addresses     = data.addresses || [];

    if (addresses.length) {
      document.getElementById('addresses-section').style.display = 'block';
      renderAddressList();
      updateAddrCount();
    }

    if (data.orderedStops?.length) {
      orderedStops = data.orderedStops;
      // Wait up to 10s for Google Maps
      const deadline = Date.now() + 10000;
      while (!googleMapsLoaded && Date.now() < deadline) await sleep(200);
      if (!googleMapsLoaded) { alert('Google Maps did not load. Try refreshing.'); return; }

      showResultOnMap([...orderedStops]);
      currentBatch = data.currentBatch || 0;
      updateBatchButton();
    }
  } catch(e) {
    console.error('Restore session failed:', e);
    alert('Could not restore your previous session — starting fresh.');
    clearSession();
  }
}

// ─── Google Maps ──────────────────────────────────────────────────────────────
const GMAPS_API_KEY = 'AIzaSyBjLabRdpEvNXzP1mAdme-RMEOxtbeyNzo';

function loadGoogleMapsScript(key) {
  if (document.getElementById('gmaps-script')) return;
  const s = document.createElement('script');
  s.id  = 'gmaps-script';
  s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&loading=async&libraries=geocoding,routes&callback=onGoogleMapsReady`;
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

let _ocrBusy = false;

async function handleFiles(files) {
  if (!files || !files.length) return;
  if (_ocrBusy) {
    setOcrProgress(0, '⏳ Still processing previous screenshots — please wait…');
    document.getElementById('ocr-progress').style.display = 'block';
    return;
  }
  _ocrBusy = true;
  const arr = Array.from(files);
  // Capture offset before adding new thumbnails so badges land on the right thumbs
  const thumbOffset = document.getElementById('photo-thumbs').children.length;

  document.getElementById('addresses-section').style.display = 'block';
  document.getElementById('ocr-progress').style.display = 'block';
  document.getElementById('photo-strip').style.display = 'flex';

  try {
  for (let i = 0; i < arr.length; i++) {
    const file = arr[i];
    const label = `Photo ${thumbOffset + i + 1}`;

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
      updateThumbnailBadge(thumbOffset + i, '⚠ failed', true);
      setOcrProgress(0, `⚠ Couldn't read ${file.name} — check your internet connection and try again.`);
      continue;
    }

    // Append unique addresses
    const existing = new Set(addresses.map(normalizeKey));
    const unique = newAddrs.filter(a => !existing.has(normalizeKey(a)));
    addresses.push(...unique);

    updateThumbnailBadge(thumbOffset + i, `${newAddrs.length} addr`);
    renderAddressList();
  }
  } finally {
    _ocrBusy = false;
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
    // Verify all addresses in background — shows green/red badges as they resolve
    verifyAllAddresses();
    scheduleSave();
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
  orderedStops = [];
  currentBatch = 0;
  addrVerified.clear();
  document.getElementById('address-list').innerHTML = '';
  document.getElementById('photo-thumbs').innerHTML = '';
  document.getElementById('photo-strip').style.display = 'none';
  document.getElementById('addresses-section').style.display = 'none';
  document.getElementById('result-section').style.display = 'none';
  document.getElementById('addr-count-row').style.display = 'none';
  document.getElementById('file-input').value = '';
  markers.forEach(m => m.setMap && m.setMap(null));
  markers = [];
  dirRenderers.forEach(r => r.setMap(null));
  dirRenderers = [];
  if (fallbackPoly) { fallbackPoly.setMap(null); fallbackPoly = null; }
  clearSession();
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
  // Keep lines longer than 2 chars OR pure-digit lines (short house numbers like "15", "5")
  const rawLines = cleaned.split('\n').map(l => l.trim())
    .filter(l => l.length > 2 || /^\d{1,5}$/.test(l));

  // ── Strip every line that can't be part of a street address ─────────────
  // Anything matching ANY of these patterns is thrown away before parsing.
  const noiseRe = new RegExp([
    /^expected\s+by\b/,             // "Expected by 8:00 AM"
    /^deliver\b/,                   // "Deliver 1 package / item"
    /\bpackages?\b/,                // lines containing "package"
    /\bitems?\b/,                   // lines containing "item"
    /^#\s*[A-Za-z][-–—\d]/,        // "# M-23.3A"  route codes
    /^itinerary\b/,                 // "Itinerary List"
    /^route\s*#/,                   // "Route #..."
    /\d{1,2}:\d{2}/,               // any time string  "8:00", "3:31"
    /^(AM|PM)$/i,                   // lone AM / PM
    /^\d{1,3}%$/,                   // battery %
    /^(5G|LTE|4G|3G|WiFi|WIFI)$/i, // network indicators
    /^(loading|searching)\b/i,      // loading states
    /^\W+$/,                        // lines of only symbols / punctuation
    /^[A-Z]{1,3}\d{1,3}$/,         // short alphanumeric codes e.g. "M23"
  ].map(r => r.source).join('|'), 'i');

  const lines = rawLines.filter(l => !noiseRe.test(l));

  // ── Pre-process: merge a bare house number with the next line when OCR
  //    splits "15" and "S ELM GROVE RD" onto separate lines ─────────────────
  const dirStreetRe = /^[NSEWnsew]\s+[A-Za-z]/;
  const mergedLines = [];
  for (let k = 0; k < lines.length; k++) {
    if (/^\d{1,5}$/.test(lines[k]) && k + 1 < lines.length && dirStreetRe.test(lines[k + 1])) {
      mergedLines.push(lines[k] + ' ' + lines[k + 1]);
      k++;   // consumed the next line
    } else {
      mergedLines.push(lines[k]);
    }
  }

  const found = [];
  const houseNumRe     = /^\d{1,5}\s+[A-Za-z]/;
  const aptRe          = /^(apt|unit|suite|ste|#\s*\d|bldg|building|floor|fl|room|rm)\.?\s*\S/i;
  const cityStateZipRe = /^[A-Za-z][A-Za-z\s\-']{1,30},?\s+[A-Z]{2}\s+\d{5}(-\d{4})?$/;
  const cityStateRe    = /^[A-Za-z][A-Za-z\s\-']{1,30},?\s+[A-Z]{2}$/;
  const stateZipRe     = /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/;
  const oneLineRe      = /^\d{1,5}\s+.{5,},\s*[A-Za-z\s]+,?\s+[A-Z]{2}(\s+\d{5})?/;
  const streetKwRe     = /\b(st\.?|ave\.?|blvd\.?|dr\.?|rd\.?|way|ln\.?|ct\.?|pl\.?|pkwy|hwy|highway|route|rte|circle|cir|terr?\.?|trail|trl|loop|court|place|drive|street|avenue|boulevard|lane|road|run|row|ridge|park|point|pointe|bend|crossing|chase|grove|glen|hollow|hill|heights|vista|view|creek|bridge|gate|pass|path|pike|square|sq\.?|commons|village|manor|estates?|xing)\b/i;

  let i = 0;
  while (i < mergedLines.length) {
    const line = mergedLines[i];
    if (oneLineRe.test(line)) { found.push(line); i++; continue; }
    if (houseNumRe.test(line)) {
      const parts = [line];
      let j = i + 1;
      while (j < mergedLines.length && j < i + 6) {
        const next = mergedLines[j];
        if (noiseRe.test(next)) break;
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
    const partial  = !/\b[A-Z]{2}\b/.test(addr);
    const vStatus  = addrVerified.get(normalizeKey(addr));
    const statusCls = !vStatus             ? 'vstatus-pending'
                    : vStatus.ok           ? 'vstatus-ok'
                    :                        'vstatus-fail';
    const statusTip = !vStatus  ? 'Not verified yet'
                    : vStatus.ok ? 'Found on Google Maps ✓'
                    :              'Could not find on Google Maps';
    const mapsUrl  = `https://www.google.com/maps/search/${encodeURIComponent(enrichAddress(addr))}`;
    const li = document.createElement('li');
    li.className = partial ? 'addr-partial' : '';
    li.innerHTML = `
      <span class="addr-num">${i + 1}</span>
      <span class="addr-vstatus ${statusCls}" title="${statusTip}"></span>
      <input type="text" value="${escHtml(addr)}"
             onchange="onAddrEdit(${i}, this)" />
      ${vStatus && !vStatus.ok
        ? `<a class="maps-fix-btn" href="${mapsUrl}" target="_blank" title="Search Google Maps to fix this address">Search Maps</a>`
        : `<a class="maps-view-btn" href="${mapsUrl}" target="_blank" title="View on Google Maps">📍</a>`}
      <button class="del-btn" onclick="deleteAddress(${i})" title="Remove">&#x2715;</button>`;
    list.appendChild(li);
  });
  updateAddrCount();
}

function onAddrEdit(i, input) {
  const newVal = input.value;
  addresses[i] = newVal;
  addrVerified.delete(normalizeKey(newVal)); // clear cache so it re-verifies
  input.parentElement.className = /\b[A-Z]{2}\b/.test(newVal) ? '' : 'addr-partial';
  // Re-verify this address in background
  verifyAddress(newVal).then(() => renderAddressList());
  scheduleSave();
}

function syncAddressesFromDom() {
  addresses = Array.from(document.querySelectorAll('#address-list input[type=text]'))
    .map(el => el.value.trim()).filter(Boolean);
}
function deleteAddress(i) {
  syncAddressesFromDom();
  addrVerified.delete(normalizeKey(addresses[i]));
  addresses.splice(i, 1);
  renderAddressList();
  scheduleSave();
}
function saveAddresses() {
  syncAddressesFromDom();
  if (!addresses.length) { alert('No addresses to save yet.'); return; }
  const text = addresses.map((a, i) => `${i + 1}. ${a}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flex-addresses-${new Date().toLocaleDateString('en-CA')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function addAddressManually() {
  const inp = document.getElementById('new-address-input');
  const val = inp.value.trim(); if (!val) return;
  syncAddressesFromDom(); addresses.push(val); inp.value = '';
  renderAddressList();
  verifyAddress(val).then(() => renderAddressList());
  scheduleSave();
}
document.getElementById('new-address-input').addEventListener('keydown', e => { if (e.key === 'Enter') addAddressManually(); });

// ─── Background Address Verification ─────────────────────────────────────────
async function verifyAddress(addr) {
  const key = normalizeKey(addr);
  if (addrVerified.has(key)) return;  // already cached
  const enriched = enrichAddress(addr);
  try {
    const pt = await geocodeAddress(enriched);
    addrVerified.set(key, { ok: true, lat: pt.lat, lng: pt.lng });
  } catch {
    addrVerified.set(key, { ok: false });
  }
}

async function verifyAllAddresses() {
  // Verify addresses in the background, re-rendering after each one
  const toCheck = addresses.filter(a => !addrVerified.has(normalizeKey(a)));
  for (const addr of toCheck) {
    await verifyAddress(addr);
    renderAddressList();
    await sleep(120); // gentle rate-limit
  }
}

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
      const key    = normalizeKey(allAddrs[i]);
      const cached = addrVerified.get(key);

      // Use cached result if already verified
      if (cached && cached.ok) {
        points.push({ lat: cached.lat, lng: cached.lng, address: allAddrs[i] });
        btn.textContent = `Geocoding ${i + 1} / ${allAddrs.length}…`;
        continue;
      }
      if (cached && !cached.ok) {
        // Already known bad — skip without re-trying
        if (i === 0 && startEnr) startSkipped = true;
        else failed.push(allAddrs[i]);
        continue;
      }

      btn.textContent = `Geocoding ${i + 1} / ${allAddrs.length}…`;
      try {
        const pt = await geocodeAddress(allAddrs[i]);
        addrVerified.set(key, { ok: true, lat: pt.lat, lng: pt.lng });
        points.push({ ...pt, address: allAddrs[i] });
      } catch {
        addrVerified.set(key, { ok: false });
        if (i === 0 && startEnr) { startSkipped = true; }
        else { failed.push(allAddrs[i]); }
      }
    }

    if (startSkipped) showGeoNotice('⚠ Starting point not found — optimized delivery stops only.');
    if (failed.length) {
      // Re-render list so red badges are visible, then show notice (no blocking alert)
      renderAddressList();
      showGeoNotice(`⚠ ${failed.length} address${failed.length > 1 ? 'es' : ''} couldn't be found — marked red above. Fix them and re-optimize.`);
    }
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
  orderedStops = ordered;
  currentBatch = 0;

  document.getElementById('result-section').style.display = 'block';
  document.getElementById('result-section').scrollIntoView({ behavior: 'smooth' });

  // Clear old map state
  markers.forEach(m => m.setMap && m.setMap(null));  markers = [];
  dirRenderers.forEach(r => r.setMap(null));          dirRenderers = [];
  if (fallbackPoly) { fallbackPoly.setMap(null); fallbackPoly = null; }

  if (!map) {
    map = new google.maps.Map(document.getElementById('map'), {
      zoom: 12, mapTypeId: 'roadmap', styles: darkMapStyles(),
    });
  }

  // Numbered markers
  const bounds = new google.maps.LatLngBounds();
  ordered.forEach((pt, i) => {
    const pos = { lat: pt.lat, lng: pt.lng };
    bounds.extend(pos);
    markers.push(new google.maps.Marker({
      position: pos, map,
      label: { text: String(i + 1), color: '#fff', fontWeight: 'bold', fontSize: '12px' },
      title: pt.address,
    }));
  });
  map.fitBounds(bounds);

  // Dashed fallback polyline — replaced by real roads once they load
  fallbackPoly = new google.maps.Polyline({
    path: ordered.map(p => ({ lat: p.lat, lng: p.lng })),
    map, strokeColor: '#4a90e2', strokeWeight: 2, strokeOpacity: 0.35,
  });

  // Distance estimate
  let totalMiles = 0;
  for (let i = 0; i < ordered.length - 1; i++) totalMiles += haversineDistance(ordered[i], ordered[i + 1]);

  document.getElementById('route-summary').innerHTML = `
    <div class="stat-row">
      <div class="stat"><span>Stops</span><span>${ordered.length}</span></div>
      <div class="stat"><span>Est. Distance</span><span id="route-miles">${totalMiles.toFixed(1)} mi</span></div>
      <div class="stat"><span>Roads</span><span id="route-road-status">Loading…</span></div>
    </div>
    <div class="ordered-stops">
      <h3>Stop Order</h3>
      <ol>${ordered.map(p => `<li>${escHtml(p.address)}</li>`).join('')}</ol>
    </div>`;

  updateBatchButton();

  // Load real road paths in background
  drawRealRoads(ordered);
  scheduleSave();
}

// ─── Real Road Directions (batched, 25 stops max per request) ─────────────────
async function drawRealRoads(ordered) {
  const BATCH = 25;
  const batches = [];
  for (let i = 0; i < ordered.length; i += BATCH - 1) {
    const slice = ordered.slice(i, i + BATCH);
    if (slice.length >= 2) batches.push(slice);
  }

  let totalDriveMin = 0, loadedBatches = 0;

  for (let b = 0; b < batches.length; b++) {
    try {
      const result = await requestDirections(batches[b]);
      if (!result) continue;

      result.routes[0].legs.forEach(leg => {
        totalDriveMin += leg.duration.value / 60;
      });

      const renderer = new google.maps.DirectionsRenderer({
        map,
        suppressMarkers: true,
        suppressInfoWindows: true,
        preserveViewport: true,
        polylineOptions: { strokeColor: '#4a90e2', strokeWeight: 4, strokeOpacity: 0.9 },
      });
      renderer.setDirections(result);
      dirRenderers.push(renderer);
      loadedBatches++;
    } catch (e) {
      console.warn('Directions batch', b, 'failed — keeping fallback line:', e.message);
    }
    if (b < batches.length - 1) await sleep(250);
  }

  if (loadedBatches === batches.length && fallbackPoly) {
    fallbackPoly.setMap(null);
    fallbackPoly = null;
  }

  const statusEl = document.getElementById('route-road-status');
  if (statusEl) {
    statusEl.textContent = loadedBatches === batches.length
      ? `${Math.round(totalDriveMin)} min`
      : 'Partial';
  }
}

function requestDirections(pts) {
  return new Promise((resolve, reject) => {
    new google.maps.DirectionsService().route({
      origin:      { lat: pts[0].lat,            lng: pts[0].lng },
      destination: { lat: pts[pts.length-1].lat, lng: pts[pts.length-1].lng },
      waypoints:   pts.slice(1, -1).map(p => ({ location: { lat: p.lat, lng: p.lng }, stopover: true })),
      travelMode:  google.maps.TravelMode.DRIVING,
      optimizeWaypoints: false,
    }, (result, status) => {
      if (status === 'OK') resolve(result);
      else reject(new Error(status));
    });
  });
}

// ─── Batched Open in Maps ─────────────────────────────────────────────────────
function openNextBatch() {
  const total = orderedStops.length;
  if (!total) return;

  const startIdx = currentBatch * MAPS_BATCH_SIZE;

  // If we've opened all batches, wrap back to beginning
  if (startIdx >= total) {
    currentBatch = 0;
    updateBatchButton();
    return;
  }

  const batch = orderedStops.slice(startIdx, startIdx + MAPS_BATCH_SIZE);
  const parts = batch.map(s => encodeURIComponent(s.address));
  window.open(`https://www.google.com/maps/dir/${parts.join('/')}`, '_blank');

  currentBatch++;
  updateBatchButton();
  scheduleSave();
}

function updateBatchButton() {
  const btn  = document.getElementById('open-maps-btn');
  const hint = document.getElementById('batch-hint');
  if (!btn) return;

  const total = orderedStops.length;
  if (!total) return;

  const startIdx = currentBatch * MAPS_BATCH_SIZE;

  if (startIdx >= total) {
    btn.textContent = 'All stops opened — tap to restart';
    btn.style.opacity = '0.65';
    if (hint) hint.textContent = `All ${total} stops have been sent to Google Maps.`;
    return;
  }

  btn.style.opacity = '1';
  const endIdx   = Math.min(startIdx + MAPS_BATCH_SIZE, total);
  const batchNum = currentBatch + 1;
  const totalBatches = Math.ceil(total / MAPS_BATCH_SIZE);
  btn.textContent = `Open in Maps: Stops ${startIdx + 1}–${endIdx} →`;
  if (hint) {
    hint.textContent = totalBatches > 1
      ? `Trip ${batchNum} of ${totalBatches} · tap again after each trip for the next batch`
      : `Opens all ${total} stops in Google Maps`;
  }
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
  checkSavedSession();
})();
