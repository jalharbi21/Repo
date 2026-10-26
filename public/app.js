// Page logic: route search, the combined result panel, the map, and in-app navigation.
// Google Maps and Apple Maps are only data sources here; the app picks the fastest route itself.
import { fetchGoogleRoutes, fetchAppleRoutes, demoRoutes, mergeRoutes } from "./providers.js";
import { createTracker, pointAt, bearingDeg } from "./nav.js";

const $ = (s) => document.querySelector(s);
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
const state = {
  mode: "drive",
  opts: { avoidTolls: false, avoidHighways: false },
  server: null,     // config from our own server, when the page runs on it
  result: null,     // { routes, notes, google, apple, origin, destination, demo }
  selected: 0,
  demo: true,
};

// ---------------------------------------------------------------- formatting
const IMPERIAL = /^en-(US|GB|LR|MM)\b/i.test(navigator.language || "en-US");
const fmtDur = (s) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`;
};
function fmtDist(m) {
  if (IMPERIAL) {
    const mi = m / 1609.344;
    if (mi >= 0.1) return `${mi >= 10 ? Math.round(mi) : mi.toFixed(1)} mi`;
    return `${Math.max(10, Math.round((m * 3.28084) / 10) * 10)} ft`;
  }
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}
function roundedDist(m) {
  if (IMPERIAL) return m / 1609.344 >= 0.1 ? fmtDist(m) : `${Math.max(50, Math.round((m * 3.28084) / 50) * 50)} ft`;
  return fmtDist(m >= 1000 ? m : m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10);
}
const arriveAt = (s) => new Date(Date.now() + s * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const money = (t) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: t.currency }).format(t.amount); }
  catch { return `${t.amount.toFixed(2)} ${t.currency}`; }
};
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------------------------------------------------------------- icons
const ICONS = {
  straight: ["M12 20V5", "M6 11l6-6 6 6"],
  depart: ["M12 20V5", "M6 11l6-6 6 6"],
  left: ["M17 20v-7a3 3 0 0 0-3-3H6", "M10 6l-4 4 4 4"],
  right: ["M7 20v-7a3 3 0 0 1 3-3h8", "M14 6l4 4-4 4"],
  "slight-left": ["M15 20v-6L8 7", "M8 13V7h6"],
  "slight-right": ["M9 20v-6l7-7", "M10 7h6v6"],
  "sharp-left": ["M16 4v8L7 18", "M7 12v6h6"],
  "sharp-right": ["M8 4v8l9 6", "M17 12v6h-6"],
  uturn: ["M16 20V9a4 4 0 0 0-8 0v5", "M5 11l3 3 3-3"],
  roundabout: ["M12 21v-7", "M16 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0", "M16 10h4", "M18 8l2 2-2 2"],
  merge: ["M8 20v-5l4-4V4", "M16 20v-5l-4-4", "M8 8l4-4 4 4"],
  arrive: ["M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z", "M14 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0"],
  ferry: ["M3 18c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0", "M5 15l1-5h12l1 5", "M9 10V6h6v4"],
  toll: ["M12 3v18", "M16 7.5c0-1.9-1.8-3-4-3s-4 1.1-4 3 1.8 2.6 4 3 4 1.3 4 3.2-1.8 3-4 3-4-1.1-4-3"],
  check: ["M5 12l5 5 9-10"],
  go: ["M12 3l7 18-7-4-7 4z"],
  traffic: ["M12 7v5l3 3", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
};
const icon = (m, w = 2.4) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(ICONS[m] || ICONS.straight).map((d) => `<path d="${d}"/>`).join("")}</svg>`;

// ---------------------------------------------------------------- map
let map, routeLayer, baseTiles = null, vectorBase = null;
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : darkQuery.matches;
};

function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: true }).setView([40.70, -73.88], 12);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.attributionControl.setPrefix(false);
  routeLayer = L.layerGroup().addTo(map);
  useRasterTiles();
}

// Street map tiles. Where the page can't load them (for example on claude.ai, which blocks
// outside images), fall back to the built-in vector map of the sample trip's area.
function useRasterTiles() {
  baseTiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, className: "osm-tiles",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  let loaded = 0, failed = 0;
  baseTiles.on("tileload", () => loaded++);
  baseTiles.on("tileerror", () => {
    failed++;
    if (!loaded && failed >= 2 && !vectorBase) switchToVectorBase();
  });
  baseTiles.addTo(map);
}

async function switchToVectorBase() {
  if (baseTiles) { map.removeLayer(baseTiles); baseTiles = null; }
  try {
    const data = await (await fetch("demo-basemap.json")).json();
    vectorBase = buildVectorBase(data);
    vectorBase.addTo(map);
    map.attributionControl.addAttribution(`Map data ${data.attribution}`);
    const note = $("#map-note");
    note.textContent = "This page can't load live map tiles here, so it shows a built-in map of the sample trip's area. Run the app yourself for maps everywhere.";
    note.hidden = false;
    setTimeout(() => (note.hidden = true), 12000);
  } catch {
    /* no fallback map available; routes still draw on a plain background */
  }
}

function decode(arr) {
  const out = [];
  let a = 0, b = 0;
  for (let i = 0; i < arr.length; i += 2) {
    a += arr[i]; b += arr[i + 1];
    out.push([a / 1e5, b / 1e5]);
  }
  return out;
}

function buildVectorBase(data) {
  const pane = map.createPane("base");
  pane.style.zIndex = 200;
  const renderer = L.canvas({ pane: "base", padding: 0.3 });
  const L_ = data.layers;
  const group = L.layerGroup();
  const poly = (k, color) => L_[k]?.length &&
    // A hairline stroke in the fill color hides seams where the source tiles were cut.
    L.polygon(L_[k].map((p) => p.map(decode)), { renderer, pane: "base", color: cssVar(color), weight: 1, fillColor: cssVar(color), fillOpacity: 1, fillRule: "nonzero", interactive: false }).addTo(group);
  const line = (k) => L_[k]?.length && L.polyline(L_[k].map(decode), { renderer, pane: "base", interactive: false, lineCap: "round", lineJoin: "round" }).addTo(group);
  // Wider, simpler layer for the surroundings, then full detail around the trip.
  poly("lo_park", "--park");
  poly("lo_water", "--water");
  const loMajor = line("lo_road_major");
  const loHwy = line("lo_road_hwy");
  poly("park", "--park");
  poly("aero_poly", "--aero");
  poly("water", "--water");
  const roads = {
    aero: line("aero_line"),
    minor: line("road_minor"),
    mid: line("road_mid"),
    majorCase: line("road_major"),
    major: line("road_major"),
    hwyCase: line("road_hwy"),
    hwy: line("road_hwy"),
    tunnel: line("road_tunnel"),
  };
  const labels = L.layerGroup(
    (data.labels || []).map(([name, , pt]) =>
      L.marker(pt, { interactive: false, keyboard: false, icon: L.divIcon({ className: "nb-label", html: `<span>${esc(name)}</span>`, iconSize: [0, 0] }) })
    )
  );
  function restyle() {
    const z = map.getZoom();
    const w = (base) => Math.min(base * 2.6, Math.max(0.5, base * Math.pow(1.6, z - 14)));
    const set = (l, o) => l && l.setStyle(o);
    set(loMajor, { color: cssVar("--road-major"), weight: w(3), opacity: 1 });
    set(loHwy, { color: cssVar("--road-hwy"), weight: w(4.5), opacity: 1 });
    set(roads.aero, { color: cssVar("--aero"), weight: w(6), opacity: 1 });
    set(roads.minor, { color: cssVar("--road-minor"), weight: w(2.2), opacity: z >= 13 ? 1 : 0 });
    set(roads.mid, { color: cssVar("--road-mid"), weight: w(3), opacity: 1 });
    set(roads.majorCase, { color: cssVar("--road-case"), weight: w(4.6) + 1.5, opacity: 1 });
    set(roads.major, { color: cssVar("--road-major"), weight: w(4.6), opacity: 1 });
    set(roads.hwyCase, { color: cssVar("--road-case"), weight: w(6) + 2, opacity: 1 });
    set(roads.hwy, { color: cssVar("--road-hwy"), weight: w(6), opacity: 1 });
    set(roads.tunnel, { color: cssVar("--road-hwy"), weight: w(4), opacity: 0.6, dashArray: "4 6" });
    if (z >= 13 && !group.hasLayer(labels)) group.addLayer(labels);
    if (z < 13 && group.hasLayer(labels)) group.removeLayer(labels);
  }
  map.on("zoomend", restyle);
  restyle();
  return group;
}

const PIN = (fill) => `<svg viewBox="0 0 30 38" aria-hidden="true"><path d="M15 37s12-11.3 12-21A12 12 0 0 0 3 16c0 9.7 12 21 12 21z" fill="${fill}" stroke="#fff" stroke-width="2"/><circle cx="15" cy="16" r="4.5" fill="#fff"/></svg>`;

function drawRoutes(fit = false) {
  routeLayer.clearLayers();
  const routes = state.result?.routes || [];
  if (!routes.length) return;
  const accent = cssVar("--accent"), alt = cssVar("--alt-route"), casing = isDark() ? "#0b0e12" : "#ffffff";
  // Alternatives first (underneath), then the selected route on top.
  routes.forEach((r, i) => {
    if (i === state.selected || !r.path.length) return;
    L.polyline(r.path, { color: casing, weight: 9, opacity: 0.9 }).addTo(routeLayer);
    L.polyline(r.path, { color: alt, weight: 6, opacity: 1 })
      .bindTooltip(`${fmtDur(r.durationSec)} · ${esc(r.name)}`, { sticky: true })
      .on("click", () => select(i))
      .addTo(routeLayer);
  });
  const sel = routes[state.selected];
  L.polyline(sel.path, { color: casing, weight: 11, opacity: 1, interactive: false }).addTo(routeLayer);
  L.polyline(sel.path, { color: accent, weight: 7, opacity: 1, interactive: false }).addTo(routeLayer);
  L.circleMarker(sel.path[0], { radius: 7, color: "#fff", weight: 3, fillColor: accent, fillOpacity: 1 }).bindTooltip("Start").addTo(routeLayer);
  L.marker(sel.path.at(-1), { icon: L.divIcon({ className: "pin", html: PIN(cssVar("--ink")), iconSize: [30, 38], iconAnchor: [15, 37] }) })
    .bindTooltip("Destination").addTo(routeLayer);
  if (fit) {
    const all = L.latLngBounds(routes.flatMap((r) => r.path));
    const wide = innerWidth > 760;
    map.fitBounds(all, { paddingTopLeft: [wide ? 430 : 24, 40], paddingBottomRight: [40, 40] });
  }
}

// ---------------------------------------------------------------- result panel
function tollChip(r) {
  if (r.hasTolls) {
    const price = r.toll ? `${r.toll.estimated ? "~" : ""}${money(r.toll)} toll` : "Toll road";
    return `<span class="chip toll">${icon("toll", 2.6)}${price}</span>`;
  }
  return `<span class="chip free">${icon("check", 3)}No tolls</span>`;
}

function renderResult() {
  const el = $("#result");
  const res = state.result;
  renderSources();
  if (!res) { el.innerHTML = `<p class="empty">Enter a start and destination to find the fastest route.</p>`; return; }
  if (!res.routes.length) {
    const errs = ["google", "apple"].map((p) => res[p] && !res[p].ok ? `<p class="err">${p === "google" ? "Google Maps" : "Apple Maps"}: ${esc(res[p].error)}</p>` : "").join("");
    el.innerHTML = `<p class="empty">No route found.</p>${errs}`;
    drawRoutes();
    return;
  }
  const r = res.routes[state.selected];
  const fastest = res.routes[0];
  const label = state.selected === 0 ? "Fastest route" : `${fmtDur(r.durationSec - fastest.durationSec)} slower than fastest`;
  const steps = r.steps.map((s) => `<li>${icon(s.maneuver)}<span>${esc(s.instruction)}</span><span class="sd">${fmtDist(s.distanceM)}</span></li>`).join("");
  el.innerHTML = `
    <div class="best">
      <div class="eyebrow">${label}${state.demo ? " · sample trip" : ""}</div>
      <div class="eta"><b>${fmtDur(r.durationSec)}</b><span>${fmtDist(r.distanceM)} · arrive ${arriveAt(r.durationSec)}</span></div>
      <div class="via">${esc(r.name)}</div>
      <div class="chips">${tollChip(r)}${r.trafficDelaySec >= 60 ? `<span class="chip">${icon("traffic", 2.4)}+${fmtDur(r.trafficDelaySec)} traffic</span>` : ""}</div>
      ${(r.warnings || []).map((w) => `<p class="note">${esc(w)}</p>`).join("")}
      <button type="button" class="go start" id="start-nav">${icon("go", 2.6)}Start</button>
    </div>
    ${res.routes.length > 1 ? `<div class="routes" role="list" aria-label="All routes">
      ${res.routes.map((x, i) => `
        <button type="button" class="rt" data-i="${i}" aria-pressed="${i === state.selected}">
          <span class="t">${fmtDur(x.durationSec)}</span>
          <span class="v">${esc(x.name)}</span>
          <span class="c">${tollChip(x)}</span>
          <span class="d">${i === 0 ? "fastest" : `+${fmtDur(x.durationSec - fastest.durationSec)}`}</span>
        </button>`).join("")}
    </div>` : ""}
    ${(res.notes || []).map((n) => `<p class="note warn">${esc(n)}</p>`).join("")}
    ${steps ? `<details class="steps"><summary>${r.steps.length} steps · ${fmtDist(r.distanceM)}</summary><ol>${steps}</ol></details>` : ""}`;
  drawRoutes();
}

function renderSources() {
  const res = state.result;
  const set = (p, name) => {
    const el = $(`#src-${p}`);
    if (state.demo) { el.className = ""; el.textContent = name; return; }
    const ok = res?.[p]?.ok;
    el.className = ok ? "on" : "off";
    el.textContent = name;
    el.title = ok ? `${name} answered` : res?.[p]?.error || `${name} not set up`;
  };
  set("google", "Google");
  set("apple", "Apple");
  $("#foot-text").textContent = state.demo
    ? "Sample trip. Add keys for live routes from Google Maps and Apple Maps."
    : "Checks Google Maps and Apple Maps, then picks the fastest.";
}

function select(i) {
  state.selected = i;
  renderResult();
}

document.addEventListener("click", (e) => {
  const rt = e.target.closest(".rt");
  if (rt) return select(Number(rt.dataset.i));
  if (e.target.closest("#start-nav")) startNavigation();
});

// ---------------------------------------------------------------- data
const SAMPLE = { origin: "Times Square, New York", destination: "JFK Airport, Terminal 5" };

async function settle(promise) {
  try { return { ok: true, ...(await promise) }; } catch (err) { return { ok: false, error: friendly(err) }; }
}
function friendly(err) {
  const msg = err?.message || String(err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return "Couldn't reach the service from this page. Hosted pages on claude.ai can't call outside services; run the app on your computer (see the README) for live routes.";
  }
  return msg;
}

async function lookUp(origin, destination) {
  const mode = state.mode;
  const opts = mode === "drive" ? state.opts : { avoidTolls: false, avoidHighways: false };
  if (state.demo) {
    const d = await demoRoutes(opts);
    return { ...d, ...mergeRoutes(d, opts) };
  }
  if (state.server) {
    const res = await fetch("api/routes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin, destination, mode, ...opts }),
    });
    return res.json();
  }
  const gKey = store.get("nav.googleKey"), aTok = store.get("nav.appleToken");
  const [google, apple] = await Promise.all([
    gKey ? settle(fetchGoogleRoutes({ apiKey: gKey, origin, destination, mode, ...opts })) : { ok: false, error: "No Google Maps key added yet (key button, top right)." },
    aTok ? settle(fetchAppleRoutes({ authToken: aTok, origin, destination, mode, ...opts })) : { ok: false, error: "No Apple Maps token added yet (key button, top right)." },
  ]);
  return { origin, destination, mode, google, apple, ...mergeRoutes({ google, apple }, opts) };
}

async function search({ fit = true } = {}) {
  const origin = $("#origin").value.trim(), destination = $("#destination").value.trim();
  if (!origin || !destination) return;
  const go = $("#go");
  go.disabled = true;
  go.textContent = "Checking Google and Apple…";
  try {
    const res = await lookUp(origin, destination);
    state.result = { origin, destination, ...res };
    state.selected = 0;
    renderResult();
    drawRoutes(fit);
  } catch (err) {
    $("#result").innerHTML = `<p class="err">${esc(friendly(err))}</p>`;
  } finally {
    go.disabled = false;
    go.textContent = "Find route";
  }
}

function showSample() {
  state.demo = true;
  $("#origin").value = SAMPLE.origin;
  $("#destination").value = SAMPLE.destination;
  search();
}

$("#trip").addEventListener("submit", (e) => {
  e.preventDefault();
  const o = $("#origin").value.trim(), d = $("#destination").value.trim();
  state.demo = o === SAMPLE.origin && d === SAMPLE.destination;
  search();
});
$("#swap").addEventListener("click", () => {
  const o = $("#origin"), d = $("#destination");
  [o.value, d.value] = [d.value, o.value];
});
document.querySelectorAll(".modes button").forEach((b) =>
  b.addEventListener("click", () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll(".modes button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    const driving = state.mode === "drive";
    for (const id of ["opt-tolls", "opt-highways"]) {
      $(`#${id}`).disabled = !driving;
      $(`#${id}`).closest(".switch").classList.toggle("disabled", !driving);
    }
    if (state.result && !state.demo) search();
  })
);
for (const [id, key] of [["opt-tolls", "avoidTolls"], ["opt-highways", "avoidHighways"]]) {
  $(`#${id}`).addEventListener("change", (e) => {
    state.opts[key] = e.target.checked;
    store.set(`nav.${key}`, e.target.checked ? "1" : "");
    if (state.result) search();
  });
}

// ---------------------------------------------------------------- keys dialog
$("#open-keys").addEventListener("click", () => {
  $("#keys-mode-note").textContent = state.server
    ? "This app is running on your own server, which reads the keys from its .env file. Edit .env and restart to change them."
    : "Paste your keys to get live routes straight from this browser. On claude.ai the page can only show the sample trip, because hosted pages can't call outside services.";
  $("#k-google").value = store.get("nav.googleKey");
  $("#k-apple").value = store.get("nav.appleToken");
  $("#keys").showModal();
});
$("#keys-form").addEventListener("submit", () => {
  store.set("nav.googleKey", $("#k-google").value.trim());
  store.set("nav.appleToken", $("#k-apple").value.trim());
});
$("#k-clear").addEventListener("click", () => {
  $("#k-google").value = ""; $("#k-apple").value = "";
  store.set("nav.googleKey", ""); store.set("nav.appleToken", "");
});
$("#k-demo").addEventListener("click", () => { $("#keys").close(); showSample(); });

// ---------------------------------------------------------------- navigation
const ARROW = `<svg viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="15" fill="#fff"/><circle cx="17" cy="17" r="12" fill="var(--accent)"/><path d="M17 5l6 20-6-3.2-6 3.2z" fill="#fff"/></svg>`;
const nav = {
  on: false, route: null, tracker: null, destination: "", source: "sim", simAlong: 0, lastAlong: 0, simTimer: null,
  watchId: null, speed: 4, voice: store.get("nav.voice") !== "off", follow: true, rerouting: false, lastFix: null,
  layer: null, wakeLock: null, sourceNote: "",
};

function speak(lines) {
  if (!nav.voice || !lines.length || !("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    for (const t of lines) speechSynthesis.speak(new SpeechSynthesisUtterance(t));
  } catch {}
}

function startNavigation() {
  const r = state.result?.routes?.[state.selected];
  if (!r?.path.length || !r.steps.length) return;
  Object.assign(nav, { on: true, route: r, destination: state.result.destination, follow: true, rerouting: false, lastFix: null, lastAlong: 0, sourceNote: "" });
  nav.tracker = createTracker(r, { imperial: IMPERIAL });
  document.body.classList.add("navigating");
  map.invalidateSize();
  routeLayer.clearLayers();
  nav.layer = L.layerGroup().addTo(map);
  map.on("dragstart", onDrag);
  try { navigator.wakeLock?.request("screen").then((w) => (nav.wakeLock = w)).catch(() => {}); } catch {}
  renderStepList();
  setVoiceBtn();
  useSource(state.demo ? "sim" : "gps");
  scrollTo(0, 0);
}

function onDrag() { nav.follow = false; $("#recenter").hidden = false; }
$("#recenter-btn").addEventListener("click", () => {
  nav.follow = true;
  $("#recenter").hidden = true;
  if (nav.lastFix) map.setView(nav.lastFix, 17);
});

function stopPosition() {
  clearInterval(nav.simTimer);
  nav.simTimer = null;
  if (nav.watchId != null) navigator.geolocation?.clearWatch(nav.watchId);
  nav.watchId = null;
}

function useSource(source) {
  stopPosition();
  nav.source = source;
  $("#nav-pos").textContent = source === "gps" ? "Simulate" : "Use GPS";
  $("#nav-speed").hidden = source !== "sim";
  if (source === "gps") {
    if (!navigator.geolocation) return gpsFailed("This browser can't share your location.");
    $("#turn-instr").textContent = "Finding your location…";
    nav.watchId = navigator.geolocation.watchPosition(
      (p) => onFix([p.coords.latitude, p.coords.longitude], p.coords.heading),
      (e) => gpsFailed(e.code === 1 ? "Location permission was refused." : "Couldn't get your location."),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  } else {
    const n = nav.tracker.nav;
    const mps = n.total / Math.max(60, n.durationSec);
    nav.simAlong = nav.lastAlong || 0;
    const tick = () => {
      nav.simAlong = Math.min(n.total, nav.simAlong + mps * nav.speed * 0.5);
      const pt = pointAt(n, nav.simAlong);
      onFix(pt.point, pt.heading);
      if (nav.simAlong >= n.total) clearInterval(nav.simTimer);
    };
    tick();
    nav.simTimer = setInterval(tick, 500);
  }
}

function gpsFailed(why) {
  nav.sourceNote = `${why} Showing a simulated drive instead.`;
  useSource("sim");
}

function onFix(pos, heading) {
  if (!nav.on) return;
  const u = nav.tracker.update(pos);
  nav.lastAlong = nav.tracker.nav.total - u.remainingM;
  const prev = nav.lastFix;
  nav.lastFix = pos;
  const hdg = Number.isFinite(heading) ? heading : prev ? bearingDeg(prev, pos) : 0;
  drawNav(u, pos, hdg);
  renderNav(u);
  speak(u.announce);
  if (u.needsReroute && !nav.rerouting && nav.source === "gps") reroute(pos);
  if (u.arrived) stopPosition();
}

function drawNav(u, pos, hdg) {
  const n = nav.tracker.nav;
  const g = nav.layer;
  g.clearLayers();
  const split = pointAt(n, n.total - u.remainingM);
  const done = n.path.slice(0, split.segIdx + 1).concat([split.point]);
  const ahead = [split.point].concat(n.path.slice(split.segIdx + 1));
  const casing = isDark() ? "#0b0e12" : "#ffffff";
  L.polyline(done, { color: cssVar("--alt-route"), weight: 7, opacity: 0.8, interactive: false }).addTo(g);
  L.polyline(ahead, { color: casing, weight: 12, opacity: 1, interactive: false }).addTo(g);
  L.polyline(ahead, { color: cssVar("--accent"), weight: 8, opacity: 1, interactive: false }).addTo(g);
  L.marker(n.path.at(-1), { icon: L.divIcon({ className: "pin", html: PIN(cssVar("--ink")), iconSize: [30, 38], iconAnchor: [15, 37] }), interactive: false }).addTo(g);
  const at = u.offBy > 45 ? pos : u.snapped;
  // One position marker for the whole trip, moved and turned on each fix.
  if (!nav.me) {
    nav.me = L.marker(at, { icon: L.divIcon({ className: "me", html: ARROW, iconSize: [34, 34], iconAnchor: [17, 17] }), interactive: false, zIndexOffset: 1000 });
  }
  nav.me.setLatLng(at);
  if (!map.hasLayer(nav.me)) nav.me.addTo(map);
  const svg = nav.me.getElement()?.querySelector("svg");
  if (svg) svg.style.transform = `rotate(${Math.round(hdg)}deg)`;
  if (nav.follow) map.setView(at, Math.max(map.getZoom(), 16), { animate: true });
}

function renderNav(u) {
  const off = u.offBy > 45 && !u.arrived;
  $("#turn").classList.toggle("off", off);
  if (u.arrived) {
    $("#turn-icon").innerHTML = icon("arrive");
    $("#turn-dist").textContent = "You've arrived";
    $("#turn-instr").textContent = nav.destination;
    $("#turn-then").innerHTML = "";
  } else if (off) {
    $("#turn-icon").innerHTML = icon("uturn");
    $("#turn-dist").textContent = `${fmtDist(u.offBy)} off route`;
    $("#turn-instr").textContent = nav.rerouting ? "Finding a new route…" : "Head back to the blue line";
    $("#turn-then").innerHTML = "";
  } else {
    $("#turn-icon").innerHTML = icon(u.next ? u.next.maneuver : "arrive");
    $("#turn-dist").textContent = roundedDist(u.toNextM);
    $("#turn-instr").textContent = u.next ? u.next.instruction : `Arrive at ${nav.destination}`;
    const after = nav.tracker.nav.steps[u.stepIdx + 2];
    $("#turn-then").innerHTML = after ? `Then ${icon(after.maneuver)}<span>${esc(after.instruction)}</span>` : u.next ? "Then you arrive" : "";
  }
  $("#nav-left").textContent = fmtDur(u.remainingSec);
  $("#nav-meta").textContent = `${fmtDist(u.remainingM)} · ${arriveAt(u.remainingSec)}`;
  $("#nav-street").textContent = u.current?.street ? `On ${u.current.street}` : "";
  const toll = nav.route.hasTolls ? ` · ${nav.route.toll ? money(nav.route.toll) + " toll" : "toll road"}` : "";
  $("#nav-source").textContent = nav.sourceNote ||
    `${nav.source === "gps" ? "Live GPS" : `Simulated drive at ${nav.speed}×`}${toll}`;
  document.querySelectorAll("#nav-steplist li").forEach((li, i) => {
    li.className = i < u.stepIdx ? "done" : i === u.stepIdx ? "now" : "";
  });
}

function renderStepList() {
  $("#nav-steplist").innerHTML = nav.tracker.nav.steps.map((s) => `<li>${esc(s.instruction)}</li>`).join("");
}

async function reroute(pos) {
  nav.rerouting = true;
  try {
    const res = await lookUp(`${pos[0].toFixed(6)},${pos[1].toFixed(6)}`, nav.destination);
    const best = res.routes?.[0];
    if (best?.steps.length && nav.on) {
      nav.route = best;
      nav.tracker = createTracker(best, { imperial: IMPERIAL });
      nav.lastAlong = 0;
      renderStepList();
      speak(["Route updated"]);
    }
  } catch {}
  setTimeout(() => (nav.rerouting = false), 8000);
}

function endNavigation() {
  stopPosition();
  nav.on = false;
  try { speechSynthesis.cancel(); } catch {}
  try { nav.wakeLock?.release(); } catch {}
  document.body.classList.remove("navigating");
  $("#recenter").hidden = true;
  map.off("dragstart", onDrag);
  nav.layer?.remove();
  nav.me?.remove();
  map.invalidateSize();
  renderResult();
  drawRoutes(true);
}

function setVoiceBtn() {
  const b = $("#nav-voice");
  b.setAttribute("aria-pressed", String(nav.voice));
  b.textContent = nav.voice ? "Voice on" : "Voice off";
}
$("#nav-voice").addEventListener("click", () => {
  nav.voice = !nav.voice;
  store.set("nav.voice", nav.voice ? "" : "off");
  if (!nav.voice) try { speechSynthesis.cancel(); } catch {}
  setVoiceBtn();
});
$("#nav-pos").addEventListener("click", () => {
  nav.sourceNote = "";
  useSource(nav.source === "gps" ? "sim" : "gps");
});
$("#nav-speed").addEventListener("click", () => {
  const speeds = [1, 4, 10];
  nav.speed = speeds[(speeds.indexOf(nav.speed) + 1) % speeds.length];
  $("#nav-speed").textContent = `Speed ${nav.speed}×`;
});
$("#nav-steps").addEventListener("click", () => {
  const list = $("#nav-steplist");
  list.hidden = !list.hidden;
  $("#nav-steps").setAttribute("aria-pressed", String(!list.hidden));
});
$("#nav-end").addEventListener("click", endNavigation);

// ---------------------------------------------------------------- boot
async function boot() {
  initMap();
  state.opts.avoidTolls = store.get("nav.avoidTolls") === "1";
  state.opts.avoidHighways = store.get("nav.avoidHighways") === "1";
  $("#opt-tolls").checked = state.opts.avoidTolls;
  $("#opt-highways").checked = state.opts.avoidHighways;
  try {
    const res = await fetch("api/config", { cache: "no-store" });
    if (res.ok && (res.headers.get("content-type") || "").includes("json")) state.server = await res.json();
  } catch {}
  showSample();
}
boot();
