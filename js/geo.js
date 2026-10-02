/* Pure helper functions (no DOM needed, except parseGPX which needs DOMParser).
   Used by the admin screen and by the driver-view data loader. Also unit-tested in Node. */

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* ---- Encoded polyline (Google algorithm, 5 decimal places ~ 1.1 m) ----
   Why: Firestore cannot store arrays-of-arrays ([[lat,lng],...]) and a plain
   flat number array is ~9 bytes per number. An encoded string is ~4-6 bytes
   per POINT, so even very long routes fit far below the 1 MiB document limit. */
export function encodePolyline(points) {
  let out = "", pLat = 0, pLng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p[0] * 1e5), lng = Math.round(p[1] * 1e5);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat; pLng = lng;
  }
  return out;
}

export function decodePolyline(str) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => {
    let shift = 0, result = 0, b;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i <= str.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next(); lng += next();
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

/* ---- Douglas-Peucker simplification (iterative, safe for 100k+ points) ---- */
export function simplifyDP(points, tolMeters) {
  const n = points.length;
  if (n < 3 || tolMeters <= 0) return points.slice();
  const refLat = points[Math.floor(n / 2)][0];
  const kx = 111320 * Math.cos(rad(refLat)), ky = 111320;
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = points[i][1] * kx; Y[i] = points[i][0] * ky; }
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tolMeters * tolMeters;
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    const dx = X[e] - X[s], dy = Y[e] - Y[s], len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      let d2;
      if (len2 === 0) { d2 = (X[i] - X[s]) ** 2 + (Y[i] - Y[s]) ** 2; }
      else {
        let t = ((X[i] - X[s]) * dx + (Y[i] - Y[s]) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d2 = (X[i] - (X[s] + t * dx)) ** 2 + (Y[i] - (Y[s] + t * dy)) ** 2;
      }
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/* Insert evenly spaced points on any segment longer than maxGapM. The shape does
   not change (points lie on the same straight segment). The driver app finds the
   "road heading" from the nearest track vertex, so a simplified track with 500 m
   straight segments would otherwise lose heading-up smoothing. */
export function densify(points, maxGapM = 30) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = haversine(a, b);
    if (d > maxGapM) {
      const k = Math.ceil(d / maxGapM);
      for (let j = 1; j < k; j++) {
        const t = j / k;
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    out.push(b);
  }
  return out;
}

export const MAX_TRACK_POINTS = 12000;

/* Prepare a track for storage: round to 5 dp, drop consecutive duplicates; if there
   are more than maxPoints, simplify with Douglas-Peucker, starting at 1 m tolerance
   and widening until it fits. Returns {track, originalPoints, simplified, toleranceM}. */
export function fitTrack(points, maxPoints = MAX_TRACK_POINTS) {
  const clean = [];
  for (const p of points) {
    const q = [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
    const l = clean[clean.length - 1];
    if (!l || l[0] !== q[0] || l[1] !== q[1]) clean.push(q);
  }
  if (clean.length <= maxPoints) return { track: clean, originalPoints: points.length, simplified: false, toleranceM: 0 };
  let tol = 1, res = simplifyDP(clean, tol);
  while (res.length > maxPoints && tol < 5000) { tol *= 1.6; res = simplifyDP(clean, tol); }
  return { track: res, originalPoints: points.length, simplified: true, toleranceM: Math.round(tol * 10) / 10 };
}

/* ---- GPX ---- */
export function parseGPX(text, fallbackName = "Route", Parser = globalThis.DOMParser) {
  const xml = new Parser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("That file is not valid GPX/XML.");
  const nameEl = xml.querySelector("trk > name, rte > name, metadata > name");
  const name = (nameEl && nameEl.textContent.trim()) || fallbackName;
  const pt = (el) => [parseFloat(el.getAttribute("lat")), parseFloat(el.getAttribute("lon"))];
  const ok = (p) => !isNaN(p[0]) && !isNaN(p[1]);
  const nameOf = (el) => { const n = el.querySelector("name"); return n ? n.textContent.trim() : ""; };

  const track = Array.from(xml.querySelectorAll("trk trkpt")).map(pt).filter(ok);
  // Stops: route points (rtept) first, else waypoints (wpt) - same precedence as the original app.
  let stopEls = Array.from(xml.querySelectorAll("rte > rtept"));
  if (!stopEls.length) stopEls = Array.from(xml.querySelectorAll("wpt"));
  const stops = stopEls.map((el) => ({ p: pt(el), name: nameOf(el) })).filter((s) => ok(s.p))
    .map((s, i) => ({ lat: s.p[0], lng: s.p[1], name: s.name || "Stop " + (i + 1) }));

  if (!track.length && !stops.length) throw new Error("No track points or stops found in that GPX file.");
  return { name, track: track.length ? track : stops.map((s) => [s.lat, s.lng]), stops };
}
