/* Runway Next Door — interactive prototype (no build step). */
(() => {
'use strict';

// ---------- Constants (all listed in the "Assumptions & sources" panel) ----------
const K = {
  DRIVE_MPH: 65,                              // OSRM road distance ÷ 65 mph (public OSRM durations run slow)
  DRIVE_DETOUR: 1.25,                         // fallback when OSRM unavailable
  LOCAL_DETOUR: 1.3, LOCAL_MPH: 35,           // drive to/from an airport
  HUB_PROCESS: 90, HUB_DEPLANE: 25, HUB_MPH: 450, HUB_OVERHEAD: 30, HUB_MIN_GC: 150,
  NX_CURB: 10, NX_DEPLANE: 5, NX_MPH: 230, NX_OVERHEAD: 15,
  CO2_CAR: 0.306, CO2_AIR: 0.207, HYBRID_FACTOR: 0.70,
};
let STATS = { hubs: { n: 95, median: 23.4, w10: 23.4 }, usable: { n: 2892, median: 6.8, w10: 74.7 } };
const PAD_TL = [640, 150], PAD_BR = [240, 90];
const US_BOUNDS = [[24.5, -124.8], [49.4, -66.9]];
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R_MI = 3958.8;
function hav(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, dLa = (bLat - aLat) * r, dLo = (bLon - aLon) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(h));
}
function nearest(list, lat, lon) {
  let best = null, bd = Infinity;
  for (const p of list) { const d = hav(lat, lon, p.lat, p.lon); if (d < bd) { bd = d; best = p; } }
  return { p: best, d: bd };
}
const fmtMi = d => d < 10 ? d.toFixed(1) : Math.round(d).toLocaleString();
function fmtT(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}
const fmtKg = kg => kg < 10 ? kg.toFixed(1) : Math.round(kg).toLocaleString();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const titleCase = s => String(s || '').toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
const shortName = r => (r.iata || r.id);
async function fetchT(url, ms = 6000, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
function animateNum(el, from, to, ms, dec = 0, done) {
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    const v = from + (to - from) * e;
    el.textContent = dec ? v.toFixed(dec) : Math.round(v).toLocaleString();
    if (k < 1) requestAnimationFrame(step); else done && done();
  };
  requestAnimationFrame(step);
}

// ---------- Map ----------
const map = L.map('map', { zoomControl: false, zoomSnap: 0.1, zoomDelta: 0.5, worldCopyJump: true, attributionControl: true })
  .setView([38.5, -100.5], 4.6);
map.fitBounds([[24.5, -124.8], [49.4, -66.9]], { paddingTopLeft: [600, 130], paddingBottomRight: [70, 40] });
L.control.zoom({ position: 'topright' }).addTo(map);
// Basemap. CARTO dark_all now serves an "API KEY REQUIRED" watermark to keyless clients,
// so the keyless Esri Dark Gray Canvas (tinted navy in CSS) is the default; ?tiles=carto opts back in.
map.createPane('labels').style.zIndex = 350;
map.getPane('labels').style.pointerEvents = 'none';
if (new URLSearchParams(location.search).get('tiles') === 'carto') {
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19, className: 'carto-tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
} else {
  const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  L.tileLayer(esri + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, className: 'base-tiles',
    attribution: 'Basemap &copy; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const ref = L.tileLayer(esri + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, pane: 'labels', className: 'ref-tiles' }).addTo(map);
  // Don't show upscaled label tiles from other zoom levels while new ones load (giant blurry text).
  const hideStale = () => { for (const z in ref._levels) ref._levels[z].el.style.visibility = +z === ref._tileZoom ? '' : 'hidden'; };
  ref.on('tileloadstart tileload load', hideStale); map.on('zoomend', hideStale);
}
map.createPane('dots').style.zIndex = 380;
const canvas = L.canvas({ padding: 0.5, pane: 'dots' });
// Canvas layers get CSS-scaled during fly animations (dots balloon); fade them out while zooming.
map.on('zoomstart', () => map.getPane('dots').classList.add('zooming'));
map.on('zoomend', () => map.getPane('dots').classList.remove('zooming'));
map.createPane('cov').style.zIndex = 390;
const covCanvas = L.canvas({ padding: 0.5, pane: 'cov' });
const layers = { dots: L.layerGroup().addTo(map), find: L.layerGroup().addTo(map), trip: L.layerGroup(), cov: L.layerGroup(), routes: L.layerGroup() };

const pulseIcon = (color, size = 18) => L.divIcon({
  className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  html: `<div class="pulse" style="--c:${color};width:${size}px;height:${size}px"><div class="ring"></div><div class="ring r2"></div><div class="core"></div></div>`,
});
const pinIcon = (label, color = '#19E6C1') => L.divIcon({
  className: '', iconSize: [30, 30], iconAnchor: [15, 34],
  html: `<div class="home-pin" style="box-shadow:0 6px 18px rgba(0,0,0,.5),0 0 0 3px ${color}66"><span>${label}</span></div>`,
});
const planeIcon = L.divIcon({
  className: '', iconSize: [30, 30], iconAnchor: [15, 15],
  html: `<svg class="plane" viewBox="0 0 24 24"><path fill="#EFFFFB" d="M12 1.5c.8 0 1.4 1 1.4 2.2v5.6l8.1 4.6v2.2l-8.1-2.4v4.6l2.3 1.7v1.7L12 20.8l-3.7 1.1v-1.7l2.3-1.7v-4.6l-8.1 2.4v-2.2l8.1-4.6V3.7c0-1.2.6-2.2 1.4-2.2z"/></svg>`,
});
function label(marker, html, cls = '', dir = 'right', offset = [14, 0]) {
  marker.bindTooltip(html, { permanent: true, direction: dir, offset, className: `lbl ${cls}`, opacity: 1 });
  return marker;
}
function fit(latlngs, maxZoom = 11) {
  map.flyToBounds(L.latLngBounds(latlngs), { paddingTopLeft: PAD_TL, paddingBottomRight: PAD_BR, maxZoom, duration: 1.8, easeLinearity: 0.2 });
}
// Curved arc between two points (quadratic Bézier in lat/lon space), used for flights.
function arcPts(a, b, bend = 0.18, n = 80) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
  const c = [mx - dy * bend * -1, my + dx * bend * -1];
  const c2 = [mx + dy * bend, my - dx * bend];
  const ctrl = c2[0] > c[0] ? c2 : c; // bow toward north
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * ctrl[0] + t * t * b[0], u * u * a[1] + 2 * u * t * ctrl[1] + t * t * b[1]]);
  }
  return out;
}
// Progressive line drawing for a cinematic reveal.
function drawLine(layer, pts, style, ms = 1200) {
  const line = L.polyline([pts[0]], style).addTo(layer);
  const t0 = performance.now();
  const step = now => {
    const k = Math.min(1, (now - t0) / ms), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    const n = Math.max(1, Math.round(e * (pts.length - 1)));
    line.setLatLngs(pts.slice(0, n + 1));
    if (k < 1 && layer.hasLayer(line)) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return line;
}
function densify(a, b, n = 40) { const o = []; for (let i = 0; i <= n; i++) o.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]); return o; }
let planeAnim = 0;
function flyPlane(layer, pts, ms = 3200) {
  const id = ++planeAnim;
  const m = L.marker(pts[0], { icon: planeIcon, interactive: false, zIndexOffset: 1000 }).addTo(layer);
  let t0 = performance.now();
  const step = now => {
    if (id !== planeAnim || !layer.hasLayer(m)) return;
    let k = (now - t0) / ms;
    if (k > 1.25) { t0 = now; k = 0; }
    const kk = Math.min(1, k), e = kk < .5 ? 2 * kk * kk : 1 - Math.pow(-2 * kk + 2, 2) / 2;
    const f = e * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f)), r = f - i;
    const p = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * r, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * r];
    m.setLatLng(p);
    const A = map.latLngToContainerPoint(pts[i]), B = map.latLngToContainerPoint(pts[i + 1]);
    const ang = Math.atan2(B.y - A.y, B.x - A.x) * 180 / Math.PI + 90;
    const svg = m.getElement() && m.getElement().querySelector('svg');
    if (svg) svg.style.transform = `rotate(${ang}deg)`;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- Data ----------
let RUNWAYS = [], HUBS = [];
const dataReady = (async () => {
  try {
    const c = await fetchT('coverage.json', 4000);
    if (c.ok) { const j = await c.json(); if (j.hubs && j.usable) STATS = j; }
  } catch (_) { /* keep defaults */ }
  const r = await fetch('runways_3600.json');
  RUNWAYS = await r.json();
  HUBS = RUNWAYS.filter(x => x.hub);
  buildDots();
  applyStats();
})();
function applyStats() {
  $('covPct').textContent = Math.round(STATS.hubs.w10);
  $('covMed').textContent = STATS.hubs.median.toFixed(1);
}
function buildDots() {
  for (const r of RUNWAYS) {
    if (r.hub) continue;
    L.circleMarker([r.lat, r.lon], { renderer: canvas, radius: 2, stroke: false, fillColor: '#19E6C1', fillOpacity: 0.55, interactive: false }).addTo(layers.dots);
  }
  for (const h of HUBS) {
    L.circleMarker([h.lat, h.lon], { renderer: canvas, radius: 4.2, color: '#FF9F43', weight: 2, fillColor: '#FFFFFF', fillOpacity: 1, interactive: false }).addTo(layers.dots);
  }
}
function setDotsOpacity(o) {
  layers.dots.eachLayer(l => l.setStyle(l.options.radius > 3 ? { opacity: Math.min(1, o + .2), fillOpacity: Math.min(1, o + .2) } : { fillOpacity: o }));
}

// ---------- Geocoding (Nominatim → offline gazetteer fallback) ----------
const geoCache = new Map();
let lastNominatim = 0;
function gazetteer(q) {
  const s = q.toLowerCase().replace(/[^a-z0-9, ]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = new Set(s.split(/[ ,]+/));
  let best = null;
  for (const [city, st, lat, lon] of window.GAZETTEER || []) {
    const c = city.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s.includes(c)) continue;
    const score = c.length + (words.has(st.toLowerCase()) ? 100 : 0);
    if (!best || score > best.score) best = { score, lat, lon, label: `${city}, ${st}` };
  }
  return best && { lat: best.lat, lon: best.lon, label: best.label, src: 'offline gazetteer' };
}
async function geocode(q) {
  q = q.trim();
  if (!q) throw new Error('Please enter an address.');
  if (geoCache.has(q)) return geoCache.get(q);
  let res = DEMO ? gazetteer(q) : null;
  if (!res) {
    try {
      const wait = 1100 - (Date.now() - lastNominatim);
      if (wait > 0) await sleep(wait);
      lastNominatim = Date.now();
      const r = await fetchT(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}`, 6000, { headers: { 'Accept-Language': 'en' } });
      if (r.ok) {
        const j = await r.json();
        if (j.length) {
          const parts = j[0].display_name.split(',').map(s => s.trim());
          res = { lat: +j[0].lat, lon: +j[0].lon, label: parts.slice(0, 3).join(', '), src: 'Nominatim' };
        }
      }
    } catch (_) { /* fall through to gazetteer */ }
  }
  if (!res) res = gazetteer(q);
  if (!res) throw new Error(`Couldn't find “${q}”. Try a US city and state, e.g. “Kalamazoo, MI”.`);
  geoCache.set(q, res);
  return res;
}

// ---------- Routing (OSRM → great-circle fallback) ----------
async function driveRoute(a, b) {
  try {
    const r = await fetchT(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=simplified&geometries=geojson`, DEMO ? 5000 : 8000);
    if (r.ok) {
      const j = await r.json();
      if (j.code === 'Ok' && j.routes && j.routes.length) {
        const rt = j.routes[0];
        const mi = rt.distance / 1609.344;
        return { min: mi / K.DRIVE_MPH * 60, mi, geom: rt.geometry.coordinates.map(([x, y]) => [y, x]), src: `OSRM road distance @ ${K.DRIVE_MPH} mph` };
      }
    }
  } catch (_) { /* fallback below */ }
  const mi = hav(a.lat, a.lon, b.lat, b.lon) * K.DRIVE_DETOUR;
  return { min: mi / K.DRIVE_MPH * 60, mi, geom: null, src: `estimate (great-circle × ${K.DRIVE_DETOUR} @ ${K.DRIVE_MPH} mph)` };
}
const localDrive = gc => { const mi = gc * K.LOCAL_DETOUR; return { mi, min: mi / K.LOCAL_MPH * 60 }; };

// ---------- Tabs ----------
let currentTab = 'find';
function moveInk() {
  const btn = document.querySelector('.tab.active'), ink = $('tabInk');
  if (!btn) return;
  ink.style.left = btn.offsetLeft + 'px'; ink.style.width = btn.offsetWidth + 'px';
  ink.style.top = btn.offsetTop + 'px'; ink.style.height = btn.offsetHeight + 'px';
}
function showTab(name) {
  currentTab = name;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + name));
  moveInk();
  for (const k of ['find', 'trip', 'cov', 'routes']) map.removeLayer(layers[k]);
  const lk = name === 'coverage' ? 'cov' : name;
  layers[lk].addTo(map);
  setDotsOpacity(name === 'coverage' ? (covMode === 'future' ? 0.9 : 0.3) : name === 'routes' ? 0.25 : 0.4);
  if (name === 'coverage') {
    map.flyToBounds(US_BOUNDS, { paddingTopLeft: [600, 130], paddingBottomRight: [70, 40], duration: 1.4 });
    if (!covInit) setCoverage('today', true);
  } else if (name === 'routes') { fitRoutes(); }
  else if (layers[lk].getLayers().length === 0) map.flyToBounds(US_BOUNDS, { paddingTopLeft: [600, 130], paddingBottomRight: [70, 40], duration: 1.2 });
  else if (layers[lk]._bounds) fit(layers[lk]._bounds);
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
addEventListener('resize', moveInk);
document.fonts && document.fonts.ready.then(moveInk);
setTimeout(moveInk, 50);

function setStatus(id, msg, err = false) {
  const el = $(id); el.className = 'status' + (err ? ' err' : '');
  el.innerHTML = msg;
}
const spin = t => `<span class="spin"></span>${t}`;

// ---------- Tab 1: Find My Runway ----------
async function doFind(q) {
  setStatus('findStatus', spin('Locating…'));
  $('findGo').disabled = true;
  try {
    await dataReady;
    const home = await geocode(q);
    const rw = nearest(RUNWAYS, home.lat, home.lon), hub = nearest(HUBS, home.lat, home.lon);
    const rwDrive = localDrive(rw.d).min, hubDrive = localDrive(hub.d).min;
    setStatus('findStatus', `📍 ${esc(home.label)} <span style="opacity:.6">· via ${home.src}</span>`);
    $('findHeadline').innerHTML = `Your runway next door is <span class="t">${fmtMi(rw.d)} mi</span> away, versus <span class="o">${fmtMi(hub.d)} mi</span> to the hub.`;
    $('rwName').textContent = rw.p.n;
    $('rwMeta').textContent = `${titleCase(rw.p.c)}, ${rw.p.s} · ${shortName(rw.p)}`;
    $('rwDist').textContent = fmtMi(rw.d);
    $('rwLen').textContent = rw.p.rw.toLocaleString();
    $('rwDrive').textContent = Math.max(1, Math.round(rwDrive));
    const b = $('rwBadge');
    if (rw.p.hub) { b.className = 'badge'; b.textContent = 'This is a large hub — lucky you'; }
    else if (rw.p.sched) { b.className = 'badge'; b.textContent = 'Limited airline service today'; }
    else { b.className = 'badge none'; b.textContent = 'No airline service today — ready for the NX-30'; }
    $('hubName').textContent = `${hub.p.n} (${shortName(hub.p)})`;
    $('hubDist').textContent = fmtMi(hub.d);
    $('hubDrive').textContent = Math.round(hubDrive);
    $('hubRatio').textContent = (hub.d / Math.max(rw.d, 0.1)).toFixed(1) + '×';
    const res = $('findResult'); res.classList.add('hidden'); void res.offsetWidth; res.classList.remove('hidden');

    const L1 = layers.find; L1.clearLayers();
    const H = [home.lat, home.lon], Rp = [rw.p.lat, rw.p.lon], Hb = [hub.p.lat, hub.p.lon];
    L1._bounds = [H, Rp, Hb];
    if (currentTab === 'find') fit(L1._bounds);
    await sleep(900);
    drawLine(L1, densify(H, Hb), { color: '#FF9F43', weight: 2.5, opacity: .85, dashArray: '6 8' }, 1400);
    drawLine(L1, densify(H, Rp), { color: '#19E6C1', weight: 10, opacity: .18 }, 1100);
    drawLine(L1, densify(H, Rp), { color: '#19E6C1', weight: 3.5, opacity: 1 }, 1100);
    label(L.marker(Hb, { icon: pulseIcon('#FF9F43', 18) }).addTo(L1), `<b>${fmtMi(hub.d)} mi</b> · ${esc(shortName(hub.p))} hub`, 'o');
    label(L.marker(Rp, { icon: pulseIcon('#19E6C1', 22), zIndexOffset: 500 }).addTo(L1), `<b>${fmtMi(rw.d)} mi</b> · ${esc(shortName(rw.p))} · ${rw.p.rw.toLocaleString()} ft`);
    label(L.marker(H, { icon: pinIcon('⌂'), zIndexOffset: 800 }).addTo(L1), 'Home', 'w', 'left', [-16, -18]);
  } catch (e) {
    setStatus('findStatus', esc(e.message), true);
  } finally { $('findGo').disabled = false; }
}
$('findForm').addEventListener('submit', e => { e.preventDefault(); doFind($('findInput').value); });

// ---------- Tab 2: Plan a 2050 Trip ----------
async function doTrip(qa, qb) {
  setStatus('tripStatus', spin('Geocoding & routing…'));
  $('tripGo').disabled = true;
  try {
    await dataReady;
    const A = await geocode(qa), B = await geocode(qb);
    setStatus('tripStatus', spin('Routing the drive (OSRM)…'));
    const drive = await driveRoute(A, B);
    drive.co2 = drive.mi * K.CO2_CAR;

    // Hub airline (today)
    const hA = nearest(HUBS, A.lat, A.lon), hB = nearest(HUBS, B.lat, B.lon);
    const hubGc = hav(hA.p.lat, hA.p.lon, hB.p.lat, hB.p.lon);
    const hgA = localDrive(hA.d), hgB = localDrive(hB.d);
    const hub = { na: hA.p === hB.p || hubGc < K.HUB_MIN_GC, gc: hubGc, a: hA, b: hB };
    hub.reason = hA.p === hB.p ? `both ends map to ${shortName(hA.p)}` : `${shortName(hA.p)}–${shortName(hB.p)} hubs only ${Math.round(hubGc)} mi apart`;
    hub.flight = hubGc / K.HUB_MPH * 60 + K.HUB_OVERHEAD;
    hub.min = hgA.min + K.HUB_PROCESS + hub.flight + K.HUB_DEPLANE + hgB.min;
    hub.co2 = K.CO2_AIR * hubGc + K.CO2_CAR * (hgA.mi + hgB.mi);

    // Runway Next Door (2050)
    const rA = nearest(RUNWAYS, A.lat, A.lon), rB = nearest(RUNWAYS, B.lat, B.lon);
    const nxGc = hav(rA.p.lat, rA.p.lon, rB.p.lat, rB.p.lon);
    const rgA = localDrive(rA.d), rgB = localDrive(rB.d);
    const nx = { na: rA.p === rB.p, gc: nxGc, a: rA, b: rB };
    nx.flight = nxGc / K.NX_MPH * 60 + K.NX_OVERHEAD;
    nx.min = rgA.min + K.NX_CURB + nx.flight + K.NX_DEPLANE + rgB.min;
    nx.ground = K.CO2_CAR * (rgA.mi + rgB.mi);
    nx.co2_2035 = K.CO2_AIR * K.HYBRID_FACTOR * nxGc + nx.ground;

    setStatus('tripStatus', `🛫 ${esc(A.label.split(',')[0])} → ${esc(B.label.split(',')[0])} <span style="opacity:.6">· geocoded via ${A.src} · drive via ${drive.src}</span>`);

    const today = hub.na ? drive.min : Math.min(drive.min, hub.min);
    const todayName = hub.na || drive.min <= hub.min ? 'driving' : 'the hub airline';
    if (nx.na) {
      $('saveVal').textContent = 'Just drive';
      $('saveSub').textContent = `Both addresses share the same runway next door (${shortName(rA.p)}).`;
    } else {
      const s = today - nx.min;
      $('saveVal').textContent = s > 0 ? fmtT(s) : '—';
      $('saveSub').innerHTML = s > 0
        ? `door to door vs. ${todayName} — ${fmtT(nx.min)} instead of ${fmtT(today)}`
        : `For this short trip, driving is still fastest.`;
    }
    const max = Math.max(drive.min, hub.na ? 0 : hub.min, nx.na ? 0 : nx.min);
    const row = (cls, name, sub, min, legs, na, naText) => `
      <div class="bar ${cls}${na ? ' na' : ''}">
        <div class="bar-top"><div class="bar-l">${name} <small>${sub}</small></div><div class="bar-v">${na ? naText : fmtT(min)}</div></div>
        <div class="track"><div class="fill" data-w="${na ? 0 : (min / max * 100).toFixed(1)}"></div></div>
        <div class="legs">${legs}</div>
      </div>`;
    const m = x => `<i>${Math.max(1, Math.round(x))}</i>`;
    $('bars').innerHTML =
      row('drive', '🚗 Drive', 'today', drive.min, `${Math.round(drive.mi)} ${drive.geom ? 'road' : 'est. road'} mi · ${drive.src}`) +
      row('hub', '✈️ Hub airline', 'today', hub.min, hub.na
        ? `No practical flight — ${hub.reason}`
        : `${m(hgA.min)} drive to ${shortName(hA.p)} + ${m(K.HUB_PROCESS)} security/boarding + ${m(hub.flight)} flight + ${m(K.HUB_DEPLANE)} bags + ${m(hgB.min)} drive from ${shortName(hB.p)}`,
        hub.na, 'N/A') +
      row('rnd', '◆ Runway Next Door', '2050 · NX-30', nx.min, nx.na
        ? `Same runway at both ends — no flight needed`
        : `${m(rgA.min)} drive to ${shortName(rA.p)} + ${m(K.NX_CURB)} curb-to-seat + ${m(nx.flight)} flight (${Math.round(nxGc)} mi) + ${m(K.NX_DEPLANE)} deplane + ${m(rgB.min)} drive from ${shortName(rB.p)}`,
        nx.na, 'N/A');
    $('co2').innerHTML = `
      <div class="h">CO₂ per passenger, door to door</div>
      <div class="c"><b>${fmtKg(drive.co2)} kg</b><span>🚗 Drive (1 occupant)</span></div>
      <div class="c o"><b>${hub.na ? 'N/A' : fmtKg(hub.co2) + ' kg'}</b><span>✈️ Hub airline today</span></div>
      <div class="c t"><b>${nx.na ? 'N/A' : fmtKg(nx.co2_2035) + ' kg'}</b><span>NX-30 · 2035 hybrid (−30% fuel)</span></div>
      <div class="c g"><b>≈ 0 kg</b><span>NX-30 · 2050 H₂-electric/SAF flight${nx.na ? '' : ` (+${fmtKg(nx.ground)} kg ground legs)`}</span></div>`;
    const res = $('tripResult'); res.classList.add('hidden'); void res.offsetWidth; res.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.querySelectorAll('#bars .fill').forEach((f, i) => setTimeout(() => f.style.width = f.dataset.w + '%', 150 + i * 250));
    }));

    // Map
    const T = layers.trip; T.clearLayers(); planeAnim++;
    const Ap = [A.lat, A.lon], Bp = [B.lat, B.lon], RA = [rA.p.lat, rA.p.lon], RB = [rB.p.lat, rB.p.lon];
    T._bounds = [Ap, Bp, RA, RB];
    if (drive.geom) T._bounds = T._bounds.concat(drive.geom.filter((_, i) => i % 10 === 0));
    if (currentTab === 'trip') fit(T._bounds, 10);
    await sleep(800);
    const dpts = drive.geom || densify(Ap, Bp);
    drawLine(T, dpts, { color: '#9fb2cc', weight: 3, opacity: .7, dashArray: '2 7', lineCap: 'round' }, 2000);
    if (!hub.na) {
      label(L.circleMarker([hA.p.lat, hA.p.lon], { radius: 6, color: '#FF9F43', weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(T), `${esc(shortName(hA.p))} hub`, 'o', 'left', [-10, 0]);
      label(L.circleMarker([hB.p.lat, hB.p.lon], { radius: 6, color: '#FF9F43', weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(T), `${esc(shortName(hB.p))} hub`, 'o', 'left', [-10, 0]);
      drawLine(T, arcPts([hA.p.lat, hA.p.lon], [hB.p.lat, hB.p.lon], -0.12), { color: '#FF9F43', weight: 2, opacity: .6, dashArray: '6 8' }, 1800);
    }
    if (!nx.na) {
      drawLine(T, densify(Ap, RA, 10), { color: '#19E6C1', weight: 3, opacity: .9, dashArray: '4 6' }, 600);
      const arc = arcPts(RA, RB, 0.2);
      setTimeout(() => {
        drawLine(T, arc, { color: '#19E6C1', weight: 12, opacity: .16 }, 1600);
        drawLine(T, arc, { color: '#7ff5e0', weight: 3.5, opacity: 1 }, 1600);
      }, 500);
      setTimeout(() => { drawLine(T, densify(RB, Bp, 10), { color: '#19E6C1', weight: 3, opacity: .9, dashArray: '4 6' }, 600); flyPlane(T, arc); }, 2100);
      label(L.marker(RA, { icon: pulseIcon('#19E6C1', 20), zIndexOffset: 500 }).addTo(T), `<b>${esc(shortName(rA.p))}</b> · ${fmtMi(rA.d)} mi from A`, '', 'right', [14, 0]);
      label(L.marker(RB, { icon: pulseIcon('#19E6C1', 20), zIndexOffset: 500 }).addTo(T), `<b>${esc(shortName(rB.p))}</b> · ${fmtMi(rB.d)} mi from B`, '', 'right', [14, 0]);
      const mid = arc[Math.floor(arc.length / 2)];
      setTimeout(() => label(L.marker(mid, { icon: L.divIcon({ className: '', iconSize: [0, 0] }), interactive: false }).addTo(T),
        `NX-30 · <b>${Math.round(nxGc)} mi</b> · ${Math.round(nx.flight)} min`, '', 'top', [0, -12]), 1800);
    }
    label(L.marker(Ap, { icon: pinIcon('A'), zIndexOffset: 800 }).addTo(T), esc(A.label.split(',')[0]), 'w', 'left', [-16, -18]);
    label(L.marker(Bp, { icon: pinIcon('B', '#FF9F43'), zIndexOffset: 800 }).addTo(T), esc(B.label.split(',')[0]), 'w', 'left', [-16, -18]);
  } catch (e) {
    setStatus('tripStatus', esc(e.message), true);
  } finally { $('tripGo').disabled = false; }
}
$('tripForm').addEventListener('submit', e => { e.preventDefault(); doTrip($('fromInput').value, $('toInput').value); });

// ---------- Tab 3: Coverage ----------
let covInit = false, covMode = null, covGen = 0;
async function setCoverage(mode, instant = false) {
  await dataReady;
  covInit = true;
  if (mode === covMode) return;
  const prev = covMode; covMode = mode;
  const gen = ++covGen;
  const fut = mode === 'future';
  $('covToggle').classList.toggle('future', fut);
  $('covToggle').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelector('.counter').classList.toggle('future', fut);
  $('covWhat').textContent = fut ? 'a usable paved runway' : 'a large hub airport';
  const from = fut ? STATS.hubs : STATS.usable, to = fut ? STATS.usable : STATS.hubs;
  const ms = instant || !prev ? 0 : 2200;
  if (ms) {
    animateNum($('covPct'), Math.round(from.w10), Math.round(to.w10), ms);
    animateNum($('covMed'), from.median, to.median, ms, 1);
    animateNum($('covN'), from.n, to.n, ms);
  } else {
    $('covPct').textContent = Math.round(to.w10); $('covMed').textContent = to.median.toFixed(1); $('covN').textContent = to.n.toLocaleString();
  }
  $('covBar').style.transition = `width ${ms}ms cubic-bezier(.2,.8,.2,1), background .6s`;
  $('covBar').style.width = to.w10 + '%';

  if (currentTab === 'coverage') setDotsOpacity(fut ? 0.9 : 0.3);
  const C = layers.cov; C.clearLayers();
  const list = fut ? RUNWAYS.slice().sort(() => Math.random() - .5) : HUBS;
  const style = r => r.hub
    ? { renderer: covCanvas, radius: 16093, stroke: true, color: '#FFB46B', weight: 1.2, opacity: .9, fillColor: '#FF9F43', fillOpacity: fut ? .3 : .45, interactive: false }
    : { renderer: covCanvas, radius: 16093, stroke: true, color: '#19E6C1', weight: 1, opacity: .55, fillColor: '#19E6C1', fillOpacity: .28, interactive: false };
  if (!ms) { for (const r of list) L.circle([r.lat, r.lon], style(r)).addTo(C); return; }
  const batches = 40, per = Math.ceil(list.length / batches);
  for (let i = 0; i < batches && gen === covGen; i++) {
    for (const r of list.slice(i * per, (i + 1) * per)) L.circle([r.lat, r.lon], style(r)).addTo(C);
    await sleep(ms / batches * 0.8);
  }
}
$('covToggle').querySelectorAll('button').forEach(b => b.addEventListener('click', () => setCoverage(b.dataset.mode)));

// ---------- Tab 4: 50 Routes Nobody Flies (optional data) ----------
let ROUTES = null, routeArcs = [];
(async () => {
  try {
    const r = await fetchT('routes_top50.json', 5000, { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (!Array.isArray(j) || !j.length) return;
    ROUTES = j.slice(0, 50);
    buildRoutes();
    $('routesTabBtn').classList.remove('hidden');
    moveInk();
  } catch (_) { /* optional file absent — tab stays hidden */ }
})();
function buildRoutes() {
  const list = $('routesList'); list.innerHTML = '';
  const R = layers.routes;
  const hrs = m => m == null ? '—' : fmtT(m);
  const hm = m => m == null ? 'N/A' : `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, '0')}`;
  ROUTES.forEach((rt, i) => {
    const A = [rt.a.lat, rt.a.lon], B = [rt.b.lat, rt.b.lon];
    const arc = arcPts(A, B, 0.18, 50);
    const glow = L.polyline(arc, { color: '#19E6C1', weight: 8, opacity: 0.06 }).addTo(R);
    const line = L.polyline(arc, { color: '#19E6C1', weight: 1.8, opacity: Math.max(.35, 1 - i / 60) }).addTo(R);
    L.circleMarker(A, { radius: 3.5, stroke: false, fillColor: '#7ff5e0', fillOpacity: 1 }).addTo(R);
    L.circleMarker(B, { radius: 3.5, stroke: false, fillColor: '#7ff5e0', fillOpacity: 1 }).addTo(R);
    routeArcs.push({ line, glow, arc, rt });
    const el = document.createElement('div');
    el.className = 'route';
    el.innerHTML = `<div class="rk">${rt.rank ?? i + 1}</div>
      <div class="nm">${esc(titleCase(rt.a.c))}, ${esc(rt.a.s)} ↔ ${esc(titleCase(rt.b.c))}, ${esc(rt.b.s)}
        <small>${esc(rt.a.id)}–${esc(rt.b.id)} · ${Math.round(rt.gc_mi)} mi${rt.road_mi != null ? ` (${Math.round(rt.road_mi)} by road)` : ''} · drive ${hm(rt.drive_min)} · hub ${hm(rt.hub_min)} · NX-30 ${hm(rt.rnd_min)}</small></div>
      <div class="sv">${hrs(rt.saved_min)}<small>saved</small></div>`;
    el.addEventListener('click', () => selectRoute(i));
    line.on('click', () => selectRoute(i));
    list.appendChild(el);
  });
}
function selectRoute(i) {
  document.querySelectorAll('.route').forEach((e, j) => e.classList.toggle('sel', j === i));
  routeArcs.forEach((r, j) => {
    r.line.setStyle(j === i ? { color: '#FFFFFF', weight: 3.5, opacity: 1 } : { color: '#19E6C1', weight: 1.8, opacity: .3 });
    r.glow.setStyle({ opacity: j === i ? .35 : .04 });
    if (j === i) { r.glow.bringToFront(); r.line.bringToFront(); }
  });
  fit(routeArcs[i].arc, 8);
  document.querySelectorAll('.route')[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function fitRoutes() {
  if (!routeArcs.length) return;
  fit(routeArcs.flatMap(r => [r.arc[0], r.arc[r.arc.length - 1]]), 6);
}

// ---------- Demo mode (?demo=1) ----------
function caption(step, text) {
  const c = $('caption');
  if (!text) { c.classList.add('hidden'); return; }
  $('capStep').textContent = step; $('capText').innerHTML = text;
  c.classList.add('hidden'); void c.offsetWidth; c.classList.remove('hidden');
}
async function typeInto(input, text, cps = 11) {
  input.focus(); input.value = ''; input.classList.add('typing');
  for (const ch of text) { input.value += ch; await sleep(1000 / cps + (Math.random() * 40 - 20)); }
  await sleep(250); input.classList.remove('typing');
}
async function press(btn) { btn.classList.add('pressed'); await sleep(180); btn.classList.remove('pressed'); }
async function runDemo() {
  await dataReady;
  await sleep(1500);
  caption('STEP 1', 'Find my runway next door');
  await sleep(900);
  await typeInto($('findInput'), 'Kalamazoo, MI');
  await press($('findGo'));
  await doFind($('findInput').value);
  await sleep(7500);

  caption('STEP 2', 'Plan a 2050 trip — Kalamazoo to Madison, around Lake Michigan');
  showTab('trip');
  await sleep(1100);
  await typeInto($('fromInput'), 'Kalamazoo, MI');
  await typeInto($('toInput'), 'Madison, WI');
  await press($('tripGo'));
  await doTrip($('fromInput').value, $('toInput').value);
  await sleep(4500);
  caption('STEP 2', 'No practical airline today. The NX-30 flies straight across the lake.');
  await sleep(6000);

  caption('STEP 3', 'Coverage — today: 95 hubs');
  showTab('coverage');
  await sleep(3200);
  caption('STEP 3', '2050: every usable runway becomes an airport');
  const fb = document.querySelector('#covToggle [data-mode="future"]');
  await press(fb);
  setCoverage('future');
  await sleep(4500);
  caption('2050', `<b style="color:#19E6C1">${Math.round(STATS.usable.w10)}%</b>&nbsp;of Americans already live within 10 miles of their runway next door.`);
  await sleep(6500);
  window.__demoDone = true;
}
if (DEMO) runDemo();
window.RND = { doFind, doTrip, showTab, setCoverage, geocode };
})();
