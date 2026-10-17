// The server works out the fare itself. The phone's fare is never trusted.
const CATS = {
  scooty: { base: 30, km: 12, min: 2, minFare: 50 },
  mini:   { base: 50, km: 20, min: 3, minFare: 90 },
  ac:     { base: 70, km: 25, min: 5, minFare: 140 },
};

const toRad = (d) => (d * Math.PI) / 180;
const haversineKm = (a, b) => { // points are [lng, lat]
  const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
};

// Real road distance from OSRM, falls back to straight line x 1.35
async function trip(from, to) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}?overview=false`,
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    const route = (await res.json()).routes?.[0];
    if (!res.ok || !route) throw new Error('no route');
    return { km: route.distance / 1000, minutes: route.duration / 60 };
  } catch (e) {
    const km = haversineKm(from, to) * 1.35;
    return { km, minutes: (km / 25) * 60 };
  }
}

function fareFor(type, km, minutes) {
  const c = CATS[type] || CATS.mini;
  return Math.round(Math.max(c.base + km * c.km + minutes * c.min, c.minFare));
}

module.exports = { CATS, trip, fareFor };
