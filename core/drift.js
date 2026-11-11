// Core of the slick-source shortlist: drift fields, ensemble back-tracking,
// vessel scoring and split-conformal (APS) suspect sets.
// Pure ES module, no dependencies; runs in the browser and under `node --test`.

export const STEP_S = 600;          // 10-minute integration step (matches AIS resample)
export const R_EARTH = 6371000;

// ---------- seeded RNG ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- geometry (local equirectangular, fine at < 200 km) ----------
export function toXY(lat, lon, lat0, lon0) {
  const k = Math.PI / 180;
  return [(lon - lon0) * k * R_EARTH * Math.cos(lat0 * k), (lat - lat0) * k * R_EARTH];
}
export function toLatLon(x, y, lat0, lon0) {
  const k = Math.PI / 180;
  return [lat0 + y / (R_EARTH * k), lon0 + x / (R_EARTH * k * Math.cos(lat0 * k))];
}
export function haversine(lat1, lon1, lat2, lon2) {
  const k = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * k / 2) ** 2 +
    Math.cos(lat1 * k) * Math.cos(lat2 * k) * Math.sin((lon2 - lon1) * k / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------- weather field ----------
// wx = { t0, dt, lat0, lon0, wind: [{x,y,u[],v[]}], cur: [{x,y,u[],v[]}] }
// u,v in m/s, "towards" components. Spatial: inverse-distance weighting (p=2)
// over the sample points; temporal: linear between hourly samples.
export function windFromMet(speed, dirFrom) {
  const r = dirFrom * Math.PI / 180;
  return [-speed * Math.sin(r), -speed * Math.cos(r)];
}
export function currentFromOcean(speedKmh, dirTo) {
  const s = speedKmh / 3.6, r = dirTo * Math.PI / 180;
  return [s * Math.sin(r), s * Math.cos(r)];
}
function idw(points, x, y, ti, f) {
  let wsum = 0, us = 0, vs = 0;
  for (const p of points) {
    const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d2 < 1) return [p.u[ti] * (1 - f) + p.u[ti + 1] * f, p.v[ti] * (1 - f) + p.v[ti + 1] * f];
    const w = 1 / d2;
    wsum += w;
    us += w * (p.u[ti] * (1 - f) + p.u[ti + 1] * f);
    vs += w * (p.v[ti] * (1 - f) + p.v[ti + 1] * f);
  }
  return [us / wsum, vs / wsum];
}
export function sampleField(points, t0, dt, x, y, t) {
  const n = points[0].u.length;
  let s = (t - t0) / dt;
  if (s < 0) s = 0;
  if (s > n - 1.000001) s = n - 1.000001;
  const ti = Math.floor(s);
  return idw(points, x, y, ti, s - ti);
}

// Surface drift velocity of oil: current*kappa + bias + alpha * wind rotated
// clockwise by theta (Ekman-like deflection to the right in the northern hemisphere).
export function driftVelocity(wx, x, y, t, p) {
  const [cu, cv] = sampleField(wx.cur, wx.t0, wx.dt, x, y, t);
  const [wu, wv] = sampleField(wx.wind, wx.t0, wx.dt, x, y, t);
  const c = Math.cos(-p.theta), s = Math.sin(-p.theta);
  const ru = wu * c - wv * s, rv = wu * s + wv * c;
  return [p.kappa * cu + p.bu + p.alpha * ru, p.kappa * cv + p.bv + p.alpha * rv];
}

// RK2 (midpoint) step; dtSigned < 0 integrates backwards in time.
export function step(wx, x, y, t, p, dtSigned) {
  const [u1, v1] = driftVelocity(wx, x, y, t, p);
  const xm = x + u1 * dtSigned / 2, ym = y + v1 * dtSigned / 2;
  const [u2, v2] = driftVelocity(wx, xm, ym, t + dtSigned / 2, p);
  return [x + u2 * dtSigned, y + v2 * dtSigned];
}

// ---------- ensemble priors ----------
// The back-tracking ensemble is deliberately wider than any single truth.
export const PRIOR = {
  alpha: [0.02, 0.045],      // windage (fraction of 10 m wind), oil-spill literature 2-4.5%
  thetaDeg: [0, 25],         // wind-drift deflection to the right
  kappaSd: 0.3,              // multiplicative current error
  biasSd: 0.06,              // additive current error, m/s per component
};
export function drawMembers(n, seed, prior = PRIOR) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      alpha: prior.alpha[0] + (prior.alpha[1] - prior.alpha[0]) * rng(),
      theta: (prior.thetaDeg[0] + (prior.thetaDeg[1] - prior.thetaDeg[0]) * rng()) * Math.PI / 180,
      kappa: Math.max(0, 1 + prior.kappaSd * gauss(rng)),
      bu: prior.biasSd * gauss(rng),
      bv: prior.biasSd * gauss(rng),
    });
  }
  return out;
}

// ---------- back-tracking ----------
// slickPts: [[x,y],...] sampled along the observed slick at time tObs.
// Returns per step k (k=0 at tObs, k=K at tObs-K*STEP_S) and per slick point j
// the ensemble moment-matched Gaussian {mx,my,sxx,syy,sxy}.
export function backtrack(wx, slickPts, tObs, members, K) {
  const J = slickPts.length, M = members.length;
  const X = new Float64Array(M * J), Y = new Float64Array(M * J);
  for (let m = 0; m < M; m++) for (let j = 0; j < J; j++) { X[m * J + j] = slickPts[j][0]; Y[m * J + j] = slickPts[j][1]; }
  const out = [];
  const summarize = () => {
    const row = [];
    for (let j = 0; j < J; j++) {
      let mx = 0, my = 0;
      for (let m = 0; m < M; m++) { mx += X[m * J + j]; my += Y[m * J + j]; }
      mx /= M; my /= M;
      let sxx = 0, syy = 0, sxy = 0;
      for (let m = 0; m < M; m++) {
        const dx = X[m * J + j] - mx, dy = Y[m * J + j] - my;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      }
      row.push({ mx, my, sxx: sxx / M, syy: syy / M, sxy: sxy / M });
    }
    return row;
  };
  out.push(summarize());
  for (let k = 1; k <= K; k++) {
    const t = tObs - (k - 1) * STEP_S;
    for (let m = 0; m < M; m++) {
      for (let j = 0; j < J; j++) {
        const i = m * J + j;
        const [nx, ny] = step(wx, X[i], Y[i], t, members[m], -STEP_S);
        X[i] = nx; Y[i] = ny;
      }
    }
    out.push(summarize());
  }
  return out;
}

// log N(d; 0, S) for 2x2 covariance S
export function logGauss2(dx, dy, sxx, syy, sxy) {
  const det = sxx * syy - sxy * sxy;
  const q = (syy * dx * dx - 2 * sxy * dx * dy + sxx * dy * dy) / det;
  return -0.5 * q - Math.log(2 * Math.PI) - 0.5 * Math.log(det);
}
export function logSumExp(a) {
  let m = -Infinity;
  for (const v of a) if (v > m) m = v;
  if (m === -Infinity) return -Infinity;
  let s = 0;
  for (const v of a) s += Math.exp(v - m);
  return m + Math.log(s);
}

// Kernel added to every ensemble Gaussian: AIS position error, slick extent
// and unresolved sub-grid diffusion growing with age (sqrt(2*K*age)).
export const KERNEL = { sigma0: 250, diffusivity: 15 };

// Score one vessel track against the back-tracked cloud.
// track: { t0, lat:[], lon:[] } on the same 10-min grid as STEP_S (null = no fix).
// Returns { logLik, bestK, bestDist } where logLik integrates (log-mean-exp)
// over the discharge-time prior: uniform over steps minAgeSteps..K.
export function scoreTrack(cloud, track, tObs, lat0, lon0, minAgeSteps = 0) {
  const K = cloud.length - 1;
  const terms = [];
  let best = -Infinity, bestK = -1, bestDist = Infinity;
  for (let k = minAgeSteps; k <= K; k++) {
    const t = tObs - k * STEP_S;
    const idx = Math.round((t - track.t0) / STEP_S);
    if (idx < 0 || idx >= track.lat.length || track.lat[idx] == null) continue;
    const [x, y] = toXY(track.lat[idx], track.lon[idx], lat0, lon0);
    const age = k * STEP_S;
    const s2 = KERNEL.sigma0 ** 2 + 2 * KERNEL.diffusivity * age;
    const per = [];
    let dmin = Infinity;
    for (const g of cloud[k]) {
      const dx = x - g.mx, dy = y - g.my;
      per.push(logGauss2(dx, dy, g.sxx + s2, g.syy + s2, g.sxy));
      const d = Math.hypot(dx, dy);
      if (d < dmin) dmin = d;
    }
    const l = logSumExp(per) - Math.log(per.length);
    terms.push(l);
    if (l > best) { best = l; bestK = k; bestDist = dmin; }
  }
  // steps without AIS contribute zero likelihood (vessel not observed there)
  const nSteps = K - minAgeSteps + 1;
  const logLik = terms.length ? logSumExp(terms) - Math.log(nSteps) : -Infinity;
  return { logLik, bestK, bestDist };
}

// Normalise log-likelihoods to posterior shares (uniform prior over candidates).
// T > 1 tempers an over-confident likelihood (fitted on held-out events).
export function posterior(logLiks, T = 1) {
  const a = logLiks.map(l => l / T);
  const z = logSumExp(a);
  return a.map(l => (z === -Infinity ? 1 / a.length : Math.exp(l - z)));
}
// Maximum-likelihood temperature on labelled events: argmax_T sum log p_T(true).
export function fitTemperature(events, grid = null) {
  grid = grid || Array.from({ length: 60 }, (_, i) => Math.exp(Math.log(0.5) + i * (Math.log(200) - Math.log(0.5)) / 59));
  let best = grid[0], bestLL = -Infinity;
  for (const T of grid) {
    let ll = 0;
    for (const e of events) {
      const a = e.logLiks.map(l => l / T);
      ll += a[e.trueIdx] - logSumExp(a);
    }
    if (ll > bestLL) { bestLL = ll; best = T; }
  }
  return best;
}

// ---------- conformal (APS-style, Romano et al. 2020, non-randomised) ----------
// Score of a candidate = posterior mass of all candidates ranked strictly above
// it (ties broken by index). The top-ranked candidate always scores 0, so sets
// are never empty. Larger score = less conforming.
export function rankOrder(probs) {
  return probs.map((p, i) => i).sort((a, b) => probs[b] - probs[a] || a - b);
}
export function apsScore(probs, trueIdx) {
  let s = 0;
  for (const i of rankOrder(probs)) {
    if (i === trueIdx) return s;
    s += probs[i];
  }
  return s;
}
export function conformalQuantile(scores, alpha) {
  const n = scores.length;
  const r = Math.ceil((n + 1) * (1 - alpha));
  if (r > n) return Infinity;
  const s = [...scores].sort((a, b) => a - b);
  return s[r - 1];
}
// Prediction set = { candidates whose score <= qhat }: a prefix of the ranking.
export function apsSet(probs, qhat) {
  const set = [];
  let above = 0;
  for (const i of rankOrder(probs)) {
    if (above <= qhat + 1e-12) set.push(i); else break;
    above += probs[i];
  }
  return set;
}

// ---------- truth simulator (used only to make labelled events) ----------
// A vessel discharges for `durS` seconds ending at tEnd; particles drift with a
// hidden truth parameter set plus random-walk diffusion; the drone observes the
// slick at tObs: we return points along its principal axis + noise.
export function simulateSlick(wx, track, lat0, lon0, tEnd, durS, tObs, truth, rng, opts = {}) {
  const nRel = opts.nRelease || 12, perRel = opts.perRelease || 20;
  const Kd = opts.diffusivity ?? 10;           // m^2/s
  const obsNoise = opts.obsNoise ?? 60;        // m, drone geolocation
  const parts = [];
  for (let r = 0; r < nRel; r++) {
    const tRel = tEnd - durS + (durS * (r + 0.5)) / nRel;
    const idx = (tRel - track.t0) / STEP_S;
    const i0 = Math.floor(idx), f = idx - i0;
    if (track.lat[i0] == null || track.lat[i0 + 1] == null) return null;
    const la = track.lat[i0] * (1 - f) + track.lat[i0 + 1] * f;
    const lo = track.lon[i0] * (1 - f) + track.lon[i0 + 1] * f;
    const [x, y] = toXY(la, lo, lat0, lon0);
    for (let q = 0; q < perRel; q++) parts.push({ x, y, t: tRel });
  }
  for (const p of parts) {
    let t = p.t;
    while (t < tObs - 1e-6) {
      const dt = Math.min(STEP_S, tObs - t);
      const [nx, ny] = step(wx, p.x, p.y, t, truth, dt);
      const sd = Math.sqrt(2 * Kd * dt);
      p.x = nx + sd * gauss(rng); p.y = ny + sd * gauss(rng);
      t += dt;
    }
  }
  // principal axis of the particle cloud
  let mx = 0, my = 0;
  for (const p of parts) { mx += p.x; my += p.y; }
  mx /= parts.length; my /= parts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of parts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(ang), uy = Math.sin(ang);
  let lo = Infinity, hi = -Infinity;
  for (const p of parts) { const s = (p.x - mx) * ux + (p.y - my) * uy; if (s < lo) lo = s; if (s > hi) hi = s; }
  const J = opts.nAxis || 9;
  const pts = [];
  for (let j = 0; j < J; j++) {
    const s = lo + (hi - lo) * j / (J - 1);
    pts.push([mx + s * ux + obsNoise * gauss(rng), my + s * uy + obsNoise * gauss(rng)]);
  }
  return { pts, lengthM: hi - lo, centroid: [mx, my], angle: ang };
}

export function drawTruth(rng) {
  return {
    alpha: 0.025 + 0.015 * rng(),
    theta: (20 * rng()) * Math.PI / 180,
    kappa: Math.max(0, 1 + 0.2 * gauss(rng)),
    bu: 0.04 * gauss(rng),
    bv: 0.04 * gauss(rng),
  };
}

// Baseline used by rule-based tools: the vessel closest to the slick centroid
// at observation time, or ever within `rWindow` steps before it.
export function nearestVesselBaseline(tracks, centroidLatLon, tObs, steps) {
  let best = -1, bestD = Infinity;
  tracks.forEach((tr, i) => {
    for (let k = 0; k <= steps; k++) {
      const idx = Math.round((tObs - k * STEP_S - tr.t0) / STEP_S);
      if (idx < 0 || idx >= tr.lat.length || tr.lat[idx] == null) continue;
      const d = haversine(tr.lat[idx], tr.lon[idx], centroidLatLon[0], centroidLatLon[1]);
      if (d < bestD) { bestD = d; best = i; }
    }
  });
  return best;
}

// Candidate vessels: any AIS track that came within `radiusM` of the slick
// during the search window.
export function candidates(tracks, centroidLatLon, tObs, steps, radiusM) {
  const out = [];
  tracks.forEach((tr, i) => {
    for (let k = 0; k <= steps; k++) {
      const idx = Math.round((tObs - k * STEP_S - tr.t0) / STEP_S);
      if (idx < 0 || idx >= tr.lat.length || tr.lat[idx] == null) continue;
      if (haversine(tr.lat[idx], tr.lon[idx], centroidLatLon[0], centroidLatLon[1]) <= radiusM) { out.push(i); return; }
    }
  });
  return out;
}

// ---------- joint (shape-aware) scoring ----------
// The marginal Gaussians above throw away the fact that every point of the slick
// shares one drift error. Per ensemble member, the back-tracked slick keeps its
// shape, so the polluter's track must pass ALL slick points within one short
// discharge window. backtrackMembers keeps the per-member positions.
export function backtrackMembers(wx, slickPts, tObs, members, K) {
  const J = slickPts.length, M = members.length;
  const pos = [];
  let cur = new Float64Array(M * J * 2);
  for (let m = 0; m < M; m++) for (let j = 0; j < J; j++) { cur[(m * J + j) * 2] = slickPts[j][0]; cur[(m * J + j) * 2 + 1] = slickPts[j][1]; }
  pos.push(cur);
  for (let k = 1; k <= K; k++) {
    const t = tObs - (k - 1) * STEP_S, nxt = new Float64Array(M * J * 2);
    for (let m = 0; m < M; m++) for (let j = 0; j < J; j++) {
      const i = (m * J + j) * 2;
      const [nx, ny] = step(wx, cur[i], cur[i + 1], t, members[m], -STEP_S);
      nxt[i] = nx; nxt[i + 1] = ny;
    }
    pos.push(nxt); cur = nxt;
  }
  return { pos, M, J, K };
}
export function cloudFromMembers(bm) {
  const out = [];
  for (let k = 0; k <= bm.K; k++) {
    const P = bm.pos[k], row = [];
    for (let j = 0; j < bm.J; j++) {
      let mx = 0, my = 0;
      for (let m = 0; m < bm.M; m++) { mx += P[(m * bm.J + j) * 2]; my += P[(m * bm.J + j) * 2 + 1]; }
      mx /= bm.M; my /= bm.M;
      let sxx = 0, syy = 0, sxy = 0;
      for (let m = 0; m < bm.M; m++) {
        const dx = P[(m * bm.J + j) * 2] - mx, dy = P[(m * bm.J + j) * 2 + 1] - my;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      }
      row.push({ mx, my, sxx: sxx / bm.M, syy: syy / bm.M, sxy: sxy / bm.M });
    }
    out.push(row);
  }
  return out;
}
export function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
  let t = L2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}
export const WINDOW_STEPS = 5;   // a discharge lasts at most 45 min -> 5 consecutive steps
export const RELEVANT_M = 15000; // skip steps where the vessel is far from every member

// Returns { logLik, bestK, bestDist } for one track.
export function jointScore(bm, track, tObs, lat0, lon0) {
  const { pos, M, J, K } = bm;
  const vx = new Float64Array(K + 2), vy = new Float64Array(K + 2), ok = new Uint8Array(K + 2);
  for (let k = 0; k <= K + 1; k++) {
    const idx = Math.round((tObs - k * STEP_S - track.t0) / STEP_S);
    if (idx < 0 || idx >= track.lat.length || track.lat[idx] == null) continue;
    const [x, y] = toXY(track.lat[idx], track.lon[idx], lat0, lon0);
    vx[k] = x; vy[k] = y; ok[k] = 1;
  }
  // segment k joins the vessel position at step k with step k+1 (one step earlier in time)
  const rel = [];
  for (let k = 0; k <= K; k++) {
    if (!ok[k]) continue;
    const P = pos[k];
    let cx = 0, cy = 0;
    for (let i = 0; i < M * J; i++) { cx += P[2 * i]; cy += P[2 * i + 1]; }
    cx /= M * J; cy /= M * J;
    const bx = ok[k + 1] ? vx[k + 1] : vx[k], by = ok[k + 1] ? vy[k + 1] : vy[k];
    if (distToSegment(cx, cy, vx[k], vy[k], bx, by) < RELEVANT_M) rel.push(k);
  }
  if (!rel.length) return { logLik: -Infinity, bestK: -1, bestDist: Infinity };
  const NEG = -1e9;
  const memberScores = new Float64Array(M);
  let bestK = -1, bestDist = Infinity, bestVal = -Infinity;
  const l = new Float64Array((K + 1) * J);
  for (let m = 0; m < M; m++) {
    l.fill(NEG);
    for (const k of rel) {
      const P = pos[k], age = k * STEP_S;
      const s2 = KERNEL.sigma0 ** 2 + 2 * KERNEL.diffusivity * age;
      const bx = ok[k + 1] ? vx[k + 1] : vx[k], by = ok[k + 1] ? vy[k + 1] : vy[k];
      for (let j = 0; j < J; j++) {
        const i = (m * J + j) * 2;
        const d = distToSegment(P[i], P[i + 1], vx[k], vy[k], bx, by);
        l[k * J + j] = -d * d / (2 * s2) - Math.log(2 * Math.PI * s2);
      }
    }
    const starts = [];
    for (let k0 = 0; k0 <= K; k0++) {
      let tot = 0;
      for (let j = 0; j < J; j++) {
        let mx = NEG;
        for (let k = k0; k < Math.min(K + 1, k0 + WINDOW_STEPS); k++) if (l[k * J + j] > mx) mx = l[k * J + j];
        tot += mx;
      }
      starts.push(tot);
      if (tot > bestVal) { bestVal = tot; bestK = k0; }
    }
    memberScores[m] = logSumExp(starts) - Math.log(K + 1);
  }
  if (bestK >= 0 && ok[bestK]) {
    const P = pos[bestK];
    const bx = ok[bestK + 1] ? vx[bestK + 1] : vx[bestK], by = ok[bestK + 1] ? vy[bestK + 1] : vy[bestK];
    for (let j = 0; j < J; j++) {
      let mx = 0, my = 0;
      for (let m = 0; m < M; m++) { mx += P[(m * J + j) * 2]; my += P[(m * J + j) * 2 + 1]; }
      mx /= M; my /= M;
      bestDist = Math.min(bestDist, distToSegment(mx, my, vx[bestK], vy[bestK], bx, by));
    }
  }
  const logLik = bestVal <= NEG / 2 ? -Infinity : logSumExp(Array.from(memberScores)) - Math.log(M);
  return { logLik, bestK, bestDist };
}

// Full pipeline for one observed slick: candidates -> joint scores -> posterior.
export function rankSuspects(ctx, slick, tObs, opts = {}) {
  const { wx, tracks, lat0, lon0 } = ctx;
  const K = opts.K ?? 72;                       // 12 h search window
  const members = opts.members || drawMembers(opts.nMembers ?? 60, opts.memberSeed ?? 7);
  const cLL = toLatLon(slick.centroid[0], slick.centroid[1], lat0, lon0);
  const cand = candidates(tracks, cLL, tObs, K, opts.radiusM ?? 25000);
  const bm = backtrackMembers(wx, slick.pts, tObs, members, K);
  const scored = cand.map(i => ({ i, ...jointScore(bm, tracks[i], tObs, lat0, lon0) }));
  const probs = posterior(scored.map(s => s.logLik));
  scored.forEach((s, j) => { s.p = probs[j]; });
  return { cand, scored, probs, bm };
}

// ---------- shared by the build script, the app and the tests ----------
export function roundLL(ll) { return [+ll[0].toFixed(5), +ll[1].toFixed(5)]; }
export function slickFromLatLon(ptsLL, centroidLL, lat0, lon0) {
  return { pts: ptsLL.map(p => toXY(p[0], p[1], lat0, lon0)), centroid: toXY(centroidLL[0], centroidLL[1], lat0, lon0) };
}
// One observed slick -> ranked suspects with tempered posterior and conformal set.
export function analyzeEvent(ctx, ev, T, qhat, opts = {}) {
  const slick = slickFromLatLon(ev.slickPts, ev.centroid, ctx.lat0, ctx.lon0);
  const r = rankSuspects(ctx, slick, ev.tObs, opts);
  const probs = posterior(r.scored.map(s => s.logLik), T);
  const order = rankOrder(probs);
  const rows = order.map((j, rank) => ({ vessel: r.cand[j], p: probs[j], rank: rank + 1, bestK: r.scored[j].bestK, bestDist: r.scored[j].bestDist, logLik: r.scored[j].logLik }));
  const set = apsSet(probs, qhat).map(j => r.cand[j]);
  return { cand: r.cand, probs, rows, set, bm: r.bm };
}

// Per-step distance (m) from the member-mean back-tracked slick to a vessel's
// track segment; null where the vessel has no AIS. Used for the timeline/drill-down.
export function stepProfile(bm, track, tObs, lat0, lon0) {
  const { pos, M, J, K } = bm;
  const out = [];
  for (let k = 0; k <= K; k++) {
    const i0 = Math.round((tObs - k * STEP_S - track.t0) / STEP_S), i1 = i0 - 1;
    if (i0 < 0 || i0 >= track.lat.length || track.lat[i0] == null) { out.push(null); continue; }
    const [ax, ay] = toXY(track.lat[i0], track.lon[i0], lat0, lon0);
    let bx = ax, by = ay;
    if (i1 >= 0 && track.lat[i1] != null) [bx, by] = toXY(track.lat[i1], track.lon[i1], lat0, lon0);
    const P = pos[k];
    let dmin = Infinity;
    for (let j = 0; j < J; j++) {
      let mx = 0, my = 0;
      for (let m = 0; m < M; m++) { mx += P[(m * J + j) * 2]; my += P[(m * J + j) * 2 + 1]; }
      const d = distToSegment(mx / M, my / M, ax, ay, bx, by);
      if (d < dmin) dmin = d;
    }
    out.push(dmin);
  }
  return out;
}
export function kernelSigma(k) { return Math.sqrt(KERNEL.sigma0 ** 2 + 2 * KERNEL.diffusivity * k * STEP_S); }
