import * as D from './core/drift.js';

const $ = s => document.querySelector(s);
const LS_KEY = 'atlas.slickSource.v1';
const CONF_LEVELS = [0.8, 0.9, 0.95];
const SHOW_ROWS = 5;

let ctx, AIS, EVENTS, RESULTS, map, layers = {};
const cache = new Map();
const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
const state = { eventId: null, conf: saved.conf || 0.9, mmsi: null, k: 0, card: false, cloud: true, playing: false, flagged: saved.flagged || {} };

// ---------- formatting ----------
const pad = n => String(n).padStart(2, '0');
const utc = t => { const d = new Date(t * 1000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const dateUtc = t => { const d = new Date(t * 1000); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${utc(t)}`; };
function dms(v, pos, neg) {
  const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = ((a - d) * 60 - m) * 60;
  return `${d}° ${pad(m)}' ${s.toFixed(2).padStart(5, '0')}" ${v >= 0 ? pos : neg}`;
}
const dmsLL = ll => `${dms(ll[0], 'N', 'S')} ${dms(ll[1], 'E', 'W')}`;
const pct = p => p >= 0.995 ? '>99%' : p < 0.001 ? '<0.1%' : p < 0.1 ? `${(p * 100).toFixed(1)}%` : `${Math.round(p * 100)}%`;
const km = m => m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
const confKey = c => String(c);
const evLabel = (ev, i) => `Oil Slick OS-${pad(i + 1)}`;

function persist() {
  localStorage.setItem(LS_KEY, JSON.stringify({ conf: state.conf, flagged: state.flagged }));
  const h = new URLSearchParams({ e: state.eventId, conf: Math.round(state.conf * 100) });
  if (state.mmsi) h.set('v', state.mmsi);
  h.set('k', state.k);
  if (state.card) h.set('card', 1);
  history.replaceState(null, '', '#' + h.toString());
}
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('e') && EVENTS.some(e => e.id === h.get('e'))) state.eventId = h.get('e');
  const c = +h.get('conf') / 100;
  if (CONF_LEVELS.includes(c)) state.conf = c;
  if (h.get('v')) state.mmsi = h.get('v');
  if (h.get('k') != null && h.get('k') !== '') state.k = Math.max(0, Math.min(72, +h.get('k') || 0));
  state.card = h.get('card') === '1';
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---------- analysis ----------
function current() { return EVENTS.find(e => e.id === state.eventId); }
function analysis(ev) {
  const key = ev.id;
  if (!cache.has(key)) {
    const a = D.analyzeEvent(ctx, ev, RESULTS.temperature, RESULTS.levels['0.9'].qhat);
    a.cloud = D.cloudFromMembers(a.bm);
    a.profiles = new Map();
    cache.set(key, a);
  }
  const a = cache.get(key);
  // conformal set for the chosen level (same posterior, different threshold)
  a.setNow = D.apsSet(a.probs, RESULTS.levels[confKey(state.conf)].qhat).map(j => a.cand[j]);
  return a;
}
function profile(a, ev, vi) {
  if (!a.profiles.has(vi)) a.profiles.set(vi, D.stepProfile(a.bm, ctx.tracks[vi], ev.tObs, ctx.lat0, ctx.lon0));
  return a.profiles.get(vi);
}
const vByMmsi = m => AIS.vessels.findIndex(v => v.mmsi === m);
function posAt(vi, t) {
  const tr = ctx.tracks[vi];
  const i = Math.round((t - tr.t0) / D.STEP_S);
  if (i < 0 || i >= tr.lat.length || tr.lat[i] == null) return null;
  let hdg = null;
  for (const [a, b] of [[i, i + 1], [i - 1, i]]) {
    if (a >= 0 && b < tr.lat.length && tr.lat[a] != null && tr.lat[b] != null && (tr.lat[a] !== tr.lat[b] || tr.lon[a] !== tr.lon[b])) {
      const dy = tr.lat[b] - tr.lat[a], dx = (tr.lon[b] - tr.lon[a]) * Math.cos(tr.lat[a] * Math.PI / 180);
      hdg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; break;
    }
  }
  return { ll: [tr.lat[i], tr.lon[i]], hdg };
}
const isFlagged = (ev, mmsi) => (state.flagged[ev.id] || []).includes(mmsi);

// ---------- map ----------
function shipSvg(color, stroke = '#ffffff') {
  return `<svg viewBox="0 0 14 18"><path d="M7 0.8 C9.6 5 11.8 10.5 11.8 14.2 C11.8 16.3 9.7 17.2 7 17.2 C4.3 17.2 2.2 16.3 2.2 14.2 C2.2 10.5 4.4 5 7 0.8Z" fill="${color}" stroke="${stroke}" stroke-width="1"/></svg>`;
}
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: false, preferCanvas: true, zoomSnap: 0.25 }).setView([57.5, 11.2], 10);
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  L.tileLayer(esri + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', { attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors', maxZoom: 16 }).addTo(map);
  L.tileLayer(esri + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, opacity: 0.9 }).addTo(map);
  layers.base = L.layerGroup().addTo(map);
  layers.cloud = L.layerGroup().addTo(map);
  layers.ships = L.layerGroup().addTo(map);
  layers.renderer = L.canvas({ padding: 0.3 });
  map.on('mousemove', e => { $('#cursorPos').textContent = dmsLL([e.latlng.lat, e.latlng.lng]); });
  $('#zin').onclick = () => map.zoomIn();
  $('#zout').onclick = () => map.zoomOut();
  $('#btnRecenter').onclick = () => fitEvent(current(), analysis(current()));
  $('#btnLayers').onclick = () => { state.cloud = !state.cloud; $('#btnLayers').classList.toggle('off', !state.cloud); drawDynamic(); };
}
function fitEvent(ev, a) {
  const pts = [...ev.slickPts];
  for (const vi of a.setNow.slice(0, 4)) {
    const row = a.rows.find(r => r.vessel === vi);
    if (row && row.bestK >= 0) { const p = posAt(vi, ev.tObs - row.bestK * D.STEP_S); if (p) pts.push(p.ll); }
  }
  map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [60, 110], paddingBottomRight: [80, 270], maxZoom: 11.5 });
}
function drawStatic(ev, a) {
  layers.base.clearLayers();
  // back-tracked centroid path (member mean), dashed UAV purple
  const path = a.cloud.map(row => {
    let x = 0, y = 0; row.forEach(g => { x += g.mx; y += g.my; });
    return D.toLatLon(x / row.length, y / row.length, ctx.lat0, ctx.lon0);
  });
  L.polyline(path, { color: '#c794ff', weight: 2, dashArray: '4 6', opacity: 0.85, renderer: layers.renderer }).addTo(layers.base);
  // observed slick (at detection time)
  L.polyline(ev.slickPts, { color: '#fb5000', weight: 9, opacity: 0.22, lineCap: 'round', renderer: layers.renderer }).addTo(layers.base);
  L.polyline(ev.slickPts, { color: '#fb5000', weight: 3, opacity: 0.95, lineCap: 'round', renderer: layers.renderer }).addTo(layers.base);
  L.marker(ev.centroid, { icon: L.divIcon({ className: '', html: '<div class="slick-ico"><span class="ms fill">water_drop</span></div>', iconSize: [30, 30], iconAnchor: [15, 15] }), keyboard: false, title: 'Oil slick (detected)' }).addTo(layers.base);
  // AR5 that reported it, loitering up-wind of the slick
  const uav = [ev.centroid[0] + 0.035, ev.centroid[1] - 0.06];
  L.circle(uav, { radius: 1400, color: '#c794ff', weight: 2, fill: false, opacity: 0.9 }).addTo(layers.base);
  L.marker(uav, { icon: L.divIcon({ className: 'uav-ico', html: '<span class="ms fill">flight</span>', iconSize: [26, 26], iconAnchor: [13, 13] }), keyboard: false }).addTo(layers.base);
  L.marker([uav[0] + 0.024, uav[1]], { icon: L.divIcon({ className: '', html: '<span class="vlabel"><i style="background:#e040fb"></i>TEKEVR-AR5</span>', iconSize: null, iconAnchor: [36, 10] }), keyboard: false }).addTo(layers.base);
}
function drawDynamic() {
  const ev = current(), a = analysis(ev), k = state.k, t = ev.tObs - k * D.STEP_S;
  layers.cloud.clearLayers(); layers.ships.clearLayers();
  if (state.cloud && k > 0) {
    const P = a.bm.pos[k];
    for (let i = 0; i < a.bm.M * a.bm.J; i += 1) {
      const ll = D.toLatLon(P[2 * i], P[2 * i + 1], ctx.lat0, ctx.lon0);
      L.circleMarker(ll, { radius: 1.6, stroke: false, fillColor: '#c794ff', fillOpacity: 0.35, renderer: layers.renderer, interactive: false }).addTo(layers.cloud);
    }
    const mean = a.cloud[k].map(g => D.toLatLon(g.mx, g.my, ctx.lat0, ctx.lon0));
    L.polyline(mean, { color: '#e2c6ff', weight: 3, opacity: 0.95, renderer: layers.renderer }).addTo(layers.cloud);
  }
  const inSet = new Set(a.setNow);
  const selVi = state.mmsi ? vByMmsi(state.mmsi) : -1;
  if (selVi >= 0) {
    const tr = ctx.tracks[selVi], seg = [];
    for (let kk = 0; kk <= 72; kk++) {
      const i = Math.round((ev.tObs - kk * D.STEP_S - tr.t0) / D.STEP_S);
      if (i >= 0 && i < tr.lat.length && tr.lat[i] != null) seg.push([tr.lat[i], tr.lon[i]]);
    }
    L.polyline(seg, { color: '#67bbde', weight: 2, opacity: 0.9, renderer: layers.renderer }).addTo(layers.ships);
  }
  for (const vi of a.cand) {
    const p = posAt(vi, t);
    if (!p) continue;
    const v = AIS.vessels[vi], sel = vi === selVi, sus = inSet.has(vi);
    const cls = `vessel${sus || sel ? '' : ' dim'}${sel ? ' sel' : ''}`;
    const color = sus || sel ? '#0097d6' : '#5b7e8d';
    const html = `<div class="${cls}" style="transform:rotate(${p.hdg ?? 0}deg)">${shipSvg(color, sus || sel ? '#e9f6ff' : '#9fb4bd')}</div>`;
    const m = L.marker(p.ll, { icon: L.divIcon({ className: '', html, iconSize: [22, 22], iconAnchor: [11, 11] }), title: v.name, keyboard: false, zIndexOffset: sel ? 1000 : sus ? 500 : 0 });
    m.on('click', () => selectVessel(v.mmsi, true));
    m.addTo(layers.ships);
    if (sus || sel) {
      const flag = isFlagged(ev, v.mmsi);
      L.marker(p.ll, { icon: L.divIcon({ className: '', html: `<span class="vlabel${flag ? ' flag' : ''}"><i></i>${v.name}</span>`, iconSize: null, iconAnchor: [-12, 22] }), interactive: false, keyboard: false, zIndexOffset: sel ? 1001 : 501 }).addTo(layers.ships);
    }
  }
}

// ---------- side panel ----------
function renderFindings() {
  const box = $('#findings');
  box.innerHTML = EVENTS.map((ev, i) => {
    const a = cache.get(ev.id);
    return `<div class="fi${ev.id === state.eventId ? ' sel' : ''}" data-id="${ev.id}" role="option" aria-selected="${ev.id === state.eventId}">
      <span class="ico"><span class="ms fill">water_drop</span></span>
      <div><div class="t">${evLabel(ev, i)}</div><div class="d">${dateUtc(ev.tObs)}</div></div>
      <span class="n">${km(ev.slickLenM)}</span></div>`;
  }).join('');
  box.querySelectorAll('.fi').forEach(el => el.onclick = () => selectEvent(el.dataset.id));
}
function renderPanel() {
  const ev = current(), a = analysis(ev), i = EVENTS.indexOf(ev);
  $('#findingSelect').value = ev.id;
  $('#fDetected').textContent = dateUtc(ev.tObs);
  $('#fLength').textContent = km(ev.slickLenM);
  $('#fCentroid').textContent = dmsLL(ev.centroid);
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.conf === state.conf)));
  const lvl = RESULTS.levels[confKey(state.conf)];
  $('#summary').innerHTML = `<span class="big">${a.setNow.length} suspect${a.setNow.length === 1 ? '' : 's'}</span> of <b>${a.cand.length}</b> vessels that passed within 25 km in the 12 h before detection. Lists at this level held the polluter in <b>${(lvl.coverage * 100).toFixed(1)}%</b> of ${RESULTS.test} held-out cases.${(state.flagged[ev.id] || []).length ? ` <b>${state.flagged[ev.id].length}</b> flagged for inspection.` : ''}`;
  const inSet = new Set(a.setNow);
  const rows = a.rows.slice(0, Math.max(a.setNow.length + 3, 8));
  let html = '', dividerDone = false;
  rows.forEach(r => {
    if (!inSet.has(r.vessel) && !dividerDone) { html += `<div class="set-divider">Below the ${Math.round(state.conf * 100)}% line</div>`; dividerDone = true; }
    const v = AIS.vessels[r.vessel], flag = isFlagged(ev, v.mmsi);
    html += `<div class="sus${v.mmsi === state.mmsi ? ' sel' : ''}${inSet.has(r.vessel) ? '' : ' out'}" data-mmsi="${v.mmsi}" role="option" aria-selected="${v.mmsi === state.mmsi}" tabindex="-1">
      <span class="rk">${r.rank}</span><span>${shipSvg(inSet.has(r.vessel) ? '#0097d6' : '#5b7e8d')}</span>
      <div><div class="nm">${flag ? '<span class="ms fill flagdot">flag</span> ' : ''}${v.name}</div><div class="sub">${v.type}${v.len ? ` · ${v.len} m` : ''} · ${r.bestK >= 0 ? utc(ev.tObs - r.bestK * D.STEP_S) : '-'} UTC</div></div>
      <span class="pp">${pct(r.p)}</span><div class="bar"><i style="width:${Math.max(2, r.p * 100)}%"></i></div></div>`;
  });
  $('#suspects').innerHTML = html;
  $('#suspects').querySelectorAll('.sus').forEach(el => {
    el.onclick = () => selectVessel(el.dataset.mmsi, false);
    el.ondblclick = () => selectVessel(el.dataset.mmsi, true);
  });
  document.querySelectorAll('.sus svg').forEach(s => { s.style.width = '12px'; s.style.height = '16px'; });
  const sel = $('#suspects .sus.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
}

// ---------- timeline ----------
function renderTimeline() {
  const ev = current(), a = analysis(ev), K = 72;
  const ids = a.rows.slice(0, SHOW_ROWS).map(r => r.vessel);
  const selVi = state.mmsi ? vByMmsi(state.mmsi) : -1;
  if (selVi >= 0 && !ids.includes(selVi)) ids[ids.length - 1] = selVi;
  const x = k => `${((K - k) / K) * 100}%`;   // left = 12 h before detection
  let lab = `<div class="tl-row-label"><i style="background:#c794ff"></i>Slick back-track<span class="ms plus">add</span></div>`;
  let grid = '<div class="tl-axis">';
  const tStart = ev.tObs - K * D.STEP_S;
  for (let h = 0; h < 12; h++) {
    const tt = tStart + h * 3600, d = new Date(tt * 1000);
    grid += `<span style="left:${(h / 12) * 100}%">${pad(d.getUTCHours())}h ${pad(d.getUTCMinutes())}m</span>`;
  }
  grid += '</div>';
  for (let h = 0; h <= 12; h++) grid += `<div class="tl-vline" style="left:${(h / 12) * 100}%"></div>`;
  grid += `<div class="tl-track"><div class="tl-cell" style="left:0;width:100%;background:#c794ff"></div></div>`;
  lab += `<div class="tl-row-label section">Suspects (closest approach)</div>`;
  grid += `<div class="tl-track"></div>`;
  const inSet = new Set(a.setNow);
  for (const vi of ids) {
    const v = AIS.vessels[vi], prof = profile(a, ev, vi), row = a.rows.find(r => r.vessel === vi);
    const sel = vi === selVi;
    lab += `<div class="tl-row-label${sel ? ' sel' : ''}" data-mmsi="${v.mmsi}"><i style="background:${inSet.has(vi) ? '#0097d6' : '#5b7e8d'}"></i>${v.name}<span class="ms plus">add</span></div>`;
    let cells = '';
    for (let k = 0; k <= K; k++) {
      if (prof[k] == null) continue;
      const s = D.kernelSigma(k), w = Math.exp(-(prof[k] ** 2) / (2 * s * s));
      if (w < 0.02) { cells += `<div class="tl-cell" style="left:${x(k + 1)};width:${100 / K}%;background:#2a3438"></div>`; continue; }
      cells += `<div class="tl-cell" style="left:${x(k + 1)};width:${100 / K}%;background:rgba(${inSet.has(vi) ? '103,187,222' : '150,160,165'},${(0.25 + 0.75 * w).toFixed(2)})"></div>`;
    }
    if (row && row.bestK >= 0) {
      const k0 = row.bestK, k1 = Math.min(K, k0 + D.WINDOW_STEPS);
      cells += `<div class="tl-win" style="left:${x(k1)};width:${((k1 - k0) / K) * 100}%" title="Most likely discharge window"></div>`;
    }
    grid += `<div class="tl-track">${cells}</div>`;
  }
  grid += `<div class="tl-cursor" style="left:${x(state.k)}"></div>`;
  $('#tlLabels').innerHTML = lab;
  $('#tlGrid').innerHTML = grid;
  $('#tlLabels').querySelectorAll('[data-mmsi]').forEach(el => el.onclick = () => selectVessel(el.dataset.mmsi, false));
  const t = ev.tObs - state.k * D.STEP_S, off = state.k * D.STEP_S;
  $('#tlOffset').textContent = `-${pad(Math.floor(off / 3600))}:${pad(Math.floor(off % 3600 / 60))}:00`;
  $('#tlClock').textContent = `${utc(t)} UTC`;
  $('#tlHint').textContent = state.k === 0 ? 'Detection time · drag or use ← → to drift the slick back' : `Slick drifted back ${(off / 3600).toFixed(1)} h · ${a.bm.M} ensemble members`;
}
function scrubFromEvent(e) {
  const r = $('#tlGrid').getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  setK(Math.round(72 * (1 - f)));
}
function setK(k) {
  state.k = Math.max(0, Math.min(72, k));
  drawDynamic(); renderTimeline(); persist();
}

// ---------- vessel card (drill-down) ----------
function renderCard() {
  const card = $('#card');
  const ev = current(), a = analysis(ev);
  const vi = state.mmsi ? vByMmsi(state.mmsi) : -1;
  if (!state.card || vi < 0) { card.classList.add('hidden'); return; }
  const v = AIS.vessels[vi], row = a.rows.find(r => r.vessel === vi);
  const prof = profile(a, ev, vi);
  const last = (() => { for (let k = 0; k <= 72; k++) { const p = posAt(vi, ev.tObs - k * D.STEP_S); if (p) return { k, ...p }; } return null; })();
  const inSet = a.setNow.includes(vi), flag = isFlagged(ev, v.mmsi);
  const kBest = row.bestK, tBest = ev.tObs - kBest * D.STEP_S;
  const winStart = ev.tObs - Math.min(72, kBest + D.WINDOW_STEPS) * D.STEP_S;
  // sparkline: distance to back-tracked slick vs kernel width
  const W = 300, H = 64, maxD = 20000;
  const yOf = d => (H - 2 - (H - 4) * Math.min(1, Math.sqrt(d / maxD))).toFixed(1);   // sqrt scale, 0-20 km
  let path = '', band = '';
  for (let k = 0; k <= 72; k++) {
    const xx = W - (k / 72) * W, s = D.kernelSigma(k);
    band += `${k ? 'L' : 'M'}${xx.toFixed(1)},${yOf(2 * s)}`;
    if (prof[k] == null) { path += ' '; continue; }
    path += `${/[0-9]$/.test(path) ? 'L' : 'M'}${xx.toFixed(1)},${yOf(prof[k])}`;
  }
  band += `L0,${H - 2}L${W},${H - 2}Z`;
  const xb = W - (kBest / 72) * W;
  card.innerHTML = `
    <div class="c-src">Automatic Identification System (AIS) · Slick Source analysis</div>
    <div class="c-actions">
      <button class="c-act" id="cShare"><span class="ms">share</span>Share</button>
      <button class="c-act" id="cExport"><span class="ms">download</span>Export</button>
      <button class="c-act" id="cFocus"><span class="ms">center_focus_strong</span>Focus</button>
    </div>
    <div class="c-title">${shipSvg('#0097d6')}<h3>${v.name}</h3></div>
    <div class="c-body">
      <div>
        <div class="c-meta">
          <div><label>Last time spotted</label><b>${last ? dateUtc(ev.tObs - last.k * D.STEP_S) : '-'}</b></div>
          <div><label>Coordinates</label><b>${last ? dmsLL(last.ll) : '-'}</b></div>
          <div><label>Est. discharge window</label><b class="blue">${utc(winStart)}–${utc(tBest)} UTC</b></div>
          <div><label>Closest approach to drifted slick</label><b class="blue">${km(row.bestDist)} at ${utc(tBest)}</b></div>
          <div class="span2"><label>Distance to back-tracked slick (line) vs 2σ model spread (band), 0-20 km, last 12 h</label>
            <svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Distance over time">
              <path d="${band}" fill="#c794ff22"/><path d="${path}" fill="none" stroke="#67bbde" stroke-width="1.6"/>
              <line x1="${xb}" x2="${xb}" y1="0" y2="${H}" stroke="#fff" stroke-dasharray="2 3"/></svg>
          </div>
        </div>
      </div>
      <table aria-label="Vessel particulars"><tbody>
        <tr><td>MMSI</td><td>${v.mmsi}</td></tr>
        <tr><td>IMO</td><td>${v.imo || '-'}</td></tr>
        <tr><td>Call sign</td><td>${v.cs || '-'}</td></tr>
        <tr><td>Type</td><td>${v.type}${v.len ? ` · ${v.len} m` : ''}</td></tr>
        <tr><td>Destination</td><td>${v.dest || '-'}</td></tr>
        <tr><td>Posterior share</td><td>${pct(row.p)} · rank ${row.rank}/${a.cand.length}</td></tr>
        <tr><td>Status</td><td>${flag ? 'Flagged for inspection' : inSet ? `In ${Math.round(state.conf * 100)}% suspect list` : 'Below list line'}</td></tr>
      </tbody></table>
    </div>
    <div class="c-foot">
      <button class="btn ${flag ? 'fill flagged' : 'fill'}" id="cFlag"><span class="ms fill">flag</span>${flag ? 'Flagged' : 'Flag for Inspection'}</button>
      <button class="btn outline" id="cClose">Close</button>
      <button class="link" id="cJump"><span class="ms">schedule</span>Jump to ${utc(tBest)} UTC</button>
    </div>`;
  card.classList.remove('hidden');
  $('#cClose').onclick = () => { state.card = false; renderCard(); persist(); };
  $('#cFlag').onclick = () => toggleFlag();
  $('#cJump').onclick = () => setK(kBest);
  $('#cFocus').onclick = () => { const p = posAt(vi, tBest); if (p) map.setView(p.ll, 12); };
  $('#cShare').onclick = () => { persist(); navigator.clipboard?.writeText(location.href).catch(() => {}); toast('Deep link copied'); };
  $('#cExport').onclick = () => exportJson(v.mmsi);
}

// ---------- actions ----------
function selectEvent(id) {
  state.eventId = id; state.mmsi = null; state.card = false;
  const ev = current(), a = analysis(ev);
  state.mmsi = AIS.vessels[a.rows[0].vessel].mmsi;
  state.k = a.rows[0].bestK >= 0 ? a.rows[0].bestK : 0;
  drawStatic(ev, a); fitEvent(ev, a); renderAll();
}
function selectVessel(mmsi, openCard) {
  state.mmsi = mmsi;
  if (openCard) state.card = true;
  const ev = current(), a = analysis(ev), row = a.rows.find(r => AIS.vessels[r.vessel].mmsi === mmsi);
  if (row && row.bestK >= 0) state.k = row.bestK;
  renderAll();
}
function toggleFlag() {
  const ev = current();
  if (!state.mmsi) return;
  const list = new Set(state.flagged[ev.id] || []);
  const name = AIS.vessels[vByMmsi(state.mmsi)].name;
  if (list.has(state.mmsi)) { list.delete(state.mmsi); toast(`${name} removed from inspection list`); }
  else { list.add(state.mmsi); toast(`${name} flagged for port-state inspection`); }
  state.flagged[ev.id] = [...list];
  renderAll();
}
function setConf(c) { state.conf = c; renderAll(); }
function evidence(onlyMmsi) {
  const ev = current(), a = analysis(ev), lvl = RESULTS.levels[confKey(state.conf)];
  const rows = a.rows.filter(r => !onlyMmsi || AIS.vessels[r.vessel].mmsi === onlyMmsi).map(r => {
    const v = AIS.vessels[r.vessel];
    return { rank: r.rank, mmsi: v.mmsi, imo: v.imo, call_sign: v.cs, name: v.name, type: v.type, length_m: v.len, ais_destination: v.dest, posterior: +r.p.toPrecision(4),
      in_suspect_list: a.setNow.includes(r.vessel), closest_approach_m: Number.isFinite(r.bestDist) ? Math.round(r.bestDist) : null,
      est_discharge_end_utc: r.bestK >= 0 ? new Date((ev.tObs - r.bestK * D.STEP_S) * 1000).toISOString() : null, flagged: isFlagged(ev, v.mmsi) };
  });
  return {
    finding: evLabel(ev, EVENTS.indexOf(ev)), detected_utc: new Date(ev.tObs * 1000).toISOString(), slick_length_m: ev.slickLenM,
    slick_axis_latlon: ev.slickPts, confidence: state.conf, conformal_threshold: lvl.qhat, held_out_coverage: lvl.coverage,
    method: 'Ensemble back-tracking (60 members: windage 2-4.5%, deflection 0-25 deg, current x N(1,0.3) + N(0,0.06 m/s) bias) on Open-Meteo wind/current; shape-aware track likelihood; temperature-scaled posterior; split-conformal APS set.',
    candidates: a.cand.length, suspects: rows,
  };
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const el = document.createElement('a'); el.href = url; el.download = name; el.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportJson(onlyMmsi) {
  const ev = current();
  download(`slick-source-${ev.id}${onlyMmsi ? '-' + onlyMmsi : ''}.json`, JSON.stringify(evidence(onlyMmsi), null, 2), 'application/json');
  toast('Evidence pack exported (JSON)');
}
function exportCsv() {
  const e = evidence(), cols = Object.keys(e.suspects[0]);
  const csv = [cols.join(','), ...e.suspects.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))].join('\n');
  download(`slick-source-${current().id}.csv`, csv, 'text/csv');
  toast('Ranked candidate list exported (CSV)');
}

// ---------- calibration report ----------
function openValidation() {
  const R = RESULTS, m = $('#validation');
  const rows = CONF_LEVELS.map(c => { const l = R.levels[confKey(c)]; return `<tr><td>${Math.round(c * 100)}%</td><td class="${l.coverage >= c ? 'ok' : ''}">${(l.coverage * 100).toFixed(1)}%</td><td>${l.meanSet}</td><td>${l.medianSet}</td><td>${l.p90Set}</td><td>${l.qhat.toFixed(4)}</td></tr>`; }).join('');
  const hist = R.levels['0.9'].sizeHist, maxN = Math.max(...Object.values(hist)), maxS = Math.max(...Object.keys(hist).map(Number));
  let bars = '';
  for (let s = 1; s <= maxS; s++) { const n = hist[s] || 0, h = (n / maxN) * 100; bars += `<rect x="${((s - 1) / maxS) * 340}" y="${110 - h}" width="${340 / maxS - 1}" height="${h}" fill="#67bbde"><title>${s} vessels: ${n} cases</title></rect>`; }
  const ev = current(), i = EVENTS.indexOf(ev), a = analysis(ev), truthRank = a.rows.findIndex(r => r.vessel === ev.polluter) + 1;
  m.innerHTML = `<div class="m-box">
    <div class="src">Slick Source · calibration report</div><h3>Does the suspect list keep its promise?</h3>
    <p>${R.events} oil discharges were simulated from real vessels in the Danish AIS feed for ${R.day} (Kattegat/Skagerrak, ${R.vessels} vessels), drifted with hidden "true" windage, deflection, current error and diffusion through Open-Meteo wind and surface currents, and observed as a slick 1.5-9 h later. ${R.temperatureFit} cases fit the posterior temperature (T = ${R.temperature}), ${R.calibration} calibrate the conformal threshold, and ${R.test} are held out.</p>
    <table><thead><tr><th>Target</th><th>Held-out coverage</th><th>Mean list</th><th>Median</th><th>90th pct</th><th>Threshold</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="m-grid">
      <div><p><b style="color:#fff">Top-1 accuracy:</b> ${(R.top1 * 100).toFixed(1)}% for the ranked list vs ${(R.baselineTop1 * 100).toFixed(1)}% for "nearest vessel to the slick" (a rule-based baseline). Average candidates within 25 km: ${R.meanCandidates}.</p>
      <p><b style="color:#fff">This finding (synthetic ground truth):</b> ${evLabel(ev, i)} was laid by <b style="color:#fff">${AIS.vessels[ev.polluter].name}</b>, ranked ${truthRank} of ${a.cand.length}; it is ${a.setNow.includes(ev.polluter) ? 'inside' : 'outside'} the ${Math.round(state.conf * 100)}% list.</p></div>
      <div><p style="margin-bottom:4px">List size at 90% (held-out cases)</p><svg class="hist" viewBox="0 0 340 120">${bars}<line x1="0" x2="340" y1="110.5" y2="110.5" stroke="#555"/></svg></div>
    </div>
    <p>Guarantee: for a new slick drawn from the same process, P(polluter in list) ≥ target (split conformal, exchangeable cases). It is not a guarantee for real discharges until the threshold is recalibrated on confirmed cases, e.g. CleanSeaNet feedback.</p>
    <div style="display:flex;justify-content:flex-end"><button class="btn outline" id="vClose">Close</button></div></div>`;
  m.classList.remove('hidden');
  $('#vClose').onclick = () => m.classList.add('hidden');
  m.onclick = e => { if (e.target === m) m.classList.add('hidden'); };
}
function openHelp() {
  const m = $('#validation');
  const keys = [['↑ / ↓', 'Move through suspects'], ['Enter', 'Open vessel card'], ['F', 'Flag selected vessel for inspection'], ['E', 'Export evidence pack (JSON)'], ['← / →', 'Drift the slick back / forward 10 min'], ['Space', 'Play / pause the back-track'], ['1 / 2 / 3', 'Confidence 80 / 90 / 95%'], ['[ / ]', 'Previous / next finding'], ['V', 'Calibration report'], ['Esc', 'Close']];
  m.innerHTML = `<div class="m-box" style="width:420px"><h3>Keyboard shortcuts</h3><div class="kbd-list" style="margin-top:12px">${keys.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('')}</div><div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn outline" id="vClose">Close</button></div></div>`;
  m.classList.remove('hidden');
  $('#vClose').onclick = () => m.classList.add('hidden');
}

// ---------- play ----------
function togglePlay() {
  state.playing = !state.playing;
  $('#btnPlay .ms').textContent = state.playing ? 'pause' : 'play_arrow';
  if (state.playing) {
    if (state.k >= 72) state.k = 0;
    const tick = () => { if (!state.playing) return; if (state.k >= 72) { togglePlay(); return; } setK(state.k + 1); setTimeout(tick, 160); };
    tick();
  }
}

function renderAll() { renderPanel(); renderFindings(); renderTimeline(); drawDynamic(); renderCard(); persist(); }

function bind() {
  $('#findingSelect').innerHTML = EVENTS.map((e, i) => `<option value="${e.id}">${evLabel(e, i)} · ${utc(e.tObs)} UTC</option>`).join('');
  $('#findingSelect').onchange = e => selectEvent(e.target.value);
  document.querySelectorAll('.seg button').forEach(b => b.onclick = () => setConf(+b.dataset.conf));
  $('#btnExport').onclick = () => exportJson();
  $('#btnCsv').onclick = exportCsv;
  $('#btnValidation').onclick = openValidation;
  $('#btnPlay').onclick = togglePlay;
  $('#btnBack').onclick = () => setK(state.k + 1);
  $('#btnFwd').onclick = () => setK(state.k - 1);
  $('#presToggle').onclick = e => { const on = e.currentTarget.getAttribute('aria-checked') !== 'true'; e.currentTarget.setAttribute('aria-checked', on); e.currentTarget.querySelector('b').textContent = on ? 'ON' : 'OFF'; document.querySelector('.timeline').classList.toggle('hidden', on); };
  const g = $('#tlGrid');
  let drag = false;
  g.addEventListener('pointerdown', e => { drag = true; g.setPointerCapture(e.pointerId); scrubFromEvent(e); });
  g.addEventListener('pointermove', e => { if (drag) scrubFromEvent(e); });
  g.addEventListener('pointerup', () => { drag = false; });
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
    const ev = current(), a = analysis(ev);
    const ids = a.rows.slice(0, Math.max(a.setNow.length + 3, 8)).map(r => AIS.vessels[r.vessel].mmsi);
    const i = ids.indexOf(state.mmsi);
    const k = e.key;
    if (k === 'ArrowDown' || k === 'j') { selectVessel(ids[Math.min(ids.length - 1, i + 1)], false); e.preventDefault(); }
    else if (k === 'ArrowUp' || k === 'k') { selectVessel(ids[Math.max(0, i - 1)], false); e.preventDefault(); }
    else if (k === 'Enter') { state.card = true; renderCard(); persist(); }
    else if (k === 'Escape') { $('#validation').classList.add('hidden'); state.card = false; renderCard(); persist(); }
    else if (k === 'f' || k === 'F') toggleFlag();
    else if (k === 'e' || k === 'E') exportJson();
    else if (k === 'ArrowLeft') { setK(state.k + 1); e.preventDefault(); }
    else if (k === 'ArrowRight') { setK(state.k - 1); e.preventDefault(); }
    else if (k === ' ') { togglePlay(); e.preventDefault(); }
    else if (k === '1' || k === '2' || k === '3') setConf(CONF_LEVELS[+k - 1]);
    else if (k === '[' || k === ']') { const j = EVENTS.indexOf(ev) + (k === ']' ? 1 : -1); if (j >= 0 && j < EVENTS.length) selectEvent(EVENTS[j].id); }
    else if (k === 'v' || k === 'V') openValidation();
    else if (k === '?') openHelp();
  });
}

async function boot() {
  try {
    const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };
    [AIS, ctx, EVENTS, RESULTS] = await Promise.all([get('data/ais.json'), get('data/wx.json'), get('data/events.json'), get('data/results.json')]);
    ctx = { wx: ctx, tracks: AIS.tracks, lat0: AIS.lat0, lon0: AIS.lon0 };
    state.eventId = EVENTS[0].id;
    initMap(); bind();
    const initialHash = location.hash;
    const hashEvent = new URLSearchParams(initialHash.slice(1)).get('e');
    selectEvent(EVENTS.some(e => e.id === hashEvent) ? hashEvent : EVENTS[1].id);
    history.replaceState(null, '', initialHash || '#');
    readHash();
    renderAll();
    $('#loading').classList.add('hidden');
  } catch (err) {
    console.error(err);
    $('#loading').classList.add('hidden');
    $('#errorText').textContent = `Could not load mission data (${err.message}).`;
    $('#error').classList.remove('hidden');
  }
}
boot();
