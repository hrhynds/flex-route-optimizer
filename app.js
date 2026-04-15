// ─── State ────────────────────────────────────────────────────────────────────
let addresses = [];
let optimizedOrder = [];
let googleMapsLoaded = false;
let map = null;
let markers = [];

// ─── Google Maps (display only — no Directions API needed) ───────────────────
const GMAPS_API_KEY = 'AIzaSyBjLabRdpEvNXzP1mAdme-RMEOxtbeyNzo';

function loadGoogleMapsScript(key) {
  if (document.getElementById('gmaps-script')) return;
  const script = document.createElement('script');
  script.id = 'gmaps-script';
  script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&loading=async&callback=onGoogleMapsReady`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

window.onGoogleMapsReady = function () {
  googleMapsLoaded = true;
};

// ─── Delivery Area ────────────────────────────────────────────────────────────
function loadDeliveryArea() {
  const saved = localStorage.getItem('delivery_area') || '';
  if (saved) document.getElementById('delivery-area').value = saved;
}

function onDeliveryAreaChange() {
  localStorage.setItem('delivery_area', (document.getElementById('delivery-area').value || '').trim());
}

function enrichAddress(addr) {
  const area = (document.getElementById('delivery-area').value || '').trim();
  if (!area) return addr;
  if (/\b[A-Z]{2}\b/.test(addr)) return addr; // already has state
  return addr + ', ' + area;
}

// ─── Image Normalization (MIME type fix) ─────────────────────────────────────
function normalizeImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => resolve(blob || file), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ─── File Handling ────────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!file) return;
  const preview = document.getElementById('preview-img');
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';
  document.getElementById('addresses-section').style.display = 'block';
  document.getElementById('ocr-progress').style.display = 'block';
  document.getElementById('address-list').innerHTML = '';
  addresses = [];
  runOCR(await normalizeImage(file));
}

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});

// ─── OCR ──────────────────────────────────────────────────────────────────────
async function runOCR(imageBlob) {
  const fill  = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  document.getElementById('ocr-progress').style.display = 'block';
  let worker;
  try {
    label.textContent = 'Loading OCR engine…';
    fill.style.width = '5%';
    worker = await Tesseract.createWorker('eng', 1, {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
      langPath:   'https://tessdata.projectnaptha.com/4.0.0',
      logger: m => {
        if (m.status === 'recognizing text') {
          const pct = Math.round(m.progress * 100);
          fill.style.width = Math.max(pct, 10) + '%';
          label.textContent = `Reading screenshot… ${pct}%`;
        } else if (m.status === 'loading tesseract core') {
          fill.style.width = '20%'; label.textContent = 'Loading OCR engine…';
        } else if (m.status === 'initializing tesseract') {
          fill.style.width = '40%'; label.textContent = 'Initializing…';
        } else if (m.status === 'loading language traineddata') {
          fill.style.width = '60%'; label.textContent = 'Loading language data…';
        }
      },
    });
    await worker.setParameters({ tessedit_pageseg_mode: '4' });
    const { data: { text } } = await worker.recognize(imageBlob);
    fill.style.width = '100%';
    label.textContent = 'Extracting addresses…';
    showRawOcrText(text);
    addresses = parseAddresses(text);
    renderAddressList();
    document.getElementById('ocr-progress').style.display = 'none';
    if (addresses.length === 0) {
      label.textContent = 'No addresses found — check raw text below or add manually.';
      document.getElementById('ocr-progress').style.display = 'block';
    } else if (addresses.some(a => !/\b[A-Z]{2}\b/.test(a))) {
      const el = document.getElementById('delivery-area');
      if (!el.value.trim()) el.focus();
    }
  } catch (err) {
    const msg = err?.message || String(err);
    document.getElementById('progress-label').textContent = `OCR error: ${msg}. Add addresses manually.`;
    fill.style.width = '0%';
    document.getElementById('ocr-progress').style.display = 'block';
    console.error('OCR error:', err);
  } finally {
    if (worker) { try { await worker.terminate(); } catch (_) {} }
  }
}

function showRawOcrText(text) {
  let box = document.getElementById('raw-ocr-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'raw-ocr-box';
    box.innerHTML = `<details style="margin-top:14px;"><summary style="cursor:pointer;color:#555;font-size:0.8rem;">▶ Show raw OCR text (debug)</summary>
      <textarea id="raw-ocr-text" readonly style="width:100%;height:140px;margin-top:8px;background:#0a0c12;border:1px solid #2a2d3a;border-radius:8px;color:#888;font-size:0.78rem;padding:10px;resize:vertical;"></textarea></details>`;
    document.getElementById('addresses-section').insertBefore(box, document.getElementById('ocr-progress'));
  }
  document.getElementById('raw-ocr-text').value = text;
}

// ─── Address Parsing ──────────────────────────────────────────────────────────
function parseAddresses(rawText) {
  const cleaned = rawText.replace(/\r\n/g, '\n').replace(/[|]/g, 'I').replace(/['']/g, "'").replace(/[""]/g, '"');
  const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 1);
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
      while (j < lines.length && j < i + 5) {
        const next = lines[j];
        if (aptRe.test(next)) { parts.push(next); j++; }
        else if (cityStateZipRe.test(next) || cityStateRe.test(next) || stateZipRe.test(next)) { parts.push(next); j++; break; }
        else if (/^[A-Za-z][A-Za-z\s\-']{1,30}$/.test(next) && next.length < 35) { parts.push(next); j++; }
        else break;
      }
      const candidate = parts.join(', ').replace(/,\s*,/g, ',').trim();
      if (streetKwRe.test(candidate) || stateZipRe.test(candidate)) found.push(candidate);
      i = j; continue;
    }
    i++;
  }
  const seen = new Set();
  return found.filter(a => { const k = a.toLowerCase().replace(/\s+/g, ' '); if (seen.has(k)) return false; seen.add(k); return true; });
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
      <input type="text" value="${escHtml(addr)}" onchange="addresses[${i}]=this.value;this.parentElement.className=/\\b[A-Z]{2}\\b/.test(this.value)?'':'addr-partial'" />
      <button class="del-btn" onclick="deleteAddress(${i})" title="Remove">&#x2715;</button>`;
    list.appendChild(li);
  });
}

function syncAddressesFromDom() {
  addresses = Array.from(document.querySelectorAll('#address-list input[type=text]')).map(i => i.value.trim()).filter(Boolean);
}

function deleteAddress(i) { syncAddressesFromDom(); addresses.splice(i, 1); renderAddressList(); }

function addAddressManually() {
  const input = document.getElementById('new-address-input');
  const val = input.value.trim();
  if (!val) return;
  syncAddressesFromDom();
  addresses.push(val);
  input.value = '';
  renderAddressList();
}

document.getElementById('new-address-input').addEventListener('keydown', e => { if (e.key === 'Enter') addAddressManually(); });

// ─── Geocoding (Nominatim — free, no billing required) ───────────────────────
// Tries multiple query strategies so industrial/warehouse addresses still resolve.
async function geocodeAddress(address) {
  const headers = { 'User-Agent': 'FlexRouteOptimizer/1.0', 'Accept-Language': 'en-US,en' };
  const nominatim = async (params) => {
    const qs = new URLSearchParams({ format: 'json', limit: '1', countrycodes: 'us', ...params }).toString();
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  };

  // Strategy 1: full unstructured query
  let data = await nominatim({ q: address });
  if (data.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };

  // Strategy 2: structured query (better for addresses Nominatim knows by parts)
  const m = address.match(/^(\d+\s+[^,]+),\s*([^,]+),\s*([A-Z]{2})[\s,]*(\d{5})?/);
  if (m) {
    await sleep(1100);
    data = await nominatim({ street: m[1].trim(), city: m[2].trim(), state: m[3].trim(), ...(m[4] ? { postalcode: m[4] } : {}) });
    if (data.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };

    // Strategy 3: drop the house number (finds the street in the right city)
    await sleep(1100);
    const streetNoNum = m[1].replace(/^\d+\s+/, '');
    data = await nominatim({ street: streetNoNum, city: m[2].trim(), state: m[3].trim() });
    if (data.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };

    // Strategy 4: just city + state (rough location, better than nothing)
    await sleep(1100);
    data = await nominatim({ city: m[2].trim(), state: m[3].trim() });
    if (data.length) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }

  throw new Error(`Address not found: "${address}"`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Route Optimization (client-side TSP — no Google Directions API needed) ──
function haversineDistance(a, b) {
  const R = 3959, toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function nearestNeighborTSP(points, startIdx = 0) {
  const n = points.length;
  const visited = new Array(n).fill(false);
  const route = [startIdx];
  visited[startIdx] = true;
  for (let s = 0; s < n - 1; s++) {
    const curr = route[route.length - 1];
    let best = -1, bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited[j]) { const d = haversineDistance(points[curr], points[j]); if (d < bestDist) { bestDist = d; best = j; } }
    }
    visited[best] = true; route.push(best);
  }
  return route;
}

// ─── Main Optimize Button ─────────────────────────────────────────────────────
async function optimizeRoute() {
  syncAddressesFromDom();
  if (addresses.length < 2) { alert('Add at least 2 delivery addresses first.'); return; }
  if (!googleMapsLoaded) { alert('Google Maps is still loading — wait a moment and try again.'); return; }

  onDeliveryAreaChange();

  const enriched    = addresses.map(enrichAddress);
  const startRaw    = document.getElementById('start-address').value.trim();
  if (startRaw) localStorage.setItem('start_address', startRaw);
  const startEnrich = startRaw ? enrichAddress(startRaw) : null;
  const allAddrs    = startEnrich ? [startEnrich, ...enriched] : enriched;

  const btn = document.getElementById('optimize-btn');
  btn.disabled = true;

  try {
    // Geocode each address with Nominatim (rate limit: 1 req/sec)
    const points = [];
    const failed = [];
    let startPointFailed = false;

    for (let i = 0; i < allAddrs.length; i++) {
      btn.textContent = `Geocoding ${i + 1} / ${allAddrs.length}…`;
      try {
        const pt = await geocodeAddress(allAddrs[i]);
        points.push({ ...pt, address: allAddrs[i] });
      } catch (err) {
        const isStart = i === 0 && startEnrich !== null;
        if (isStart) {
          startPointFailed = true;
          // Skip start point — still optimize delivery stops
        } else {
          failed.push(allAddrs[i]);
        }
      }
      if (i < allAddrs.length - 1) await sleep(1100);
    }

    if (startPointFailed) {
      const msg = `Starting point "${startEnrich}" couldn't be found on OpenStreetMap — it's been skipped. Optimizing delivery stops only.`;
      console.warn(msg);
      // Show a non-blocking notice (not an alert that stops flow)
      const notice = document.getElementById('geocode-notice') || (() => {
        const el = document.createElement('p');
        el.id = 'geocode-notice';
        el.style.cssText = 'color:#e0913a;font-size:0.82rem;margin-top:8px;';
        document.getElementById('optimize-btn').insertAdjacentElement('afterend', el);
        return el;
      })();
      notice.textContent = `⚠ Starting point not found on map — optimized delivery stops only.`;
    }

    if (failed.length) {
      alert(`These addresses couldn't be found and were skipped:\n\n${failed.join('\n')}\n\nEdit them or check your Delivery Area setting.`);
    }

    if (points.length < 2) {
      alert('Not enough addresses could be geocoded. Check your addresses and Delivery Area.');
      return;
    }

    btn.textContent = 'Optimizing…';

    // Nearest-neighbor TSP starting from index 0 (warehouse or first stop)
    const routeIndices = nearestNeighborTSP(points, 0);
    const orderedPoints = routeIndices.map(i => points[i]);

    optimizedOrder = orderedPoints.map(p => p.address);
    showResultOnMap(orderedPoints);

  } finally {
    btn.textContent = 'Optimize Route';
    btn.disabled = false;
  }
}

// ─── Result Display ───────────────────────────────────────────────────────────
function showResultOnMap(orderedPoints) {
  document.getElementById('result-section').style.display = 'block';
  document.getElementById('result-section').scrollIntoView({ behavior: 'smooth' });

  // Clear old markers
  markers.forEach(m => m.setMap(null));
  markers = [];

  if (!map) {
    map = new google.maps.Map(document.getElementById('map'), {
      zoom: 12, mapTypeId: 'roadmap', styles: darkMapStyles(),
    });
  }

  const bounds = new google.maps.LatLngBounds();

  orderedPoints.forEach((pt, i) => {
    const pos = { lat: pt.lat, lng: pt.lng };
    bounds.extend(pos);
    const marker = new google.maps.Marker({
      position: pos, map,
      label: { text: String(i + 1), color: '#fff', fontWeight: 'bold', fontSize: '13px' },
      title: pt.address,
    });
    markers.push(marker);
  });

  // Draw route line
  new google.maps.Polyline({
    path: orderedPoints.map(p => ({ lat: p.lat, lng: p.lng })),
    map, strokeColor: '#4a90e2', strokeWeight: 3, strokeOpacity: 0.75,
  });

  map.fitBounds(bounds);

  // Estimate total straight-line distance
  let totalMiles = 0;
  for (let i = 0; i < orderedPoints.length - 1; i++) totalMiles += haversineDistance(orderedPoints[i], orderedPoints[i + 1]);

  document.getElementById('route-summary').innerHTML = `
    <div class="stat-row">
      <div class="stat"><span>Est. Distance</span><span>${totalMiles.toFixed(1)} mi</span></div>
      <div class="stat"><span>Stops</span><span>${orderedPoints.length - (optimizedOrder[0] === (document.getElementById('start-address').value.trim() ? enrichAddress(document.getElementById('start-address').value.trim()) : null) ? 1 : 0)}</span></div>
    </div>
    <div class="ordered-stops">
      <h3>Optimized Stop Order</h3>
      <ol>${orderedPoints.map(p => `<li>${escHtml(p.address)}</li>`).join('')}</ol>
    </div>
    <p class="result-note">Tap "Open in Google Maps" to navigate turn-by-turn on your phone.</p>
  `;
}

// ─── Open in Google Maps ──────────────────────────────────────────────────────
function openInGoogleMaps() {
  if (optimizedOrder.length < 2) { alert('Optimize the route first.'); return; }
  const origin      = encodeURIComponent(optimizedOrder[0]);
  const destination = encodeURIComponent(optimizedOrder[optimizedOrder.length - 1]);
  const waypoints   = optimizedOrder.slice(1, -1).map(encodeURIComponent).join('|');
  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (waypoints) url += `&waypoints=${waypoints}`;
  window.open(url, '_blank');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function darkMapStyles() {
  return [
    { elementType: 'geometry', stylers: [{ color: '#1a1d27' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a9a' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1d27' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2d3a' }] },
    { featureType: 'road.arterial', elementType: 'geometry', stylers: [{ color: '#343747' }] },
    { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#4a90e2' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0f1117' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  ];
}

// ─── Init ─────────────────────────────────────────────────────────────────────
(function init() {
  document.getElementById('setup-section').style.display = 'none';
  localStorage.setItem('gmaps_api_key', GMAPS_API_KEY);
  loadGoogleMapsScript(GMAPS_API_KEY);
  loadDeliveryArea();
  const savedStart = localStorage.getItem('start_address');
  if (savedStart) document.getElementById('start-address').value = savedStart;
})();
