const R = 6371000; // metres
const rad = (d) => (d * Math.PI) / 180;

export function distanceMeters(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearingDegrees(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/* Straight-line distance understates road distance. A 1.3 detour factor is the
   usual rule of thumb for built-up areas and keeps the ETA honestly pessimistic. */
export const DETOUR_FACTOR = 1.3;

/* Speeds in m/s. Short hops are slow (lights, turns); longer runs pick up. */
function assumedSpeed(roadMeters, observedSpeed) {
  if (Number.isFinite(observedSpeed) && observedSpeed > 2) {
    /* Trust the phone's own speed, but cap it, so one GPS spike cannot promise
       a two-minute arrival from ten miles out. */
    return Math.min(observedSpeed, 31); // ~70 mph
  }
  if (roadMeters < 1500) return 7.5;   // ~17 mph
  if (roadMeters < 8000) return 11.5;  // ~26 mph
  if (roadMeters < 30000) return 16;   // ~36 mph
  return 22;                            // ~49 mph
}

export function estimate({ from, to, speedMps = null, now = Date.now() }) {
  const straight = distanceMeters(from, to);
  if (straight === null) {
    return { distanceM: null, roadDistanceM: null, etaAt: null, etaMinutes: null, bearing: null };
  }
  const road = straight * DETOUR_FACTOR;
  const speed = assumedSpeed(road, speedMps);
  const minutes = Math.max(1, Math.round(road / speed / 60));
  return {
    distanceM: Math.round(straight),
    roadDistanceM: Math.round(road),
    etaMinutes: minutes,
    etaAt: now + minutes * 60000,
    bearing: bearingDegrees(from, to),
  };
}

export function formatDistance(meters) {
  if (meters == null) return 'Distance unknown';
  const miles = meters / 1609.344;
  if (miles < 0.1) return 'Less than a block away';
  if (miles < 1) return `${(Math.round(miles * 10) / 10).toFixed(1)} mi away`;
  return `${miles < 10 ? (Math.round(miles * 10) / 10).toFixed(1) : Math.round(miles)} mi away`;
}
