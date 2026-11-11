// Seeded build: raw public data -> data/*.json used by the app and the tests.
//   raw/kat.csv     Danish Maritime Authority AIS, 21 Oct 2026, Class A, Kattegat/Skagerrak box,
//                   thinned to one fix per vessel per 5 min (scripts/fetch_ais.py)
//   raw/static.json per-MMSI static fields (name, type, length, IMO, call sign)
//   raw/wind.json   Open-Meteo historical API, 10 m wind, 20 points, 20-21 Oct 2026
//   raw/cur.json    Open-Meteo marine API, surface current, same points
// Run: node scripts/build_data.mjs
import fs from 'node:fs';
import * as D from '../core/drift.js';

const SEED = 20261021;
const DAY0 = Date.UTC(2026, 9, 21) / 1000;         // 2026-10-21T00:00Z
const NSTEP = 144;
const LAT0 = 57.5, LON0 = 11.3;
const N_EVENTS = 700, N_TEMP = 200, N_CAL = 250;
const K = 72;                                      // 12 h search window

// ---------- AIS -> 10-minute tracks ----------
const statics = JSON.parse(fs.readFileSync('raw/static.json', 'utf8'));
const byM = new Map();
for (const line of fs.readFileSync('raw/kat.csv', 'utf8').split('\n')) {
  if (!line) continue;
  const [m, ts, la, lo, sog] = line.split(',');
  if (!byM.has(m)) byM.set(m, []);
  byM.get(m).push([+ts, +la, +lo, sog === '' ? null : +sog]);
}
const vessels = [], tracks = [];
for (const [m, fixes] of byM) {
  fixes.sort((a, b) => a[0] - b[0]);
  const lat = new Array(NSTEP).fill(null), lon = new Array(NSTEP).fill(null), err = new Array(NSTEP).fill(Infinity);
  const sogs = [];
  for (const [ts, la, lo, sog] of fixes) {
    const s = (ts - DAY0) / D.STEP_S, i = Math.round(s), e = Math.abs(s - i);
    if (i < 0 || i >= NSTEP) continue;
    if (e < err[i]) { err[i] = e; lat[i] = la; lon[i] = lo; }
    if (sog != null) sogs.push(sog);
  }
  // fill gaps of up to 3 steps linearly
  let last = -1;
  for (let i = 0; i < NSTEP; i++) {
    if (lat[i] == null) continue;
    if (last >= 0 && i - last > 1 && i - last <= 4) {
      for (let j = last + 1; j < i; j++) {
        const f = (j - last) / (i - last);
        lat[j] = lat[last] + (lat[i] - lat[last]) * f; lon[j] = lon[last] + (lon[i] - lon[last]) * f;
      }
    }
    last = i;
  }
  const nFix = lat.filter(v => v != null).length;
  if (nFix < 6) continue;
  const st = statics[m] || {};
  sogs.sort((a, b) => a - b);
  vessels.push({
    mmsi: m, name: (st.name || '').trim() || `MMSI ${m}`, type: st.type || 'Unknown',
    len: st.len ? +st.len : null, imo: st.imo || null, cs: st.cs || null, dest: st.dest || null,
    sogMed: sogs.length ? sogs[Math.floor(sogs.length / 2)] : null,
  });
  tracks.push({ t0: DAY0, lat: lat.map(v => v == null ? null : +v.toFixed(5)), lon: lon.map(v => v == null ? null : +v.toFixed(5)) });
}

// ---------- weather points ----------
function wxPoints(file, conv, uKey, dKey) {
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pts = [];
  for (const e of arr) {
    const sp = e.hourly[uKey], dr = e.hourly[dKey];
    if (sp.some(v => v == null) || dr.some(v => v == null)) continue;   // land cell
    const [x, y] = D.toXY(e.latitude, e.longitude, LAT0, LON0);
    const u = [], v = [];
    for (let i = 0; i < sp.length; i++) { const [a, b] = conv(sp[i], dr[i]); u.push(+a.toFixed(4)); v.push(+b.toFixed(4)); }
    pts.push({ lat: e.latitude, lon: e.longitude, x, y, u, v });
  }
  return pts;
}
const wx = {
  t0: Date.UTC(2026, 9, 20) / 1000, dt: 3600,
  wind: wxPoints('raw/wind.json', D.windFromMet, 'wind_speed_10m', 'wind_direction_10m'),
  cur: wxPoints('raw/cur.json', D.currentFromOcean, 'ocean_current_velocity', 'ocean_current_direction'),
};

// ---------- labelled synthetic discharges in the real traffic ----------
const rng = D.mulberry32(SEED);
const POLLUTER_TYPES = new Set(['Cargo', 'Tanker', 'Fishing', 'Passenger', 'Other', 'Towing', 'Dredging', 'HSC', 'Unknown']);
const pool = vessels.map((v, i) => i).filter(i => POLLUTER_TYPES.has(vessels[i].type) && (vessels[i].sogMed ?? 0) > 3);
const ctx = { wx, tracks, lat0: LAT0, lon0: LON0 };
const members = D.drawMembers(60, 7);
const events = [];
let tries = 0;
while (events.length < N_EVENTS && tries < 20000) {
  tries++;
  const vi = pool[Math.floor(rng() * pool.length)];
  const tr = tracks[vi];
  const durS = 900 + Math.floor(rng() * 4) * 600;            // 15-45 min
  const ageS = 5400 + Math.floor(rng() * 46) * 600;           // 1.5-9 h after discharge ends
  const tEnd = DAY0 + 3600 + Math.floor(rng() * (NSTEP * D.STEP_S - 3600 - ageS) / 600) * 600;
  const tObs = tEnd + ageS;
  if (tObs > DAY0 + (NSTEP - 1) * D.STEP_S) continue;
  // vessel must be under way through the discharge
  const i0 = Math.floor((tEnd - durS - DAY0) / D.STEP_S), i1 = Math.ceil((tEnd - DAY0) / D.STEP_S);
  if (i0 < 0 || tr.lat[i0] == null || tr.lat[i1] == null) continue;
  if (D.haversine(tr.lat[i0], tr.lon[i0], tr.lat[i1], tr.lon[i1]) < 1500) continue;
  const truth = D.drawTruth(rng);
  const slick = D.simulateSlick(wx, tr, LAT0, LON0, tEnd, durS, tObs, truth, rng);
  if (!slick) continue;
  // the drone reports positions to 1e-5 deg; rank exactly what the app will see
  const slickPtsLL = slick.pts.map(([x, y]) => D.roundLL(D.toLatLon(x, y, LAT0, LON0)));
  const cLL = D.roundLL(D.toLatLon(slick.centroid[0], slick.centroid[1], LAT0, LON0));
  const r = D.rankSuspects(ctx, D.slickFromLatLon(slickPtsLL, cLL, LAT0, LON0), tObs, { K, members });
  const trueIdx = r.cand.indexOf(vi);
  if (trueIdx < 0) continue;                                  // polluter outside the 25 km candidate box
  const base = D.nearestVesselBaseline(r.cand.map(i => tracks[i]), cLL, tObs, K);
  events.push({
    id: `E${String(events.length + 1).padStart(3, '0')}`, polluter: vi, tEnd, durS, tObs,
    slickPts: slickPtsLL, slickLenM: Math.round(slick.lengthM), centroid: cLL,
    cand: r.cand, logLiks: r.scored.map(s => s.logLik), trueIdx,
    top1: D.rankOrder(r.probs)[0] === trueIdx, baselineTop1: base === trueIdx,
  });
}

// ---------- split conformal ----------
const fitSet = events.slice(0, N_TEMP), cal = events.slice(N_TEMP, N_TEMP + N_CAL), test = events.slice(N_TEMP + N_CAL);
const T = D.fitTemperature(fitSet);
for (const e of events) { e.probs = D.posterior(e.logLiks, T); e.score = D.apsScore(e.probs, e.trueIdx); }
const levels = {};
for (const conf of [0.8, 0.9, 0.95]) {
  const qhat = D.conformalQuantile(cal.map(e => e.score), 1 - conf);
  let cover = 0, sizes = [];
  for (const e of test) {
    const set = D.apsSet(e.probs, qhat);
    if (set.includes(e.trueIdx)) cover++;
    sizes.push(set.length);
  }
  sizes.sort((a, b) => a - b);
  levels[conf] = {
    qhat: +qhat.toPrecision(6), coverage: +(cover / test.length).toFixed(4),
    meanSet: +(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(2), medianSet: sizes[Math.floor(sizes.length / 2)],
    p90Set: sizes[Math.floor(sizes.length * 0.9)],
    sizeHist: Object.fromEntries([...new Set(sizes)].map(s => [s, sizes.filter(v => v === s).length])),
  };
}
const meanCand = test.reduce((a, e) => a + e.cand.length, 0) / test.length;
const results = {
  generated: 'node scripts/build_data.mjs', seed: SEED, day: '2026-10-21', box: [56.9, 58.1, 10.2, 12.4],
  vessels: vessels.length, aisFixes10min: tracks.reduce((a, t) => a + t.lat.filter(v => v != null).length, 0),
  events: events.length, temperatureFit: fitSet.length, temperature: +T.toFixed(4), calibration: cal.length, test: test.length, tries,
  meanCandidates: +meanCand.toFixed(1), medianCandidates: [...test.map(e => e.cand.length)].sort((a, b) => a - b)[Math.floor(test.length / 2)],
  top1: +(test.filter(e => e.top1).length / test.length).toFixed(4),
  baselineTop1: +(test.filter(e => e.baselineTop1).length / test.length).toFixed(4),
  levels,
};
results.headline = {
  conf: 0.9, coverage: levels[0.9].coverage, meanSet: levels[0.9].meanSet, medianSet: levels[0.9].medianSet,
  meanCandidates: results.meanCandidates,
  sentence: `On ${test.length} held-out discharges replayed through real Kattegat AIS traffic, the 90% suspect list averaged ${levels[0.9].meanSet} vessels out of ${results.meanCandidates} in the area and contained the polluter ${(levels[0.9].coverage * 100).toFixed(1)}% of the time.`,
};

// Showcase events for the app: varied, held-out, with the full ranked list.
const show = [];
const testSorted = [...test].sort((a, b) => a.tObs - b.tObs);
const step = Math.floor(testSorted.length / 12);
for (let i = 0; i < 12; i++) show.push(testSorted[i * step]);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/ais.json', JSON.stringify({ t0: DAY0, step: D.STEP_S, lat0: LAT0, lon0: LON0, vessels, tracks }));
fs.writeFileSync('data/wx.json', JSON.stringify(wx));
fs.writeFileSync('data/events.json', JSON.stringify(show.map(e => ({ ...e, probs: undefined, logLiks: undefined, cand: undefined, score: +e.score.toPrecision(6) }))));
fs.writeFileSync('data/results.json', JSON.stringify({ ...results, showcase: show.map(e => ({ id: e.id, cand: e.cand.length, trueRank: D.rankOrder(e.probs).indexOf(e.trueIdx) + 1, setSize90: D.apsSet(e.probs, levels[0.9].qhat).length, top3: D.rankOrder(e.probs).slice(0, 3).map(j => vessels[e.cand[j]].mmsi) })) }, null, 1));
console.log(JSON.stringify(results, null, 1));
