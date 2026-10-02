// Unit tests for js/geo.js (track encoding / simplification). Run: npm run test:geo
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePolyline, decodePolyline, simplifyDP, densify, fitTrack, haversine } from "../js/geo.js";

function noisyTrack(n) {
  let s = 12345; const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let lat = 51.6, lon = -3.95, hd = 0; const pts = [];
  for (let i = 0; i < n; i++) {
    hd += (rnd() - 0.5) * 0.06;
    lat += Math.cos(hd) * 4e-5 + (rnd() - 0.5) * 8e-6;
    lon += Math.sin(hd) * 6.4e-5 + (rnd() - 0.5) * 1.2e-5;
    pts.push([lat, lon]);
  }
  return pts;
}
function maxDevM(orig, simp) {   // max distance (m) of original points from the simplified polyline
  const kx = 111320 * Math.cos(51.6 * Math.PI / 180), ky = 111320; let worst = 0;
  for (const p of orig) {
    let best = Infinity;
    for (let k = 0; k < simp.length - 1; k++) {
      const ax = simp[k][1] * kx, ay = simp[k][0] * ky, bx = simp[k + 1][1] * kx, by = simp[k + 1][0] * ky, px = p[1] * kx, py = p[0] * ky;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy; let u = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u));
      best = Math.min(best, Math.hypot(px - (ax + u * dx), py - (ay + u * dy)));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

test("polyline round trip is exact to 5 decimal places, incl. negative longitudes", () => {
  const pts = noisyTrack(5000).map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5]);
  const dec = decodePolyline(encodePolyline(pts));
  assert.equal(dec.length, pts.length);
  pts.forEach((p, i) => { assert.ok(Math.abs(p[0] - dec[i][0]) < 1e-9 && Math.abs(p[1] - dec[i][1]) < 1e-9); });
});

test("known polyline vector (Google docs example)", () => {
  const dec = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
  assert.deepEqual(dec, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  assert.equal(encodePolyline(dec), "_p~iF~ps|U_ulLnnqC_mqNvxq`@");
});

test("Douglas-Peucker keeps every original point within the tolerance", () => {
  const pts = noisyTrack(8000);
  for (const tol of [1, 3, 10]) {
    const s = simplifyDP(pts, tol);
    assert.ok(s.length < pts.length);
    assert.deepEqual(s[0], pts[0]); assert.deepEqual(s[s.length - 1], pts[pts.length - 1]);
    const dev = maxDevM(pts, s);
    assert.ok(dev <= tol * 1.05, `tol ${tol}: deviation ${dev}`);
  }
});

test("densify keeps the shape and bounds segment length", () => {
  const line = [[51.6, -3.9], [51.61, -3.9], [51.61, -3.88]];
  const d = densify(line, 30);
  assert.ok(d.length > 50);
  for (let i = 1; i < d.length; i++) assert.ok(haversine(d[i - 1], d[i]) <= 31);
  assert.deepEqual(d[0], line[0]); assert.deepEqual(d[d.length - 1], line[2]);
  assert.ok(maxDevM(d, line) < 0.01);
});

test("fitTrack: small tracks untouched; 120k-point track fits <=12,000 points and a tiny encoded size", () => {
  const small = noisyTrack(500);
  const f1 = fitTrack(small);
  assert.equal(f1.simplified, false); assert.equal(f1.track.length, 500);
  const big = noisyTrack(120000);
  const f2 = fitTrack(big);
  assert.equal(f2.simplified, true);
  assert.ok(f2.track.length <= 12000, "points " + f2.track.length);
  const enc = encodePolyline(f2.track);
  assert.ok(enc.length < 150000, "encoded chars " + enc.length);
  // sampled deviation check (every 50th point to keep the test fast)
  const dev = maxDevM(big.filter((_, i) => i % 50 === 0), f2.track);
  assert.ok(dev <= f2.toleranceM * 1.1 + 1e-6, `dev ${dev} tol ${f2.toleranceM}`);
  console.log(`      120,000 pts -> ${f2.track.length} pts, tol ${f2.toleranceM} m, encoded ${enc.length} chars, max deviation ${dev.toFixed(2)} m`);
});
