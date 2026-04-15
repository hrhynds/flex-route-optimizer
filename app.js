// ─── State ────────────────────────────────────────────────────────────────────
let addresses = [];          // array of address strings reviewed by user
let optimizedOrder = [];     // indices into addresses[], in optimal order
let googleMapsLoaded = false;
let map = null;
let directionsService = null;
let directionsRenderer = null;

// ─── API Key ──────────────────────────────────────────────────────────────────
function saveApiKey() {
  const key = document.getElementById('api-key-input').value.trim();
  const status = document.getElementById('key-status');

  if (!key) {
    setStatus(status, 'Please paste your API key first.', 'error');
    return;
  }

  localStorage.setItem('gmaps_api_key', key);
  setStatus(status, 'Key saved! It will be used for route optimization.', 'success');
  loadGoogleMapsScript(key);
}

function loadGoogleMapsScript(key) {
  if (document.getElementById('gmaps-script')) return; // already loaded
  const script = document.createElement('script');
  script.id = 'gmaps-script';
  script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=geometry&callback=onGoogleMapsReady`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

window.onGoogleMapsReady = function () {
  googleMapsLoaded = true;
  directionsService = new google.maps.DirectionsService();
  directionsRenderer = new google.maps.DirectionsRenderer({ suppressMarkers: false });
};

// ─── Image Normalization (MIME type fix) ─────────────────────────────────────
// Draws the image onto a canvas and exports as PNG — guarantees correct MIME
// type regardless of whether the file was JPEG mislabeled as PNG or vice versa.
function normalizeImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(objectUrl);
      canvas.toBlob((blob) => resolve(blob || file), 'image/png');
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file); // fall back to original if image can't be decoded
    };

    img.src = objectUrl;
  });
}

// ─── File Handling ────────────────────────────────────────────────────────────
async function handleFile(file) {
  if (!file) return;

  // Show preview immediately with original file
  const preview = document.getElementById('preview-img');
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';

  // Show addresses section
  document.getElementById('addresses-section').style.display = 'block';
  document.getElementById('ocr-progress').style.display = 'block';
  document.getElementById('address-list').innerHTML = '';
  addresses = [];

  // Normalize to PNG (fixes JPEG/PNG MIME type mismatches before OCR)
  const normalizedFile = await normalizeImage(file);
  runOCR(normalizedFile);
}

// Drag & drop support
const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// ─── OCR ──────────────────────────────────────────────────────────────────────
async function runOCR(imageBlob) {
  const progressFill  = document.getElementById('progress-fill');
  const progressLabel = document.getElementById('progress-label');
  document.getElementById('ocr-progress').style.display = 'block';

  let worker;
  try {
    progressLabel.textContent = 'Loading OCR engine…';
    progressFill.style.width = '5%';

    worker = await Tesseract.createWorker('eng', 1, {
      workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js',
      langPath:   'https://tessdata.projectnaptha.com/4.0.0',
      logger: (m) => {
        if (m.status === 'recognizing text') {
          const pct = Math.round(m.progress * 100);
          progressFill.style.width = Math.max(pct, 10) + '%';
          progressLabel.textContent = `Reading screenshot… ${pct}%`;
        } else if (m.status === 'loading tesseract core') {
          progressFill.style.width = '20%';
          progressLabel.textContent = 'Loading OCR engine…';
        } else if (m.status === 'initializing tesseract') {
          progressFill.style.width = '40%';
          progressLabel.textContent = 'Initializing…';
        } else if (m.status === 'loading language traineddata') {
          progressFill.style.width = '60%';
          progressLabel.textContent = 'Loading language data…';
        }
      },
    });

    // PSM 4 = single column of variable-size text — best for Flex stop lists
    await worker.setParameters({ tessedit_pageseg_mode: '4' });

    const { data: { text } } = await worker.recognize(imageBlob);

    progressFill.style.width = '100%';
    progressLabel.textContent = 'Extracting addresses…';

    showRawOcrText(text);

    const extracted = parseAddresses(text);
    addresses = extracted;
    renderAddressList();

    document.getElementById('ocr-progress').style.display = 'none';

    if (addresses.length === 0) {
      progressLabel.textContent = 'No addresses found — check the raw text below or add them manually.';
      document.getElementById('ocr-progress').style.display = 'block';
    }
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    progressLabel.textContent = `OCR error: ${msg}. Add addresses manually below.`;
    progressFill.style.width = '0%';
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
    box.innerHTML = `
      <details style="margin-top:14px;">
        <summary style="cursor:pointer;color:#666;font-size:0.8rem;">Show raw OCR text (for debugging)</summary>
        <textarea id="raw-ocr-text" readonly
          style="width:100%;height:140px;margin-top:8px;background:#0a0c12;border:1px solid #2a2d3a;
                 border-radius:8px;color:#888;font-size:0.78rem;padding:10px;resize:vertical;"></textarea>
      </details>`;
    document.getElementById('addresses-section').insertBefore(
      box, document.getElementById('ocr-progress')
    );
  }
  document.getElementById('raw-ocr-text').value = text;
}

// ─── Address Parsing ──────────────────────────────────────────────────────────
// Tuned for Amazon Flex screenshot formats (stop lists, multi-line addresses)
function parseAddresses(rawText) {
  // Fix common OCR artifacts
  const cleaned = rawText
    .replace(/\r\n/g, '\n')
    .replace(/[|]/g, 'I')      // pipe mistaken for letter I
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"');

  const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  const found = [];

  // A house number line: starts with 1–5 digits followed by a space and a letter
  const houseNumRe   = /^\d{1,5}\s+[A-Za-z]/;
  // Apartment / unit continuation lines
  const aptRe        = /^(apt|unit|suite|ste|#|bldg|building|floor|fl|room|rm)\.?\s*\S/i;
  // City + State + ZIP line  e.g. "Seattle, WA 98101" or "SEATTLE WA 98101-1234"
  const cityStateZipRe = /^[A-Za-z][A-Za-z\s\-']{1,30},?\s+[A-Z]{2}\s+\d{5}(-\d{4})?$/;
  // State + ZIP anywhere in line
  const stateZipRe   = /\b[A-Z]{2}\s+\d{5}(-\d{4})?\b/;
  // Full address on one line: house# + street + city/state/zip
  const oneLineRe    = /^\d{1,5}\s+.{5,},\s*[A-Za-z\s]+,?\s+[A-Z]{2}\s+\d{5}/;
  // Street keyword (broad list for US addresses)
  const streetKwRe   = /\b(st\.?|ave\.?|blvd\.?|dr\.?|rd\.?|way|ln\.?|ct\.?|pl\.?|pkwy|hwy|highway|route|rte|circle|cir|terr?\.?|trail|trl|loop|court|place|drive|street|avenue|boulevard|lane|road|run|row|ridge|park|point|pointe|bend|crossing|chase|grove|glen|hollow|hill|heights|vista|view|creek|bridge|gate|pass|path|pike|square|sq\.?|commons|village|manor|estates?|xing)\b/i;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // One-line full address (common in Amazon Flex list view)
    if (oneLineRe.test(line)) {
      found.push(line);
      i++;
      continue;
    }

    // Multi-line address starting with a house number
    if (houseNumRe.test(line)) {
      const parts = [line];
      let j = i + 1;

      while (j < lines.length && j < i + 5) {
        const next = lines[j];
        if (aptRe.test(next)) {
          parts.push(next);
          j++;
        } else if (cityStateZipRe.test(next) || stateZipRe.test(next)) {
          parts.push(next);
          j++;
          break;
        } else if (/^[A-Za-z][A-Za-z\s\-']{1,30}$/.test(next) && next.length < 35) {
          // Likely a city-only line — absorb and keep looking
          parts.push(next);
          j++;
        } else {
          break;
        }
      }

      const candidate = parts.join(', ').replace(/,\s*,/g, ',').trim();
      // Accept if it has a street keyword OR a state+zip
      if (streetKwRe.test(candidate) || stateZipRe.test(candidate)) {
        found.push(candidate);
      }
      i = j;
      continue;
    }

    i++;
  }

  // De-duplicate (case-insensitive, collapse extra spaces)
  const seen = new Set();
  return found.filter(a => {
    const key = a.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Address List UI ──────────────────────────────────────────────────────────
function renderAddressList() {
  const list = document.getElementById('address-list');
  list.innerHTML = '';
  addresses.forEach((addr, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="addr-num">${i + 1}</span>
      <input type="text" value="${escHtml(addr)}" onchange="addresses[${i}] = this.value" />
      <button class="del-btn" onclick="deleteAddress(${i})" title="Remove">&#x2715;</button>
    `;
    list.appendChild(li);
  });
}

function deleteAddress(index) {
  addresses.splice(index, 1);
  renderAddressList();
}

function addAddressManually() {
  const input = document.getElementById('new-address-input');
  const val = input.value.trim();
  if (!val) return;
  addresses.push(val);
  input.value = '';
  renderAddressList();
}

// Allow pressing Enter in the add-address field
document.getElementById('new-address-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addAddressManually();
});

// ─── Route Optimization ───────────────────────────────────────────────────────
function optimizeRoute() {
  if (addresses.length < 2) {
    alert('Please add at least 2 delivery addresses.');
    return;
  }

  const key = localStorage.getItem('gmaps_api_key');
  if (!key) {
    alert('Please enter and save your Google Maps API key in Step 1 first.');
    return;
  }

  if (!googleMapsLoaded) {
    loadGoogleMapsScript(key);
    alert('Google Maps is still loading. Please wait a moment and try again.');
    return;
  }

  const startAddr = document.getElementById('start-address').value.trim();
  const origin = startAddr || addresses[0];

  const waypoints = addresses.map(addr => ({ location: addr, stopover: true }));

  // If user provided a custom start, all addresses are waypoints.
  // Otherwise, use first as origin and last as destination.
  const destination = startAddr ? addresses[addresses.length - 1] : addresses[addresses.length - 1];
  const waypointsForApi = startAddr ? waypoints : waypoints.slice(1, -1);

  const request = {
    origin,
    destination,
    waypoints: waypointsForApi,
    optimizeWaypoints: true,    // <-- Google optimizes the order for us
    travelMode: google.maps.TravelMode.DRIVING,
  };

  document.getElementById('optimize-btn').textContent = 'Optimizing…';
  document.getElementById('optimize-btn').disabled = true;

  directionsService.route(request, (result, status) => {
    document.getElementById('optimize-btn').textContent = 'Optimize Route';
    document.getElementById('optimize-btn').disabled = false;

    if (status === google.maps.DirectionsStatus.OK) {
      showResult(result, origin, destination, waypointsForApi, startAddr);
    } else {
      alert(`Route optimization failed: ${status}\n\nMake sure your API key has Directions API enabled and the addresses are valid.`);
      console.error('Directions API error:', status, result);
    }
  });
}

// ─── Result Display ───────────────────────────────────────────────────────────
function showResult(result, origin, destination, waypointsForApi, hasCustomStart) {
  document.getElementById('result-section').style.display = 'block';
  document.getElementById('result-section').scrollIntoView({ behavior: 'smooth' });

  // Build map
  if (!map) {
    map = new google.maps.Map(document.getElementById('map'), {
      zoom: 12,
      mapTypeId: 'roadmap',
      styles: darkMapStyles(),
    });
    directionsRenderer.setMap(map);
  }
  directionsRenderer.setDirections(result);

  // Compute totals
  const legs = result.routes[0].legs;
  let totalMeters = 0;
  let totalSeconds = 0;
  legs.forEach(leg => {
    totalMeters  += leg.distance.value;
    totalSeconds += leg.duration.value;
  });

  const totalMiles   = (totalMeters / 1609.34).toFixed(1);
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours        = Math.floor(totalMinutes / 60);
  const mins         = totalMinutes % 60;
  const timeStr      = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  // Rebuild ordered stop list using the optimized waypoint order
  const order = result.routes[0].waypoint_order;  // indices into waypointsForApi
  const orderedAddresses = [origin];
  order.forEach(i => orderedAddresses.push(waypointsForApi[i].location));
  if (destination !== origin) orderedAddresses.push(destination);

  // Store for "Open in Maps" button
  optimizedOrder = orderedAddresses;

  // Render summary
  const summary = document.getElementById('route-summary');
  summary.innerHTML = `
    <div class="stat-row">
      <div class="stat"><span>Total Distance</span><span>${totalMiles} miles</span></div>
      <div class="stat"><span>Est. Drive Time</span><span>${timeStr}</span></div>
      <div class="stat"><span>Stops</span><span>${addresses.length}</span></div>
    </div>
    <div class="ordered-stops">
      <h3>Optimized Stop Order</h3>
      <ol>${orderedAddresses.map(a => `<li>${escHtml(a)}</li>`).join('')}</ol>
    </div>
  `;
}

// ─── Open in Google Maps ──────────────────────────────────────────────────────
function openInGoogleMaps() {
  if (optimizedOrder.length < 2) {
    alert('Please optimize a route first.');
    return;
  }

  const origin      = encodeURIComponent(optimizedOrder[0]);
  const destination = encodeURIComponent(optimizedOrder[optimizedOrder.length - 1]);
  const waypoints   = optimizedOrder.slice(1, -1).map(encodeURIComponent).join('|');

  let url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
  if (waypoints) url += `&waypoints=${waypoints}`;

  window.open(url, '_blank');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setStatus(el, msg, type) {
  el.textContent = msg;
  el.className = 'status-msg ' + type;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Dark map style for the embedded map
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

// ─── Init: auto-load hardcoded API key ───────────────────────────────────────
const GMAPS_API_KEY = 'AIzaSyBjLabRdpEvNXzP1mAdme-RMEOxtbeyNzo';

(function init() {
  // Hide the API key setup section — key is built in
  document.getElementById('setup-section').style.display = 'none';
  localStorage.setItem('gmaps_api_key', GMAPS_API_KEY);
  loadGoogleMapsScript(GMAPS_API_KEY);
})();
