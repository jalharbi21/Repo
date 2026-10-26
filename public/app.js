// Page logic: the home screen and its sections (search, place pages, saved places, trips, settings),
// route planning across Google Maps and Apple Maps, the map, and in-app turn-by-turn navigation.
// Google and Apple are only data sources here; the app picks the fastest route itself.
import { fetchGoogleRoutes, fetchAppleRoutes, getAppleAccessToken, demoRoutes, demoPlaceRoutes, mergeRoutes, parseLatLng } from "./providers.js";
import {
  CATEGORIES, CHIPS, fetchGooglePlaces, fetchApplePlaces, fetchGoogleSuggest, fetchAppleSuggest, fetchAppleReverse,
  mergePlaces, mergeSuggestions, loadDemoPlaces, searchDemoPlaces, findDemoPlace, nearestDemoPlace, openStatus, hoursTable, metresBetween,
} from "./places.js";
import { createLibrary, monthStats, suggestedShortcut, placeKey } from "./library.js";
import { createTracker, pointAt, bearingDeg } from "./nav.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const store = {
  get(k) { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
};
let storage = null;
try { storage = localStorage; } catch {}
const lib = createLibrary(storage);
const S = () => lib.data.settings;

const SAMPLE_HERE = { id: "here", name: "Times Square", address: "Sample location · Broadway & 7th Ave", at: [40.758, -73.98551] };
const state = {
  mode: "drive",
  opts: { avoidTolls: false, avoidHighways: false },
  when: { kind: "now", at: "" }, // now | depart | arrive
  server: null,     // config from our own server, when the page runs on it
  forceDemo: false,
  catalog: null,    // sample places
  here: null,       // { at, name, address } – the sample location, or your GPS position
  trip: { from: null, to: null }, // { label, q, place }
  result: null,     // { routes, notes, google, apple, origin, destination, demo }
  selected: 0,
  place: null,      // place on the place page
  results: [],      // last search results
  lastQuery: "",
  view: "home",
  back: [],
};

// ---------------------------------------------------------------- formatting
const imperial = () => S().units === "mi" || (S().units === "auto" && /^en-(US|GB|LR|MM)\b/i.test(navigator.language || "en-US"));
const fmtDur = (s) => {
  const m = Math.max(1, Math.round(s / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`;
};
function fmtDist(m) {
  if (imperial()) {
    const mi = m / 1609.344;
    if (mi >= 0.1) return `${mi >= 10 ? Math.round(mi) : mi.toFixed(1)} mi`;
    return `${Math.max(10, Math.round((m * 3.28084) / 10) * 10)} ft`;
  }
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`;
}
function roundedDist(m) {
  if (imperial()) return m / 1609.344 >= 0.1 ? fmtDist(m) : `${Math.max(50, Math.round((m * 3.28084) / 50) * 50)} ft`;
  return fmtDist(m >= 1000 ? m : m >= 100 ? Math.round(m / 50) * 50 : Math.round(m / 10) * 10);
}
const clock = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const startTime = () => (state.when.kind === "depart" && state.when.at ? new Date(state.when.at) : new Date());
const arriveAt = (s, from = new Date()) => clock(new Date(from.getTime() + s * 1000));
const money = (t) => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: t.currency }).format(t.amount); }
  catch { return `${t.amount.toFixed(2)} ${t.currency}`; }
};
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fmtLatLng = (at) => `${at[0].toFixed(5)}, ${at[1].toFixed(5)}`;

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
  search: ["M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z", "M21 21l-5-5"],
  home: ["M3 11l9-8 9 8", "M5 10v10h14V10", "M10 20v-6h4v6"],
  work: ["M4 7h16v13H4z", "M9 7V4h6v3", "M4 13h16"],
  star: ["M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.5 6.7 19.4l1.2-6L3.4 9.3l6-.7z"],
  flag: ["M5 21V4", "M5 4h12l-2 4 2 4H5"],
  list: ["M8 6h13M8 12h13M8 18h13", "M3.5 6h.01M3.5 12h.01M3.5 18h.01"],
  back: ["M15 18l-6-6 6-6"],
  close: ["M6 6l12 12M18 6L6 18"],
  share: ["M12 3v13", "M7 8l5-5 5 5", "M5 13v7h14v-7"],
  phone: ["M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"],
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M3 12h18", "M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"],
  bookmark: ["M6 3h12v18l-6-4-6 4z"],
  locate: ["M12 2v3M12 19v3M2 12h3M19 12h3", "M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z", "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"],
  plus: ["M12 5v14M5 12h14"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  gear: ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.8 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3.1 14H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.8 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 20.9 10H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
  chart: ["M4 20V10M10 20V4M16 20v-7", "M2 20h20"],
  explore: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M15.5 8.5l-2 5-5 2 2-5z"],
  report: ["M12 3l10 18H2z", "M12 10v5", "M12 18h.01"],
  food: ["M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10", "M17 3c-2 2-2 6 0 8v10"],
  coffee: ["M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z", "M16 11h2a2 2 0 0 1 0 4h-2", "M8 3v3M12 3v3"],
  gas: ["M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16", "M3 21h12", "M4 10h10", "M14 8l3 3v6a1.5 1.5 0 0 0 3 0V8l-3-3"],
  ev: ["M13 2L5 13h6l-1 9 8-11h-6z"],
  parking: ["M4 4h16v16H4z", "M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"],
  grocery: ["M3 4h2l2.5 11h10L20 7H6.2", "M9 20h.01M17 20h.01"],
  pharmacy: ["M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"],
  hotel: ["M3 18V6", "M3 14h18v4", "M21 14v-3a3 3 0 0 0-3-3h-7v6", "M7 11h.01"],
  park: ["M12 22v-6", "M12 2l7 10h-4l4 5H5l4-5H5z"],
  museum: ["M3 21h18M4 10h16M12 3l9 5H3z", "M6 10v8M10 10v8M14 10v8M18 10v8"],
  landmark: ["M4 8h3l2-3h6l2 3h3v11H4z", "M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0"],
  transit: ["M6 4h12v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z", "M6 11h12", "M8 21l2-4M16 21l-2-4"],
  airport: ["M10 21l2-1 2 1v-2l-1.5-1V13l8 3v-2l-8-5V4a1.5 1.5 0 0 0-3 0v5l-8 5v2l8-3v5L8 19z"],
  venue: ["M9 18V5l11-2v13", "M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0", "M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0"],
  address: ["M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10z", "M14 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0"],
  clock: ["M12 7v5l3 3", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0"],
};
const icon = (m, w = 2.4) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(ICONS[m] || ICONS.straight).map((d) => `<path d="${d}"/>`).join("")}</svg>`;
const catIcon = (c) => icon(ICONS[c] ? c : "address", 2);

// ---------------------------------------------------------------- theme
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => {
  const t = document.documentElement.getAttribute("data-theme");
  return t ? t === "dark" : darkQuery.matches;
};
function applyTheme() {
  const t = S().theme;
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  if (map) { drawRoutes(); drawPlaces(); vectorBase?.restyle?.(); }
}
darkQuery.addEventListener?.("change", () => { if (map) { drawRoutes(); drawPlaces(); vectorBase?.restyle?.(); } });

// ---------------------------------------------------------------- map
let map, routeLayer, placeLayer, hereLayer, reportLayer, baseTiles = null, vectorBase = null;

function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: true }).setView([40.73, -73.95], 12);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.attributionControl.setPrefix(false);
  reportLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  placeLayer = L.layerGroup().addTo(map);
  hereLayer = L.layerGroup().addTo(map);
  useRasterTiles();
  // Long-press (touch) or right-click drops a pin.
  map.on("contextmenu", (e) => { if (!nav.on) dropPin([e.latlng.lat, e.latlng.lng]); });
}

// Street map tiles. Where the page can't load them (for example on claude.ai, which blocks
// outside images), fall back to the built-in vector map of the sample area.
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
  vectorBase = { loading: true };
  try {
    const data = await (await fetch("demo-basemap.json")).json();
    vectorBase = buildVectorBase(data);
    vectorBase.addTo(map);
    map.attributionControl.addAttribution(`Map data ${data.attribution}`);
    toast("This page can't load live map tiles here, so it shows a built-in map of New York. Run the app yourself for maps everywhere.", 9000);
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
  const polys = [];
  const poly = (k, color) => {
    if (!L_[k]?.length) return;
    // A hairline stroke in the fill color hides seams where the source tiles were cut.
    const p = L.polygon(L_[k].map((x) => x.map(decode)), { renderer, pane: "base", weight: 1, fillOpacity: 1, fillRule: "nonzero", interactive: false }).addTo(group);
    polys.push([p, color]);
  };
  const line = (k) => L_[k]?.length && L.polyline(L_[k].map(decode), { renderer, pane: "base", interactive: false, lineCap: "round", lineJoin: "round" }).addTo(group);
  // Wider, simpler layer for the surroundings, then full detail around the sample area.
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
    for (const [p, c] of polys) p.setStyle({ color: cssVar(c), fillColor: cssVar(c) });
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
  group.restyle = restyle;
  return group;
}

const PIN = (fill, glyph = "") => `<svg viewBox="0 0 30 38" aria-hidden="true"><path d="M15 37s12-11.3 12-21A12 12 0 0 0 3 16c0 9.7 12 21 12 21z" fill="${fill}" stroke="#fff" stroke-width="2"/>${glyph || '<circle cx="15" cy="16" r="4.5" fill="#fff"/>'}</svg>`;
const placePin = (p, selected) => {
  const c = selected ? cssVar("--accent") : cssVar("--pin");
  const glyph = `<g transform="translate(8 9) scale(.58)" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${(ICONS[p.category] || ICONS.address).map((d) => `<path d="${d}"/>`).join("")}</g>`;
  return L.divIcon({ className: `pin${selected ? " sel" : ""}`, html: PIN(c, glyph), iconSize: [30, 38], iconAnchor: [15, 37] });
};

function drawHere() {
  hereLayer.clearLayers();
  if (!state.here || nav.on) return;
  L.circleMarker(state.here.at, { radius: 16, stroke: false, fillColor: cssVar("--accent"), fillOpacity: 0.15, interactive: false }).addTo(hereLayer);
  L.circleMarker(state.here.at, { radius: 7, color: "#fff", weight: 3, fillColor: cssVar("--accent"), fillOpacity: 1 })
    .bindTooltip(state.here.sample ? "Sample location" : "You are here").addTo(hereLayer);
}

// Search results or a single place, as pins.
function drawPlaces() {
  placeLayer.clearLayers();
  if (nav.on) return;
  const showList = state.view === "search" ? state.results : state.view === "place" && state.place ? [state.place] : state.view === "saved" ? state.savedPins || [] : [];
  for (const p of showList) {
    if (!p.at?.[0]) continue;
    const sel = state.place && placeKey(state.place) === placeKey(p);
    L.marker(p.at, { icon: placePin(p, sel), zIndexOffset: sel ? 500 : 0, title: p.name })
      .bindTooltip(esc(p.name))
      .on("click", () => openPlace(p))
      .addTo(placeLayer);
  }
}

const REPORTS = { crash: "Crash", hazard: "Hazard", police: "Police", slowdown: "Slowdown" };
function drawReports() {
  reportLayer.clearLayers();
  for (const r of lib.activeReports()) {
    L.marker(r.at, { icon: L.divIcon({ className: "report-pin", html: `<span>${icon("report", 2.4)}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }) })
      .bindTooltip(`${REPORTS[r.kind] || "Report"} · reported ${fmtDur((Date.now() - r.time) / 1000)} ago`).addTo(reportLayer);
  }
}

const wide = () => innerWidth > 760;
function fitTo(points, maxZoom = 16) {
  if (!points.length) return;
  const b = L.latLngBounds(points);
  map.fitBounds(b, { paddingTopLeft: [wide() ? 440 : 24, 40], paddingBottomRight: [40, 40], maxZoom });
}

function drawRoutes(fit = false) {
  routeLayer.clearLayers();
  if (state.view !== "dir") return;
  const routes = state.result?.routes || [];
  if (!routes.length) return;
  const accent = cssVar("--accent"), alt = cssVar("--alt-route"), casing = isDark() ? "#0b0e12" : "#ffffff";
  // Alternatives first (underneath), then the selected route on top.
  routes.forEach((r, i) => {
    if (i === state.selected || !r.path.length) return;
    L.polyline(r.path, { color: casing, weight: 9, opacity: 0.9 }).addTo(routeLayer);
    L.polyline(r.path, { color: alt, weight: 6, opacity: 1 })
      .bindTooltip(`${fmtDur(r.durationSec)} · ${esc(r.name)}`, { sticky: true })
      .on("click", () => selectRoute(i))
      .addTo(routeLayer);
  });
  const sel = routes[state.selected];
  L.polyline(sel.path, { color: casing, weight: 11, opacity: 1, interactive: false }).addTo(routeLayer);
  L.polyline(sel.path, { color: accent, weight: 7, opacity: 1, interactive: false }).addTo(routeLayer);
  L.circleMarker(sel.path[0], { radius: 7, color: "#fff", weight: 3, fillColor: accent, fillOpacity: 1 }).bindTooltip("Start").addTo(routeLayer);
  L.marker(sel.path.at(-1), { icon: L.divIcon({ className: "pin", html: PIN(cssVar("--ink")), iconSize: [30, 38], iconAnchor: [15, 37] }) })
    .bindTooltip("Destination").addTo(routeLayer);
  if (fit) fitTo(routes.flatMap((r) => r.path));
}

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(text, ms = 3500) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- data sources
const isLive = () => !state.forceDemo && (state.server ? Boolean(state.server.google || state.server.apple) : Boolean(store.get("nav.googleKey") || store.get("nav.appleToken")));

let appleTok = { token: "", until: 0 };
async function appleAccess() {
  if (appleTok.token && Date.now() < appleTok.until) return appleTok.token;
  const token = await getAppleAccessToken({ authToken: store.get("nav.appleToken") });
  appleTok = { token, until: Date.now() + 25 * 60 * 1000 };
  return token;
}

async function settle(promise) {
  try { return { ok: true, ...(await promise) }; } catch (err) { return { ok: false, error: friendly(err) }; }
}
function friendly(err) {
  const msg = err?.message || String(err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    return "Couldn't reach the service from this page. Hosted pages on claude.ai can't call outside services; run the app on your computer (see the README) for live data.";
  }
  return msg;
}
async function postJson(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}

// Places: both services, merged. In the sample, the built-in places.
async function findPlaces(query, category = null) {
  const near = state.here?.at || map.getCenter() && [map.getCenter().lat, map.getCenter().lng];
  if (!isLive()) return searchDemoPlaces(state.catalog, { query, category, near });
  const q = query || CATEGORIES[category]?.q || "";
  if (state.server) {
    const res = await postJson("api/places", { query: q, near });
    if (res.error) throw new Error(res.error);
    return res.places || [];
  }
  const gKey = store.get("nav.googleKey"), aTok = store.get("nav.appleToken");
  const [google, apple] = await Promise.all([
    gKey ? settle(fetchGooglePlaces({ apiKey: gKey, query: q, near })) : { ok: false },
    aTok ? settle(appleAccess().then((accessToken) => fetchApplePlaces({ accessToken, query: q, near }))) : { ok: false },
  ]);
  if (!google.ok && !apple.ok) throw new Error(google.error || apple.error || "No place search available");
  return mergePlaces({ google, apple }, near);
}

async function suggest(query) {
  const near = state.here?.at;
  if (!isLive()) return searchDemoPlaces(state.catalog, { query, near }).slice(0, 6).map((p) => ({ text: p.name, sub: p.address, place: p }));
  if (state.server) return (await postJson("api/places", { query, near, kind: "suggest" })).suggestions || [];
  const gKey = store.get("nav.googleKey"), aTok = store.get("nav.appleToken");
  const [google, apple] = await Promise.all([
    gKey ? settle(fetchGoogleSuggest({ apiKey: gKey, query, near })) : { ok: false },
    aTok ? settle(appleAccess().then((accessToken) => fetchAppleSuggest({ accessToken, query, near }))) : { ok: false },
  ]);
  return mergeSuggestions({ google, apple });
}

async function reverseLookup(at) {
  if (!isLive()) return "";
  try {
    if (state.server) return (await (await fetch(`api/reverse?at=${at[0]},${at[1]}`)).json()).address || "";
    if (store.get("nav.appleToken")) return await fetchAppleReverse({ accessToken: await appleAccess(), at });
  } catch {}
  return "";
}

// Routes between two stops. Each stop is { label, q, place }.
async function lookUp(from, to) {
  const mode = state.mode;
  const opts = mode === "drive" ? state.opts : { avoidTolls: false, avoidHighways: false };
  if (!isLive()) {
    const fromSample = !from || from.place?.id === "here" || (from.place?.at && metresBetween(from.place.at, SAMPLE_HERE.at) < 150);
    const id = to.place?.demo ? to.place.id : null;
    const d = fromSample && id ? await demoPlaceRoutes(id, { mode, ...opts }) : null;
    if (!d) return { demo: true, routes: [], notes: [], sampleOnly: true, noModeRoute: fromSample && id ? mode : null };
    return { ...d, ...mergeRoutes(d, opts) };
  }
  const departAt = state.when.kind === "depart" && state.when.at ? new Date(state.when.at).toISOString() : null;
  const origin = from.q, destination = to.q;
  if (state.server) return postJson("api/routes", { origin, destination, mode, departAt, ...opts });
  const gKey = store.get("nav.googleKey"), aTok = store.get("nav.appleToken");
  const [google, apple] = await Promise.all([
    gKey ? settle(fetchGoogleRoutes({ apiKey: gKey, origin, destination, mode, departAt, ...opts })) : { ok: false, error: "No Google Maps key added yet (key button, top right)." },
    aTok ? settle(fetchAppleRoutes({ accessToken: await appleAccess().catch(() => ""), authToken: aTok, origin, destination, mode, departAt, ...opts })) : { ok: false, error: "No Apple Maps token added yet (key button, top right)." },
  ]);
  return { origin, destination, mode, google, apple, ...mergeRoutes({ google, apple }, opts) };
}

const stopFor = (place) => place.id === "here"
  ? { label: "Your location", q: `${place.at[0].toFixed(6)},${place.at[1].toFixed(6)}`, place }
  : { label: place.name, q: place.demo || !place.at?.[0] ? place.name : `${place.at[0].toFixed(6)},${place.at[1].toFixed(6)}`, place };

// ---------------------------------------------------------------- views
const VIEWS = ["home", "search", "place", "dir", "saved", "trips", "settings"];
const TABS = { home: "home", search: "home", place: null, dir: null, saved: "saved", trips: "trips", settings: "settings" };

function show(view, { push = true } = {}) {
  if (push && state.view !== view) state.back.push(state.view);
  if (state.back.length > 20) state.back.shift();
  state.view = view;
  for (const v of VIEWS) $(`#v-${v}`).hidden = v !== view;
  $("#searchbar").hidden = !["home", "search"].includes(view);
  $("#sb-back").hidden = view !== "search";
  const tab = TABS[view];
  $$(".tabs button").forEach((b) => b.setAttribute("aria-current", String(b.dataset.tab === tab)));
  document.body.dataset.view = view;
  if (view === "home") renderHome();
  if (view === "saved") renderSaved();
  if (view === "trips") renderTrips();
  if (view === "settings") renderSettings();
  if (view !== "dir") routeLayer.clearLayers();
  drawPlaces();
  if (view !== "search" && view !== "home") $("#sheet-scroll").scrollTop = 0;
}
function goBack() {
  const prev = state.back.pop() || "home";
  show(prev, { push: false });
  if (prev === "dir") drawRoutes(true);
  if (prev === "search" && state.results.length) fitTo(state.results.map((p) => p.at));
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-back]")) goBack();
  const tab = e.target.closest(".tabs button");
  if (tab) { state.back = []; show(tab.dataset.tab, { push: false }); }
});

// ---- home
function greeting(now = new Date()) {
  const h = now.getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const etaCache = new Map(); // place key → { sec, via, at }
async function quickEta(place) {
  const k = placeKey(place);
  const hit = etaCache.get(k);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit;
  if (!state.here) return null;
  try {
    const res = await lookUp(stopFor({ ...state.here, id: "here" }), stopFor(place));
    const best = res.routes?.[0];
    if (!best) return null;
    const v = { sec: best.durationSec, via: best.name, at: Date.now(), toll: best.hasTolls };
    etaCache.set(k, v);
    return v;
  } catch { return null; }
}

function renderHome() {
  const d = lib.data;
  const near = state.here ? `${state.here.sample ? "Sample location: " : "Near "}${esc(state.here.name)}` : "Location off · tap the locate button on the map";
  const chips = CHIPS.map((c) => `<button type="button" class="chipbtn" data-cat="${c}">${catIcon(c)}${esc(CATEGORIES[c].label)}</button>`).join("");
  const short = (which, label, ico) => {
    const p = d[which];
    return `<button type="button" class="short" data-short="${which}">${`<span class="short-ic">${icon(ico, 2.2)}</span>`}<b>${label}</b><span class="short-sub" data-eta="${which}">${p ? "…" : "Add"}</span></button>`;
  };
  const favs = lib.list("favorites");
  const moment = suggestedShortcut(d, new Date(), state.here?.at, metresBetween);
  const stats = monthStats(d.trips);
  const recents = d.recents.slice(0, 5);
  $("#v-home").innerHTML = `
    <div class="hello"><h2>${greeting()}</h2><p>${near}</p></div>
    <div class="chiprow" role="list" aria-label="Find nearby">${chips}</div>
    <div class="shorts">
      ${short("home", "Home", "home")}
      ${short("work", "Work", "work")}
      <button type="button" class="short" data-open-list="favorites"><span class="short-ic">${icon("star", 2.2)}</span><b>Favorites</b><span class="short-sub">${favs?.places.length || 0} saved</span></button>
      <button type="button" class="short" data-tab-go="saved"><span class="short-ic">${icon("list", 2.2)}</span><b>Lists</b><span class="short-sub">${d.lists.length}</span></button>
    </div>
    ${moment ? `<button type="button" class="moment" data-short="${moment.which}">
      <span class="eyebrow">${esc(moment.why)}</span>
      <span class="moment-row"><b data-eta-big="${moment.which}">…</b><span>to ${esc(moment.which === "home" ? "Home" : "Work")} · <span data-eta-via="${moment.which}">checking both maps</span></span></span>
    </button>` : ""}
    <button type="button" class="ledger-mini" data-tab-go="trips">
      <span class="ledger-ic">${icon("chart", 2.2)}</span>
      <span><b>${stats.trips ? (stats.savedSec >= 60 ? `${fmtDur(stats.savedSec)} saved this month` : `${stats.trips} trip${stats.trips > 1 ? "s" : ""} this month`) : "Trip ledger"}</b>
      <span class="sub">${stats.trips ? `${fmtDist(stats.distanceM)} driven · see which map had the faster route each time` : "Every trip, the time you saved by checking Google and Apple, and the tolls you paid."}</span></span>
    </button>
    ${recents.length ? `<section class="block"><div class="block-h"><h3>Recent</h3><button type="button" class="link" id="clear-recents">Clear</button></div>
      <ul class="rows">${recents.map((r, i) => r.place
        ? `<li><button type="button" class="row" data-recent="${i}">${catIcon(r.place.category)}<span><b>${esc(r.place.name)}</b><span class="sub">${esc(r.place.address || "")}</span></span></button></li>`
        : `<li><button type="button" class="row" data-recent="${i}">${icon("clock", 2)}<span><b>${esc(r.query)}</b><span class="sub">Search</span></span></button></li>`).join("")}</ul></section>` : ""}
    <section class="block" id="explore"><div class="block-h"><h3>Explore nearby</h3>${isLive() ? "" : '<span class="tag">sample places</span>'}</div><div id="explore-body"></div></section>`;
  fillShortcutEtas(moment);
  renderExplore();
}

async function fillShortcutEtas(moment) {
  for (const which of ["home", "work"]) {
    const p = lib.data[which];
    const el = $(`[data-eta="${which}"]`);
    if (!p || !el) continue;
    // Live ETAs cost an API call, so only the suggested one is fetched on its own.
    if (isLive() && moment?.which !== which && !etaCache.has(placeKey(p))) { el.textContent = "Tap for ETA"; continue; }
    const eta = await quickEta(p);
    el.textContent = eta ? fmtDur(eta.sec) : (isLive() ? "Set" : "No sample route");
    if (moment?.which === which) {
      const big = $(`[data-eta-big="${which}"]`), via = $(`[data-eta-via="${which}"]`);
      if (big) big.textContent = eta ? fmtDur(eta.sec) : "–";
      if (via) via.textContent = eta ? `${eta.via}${eta.toll ? " · toll" : ""} · arrive ${arriveAt(eta.sec)}` : "no route found";
    }
  }
}

function renderExplore() {
  const body = $("#explore-body");
  if (!body) return;
  if (isLive()) {
    body.innerHTML = `<p class="empty">Pick a category above, or search. Places come from Google and Apple together; a check means both know the place.</p>`;
    return;
  }
  const here = state.here?.at || SAMPLE_HERE.at;
  const list = state.catalog.places.map((p) => findDemoPlace(state.catalog, p.id))
    .filter((p) => p.category !== "address" && p.category !== "airport")
    .map((p) => ({ ...p, distanceM: metresBetween(here, p.at), status: openStatus(p.hours) }))
    .filter((p) => p.status?.open !== false)
    .sort((a, b) => a.distanceM - b.distanceM).slice(0, 6);
  body.innerHTML = `<p class="sub small">Open now, closest first</p><ul class="rows">${list.map((p, i) => placeRow(p, i)).join("")}</ul>`;
  bindPlaceRows(body, list);
}

function sourceBadge(p) {
  const s = p.sources || [];
  if (s.includes("google") && s.includes("apple")) return `<span class="src2 both" title="Google Maps and Apple Maps both list this place">${icon("check", 3)}Google + Apple</span>`;
  if (s[0]) return `<span class="src2" title="Only one service lists this place">${s[0] === "google" ? "Google only" : "Apple only"}</span>`;
  return "";
}

function placeRow(p, i = 0) {
  const st = p.status || openStatus(p.hours) || (p.openNow == null ? null : { open: p.openNow, label: p.openNow ? "Open now" : "Closed now" });
  const bits = [p.kind || CATEGORIES[p.category]?.one, p.distanceM != null ? fmtDist(p.distanceM) : ""].filter(Boolean);
  return `<li><button type="button" class="row place-row" data-pi="${i}">${catIcon(p.category)}<span>
    <b>${esc(p.name)}</b>
    <span class="sub">${esc(bits.join(" · "))}${p.rating ? ` · ★ ${p.rating.toFixed(1)}` : ""}</span>
    <span class="sub">${st ? `<span class="${st.open ? (st.closingSoon ? "warnc" : "okc") : "badc"}">${esc(st.label)}</span>` : esc(p.address || "")}</span>
  </span>${sourceBadge(p)}</button></li>`;
}
function bindPlaceRows(root, list) {
  root.querySelectorAll("[data-pi]").forEach((b, i) => b.addEventListener("click", () => openPlace(list[Number(b.dataset.pi ?? i)])));
}

$("#v-home").addEventListener("click", (e) => {
  const cat = e.target.closest("[data-cat]");
  if (cat) return runSearch("", cat.dataset.cat);
  const sh = e.target.closest("[data-short]");
  if (sh) {
    const which = sh.dataset.short;
    const p = lib.data[which];
    if (!p) return pickShortcut(which);
    return planTo(p);
  }
  const ol = e.target.closest("[data-open-list]");
  if (ol) { show("saved"); return openList(ol.dataset.openList); }
  const tg = e.target.closest("[data-tab-go]");
  if (tg) { state.back = []; return show(tg.dataset.tabGo, { push: false }); }
  if (e.target.closest("#clear-recents")) { lib.clearRecents(); return renderHome(); }
  const rc = e.target.closest("[data-recent]");
  if (rc) {
    const r = lib.data.recents[Number(rc.dataset.recent)];
    if (r?.place) return openPlace(r.place);
    if (r?.query) { $("#q").value = r.query; return runSearch(r.query); }
  }
});

// Picking Home or Work: search, then "Set as Home" on the place page.
let picking = null;
function pickShortcut(which) {
  picking = which;
  $("#q").value = "";
  show("search");
  $("#q").placeholder = `Search for your ${which} address`;
  $("#q").focus();
  renderSuggestions("");
}

// ---- search
let suggestTimer = null, suggestSeq = 0;
$("#q").addEventListener("focus", () => { if (state.view === "home") { show("search"); renderSuggestions($("#q").value); } });
$("#q").addEventListener("input", () => {
  const v = $("#q").value;
  $("#sb-clear").hidden = !v;
  if (state.view !== "search") show("search");
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(() => renderSuggestions(v), isLive() ? 300 : 60);
});
$("#sb-clear").addEventListener("click", () => { $("#q").value = ""; $("#sb-clear").hidden = true; $("#q").focus(); renderSuggestions(""); });
$("#sb-back").addEventListener("click", () => { picking = null; $("#q").placeholder = "Search places, addresses or lat,lng"; $("#q").value = ""; $("#sb-clear").hidden = true; state.results = []; state.back = []; show("home", { push: false }); });
$("#searchbar").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#q").value.trim(); if (v) runSearch(v); });

async function renderSuggestions(text) {
  const seq = ++suggestSeq;
  const t = text.trim().toLowerCase();
  const el = $("#v-search");
  const saved = [lib.data.home && { ...lib.data.home, tag: "Home" }, lib.data.work && { ...lib.data.work, tag: "Work" }, ...lib.data.lists.flatMap((l) => l.places)]
    .filter(Boolean).filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i)
    .filter((p) => !t || p.name.toLowerCase().includes(t) || (p.address || "").toLowerCase().includes(t)).slice(0, 4);
  const recents = lib.data.recents.filter((r) => !t || (r.place?.name || r.query || "").toLowerCase().includes(t)).slice(0, t ? 3 : 6);
  const cats = t ? Object.entries(CATEGORIES).filter(([k, c]) => k !== "address" && (c.label.toLowerCase().startsWith(t) || c.words.some((w) => w.startsWith(t)))).slice(0, 2) : [];
  const ll = parseLatLng(text);
  const parts = [];
  if (picking) parts.push(`<p class="note">Search for a place, then choose <b>Set as ${picking === "home" ? "Home" : "Work"}</b>.</p>`);
  if (ll) parts.push(`<ul class="rows"><li><button type="button" class="row" data-ll="${ll.join(",")}">${icon("address", 2)}<span><b>${fmtLatLng(ll)}</b><span class="sub">Go to these coordinates</span></span></button></li></ul>`);
  if (cats.length) parts.push(`<ul class="rows">${cats.map(([k, c]) => `<li><button type="button" class="row" data-cat="${k}">${catIcon(k)}<span><b>${esc(c.label)}</b><span class="sub">Nearby</span></span></button></li>`).join("")}</ul>`);
  if (saved.length) parts.push(`<h4 class="mini-h">Saved</h4><ul class="rows">${saved.map((p, i) => `<li><button type="button" class="row" data-saved="${i}">${icon(p.tag === "Home" ? "home" : p.tag === "Work" ? "work" : "star", 2)}<span><b>${esc(p.tag || p.name)}</b><span class="sub">${esc(p.tag ? p.name : p.address || "")}</span></span></button></li>`).join("")}</ul>`);
  if (recents.length) parts.push(`<h4 class="mini-h">Recent</h4><ul class="rows">${recents.map((r, i) => `<li><button type="button" class="row" data-rec="${i}">${icon("clock", 2)}<span><b>${esc(r.place?.name || r.query)}</b><span class="sub">${esc(r.place?.address || "Search")}</span></span></button></li>`).join("")}</ul>`);
  const sugBox = `<div id="sug-live"></div>`;
  el.innerHTML = parts.join("") + sugBox + (!t && !recents.length && !saved.length ? `<p class="empty">Search for a place, an address, a category like "coffee", or paste lat,lng.</p>` : "");
  el.querySelectorAll("[data-saved]").forEach((b) => b.addEventListener("click", () => openPlace(saved[Number(b.dataset.saved)])));
  el.querySelectorAll("[data-rec]").forEach((b) => b.addEventListener("click", () => {
    const r = recents[Number(b.dataset.rec)];
    if (r.place) openPlace(r.place); else { $("#q").value = r.query; runSearch(r.query); }
  }));
  el.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => runSearch("", b.dataset.cat)));
  el.querySelectorAll("[data-ll]").forEach((b) => b.addEventListener("click", () => dropPin(b.dataset.ll.split(",").map(Number))));
  if (t.length < 2 || ll) return;
  try {
    const sug = await suggest(text);
    if (seq !== suggestSeq || !sug.length) return;
    const box = $("#sug-live");
    box.innerHTML = `<h4 class="mini-h">Suggestions</h4><ul class="rows">${sug.map((s, i) => `<li><button type="button" class="row" data-sug="${i}">${s.place ? catIcon(s.place.category) : icon("search", 2)}<span><b>${esc(s.text)}</b><span class="sub">${esc(s.sub)}</span></span></button></li>`).join("")}</ul>`;
    box.querySelectorAll("[data-sug]").forEach((b) => b.addEventListener("click", () => {
      const s = sug[Number(b.dataset.sug)];
      if (s.place) openPlace(s.place);
      else { const q = [s.text, s.sub].filter(Boolean).join(", "); $("#q").value = q; runSearch(q); }
    }));
  } catch {}
}

async function runSearch(query, category = null) {
  const label = query || CATEGORIES[category]?.label || "";
  $("#q").value = label;
  $("#sb-clear").hidden = !label;
  if (state.view !== "search") show("search");
  const el = $("#v-search");
  el.innerHTML = `<p class="empty">Searching${isLive() ? " Google and Apple" : ""}…</p>`;
  if (query) lib.addRecent({ query });
  try {
    const list = await findPlaces(query, category);
    state.results = list;
    state.lastQuery = label;
    if (!list.length) {
      el.innerHTML = `<p class="empty">Nothing found for "${esc(label)}".${isLive() ? "" : " The sample only knows a few New York places: try coffee, parks, gas, or museums."}</p>`;
      drawPlaces();
      return;
    }
    if (list.length === 1 && query && !category) return openPlace(list[0], { replace: true });
    const both = list.filter((p) => p.sources?.length === 2).length;
    el.innerHTML = `<div class="block-h"><h3>${esc(label)}</h3><span class="sub">${list.length} places${isLive() ? ` · ${both} on both maps` : ""}</span></div>
      <ul class="rows">${list.map((p, i) => placeRow(p, i)).join("")}</ul>`;
    bindPlaceRows(el, list);
    drawPlaces();
    fitTo(list.filter((p) => p.at?.[0]).map((p) => p.at));
  } catch (err) {
    el.innerHTML = `<p class="err">${esc(friendly(err))}</p>`;
  }
}

// ---- place page
async function dropPin(at) {
  let place = !isLive() ? nearestDemoPlace(state.catalog, at, 60) : null;
  if (!place) place = { id: `pin:${at[0].toFixed(5)},${at[1].toFixed(5)}`, name: "Dropped pin", category: "address", kind: "Dropped pin", at, address: "", sources: [] };
  openPlace(place);
  if (place.name === "Dropped pin") {
    const addr = await reverseLookup(at);
    if (addr && state.place?.id === place.id) { state.place.address = addr; state.place.name = addr.split(",")[0]; renderPlace(); }
  }
}

function openPlace(p, { replace = false } = {}) {
  state.place = { ...p };
  if (replace && state.view === "search") state.back.push("home"), (state.view = "home");
  show("place");
  if (p.id !== "here" && !String(p.id).startsWith("pin:")) lib.addRecent({ place: p });
  renderPlace();
  drawPlaces();
  if (p.at?.[0]) map.setView(p.at, Math.max(map.getZoom(), 15), { animate: true });
  if (wide() && p.at?.[0]) map.panBy([-200, 0], { animate: false });
}

function renderPlace() {
  const p = state.place;
  if (!p) return;
  const st = openStatus(p.hours) || (p.openNow == null ? null : { open: p.openNow, label: p.openNow ? "Open now" : "Closed now" });
  const dist = state.here && p.at?.[0] ? metresBetween(state.here.at, p.at) : null;
  const lists = lib.listsWith(p);
  const isHome = lib.data.home?.id === placeKey(p), isWork = lib.data.work?.id === placeKey(p);
  const hours = p.hoursText?.length ? p.hoursText : hoursTable(p.hours);
  $("#v-place").innerHTML = `
    <div class="vhead"><button type="button" class="iconbtn" data-back aria-label="Back">${icon("back", 2.4)}</button><span class="sp"></span>${sourceBadge(p)}</div>
    <div class="ptitle">
      <span class="pt-ic">${catIcon(p.category)}</span>
      <div><h2>${esc(p.name)}</h2>
      <p class="sub">${esc([p.kind || CATEGORIES[p.category]?.one, dist != null ? `${fmtDist(dist)} away` : ""].filter(Boolean).join(" · "))}${p.rating ? ` · ★ ${p.rating.toFixed(1)}${p.ratingCount ? ` (${p.ratingCount.toLocaleString()})` : ""}` : ""}${p.price ? ` · ${"$".repeat(p.price)}` : ""}</p>
      ${st ? `<p class="${st.open ? (st.closingSoon ? "warnc" : "okc") : "badc"} strong">${esc(st.label)}</p>` : ""}</div>
    </div>
    <div class="actions">
      <button type="button" class="go act-main" id="p-dir">${icon("go", 2.6)}Directions<span id="p-eta"></span></button>
      <button type="button" class="act" id="p-start">${icon("straight", 2.4)}Start</button>
      <button type="button" class="act" id="p-save" aria-pressed="${lists.length > 0}">${icon("bookmark", 2.2)}${lists.length ? "Saved" : "Save"}</button>
      <button type="button" class="act" id="p-share">${icon("share", 2.2)}Share</button>
      ${p.phone ? `<a class="act" href="tel:${esc(p.phone.replace(/[^\d+]/g, ""))}">${icon("phone", 2.2)}Call</a>` : ""}
      ${p.website ? `<a class="act" href="${esc(p.website)}" target="_blank" rel="noopener">${icon("globe", 2.2)}Website</a>` : ""}
    </div>
    <div class="savebox" id="p-lists" hidden>
      ${lib.data.lists.map((l) => `<label class="check"><input type="checkbox" data-list="${l.id}" ${lists.includes(l.id) ? "checked" : ""}>${icon(l.icon, 2)}${esc(l.name)}</label>`).join("")}
      <button type="button" class="link" id="p-newlist">${icon("plus", 2.4)}New list</button>
    </div>
    <ul class="info">
      ${p.address ? `<li>${icon("address", 2)}<span>${esc(p.address)}</span></li>` : ""}
      ${hours.length ? `<li>${icon("clock", 2)}<details><summary>Hours${p.demo ? " (sample)" : ""}</summary><ul class="hours">${hours.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></details></li>` : ""}
      ${p.phone ? `<li>${icon("phone", 2)}<span>${esc(p.phone)}</span></li>` : ""}
      ${p.website ? `<li>${icon("globe", 2)}<a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</a></li>` : ""}
      ${p.at?.[0] ? `<li>${icon("locate", 2)}<span class="mono">${fmtLatLng(p.at)}</span></li>` : ""}
    </ul>
    <div class="setas">
      <button type="button" class="ghost sm" id="p-home" aria-pressed="${isHome}">${icon("home", 2.2)}${isHome ? "Your Home" : "Set as Home"}</button>
      <button type="button" class="ghost sm" id="p-work" aria-pressed="${isWork}">${icon("work", 2.2)}${isWork ? "Your Work" : "Set as Work"}</button>
    </div>
    ${p.sources?.length === 1 ? `<p class="note">Only ${p.sources[0] === "google" ? "Google Maps" : "Apple Maps"} lists this place, so its details come from one source.</p>` : ""}
    ${p.demo ? `<p class="note">Sample place. Hours are examples; add keys for live details, ratings and phone numbers.</p>` : ""}`;
  $("#p-dir").addEventListener("click", () => planTo(p));
  $("#p-start").addEventListener("click", () => planTo(p, { start: true }));
  $("#p-save").addEventListener("click", () => { const b = $("#p-lists"); b.hidden = !b.hidden; });
  $("#p-lists").addEventListener("change", (e) => { const id = e.target.dataset.list; if (id) { lib.toggleInList(id, p); renderPlace(); $("#p-lists").hidden = false; } });
  $("#p-newlist").addEventListener("click", () => {
    const name = prompt("Name for the new list");
    if (!name) return;
    const id = lib.createList(name);
    lib.toggleInList(id, p);
    renderPlace();
    $("#p-lists").hidden = false;
  });
  $("#p-share").addEventListener("click", () => sharePlace(p));
  for (const which of ["home", "work"]) {
    $(`#p-${which}`).addEventListener("click", () => {
      const already = lib.data[which]?.id === placeKey(p);
      if (already) lib.clearShortcut(which); else lib.setShortcut(which, p);
      etaCache.delete(placeKey(p));
      toast(already ? `Removed ${which === "home" ? "Home" : "Work"}` : `Saved as ${which === "home" ? "Home" : "Work"}`);
      if (picking === which && !already) { picking = null; $("#q").placeholder = "Search places, addresses or lat,lng"; state.back = []; show("home", { push: false }); return; }
      renderPlace();
    });
  }
  // A quick ETA in the sample costs nothing; live, it waits for the Directions tap.
  if (!isLive() && p.demo) quickEta(p).then((eta) => { const el = $("#p-eta"); if (eta && el && state.place?.id === p.id) el.textContent = ` · ${fmtDur(eta.sec)}`; });
}

async function sharePlace(p) {
  const url = p.at?.[0] ? `https://www.openstreetmap.org/?mlat=${p.at[0]}&mlon=${p.at[1]}#map=17/${p.at[0]}/${p.at[1]}` : "";
  const text = `${p.name}${p.address ? `, ${p.address}` : ""}`;
  try {
    if (navigator.share) { await navigator.share({ title: p.name, text, url }); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(`${text} ${url}`.trim()); toast("Copied to clipboard"); } catch { toast(text); }
}

// ---- saved
let openListId = null;
function openList(id) { openListId = id; renderSaved(); }
function renderSaved() {
  const d = lib.data;
  const el = $("#v-saved");
  const l = openListId && lib.list(openListId);
  if (l) {
    state.savedPins = l.places;
    el.innerHTML = `
      <div class="vhead"><button type="button" class="iconbtn" id="list-back" aria-label="All lists">${icon("back", 2.4)}</button><h2 class="vt">${esc(l.name)}</h2><span class="sp"></span>
        ${l.id !== "favorites" ? `<button type="button" class="iconbtn" id="list-rename" aria-label="Rename list" title="Rename">${icon("list", 2)}</button><button type="button" class="iconbtn" id="list-del" aria-label="Delete list" title="Delete list">${icon("trash", 2)}</button>` : ""}</div>
      ${l.places.length ? `<ul class="rows">${l.places.map((p, i) => `<li class="row-wrap"><button type="button" class="row" data-lp="${i}">${catIcon(p.category)}<span><b>${esc(p.name)}</b><span class="sub">${esc(p.address || "")}</span></span></button><button type="button" class="iconbtn sm" data-lrm="${i}" aria-label="Remove ${esc(p.name)}">${icon("close", 2.2)}</button></li>`).join("")}</ul>
        <button type="button" class="ghost" id="list-map">Show all on map</button>` : `<p class="empty">Nothing here yet. Open a place and tap Save.</p>`}`;
    $("#list-back").addEventListener("click", () => { openListId = null; state.savedPins = []; renderSaved(); drawPlaces(); });
    $("#list-del")?.addEventListener("click", () => { if (confirm(`Delete the list "${l.name}"?`)) { lib.deleteList(l.id); openListId = null; renderSaved(); } });
    $("#list-rename")?.addEventListener("click", () => { const n = prompt("New name", l.name); if (n) { lib.renameList(l.id, n); renderSaved(); } });
    el.querySelectorAll("[data-lp]").forEach((b) => b.addEventListener("click", () => openPlace(l.places[Number(b.dataset.lp)])));
    el.querySelectorAll("[data-lrm]").forEach((b) => b.addEventListener("click", () => { lib.toggleInList(l.id, l.places[Number(b.dataset.lrm)]); renderSaved(); drawPlaces(); }));
    $("#list-map")?.addEventListener("click", () => { drawPlaces(); fitTo(l.places.map((p) => p.at)); });
    drawPlaces();
    return;
  }
  state.savedPins = [];
  const sc = (which, label, ico) => {
    const p = d[which];
    return `<li class="row-wrap"><button type="button" class="row" data-sc="${which}">${icon(ico, 2)}<span><b>${label}</b><span class="sub">${esc(p ? p.name : `Add your ${which} address`)}</span></span></button>${p ? `<button type="button" class="iconbtn sm" data-scrm="${which}" aria-label="Remove ${label}">${icon("close", 2.2)}</button>` : ""}</li>`;
  };
  el.innerHTML = `
    <h2 class="vt">Saved</h2>
    <ul class="rows">${sc("home", "Home", "home")}${sc("work", "Work", "work")}</ul>
    <div class="block-h"><h3>Your lists</h3><button type="button" class="link" id="new-list">${icon("plus", 2.4)}New list</button></div>
    <ul class="rows">${d.lists.map((x) => `<li><button type="button" class="row" data-list="${x.id}">${icon(x.icon, 2)}<span><b>${esc(x.name)}</b><span class="sub">${x.places.length} place${x.places.length === 1 ? "" : "s"}</span></span></button></li>`).join("")}</ul>
    <p class="note">Saved places stay on this device.</p>`;
  el.querySelectorAll("[data-sc]").forEach((b) => b.addEventListener("click", () => { const p = d[b.dataset.sc]; p ? openPlace(p) : pickShortcut(b.dataset.sc); }));
  el.querySelectorAll("[data-scrm]").forEach((b) => b.addEventListener("click", () => { lib.clearShortcut(b.dataset.scrm); renderSaved(); }));
  el.querySelectorAll("[data-list]").forEach((b) => b.addEventListener("click", () => openList(b.dataset.list)));
  $("#new-list").addEventListener("click", () => { const n = prompt("Name for the new list"); if (n) { lib.createList(n); renderSaved(); } });
  drawPlaces();
}

// ---- trips (the ledger)
function renderTrips() {
  const trips = lib.data.trips;
  const s = monthStats(trips);
  const month = new Date().toLocaleDateString([], { month: "long" });
  const total = s.wins.google + s.wins.apple + s.wins.both;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const tolls = Object.entries(s.tolls).map(([c, a]) => money({ amount: a, currency: c })).join(" + ") || money({ amount: 0, currency: "USD" });
  $("#v-trips").innerHTML = `
    <h2 class="vt">Trip ledger</h2>
    <p class="sub">What checking two maps did for you in ${esc(month)}.</p>
    <div class="stats">
      <div class="stat hero"><span class="eyebrow">Time saved</span><b>${s.trips ? (s.savedSec >= 60 ? fmtDur(s.savedSec) : "0 min") : "–"}</b><span class="sub">vs. always taking the other map's best route${s.trips && s.savedSec < 60 ? ". So far both maps agreed." : ""}</span></div>
      <div class="stat"><span class="eyebrow">Trips</span><b>${s.trips}</b></div>
      <div class="stat"><span class="eyebrow">Distance</span><b>${s.trips ? fmtDist(s.distanceM) : "–"}</b></div>
      <div class="stat"><span class="eyebrow">On the road</span><b>${s.trips ? fmtDur(s.durationSec) : "–"}</b></div>
      <div class="stat"><span class="eyebrow">Tolls paid</span><b>${esc(tolls)}</b><span class="sub">${s.tollsAvoided} toll-free by choice</span></div>
    </div>
    ${total ? `<div class="block"><div class="block-h"><h3>Who had the fastest route</h3></div>
      <div class="split" role="img" aria-label="Google ${pct(s.wins.google)}%, both ${pct(s.wins.both)}%, Apple ${pct(s.wins.apple)}%">
        <span class="g" style="flex:${s.wins.google}"></span><span class="b" style="flex:${s.wins.both}"></span><span class="a" style="flex:${s.wins.apple}"></span></div>
      <div class="legend"><span><i class="g"></i>Google ${s.wins.google}</span><span><i class="b"></i>Both agreed ${s.wins.both}</span><span><i class="a"></i>Apple ${s.wins.apple}</span></div></div>` : ""}
    <div class="block"><div class="block-h"><h3>Recent trips</h3>${trips.length ? '<button type="button" class="link" id="clear-trips">Clear</button>' : ""}</div>
    ${trips.length ? `<ul class="rows">${trips.slice(0, 30).map((t) => `<li><div class="row static">${icon(t.mode === "walk" ? "straight" : "go", 2)}<span><b>${esc(t.to?.name || "Trip")}</b>
      <span class="sub">${new Date(t.at).toLocaleDateString([], { month: "short", day: "numeric" })} · ${fmtDur(t.durationSec)} · ${fmtDist(t.distanceM)}${t.toll ? ` · ${money(t.toll)}` : ""}</span>
      <span class="sub">${t.winner === "both" ? "Google and Apple agreed" : `${t.winner === "apple" ? "Apple" : "Google"} was faster${t.savedSec >= 60 ? ` by ${fmtDur(t.savedSec)}` : ""}`}</span></span></div></li>`).join("")}</ul>`
      : `<p class="empty">Trips you finish show up here${lib.data.settings.keepHistory ? "" : " once history is on in Settings"}. Try the sample: open a place, tap Start.</p>`}</div>`;
  $("#clear-trips")?.addEventListener("click", () => { if (confirm("Clear all trips?")) { lib.clearTrips(); renderTrips(); } });
}

// ---- settings
function renderSettings() {
  const s = S();
  const seg = (key, opts) => `<div class="modes" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${key}" data-val="${v}" aria-pressed="${s[key] === v}">${l}</button>`).join("")}</div>`;
  const tog = (key, label, sub = "") => `<label class="srow"><span><b>${label}</b>${sub ? `<span class="sub">${sub}</span>` : ""}</span><span class="switch bare"><input type="checkbox" data-tog="${key}" ${s[key] ? "checked" : ""}><span class="track"></span></span></label>`;
  $("#v-settings").innerHTML = `
    <h2 class="vt">Settings</h2>
    <div class="group"><h3>Display</h3>
      <div class="srow"><b>Distance units</b>${seg("units", [["auto", "Auto"], ["mi", "Miles"], ["km", "Km"]])}</div>
      <div class="srow"><b>Theme</b>${seg("theme", [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]])}</div>
    </div>
    <div class="group"><h3>Navigation</h3>
      ${tog("voice", "Spoken directions")}
      ${tog("avoidTolls", "Avoid tolls by default")}
      ${tog("avoidHighways", "Avoid highways by default", "Uses Google only, since Apple can't avoid highways")}
    </div>
    <div class="group"><h3>Privacy</h3>
      ${tog("keepHistory", "Keep history", "Recent searches and the trip ledger, stored only on this device")}
      <div class="srow"><button type="button" class="ghost sm" id="s-clear-rec">Clear recent searches</button><button type="button" class="ghost sm" id="s-clear-trips">Clear trips</button><button type="button" class="ghost sm danger" id="s-reset">Reset everything</button></div>
    </div>
    <div class="group"><h3>Map data</h3>
      <div class="srow"><span><b>${isLive() ? "Live data" : "Sample mode"}</b><span class="sub">${isLive() ? `Using ${[state.server ? state.server.google : store.get("nav.googleKey"), state.server ? state.server.apple : store.get("nav.appleToken")].map((x, i) => (x ? ["Google", "Apple"][i] : "")).filter(Boolean).join(" and ")}` : "Add a Google key or Apple token to search anywhere"}</span></span><button type="button" class="ghost sm" id="s-keys">Keys</button></div>
    </div>
    <p class="note">Two-Map Navigator asks Google Maps and Apple Maps for every search and route, merges the answers, and picks the fastest. Map © OpenStreetMap contributors.</p>`;
  const el = $("#v-settings");
  el.querySelectorAll("[data-set]").forEach((b) => b.addEventListener("click", () => {
    lib.set(b.dataset.set, b.dataset.val);
    if (b.dataset.set === "theme") applyTheme();
    renderSettings();
  }));
  el.querySelectorAll("[data-tog]").forEach((i) => i.addEventListener("change", () => {
    lib.set(i.dataset.tog, i.checked);
    if (i.dataset.tog === "voice") nav.voice = i.checked;
    if (i.dataset.tog === "avoidTolls" || i.dataset.tog === "avoidHighways") { state.opts[i.dataset.tog] = i.checked; syncSwitches(); }
  }));
  $("#s-clear-rec").addEventListener("click", () => { lib.clearRecents(); toast("Recent searches cleared"); });
  $("#s-clear-trips").addEventListener("click", () => { lib.clearTrips(); toast("Trips cleared"); });
  $("#s-reset").addEventListener("click", () => { if (confirm("Remove Home, Work, lists, history and settings from this device?")) { lib.reset(); applyTheme(); syncSwitches(); renderSettings(); toast("Reset done"); } });
  $("#s-keys").addEventListener("click", openKeys);
}

// ---------------------------------------------------------------- directions
function planTo(place, { start = false } = {}) {
  const from = state.here ? stopFor({ ...state.here, id: "here" }) : null;
  state.trip = { from, to: stopFor(place) };
  $("#origin").value = from ? from.label : "";
  $("#destination").value = place.name;
  show("dir");
  search({ start });
}

function tollChip(r) {
  if (r.hasTolls) {
    const price = r.toll ? `${r.toll.estimated ? "~" : ""}${money(r.toll)} toll` : "Toll road";
    return `<span class="chip toll">${icon("toll", 2.6)}${price}</span>`;
  }
  return `<span class="chip free">${icon("check", 3)}No tolls</span>`;
}

// The second-opinion line: which service had the fastest route, and by how much.
function verdict(res) {
  const best = res.routes[0];
  if (!best) return "";
  const bestOf = (p) => Math.min(...(res[p]?.ok ? res[p].routes : []).map((r) => r.durationSec), Infinity);
  const g = bestOf("google"), a = bestOf("apple");
  if (best.sources?.length > 1) return `<p class="verdict both">${icon("check", 3)}Google and Apple agree on this route</p>`;
  if (!Number.isFinite(g) || !Number.isFinite(a)) return `<p class="verdict">Only ${Number.isFinite(g) ? "Google" : "Apple"} answered this time</p>`;
  const diff = Math.abs(g - a);
  const winner = g <= a ? "Google" : "Apple";
  return `<p class="verdict">${winner} found it${diff >= 60 ? `, ${fmtDur(diff)} faster than ${winner === "Google" ? "Apple" : "Google"}'s best` : ""}</p>`;
}

function renderResult() {
  const el = $("#result");
  const res = state.result;
  renderSources();
  if (!res) { el.innerHTML = `<p class="empty">Enter a start and destination to find the fastest route.</p>`; return; }
  if (res.sampleOnly) {
    el.innerHTML = res.noModeRoute
      ? `<p class="empty">The sample has no ${res.noModeRoute === "walk" ? "walking" : "cycling"} route to ${esc(state.trip.to?.label || "this place")}; it's too far. Try Drive.</p>`
      : `<p class="empty">In sample mode, routes start at Times Square and go to the sample places. Search for one, or add keys for routes anywhere.</p>`;
    routeLayer.clearLayers();
    return;
  }
  if (!res.routes.length) {
    const errs = ["google", "apple"].map((p) => res[p] && !res[p].ok ? `<p class="err">${p === "google" ? "Google Maps" : "Apple Maps"}: ${esc(res[p].error)}</p>` : "").join("");
    el.innerHTML = `<p class="empty">No route found.</p>${errs}${res.error ? `<p class="err">${esc(res.error)}</p>` : ""}`;
    drawRoutes();
    return;
  }
  const r = res.routes[state.selected];
  const fastest = res.routes[0];
  const label = state.selected === 0 ? "Fastest route" : `${fmtDur(r.durationSec - fastest.durationSec)} slower than fastest`;
  const steps = r.steps.map((s) => `<li>${icon(s.maneuver)}<span>${esc(s.instruction)}</span><span class="sd">${fmtDist(s.distanceM)}</span></li>`).join("");
  const arriveBy = state.when.kind === "arrive" && state.when.at ? new Date(state.when.at) : null;
  const leaveBy = arriveBy ? new Date(arriveBy.getTime() - r.durationSec * 1000) : null;
  const timing = leaveBy
    ? `leave by ${clock(leaveBy)}${leaveBy < new Date() ? " (that's already passed)" : ""}`
    : `arrive ${arriveAt(r.durationSec, startTime())}`;
  el.innerHTML = `
    <div class="best">
      <div class="eyebrow">${label}${res.demo ? " · sample" : ""}</div>
      <div class="eta"><b>${fmtDur(r.durationSec)}</b><span>${fmtDist(r.distanceM)} · ${timing}</span></div>
      <div class="via">${esc(r.name)}</div>
      <div class="chips">${tollChip(r)}${r.trafficDelaySec >= 60 ? `<span class="chip">${icon("traffic", 2.4)}+${fmtDur(r.trafficDelaySec)} traffic</span>` : ""}<span class="chip">${(r.sources || [r.provider]).map((s) => (s === "google" ? "Google" : "Apple")).join(" + ")}</span></div>
      ${state.selected === 0 ? verdict(res) : ""}
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
    if (!isLive()) { el.className = ""; el.textContent = name; el.title = ""; return; }
    const ok = res ? res[p]?.ok : (state.server ? state.server[p] : Boolean(store.get(p === "google" ? "nav.googleKey" : "nav.appleToken")));
    el.className = ok ? "on" : "off";
    el.textContent = name;
    el.title = ok ? `${name} ready` : res?.[p]?.error || `${name} not set up`;
  };
  set("google", "Google");
  set("apple", "Apple");
  $("#foot-text").textContent = isLive()
    ? "Checks Google Maps and Apple Maps, then picks the fastest."
    : "Sample mode: New York places and routes. Add keys for live data.";
}

function selectRoute(i) {
  state.selected = i;
  renderResult();
}

document.addEventListener("click", (e) => {
  const rt = e.target.closest(".rt");
  if (rt) return selectRoute(Number(rt.dataset.i));
  if (e.target.closest("#start-nav")) startNavigation();
});

let searchSeq = 0;
async function search({ fit = true, start = false } = {}) {
  const { from, to } = state.trip;
  if (!to) return;
  if (!from) { $("#result").innerHTML = `<p class="empty">Where are you starting from? Type a start, or turn on location.</p>`; return; }
  const seq = ++searchSeq;
  const go = $("#go");
  go.disabled = true;
  go.textContent = isLive() ? "Checking Google and Apple…" : "Finding routes…";
  try {
    const res = await lookUp(from, to);
    if (seq !== searchSeq) return;
    state.result = { origin: from.label, destination: to.label, ...res };
    state.selected = 0;
    renderResult();
    drawRoutes(fit);
    if (start && state.result.routes?.length) startNavigation();
  } catch (err) {
    $("#result").innerHTML = `<p class="err">${esc(friendly(err))}</p>`;
  } finally {
    go.disabled = false;
    go.textContent = "Find route";
  }
}

// Typed text in the trip form: match it to a sample place or "Your location", else send the text as is.
function stopFromText(text, current) {
  const t = text.trim();
  if (!t) return null;
  if (current && current.label === t) return current;
  if (/^(your|my|current) location$/i.test(t) && state.here) return stopFor({ ...state.here, id: "here" });
  const ll = parseLatLng(t);
  if (ll) return { label: t, q: t, place: { id: `pin:${t}`, name: t, at: ll, category: "address" } };
  if (!isLive()) {
    if (/times square/i.test(t)) return stopFor({ ...state.here || SAMPLE_HERE, id: "here" });
    const p = searchDemoPlaces(state.catalog, { query: t })[0];
    if (p) return stopFor(p);
  }
  return { label: t, q: t, place: { name: t } };
}

$("#trip").addEventListener("submit", (e) => {
  e.preventDefault();
  state.trip = { from: stopFromText($("#origin").value, state.trip.from), to: stopFromText($("#destination").value, state.trip.to) };
  search();
});
$("#swap").addEventListener("click", () => {
  const o = $("#origin"), d = $("#destination");
  [o.value, d.value] = [d.value, o.value];
  state.trip = { from: state.trip.to, to: state.trip.from };
  if (state.trip.from && state.trip.to) search();
});
$$(".modes[data-group=mode] button").forEach((b) =>
  b.addEventListener("click", () => {
    state.mode = b.dataset.mode;
    $$(".modes[data-group=mode] button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    syncSwitches();
    if (state.trip.to) search({ fit: false });
  })
);
function syncSwitches() {
  const driving = state.mode === "drive";
  for (const [id, key] of [["opt-tolls", "avoidTolls"], ["opt-highways", "avoidHighways"]]) {
    $(`#${id}`).checked = state.opts[key];
    $(`#${id}`).disabled = !driving;
    $(`#${id}`).closest(".switch").classList.toggle("disabled", !driving);
  }
}
for (const [id, key] of [["opt-tolls", "avoidTolls"], ["opt-highways", "avoidHighways"]]) {
  $(`#${id}`).addEventListener("change", (e) => {
    state.opts[key] = e.target.checked;
    if (state.result) search({ fit: false });
  });
}
$("#when").addEventListener("change", () => {
  state.when.kind = $("#when").value;
  const t = $("#when-at");
  t.hidden = state.when.kind === "now";
  if (!t.hidden && !t.value) {
    const d = new Date(Date.now() + 30 * 60 * 1000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    t.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  state.when.at = t.hidden ? "" : t.value;
  if (state.result) state.when.kind === "depart" && isLive() ? search({ fit: false }) : renderResult();
});
$("#when-at").addEventListener("change", () => {
  state.when.at = $("#when-at").value;
  if (state.result) state.when.kind === "depart" && isLive() ? search({ fit: false }) : renderResult();
});

// ---------------------------------------------------------------- location
function setHere(here) {
  state.here = here;
  drawHere();
  if (state.view === "home") renderHome();
}
$("#locate").addEventListener("click", () => {
  if (!isLive()) {
    setHere({ ...SAMPLE_HERE, sample: true });
    map.setView(SAMPLE_HERE.at, 15);
    toast("Sample mode: your location is Times Square.");
    return;
  }
  if (!navigator.geolocation) return toast("This browser can't share your location.");
  navigator.geolocation.getCurrentPosition(
    (p) => { setHere({ name: "your location", address: "", at: [p.coords.latitude, p.coords.longitude] }); map.setView(state.here.at, 15); },
    (e) => toast(e.code === 1 ? "Location permission was refused." : "Couldn't get your location."),
    { enableHighAccuracy: true, timeout: 15000 }
  );
});

// ---------------------------------------------------------------- keys dialog
function openKeys() {
  $("#keys-mode-note").textContent = state.server
    ? "This app is running on your own server, which reads the keys from its .env file. Edit .env and restart to change them."
    : "Paste your keys to get live places and routes straight from this browser. On claude.ai the page can only show sample data, because hosted pages can't call outside services.";
  $("#k-google").value = store.get("nav.googleKey");
  $("#k-apple").value = store.get("nav.appleToken");
  $("#keys").showModal();
}
$("#open-keys").addEventListener("click", openKeys);
$("#keys-form").addEventListener("submit", () => {
  store.set("nav.googleKey", $("#k-google").value.trim());
  store.set("nav.appleToken", $("#k-apple").value.trim());
  state.forceDemo = false;
  appleTok = { token: "", until: 0 };
  etaCache.clear();
  modeChanged();
});
$("#k-clear").addEventListener("click", () => {
  $("#k-google").value = ""; $("#k-apple").value = "";
  store.set("nav.googleKey", ""); store.set("nav.appleToken", "");
});
$("#k-demo").addEventListener("click", () => { $("#keys").close(); state.forceDemo = true; modeChanged(); });

function modeChanged() {
  etaCache.clear();
  if (!isLive()) setHere({ ...SAMPLE_HERE, sample: true });
  else if (state.here?.sample) setHere(null);
  renderSources();
  state.back = [];
  show("home", { push: false });
}

// ---------------------------------------------------------------- navigation
const ARROW = `<svg viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="15" fill="#fff"/><circle cx="17" cy="17" r="12" fill="var(--accent)"/><path d="M17 5l6 20-6-3.2-6 3.2z" fill="#fff"/></svg>`;
const nav = {
  on: false, route: null, tracker: null, destination: "", source: "sim", simAlong: 0, lastAlong: 0, simTimer: null,
  watchId: null, speed: 4, voice: true, follow: true, rerouting: false, lastFix: null,
  layer: null, wakeLock: null, sourceNote: "", trip: null, logged: false,
};

function speak(lines) {
  if (!nav.voice || !lines.length || !("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    for (const t of lines) speechSynthesis.speak(new SpeechSynthesisUtterance(t));
  } catch {}
}

function tripRecord(res, r) {
  const bestOf = (p) => Math.min(...(res[p]?.ok ? res[p].routes : []).map((x) => x.durationSec), Infinity);
  const winner = r.sources?.length > 1 ? "both" : r.provider || r.sources?.[0] || "google";
  const other = winner === "google" ? bestOf("apple") : winner === "apple" ? bestOf("google") : Infinity;
  return {
    to: state.trip.to?.place?.at ? { name: state.trip.to.label, at: state.trip.to.place.at } : { name: res.destination },
    mode: state.mode,
    durationSec: r.durationSec,
    distanceM: r.distanceM,
    toll: r.hasTolls && r.toll ? r.toll : null,
    avoidedToll: state.mode === "drive" && state.opts.avoidTolls,
    winner,
    savedSec: Number.isFinite(other) ? Math.max(0, Math.round(other - r.durationSec)) : 0,
  };
}

function startNavigation() {
  const r = state.result?.routes?.[state.selected];
  if (!r?.path.length || !r.steps.length) return;
  Object.assign(nav, {
    on: true, route: r, destination: state.result.destination, follow: true, rerouting: false, lastFix: null, lastAlong: 0, sourceNote: "",
    trip: tripRecord(state.result, r), logged: false, voice: S().voice, demo: Boolean(state.result.demo),
  });
  nav.tracker = createTracker(r, { imperial: imperial() });
  document.body.classList.add("navigating");
  map.invalidateSize();
  routeLayer.clearLayers();
  placeLayer.clearLayers();
  hereLayer.clearLayers();
  nav.layer = L.layerGroup().addTo(map);
  map.on("dragstart", onDrag);
  try { navigator.wakeLock?.request("screen").then((w) => (nav.wakeLock = w)).catch(() => {}); } catch {}
  renderStepList();
  setVoiceBtn();
  useSource(nav.demo ? "sim" : "gps");
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
  if (u.arrived) { stopPosition(); logTrip(); }
}

function logTrip() {
  if (nav.logged || !nav.trip) return;
  nav.logged = true;
  lib.logTrip(nav.trip);
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
    $("#turn-then").innerHTML = nav.trip?.savedSec >= 60 ? `Checking both maps saved you ${esc(fmtDur(nav.trip.savedSec))} on this trip` : "";
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
  nav.last = u;
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
    const res = await lookUp({ label: "Here", q: `${pos[0].toFixed(6)},${pos[1].toFixed(6)}` }, state.trip.to);
    const best = res.routes?.[0];
    if (best?.steps.length && nav.on) {
      nav.route = best;
      nav.tracker = createTracker(best, { imperial: imperial() });
      nav.lastAlong = 0;
      renderStepList();
      speak(["Route updated"]);
    }
  } catch {}
  setTimeout(() => (nav.rerouting = false), 8000);
}

function endNavigation() {
  // A trip counts in the ledger once you're past halfway.
  const u = nav.last;
  if (u && nav.tracker && u.remainingM < nav.tracker.nav.total / 2) logTrip();
  stopPosition();
  nav.on = false;
  try { speechSynthesis.cancel(); } catch {}
  try { nav.wakeLock?.release(); } catch {}
  document.body.classList.remove("navigating");
  $("#recenter").hidden = true;
  map.off("dragstart", onDrag);
  nav.layer?.remove();
  nav.me?.remove();
  nav.me = null;
  map.invalidateSize();
  drawHere();
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
  lib.set("voice", nav.voice);
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
$("#nav-share").addEventListener("click", async () => {
  const u = nav.last;
  const text = u ? `I'm on my way to ${nav.destination}, arriving around ${arriveAt(u.remainingSec)} (${fmtDur(u.remainingSec)} away).` : `I'm on my way to ${nav.destination}.`;
  try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e?.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(text); toast("Your ETA was copied, ready to paste"); } catch { toast(text, 6000); }
});
$("#nav-report").addEventListener("click", () => $("#report").showModal());
$("#report").addEventListener("click", (e) => {
  const b = e.target.closest("[data-report]");
  if (!b) return;
  $("#report").close();
  const at = nav.lastFix || state.here?.at;
  if (!at) return;
  lib.addReport(b.dataset.report, at);
  drawReports();
  toast(`${REPORTS[b.dataset.report]} marked on your map for the next hour`);
});
$("#nav-end").addEventListener("click", endNavigation);

// ---------------------------------------------------------------- boot
async function boot() {
  // Older versions kept these on their own.
  if (store.get("nav.voice") === "off") { lib.set("voice", false); store.set("nav.voice", ""); }
  if (store.get("nav.avoidTolls") === "1") { lib.set("avoidTolls", true); store.set("nav.avoidTolls", ""); }
  if (store.get("nav.avoidHighways") === "1") { lib.set("avoidHighways", true); store.set("nav.avoidHighways", ""); }
  state.opts.avoidTolls = S().avoidTolls;
  state.opts.avoidHighways = S().avoidHighways;
  applyTheme();
  initMap();
  syncSwitches();
  drawReports();
  state.catalog = await loadDemoPlaces();
  try {
    const res = await fetch("api/config", { cache: "no-store" });
    if (res.ok && (res.headers.get("content-type") || "").includes("json")) state.server = await res.json();
  } catch {}
  if (!isLive()) {
    setHere({ ...SAMPLE_HERE, sample: true });
    map.setView([40.735, -73.965], 12);
    // First visit to the sample: give it a Home so the commute card has something to show.
    if (!lib.data.home && !lib.data.seeded) { lib.data.seeded = true; lib.setShortcut("home", findDemoPlace(state.catalog, "home-sample")); }
  } else {
    // Use your location right away only if you already allowed it.
    try {
      const perm = await navigator.permissions?.query({ name: "geolocation" });
      if (perm?.state === "granted") $("#locate").click();
    } catch {}
  }
  renderSources();
  show("home", { push: false });
  lib.onChange(() => { if (state.view === "home") renderHome(); });
}
boot();
