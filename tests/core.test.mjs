import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as D from '../core/drift.js';

const read = f => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url)));
const AIS = read('ais.json'), WX = read('wx.json'), EVENTS = read('events.json'), R = read('results.json');
const ctx = { wx: WX, tracks: AIS.tracks, lat0: AIS.lat0, lon0: AIS.lon0 };

// a uniform, still weather field for synthetic geometry tests
function stillField(u = 0, v = 0, wu = 0, wv = 0) {
  const pt = (x, y) => ({ x, y, u: Array(48).fill(u), v: Array(48).fill(v) });
  const wpt = (x, y) => ({ x, y, u: Array(48).fill(wu), v: Array(48).fill(wv) });
  return { t0: 0, dt: 3600, cur: [pt(-1e5, 0), pt(1e5, 0)], wind: [wpt(-1e5, 0), wpt(1e5, 0)] };
}

test('data integrity: 144 ten-minute AIS slots, 48 hourly weather samples, events inside the day', () => {
  assert.ok(AIS.vessels.length > 400);
  for (const t of AIS.tracks) assert.equal(t.lat.length, 144);
  for (const p of [...WX.wind, ...WX.cur]) { assert.equal(p.u.length, 48); assert.ok(p.u.every(Number.isFinite)); }
  for (const e of EVENTS) { assert.ok(e.tObs > AIS.t0 && e.tObs < AIS.t0 + 86400); assert.equal(e.slickPts.length, 9); }
});

test('seeded RNG is deterministic and in [0,1)', () => {
  const a = D.mulberry32(42), b = D.mulberry32(42);
  for (let i = 0; i < 1000; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
});

test('property: local projection round-trips and agrees with haversine (< 0.5%)', () => {
  const rng = D.mulberry32(1);
  for (let i = 0; i < 500; i++) {
    const lat = 56.9 + rng() * 1.2, lon = 10.2 + rng() * 2.2;
    const [x, y] = D.toXY(lat, lon, 57.5, 11.3);
    const [la, lo] = D.toLatLon(x, y, 57.5, 11.3);
    assert.ok(Math.abs(la - lat) < 1e-9 && Math.abs(lo - lon) < 1e-9);
    const d = D.haversine(lat, lon, 57.5, 11.3);
    assert.ok(Math.abs(Math.hypot(x, y) - d) / Math.max(d, 1) < 0.005);
  }
});

test('meteorological vs oceanographic direction conventions', () => {
  const [wu, wv] = D.windFromMet(10, 0);            // wind FROM north blows south
  assert.ok(Math.abs(wu) < 1e-9 && Math.abs(wv + 10) < 1e-9);
  const [cu, cv] = D.currentFromOcean(3.6, 90);      // current TOWARDS east, 1 m/s
  assert.ok(Math.abs(cu - 1) < 1e-9 && Math.abs(cv) < 1e-9);
});

test('field interpolation: exact at sample points, constant fields stay constant', () => {
  const p = WX.cur[3];
  const [u, v] = D.sampleField(WX.cur, WX.t0, WX.dt, p.x, p.y, WX.t0 + 5 * 3600);
  assert.ok(Math.abs(u - p.u[5]) < 1e-9 && Math.abs(v - p.v[5]) < 1e-9);
  const f = stillField(0.3, -0.2);
  const [a, b] = D.sampleField(f.cur, 0, 3600, 12345, -999, 7777);
  assert.ok(Math.abs(a - 0.3) < 1e-12 && Math.abs(b + 0.2) < 1e-12);
});

test('property: integrating back then forward returns to the start (RK2 on real fields)', () => {
  const rng = D.mulberry32(3);
  const members = D.drawMembers(20, 11);
  for (const m of members) {
    let x = (rng() - 0.5) * 40000, y = (rng() - 0.5) * 40000, t = AIS.t0 + 40000;
    const x0 = x, y0 = y;
    for (let i = 0; i < 12; i++) { [x, y] = D.step(WX, x, y, t, m, -600); t -= 600; }
    for (let i = 0; i < 12; i++) { [x, y] = D.step(WX, x, y, t, m, 600); t += 600; }
    assert.ok(Math.hypot(x - x0, y - y0) < 5, `drift ${Math.hypot(x - x0, y - y0)} m`);
  }
});

test('windage and deflection: 3% of a 10 m/s northerly, rotated 20 deg to the right', () => {
  const f = stillField(0, 0, 0, -10);
  const [u, v] = D.driftVelocity(f, 0, 0, 0, { alpha: 0.03, theta: 20 * Math.PI / 180, kappa: 1, bu: 0, bv: 0 });
  assert.ok(Math.abs(Math.hypot(u, v) - 0.3) < 1e-9);
  // southward wind turned right (clockwise seen from above) points south-west: u < 0
  assert.ok(u < 0 && v < 0);
  assert.ok(Math.abs(Math.atan2(-u, -v) * 180 / Math.PI - 20) < 1e-6);
});

test('distance to segment', () => {
  assert.equal(D.distToSegment(0, 5, -10, 0, 10, 0), 5);
  assert.equal(D.distToSegment(13, 4, -10, 0, 10, 0), 5);
  assert.equal(D.distToSegment(3, 4, 0, 0, 0, 0), 5);
});

test('property: APS set membership agrees with the APS score, sets are non-empty ranked prefixes, monotone in threshold', () => {
  const rng = D.mulberry32(5);
  for (let it = 0; it < 400; it++) {
    const n = 2 + Math.floor(rng() * 20);
    const raw = Array.from({ length: n }, () => Math.exp(4 * D.gauss(rng)));
    const s = raw.reduce((a, b) => a + b, 0), p = raw.map(x => x / s);
    const q = rng(), q2 = q + rng() * (1 - q);
    const set = D.apsSet(p, q), set2 = D.apsSet(p, q2), order = D.rankOrder(p);
    assert.ok(set.length >= 1);
    assert.deepEqual(set, order.slice(0, set.length));
    assert.ok(set2.length >= set.length);
    for (let i = 0; i < n; i++) assert.equal(set.includes(i), D.apsScore(p, i) <= q + 1e-12);
  }
});

test('property: split-conformal threshold covers exchangeable scores at >= 1 - alpha', () => {
  const rng = D.mulberry32(9);
  let cover = 0, total = 0;
  for (let rep = 0; rep < 400; rep++) {
    const scores = Array.from({ length: 101 }, () => Math.abs(D.gauss(rng)));
    const qhat = D.conformalQuantile(scores.slice(0, 100), 0.1);
    total++; if (scores[100] <= qhat) cover++;
  }
  assert.ok(cover / total >= 0.86, `coverage ${cover / total}`);
  assert.equal(D.conformalQuantile([1, 2, 3], 0.1), Infinity);   // too few points -> trivial set
});

test('posterior: normalised; temperature flattens it; fitTemperature recovers the generating temperature', () => {
  const ll = [-1, -3, -10, -2];
  const p1 = D.posterior(ll, 1), p4 = D.posterior(ll, 4);
  assert.ok(Math.abs(p1.reduce((a, b) => a + b) - 1) < 1e-12);
  const H = p => -p.reduce((a, x) => a + (x > 0 ? x * Math.log(x) : 0), 0);
  assert.ok(H(p4) > H(p1));
  const rng = D.mulberry32(13), evs = [];
  for (let i = 0; i < 600; i++) {
    const logLiks = Array.from({ length: 10 }, () => 6 * D.gauss(rng));
    const p = D.posterior(logLiks, 3);
    let u = rng(), trueIdx = 0;
    while (u > p[trueIdx] && trueIdx < 9) { u -= p[trueIdx]; trueIdx++; }
    evs.push({ logLiks, trueIdx });
  }
  const T = D.fitTemperature(evs);
  assert.ok(T > 2.2 && T < 4.2, `T=${T}`);
});

test('joint score prefers the vessel that laid the slick over a parallel ship 3 km away and one passing an hour late', () => {
  const f = stillField(0.3, 0, 0, 0);   // 0.3 m/s eastward current: the slick drifts 2.16 km east in 2 h
  const lat0 = 57.5, lon0 = 11.3, t0 = 0, tObs = 6 * 3600;
  // polluter steams north at 6 m/s; slick laid between 2 h and 2.5 h before detection
  const mk = (dx, delayS) => {
    const lat = [], lon = [];
    for (let i = 0; i < 144; i++) {
      const t = i * 600 - delayS, y = (t - (tObs - 2 * 3600)) * 6;
      const [la, lo] = D.toLatLon(dx, y, lat0, lon0); lat.push(la); lon.push(lo);
    }
    return { t0, lat, lon };
  };
  const pol = mk(0, 0), parallel = mk(3000, 0), late = mk(0, 3600);
  const pts = []; for (let j = 0; j < 9; j++) pts.push([0.3 * 2 * 3600 + 0.3 * 1800 * (1 - j / 8), -1800 * 6 + j * 1800 * 6 / 8]);
  const members = D.drawMembers(30, 1, { alpha: [0, 0], thetaDeg: [0, 0], kappaSd: 0, biasSd: 0.0001 });
  const bm = D.backtrackMembers(f, pts, tObs, members, 72);
  const s = tr => D.jointScore(bm, tr, tObs, lat0, lon0).logLik;
  assert.ok(s(pol) > s(parallel) + 5);
  assert.ok(s(pol) > s(late) + 5);
  const r = D.jointScore(bm, pol, tObs, lat0, lon0);
  assert.ok(Math.abs(r.bestK - 12) <= D.WINDOW_STEPS, `bestK ${r.bestK}`);
});

test('headline: app pipeline reproduces every showcase result in results.json', () => {
  for (const ev of EVENTS) {
    const a = D.analyzeEvent(ctx, ev, R.temperature, R.levels['0.9'].qhat);
    const want = R.showcase.find(s => s.id === ev.id);
    assert.equal(a.cand.length, want.cand);
    assert.equal(a.rows.findIndex(r => r.vessel === ev.polluter) + 1, want.trueRank);
    assert.equal(a.set.length, want.setSize90);
    assert.deepEqual(a.rows.slice(0, 3).map(r => AIS.vessels[r.vessel].mmsi), want.top3);
  }
});

test('headline numbers: held-out coverage meets each target within sampling error and the sentence matches the table', () => {
  for (const c of ['0.8', '0.9', '0.95']) {
    const l = R.levels[c];
    assert.ok(l.coverage >= +c - 0.03, `${c}: ${l.coverage}`);
    assert.ok(l.meanSet < R.meanCandidates / 5);
  }
  const h = R.headline;
  assert.equal(h.coverage, R.levels['0.9'].coverage);
  assert.equal(h.meanSet, R.levels['0.9'].meanSet);
  assert.ok(h.sentence.includes(String(h.meanSet)) && h.sentence.includes(String(h.meanCandidates)));
  assert.ok(R.top1 > 3 * R.baselineTop1, 'ranking beats the nearest-vessel rule');
  assert.equal(R.calibration + R.test + R.temperatureFit, R.events);
});

test('property: stepProfile distances are non-negative and null exactly where AIS is missing', () => {
  const ev = EVENTS[1];
  const a = D.analyzeEvent(ctx, ev, R.temperature, R.levels['0.9'].qhat);
  for (const vi of a.cand.slice(0, 15)) {
    const prof = D.stepProfile(a.bm, ctx.tracks[vi], ev.tObs, ctx.lat0, ctx.lon0);
    prof.forEach((d, k) => {
      const idx = Math.round((ev.tObs - k * 600 - AIS.t0) / 600);
      if (AIS.tracks[vi].lat[idx] == null) assert.equal(d, null); else assert.ok(d >= 0);
    });
  }
});
