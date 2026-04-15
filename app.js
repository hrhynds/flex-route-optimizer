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

// ─── File Handling ────────────────────────────────────────────────────────────
function handleFile(file) {
  if (!file) return;

  // Show preview
  const preview = document.getElementById('preview-img');
  preview.src = URL.createObjectURL(file);
  preview.style.display = 'block';

  // Show addresses section
  document.getElementById('addresses-section').style.display = 'block';
  document.getElementById('ocr-progress').style.display = 'block';
  document.getElementById('address-list').innerHTML = '';
  addresses = [];

  runOCR(file);
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
async function runOCR(file) {
  const progressFill  = document.getElementById('progress-fill');
  const progressLabel = document.getElementById('progress-label');

  try {
    const result = await Tesseract.recognize(file, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          const pct = Math.round(m.progress * 100);
          progressFill.style.width = pct + '%';
          progressLabel.textContent = `Reading screenshot… ${pct}%`;
        }
      }
    });

    progressLabel.textContent = 'Done! Extracting addresses…';
    const extracted = parseAddresses(result.data.text);
    addresses = extracted;
    renderAddressList();

    document.getElementById('ocr-progress').style.display = 'none';

    if (addresses.length === 0) {
      progressLabel.textContent = 'No addresses found automatically — add them manually below.';
      document.getElementById('ocr-progress').style.display = 'block';
    }
  } catch (err) {
    progressLabel.textContent = 'OCR failed. Add addresses manually below.';
    console.error('OCR error:', err);
  }
}

// ─── Address Parsing ──────────────────────────────────────────────────────────
// Looks for lines that match common US address patterns
function parseAddresses(rawText) {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const found = [];

  // Pattern: starts with a number, has a street keyword
  const streetPattern = /^\d+\s+.{3,}/;
  const streetKeywords = /\b(st|ave|blvd|dr|rd|way|ln|ct|pl|pkwy|hwy|route|rte|circle|cir|terr?|trail|trl)\b/i;
  // Pattern: ends with a state abbreviation + zip  e.g. "Seattle, WA 98101"
  const stateZipPattern = /,?\s*[A-Z]{2}\s+\d{5}(-\d{4})?$/i;

  let buffer = '';

  for (const line of lines) {
    // If line starts with a house number, start a new potential address
    if (streetPattern.test(line)) {
      if (buffer) {
        const candidate = buffer.trim();
        if (isLikelyAddress(candidate, streetKeywords, stateZipPattern)) {
          found.push(candidate);
        }
      }
      buffer = line;
    } else if (buffer && (stateZipPattern.test(line) || /^[A-Za-z\s]+,?\s*[A-Z]{2}/.test(line))) {
      // Continuation: city/state line
      buffer += ', ' + line;
      const candidate = buffer.trim();
      if (isLikelyAddress(candidate, streetKeywords, stateZipPattern)) {
        found.push(candidate);
      }
      buffer = '';
    } else if (buffer && line.length < 50) {
      buffer += ', ' + line;
    } else {
      if (buffer) {
        const candidate = buffer.trim();
        if (isLikelyAddress(candidate, streetKeywords, stateZipPattern)) {
          found.push(candidate);
        }
        buffer = '';
      }
    }
  }

  // Catch final buffer
  if (buffer) {
    const candidate = buffer.trim();
    if (isLikelyAddress(candidate, streetKeywords, stateZipPattern)) {
      found.push(candidate);
    }
  }

  // De-duplicate
  return [...new Set(found)];
}

function isLikelyAddress(text, streetKeywords, stateZipPattern) {
  return streetKeywords.test(text) || stateZipPattern.test(text);
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
